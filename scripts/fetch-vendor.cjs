#!/usr/bin/env node
'use strict';
// Fetches the external tools the app needs (yt-dlp + ffmpeg) into vendor/ so
// the installer bundles everything the user needs to run the app. Skips any
// file that already exists with a sane size, so repeat builds are instant.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { spawnSync } = require('node:child_process');

const VENDOR = path.join(__dirname, '..', 'vendor');
const ytDlpUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const ffmpegZipUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
const MIN_YTDLP_BYTES = 5 * 1024 * 1024;   // real yt-dlp.exe is ~17 MB
const MIN_FFMPEG_BYTES = 20 * 1024 * 1024; // real ffmpeg.exe is ~80-120 MB

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const get = (target, redirects) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      https.get(target, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return get(new URL(res.headers.location, target).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${target}`)); }
        const tmp = dest + '.part';
        const file = fs.createWriteStream(tmp);
        res.pipe(file);
        file.on('finish', () => file.close(() => {
          try { fs.renameSync(tmp, dest); resolve(); } catch (e) { reject(e); }
        }));
        file.on('error', err => { try { fs.unlinkSync(tmp); } catch {} reject(err); });
      }).on('error', reject);
    };
    get(url, 0);
  });
}

async function ensure(url, dest, minBytes) {
  try {
    const stat = fs.statSync(dest);
    if (stat.size >= minBytes) { console.log(`vendor: ${path.basename(dest)} already present (${Math.round(stat.size / 1048576)} MB)`); return; }
  } catch {}
  console.log(`vendor: downloading ${path.basename(dest)} …`);
  await download(url, dest);
  const stat = fs.statSync(dest);
  if (stat.size < minBytes) throw new Error(`${dest} looks too small (${stat.size} bytes) — download failed`);
  console.log(`vendor: ${path.basename(dest)} ok (${Math.round(stat.size / 1048576)} MB)`);
}

function extractFfmpeg() {
  const need = ['ffmpeg.exe', 'ffprobe.exe'].filter(name => {
    try { return fs.statSync(path.join(VENDOR, name)).size < MIN_FFMPEG_BYTES; } catch { return true; }
  });
  if (!need.length) { console.log('vendor: ffmpeg.exe + ffprobe.exe already extracted'); return; }
  const zip = path.join(VENDOR, 'ffmpeg.zip');
  console.log('vendor: extracting ffmpeg.exe / ffprobe.exe from the zip …');
  // Git's GNU tar shadows Windows' bsdtar in PATH and can't read zips, so call
  // System32's tar explicitly; PowerShell Expand-Archive as a fallback.
  const sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const useTar = fsSyncExists(sysTar) && spawnSync(sysTar, ['-tf', zip], { encoding: 'utf8' }).status === 0;
  if (useTar) {
    const entries = String(spawnSync(sysTar, ['-tf', zip], { encoding: 'utf8' }).stdout).split(/\r?\n/).filter(Boolean);
    for (const name of need) {
      const entry = entries.find(e => e.endsWith('/' + name));
      if (!entry) throw new Error(`${name} not found inside the ffmpeg zip`);
      const extract = spawnSync(sysTar, ['-xf', zip, '-C', VENDOR, entry], { stdio: 'ignore' });
      if (extract.status !== 0) throw new Error(`Could not extract ${entry}`);
      fs.renameSync(path.join(VENDOR, entry), path.join(VENDOR, name));
    }
  } else {
    const tmp = path.join(VENDOR, 'ffmpeg-x');
    fs.mkdirSync(tmp, { recursive: true });
    const ps = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${tmp}' -Force`], { stdio: 'ignore', timeout: 300000 });
    if (ps.status !== 0) throw new Error('Could not extract the ffmpeg zip (PowerShell failed)');
    for (const name of need) {
      const found = findFileRecursive(tmp, name);
      if (!found) throw new Error(`${name} not found inside the extracted ffmpeg zip`);
      fs.renameSync(found, path.join(VENDOR, name));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  try { fs.unlinkSync(zip); } catch {}
  for (const name of need) {
    const stat = fs.statSync(path.join(VENDOR, name));
    if (stat.size < MIN_FFMPEG_BYTES) throw new Error(`${name} extracted but looks truncated`);
    console.log(`vendor: ${name} ok (${Math.round(stat.size / 1048576)} MB)`);
  }
}
function fsSyncExists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function findFileRecursive(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { const found = findFileRecursive(full, name); if (found) return found; }
    else if (entry.name === name) return full;
  }
  return '';
}

(async () => {
  fs.mkdirSync(VENDOR, { recursive: true });
  await ensure(ytDlpUrl, path.join(VENDOR, 'yt-dlp.exe'), MIN_YTDLP_BYTES);
  await ensure(ffmpegZipUrl, path.join(VENDOR, 'ffmpeg.zip'), MIN_FFMPEG_BYTES);
  extractFfmpeg();
  console.log('vendor: ready');
})().catch(err => { console.error('vendor fetch failed:', err.message); process.exit(1); });
