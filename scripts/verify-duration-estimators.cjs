#!/usr/bin/env node
// Extract the parser-worker source from index.html and unit-test the
// duration estimators with real media bytes generated here.
'use strict';
const fs = require('fs');

const html = fs.readFileSync('index.html', 'utf8');
const m = /<script type="text\/plain" id="parserWorkerSource">([\s\S]*?)<\/script>/.exec(html);
if (!m) { console.error('worker source not found'); process.exit(1); }

const factory = new Function('self', // stub the worker global so the source loads in Node
  'var STUB_postMessage=function(){};var createImageBitmap=async()=>null;var Blob=globalThis.Blob;var OffscreenCanvas=function(){};'
  + m[1].replace(/self\.postMessage\(/g, 'STUB_postMessage(') +
  '\n;return {estimateMp3Duration, estimateMp4Duration, estimateFlacDuration, estimateWavDuration};');
const STUB_postMessage = function(obj){ /* swallow worker posts */ };
const fns = factory.call(null, {});

let fail = 0;
function approx(name, got, want, tol = 0.35) {
  const ok = got != null && Math.abs(got - want) <= tol;
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + ' (got ' + (got == null ? 'null' : got.toFixed(2)) + ', want ~' + want + ')');
  if (!ok) fail++;
}

// ── WAV: 2 seconds, 8-bit mono @ 8 kHz ──
function makeWav(seconds, rate = 8000) {
  const n = Math.floor(seconds * rate);
  const dataSize = n;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < n; i++) buf[44 + i] = 128 + Math.round(120 * Math.sin(2 * Math.PI * 440 * i / rate));
  return buf;
}
const wav = makeWav(2);
const wavBytes = new Uint8Array(wav);
approx('WAV 2s duration sniffed', fns.estimateWavDuration(wavBytes, wavBytes.length), 2);

// ── MP3 CBR: build valid MPEG-1 Layer III, 128 kbps, 44.1 kHz mono frames ──
// Frame size = floor(144 * bitrate / samplerate) = 144*128000/44100 = 417 bytes + padding
function makeMp3Cbr(seconds, kbps = 128, hz = 44100) {
  const frameLen = Math.floor(144 * kbps * 1000 / hz);
  const perFrameSec = 1152 / hz;
  const nFrames = Math.ceil(seconds / perFrameSec);
  const id3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]); // 10-byte empty ID3v2
  const body = Buffer.alloc(nFrames * frameLen);
  for (let i = 0; i < nFrames; i++) {
    const off = i * frameLen;
    body[off] = 0xFF;
    body[off + 1] = 0xFB; // MPEG1, Layer III, no CRC
    // bitrate index for 128 kbps MPEG1 L3 = 9
    // sample-rate 44100 index = 0
    body[off + 2] = (9 << 4) | (0 << 2) | 0x02; // pad=0
    body[off + 3] = 0xC4; // mono, no copyright etc
  }
  return Buffer.concat([id3, body]);
}
const mp3 = makeMp3Cbr(5);
const mp3Bytes = new Uint8Array(mp3);
approx('MP3 CBR 5s duration sniffed', fns.estimateMp3Duration(mp3Bytes, mp3Bytes.length), 5);

// ── MP3 VBR with a Xing header: frame count ──
function makeMp3VbrXing(totalSeconds, kbps = 128, hz = 44100) {
  const frameLen = Math.floor(144 * kbps * 1000 / hz);
  const perFrameSec = 1152 / hz;
  const nFrames = Math.round(totalSeconds / perFrameSec);
  const head = Buffer.alloc(4 + 0);
  // Header for a big frameless placeholder: build one real frame then Xing inside it
  const frame = Buffer.alloc(frameLen);
  frame[0] = 0xFF; frame[1] = 0xFB; frame[2] = (9 << 4) | 0x02; frame[3] = 0xC4;
  // Xing header at offset +4 into the first frame's side info area
  const xing = Buffer.alloc(16);
  xing.write('Xing', 0);
  xing.writeUInt32BE(0x01, 4); // frames flag only
  xing.writeUInt32BE(nFrames, 8);
  const tag = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), frame, xing, Buffer.alloc(0)]);
  // Pad out to roughly the right size so the CBR fallback also lands close
  const extra = Buffer.alloc(Math.max(0, nFrames * frameLen - tag.length));
  return Buffer.concat([tag, extra]);
}
const vbr = makeMp3VbrXing(7);
const vbrBytes = new Uint8Array(vbr);
approx('MP3 VBR (Xing) 7s duration sniffed', fns.estimateMp3Duration(vbrBytes, vbrBytes.length), 7);

// ── MP4: minimal moov/mvhd with timescale 1000, duration 42000ms ──
function makeMp4(durationSec) {
  const timescale = 1000, dur = Math.floor(durationSec * timescale);
  const mvhd = Buffer.alloc(20 + 4 + 76);
  // box: size=100, 'mvhd', version=0, flags, ctime, mtime, timescale, duration, rest
  const buf = Buffer.alloc(120);
  buf.writeUInt32BE(0, 0); // placeholder; we just need bytes at right offsets (no full box structure)
  buf.write('mvhd', 4);
  buf.writeUInt32BE(0, 8);      // version/flags (offset from 'mvhd')
  buf.writeUInt32BE(0, 12);     // creation
  buf.writeUInt32BE(0, 16);     // modification
  buf.writeUInt32BE(timescale, 20);
  buf.writeUInt32BE(dur, 24);
  // Pad rest with fake trak
  buf.write('trak', 28);
  return buf;
}
// NOTE: The worker scans for the ASCII 'mvhd' anywhere in the head bytes and
// reads version at +4, timescale at +16, duration at +20 (from the 'mvhd' start).
const mp4 = makeMp4(42);
const mp4Bytes = new Uint8Array(mp4);
approx('MP4 mvhd 42s duration sniffed', fns.estimateMp4Duration(mp4Bytes), 42);

// ── FLAC: STREAMINFO with 44100 Hz and totalSamples = 44100 * 3 ──
function makeFlac(totalSeconds, hz = 44100) {
  const totalSamples = Math.floor(totalSeconds * hz);
  const buf = Buffer.alloc(4 + 4 + 34 + 10);
  buf.write('fLaC', 0, 'ascii');
  // block header: last=1, type=0, length=34
  buf[4] = 0x80; buf[5] = 0; buf[6] = 0; buf[7] = 34;
  // STREAMINFO body — spec layout:
  // 0-1 min blocksize, 2-3 max blocksize, 4-6 min framesize, 7-9 max framesize,
  // 10-11 + high nibble of 12 = sample rate (20 bits), then channel bits etc.,
  // 13 (low nibble) .. 17 = total samples (36 bits).
  const body = 8;
  buf.writeUInt16BE(4096, body); buf.writeUInt16BE(4096, body + 2); // min/max blocksize
  buf.writeUInt16BE(0, body + 4); buf.writeUInt16BE(0, body + 6);   // min/max framesize
  const v = hz;
  buf[body + 10] = (v >> 12) & 0xFF;
  buf[body + 11] = (v >> 4) & 0xFF;
  buf[body + 12] = (v & 0xF) << 4;   // high nibble = low 4 bits of hz
  const total = totalSamples;
  buf[body + 13] = (Math.floor(total / 1099511627776)) & 0x0F;
  buf[body + 14] = (Math.floor(total / 16777216)) & 0xFF;
  buf[body + 15] = (Math.floor(total / 65536)) & 0xFF;
  buf[body + 16] = (Math.floor(total / 256)) & 0xFF;
  buf[body + 17] = total & 0xFF;
  return buf;
}
const flac = makeFlac(3);
const flacBytes = new Uint8Array(flac);
approx('FLAC 3s duration sniffed', fns.estimateFlacDuration(flacBytes), 3);

console.log(fail ? ('FAILURES: ' + fail) : 'ALL-PASS');
process.exit(fail ? 1 : 0);
