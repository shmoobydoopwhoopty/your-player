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
// Two ad blockers ship unpacked in vendor/ and load into the Downloader's
// YouTube webview session so the embedded site plays without ads:
//   - uBlock Origin (full MV2 webRequest build) from gorhill's GitHub releases
//   - Adblock for YouTube (MV3, the store extension the user asked for) from
//     Google's CRX update endpoint, which still serves it when the extension
//     id + prodversion (not uBO's, which now returns 204) are sent.
// Both are refreshed by comparing the locally stamped version against the
// latest release/store version, and each guard is independent so one failing
// download never blocks the other.
const uboLatestUrl = 'https://api.github.com/repos/gorhill/uBlock/releases/latest';
const UBODIR = path.join(VENDOR, 'ublock-origin');
const MIN_UBO_BYTES = 4 * 1024 * 1024;
const ABY_ID = 'cmedhionkhpnakcndndgjdbohmhepckk';          // Adblock for YouTube (Chrome Web Store id)
const ABYDIR = path.join(VENDOR, 'adblock-for-youtube');
const ABY_CRX_URL = `https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3&prodversion=130.0.0.0&x=id%3D${ABY_ID}%26uc`;
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
// Latest uBlock Origin chromium zip from GitHub -> unpacked into
// vendor/ublock-origin. Refetched when the folder is missing, too small, or
// older than the latest release tag (a version stamp file holds what ships).
async function ensureUblock() {
  let local = {};
  try { local = JSON.parse(fs.readFileSync(path.join(UBODIR, '.appversion'), 'utf8')); } catch {}
  let latest = null;
  try {
    const res = await fetch(uboLatestUrl, { headers: { 'User-Agent': 'your-player' }, signal: AbortSignal.timeout(15000) });
    if (res.ok) { const j = await res.json(); if (j.tag_name) { latest = j.tag_name; } }
  } catch {}
  const stat = fsSyncExists(path.join(UBODIR, 'manifest.json')) ? fs.statSync(path.join(UBODIR, 'manifest.json')) : null;
  if (stat && stat.size > 0 && local.tag && local.tag === latest) { console.log('vendor: ublock-origin already present'); return; }
  if (latest) console.log(`vendor: uBlock Origin update -> ${latest}`);
  if (!latest && stat && stat.size >= MIN_UBO_BYTES && local.tag) { console.log('vendor: ublock-origin already present (upstream query failed, keeping current)'); return; }
  let assetUrl = '';
  try {
    const res = await fetch('https://api.github.com/repos/gorhill/uBlock/releases', { headers: { 'User-Agent': 'your-player' }, signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const j = await res.json();
      const rel = Array.isArray(j) ? j.find(r => r.tag_name === latest) : null;
      const asset = rel?.assets?.find(a => a.name === `uBlock0_${String(latest).replace(/^v/, '')}.chromium.zip`);
      if (asset) assetUrl = asset.browser_download_url;
    }
  } catch {}
  if (!assetUrl && latest) assetUrl = `https://github.com/gorhill/uBlock/releases/download/${latest}/uBlock0_${String(latest).replace(/^v/, '')}.chromium.zip`;
  if (!assetUrl && stat && stat.size >= MIN_UBO_BYTES) { console.log('vendor: could not resolve the uBlock release asset, keeping current'); return; }
  if (!assetUrl) throw new Error('Could not resolve a uBlock Origin chromium release');
  console.log('vendor: downloading uBlock Origin …');
  const zip = path.join(VENDOR, 'ublock-origin.zip');
  await download(assetUrl, zip);
  const tmp = path.join(VENDOR, 'ublock-x');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const ps = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${tmp}' -Force`], { stdio: 'ignore', timeout: 300000 });
  if (ps.status !== 0) throw new Error('Could not extract the uBlock zip (PowerShell failed)');
  const found = findDirRecursive(tmp, dir => fsSyncExists(path.join(dir, 'manifest.json')));
  if (!found) throw new Error('manifest.json not found inside the uBlock zip');
  fs.rmSync(UBODIR, { recursive: true, force: true });
  fs.renameSync(found, UBODIR);
  fs.writeFileSync(path.join(UBODIR, '.appversion'), JSON.stringify({ tag: latest }));
  const manifest = JSON.parse(fs.readFileSync(path.join(UBODIR, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 2) throw new Error(`uBlock shipped manifest_version ${manifest.manifest_version}, expected 2 (webRequest blocking)`);
  fs.rmSync(tmp, { recursive: true, force: true });
  try { fs.unlinkSync(zip); } catch {}
  console.log(`vendor: ublock-origin ok (MV ${manifest.manifest_version} ${manifest.version})`);
}
function findDirRecursive(dir, match) {
  if (match(dir)) return dir;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { const found = findDirRecursive(full, match); if (found) return found; }
  }
  return '';
}

// Adblock for YouTube: download the current store package as a CRX3, strip
// the signing header, unzip, and unpack into vendor/adblock-for-youtube.
// The store never serves the raw extension as a plain zip, only as a signed
// .crx, so the small (now-standard) header cut below is what turns it into
// the unpacked directory Electron's loadExtension expects.
async function ensureAdblockForYouTube() {
  let local = {};
  try { local = JSON.parse(fs.readFileSync(path.join(ABYDIR, '.appversion'), 'utf8')); } catch {}
  if (fsSyncExists(path.join(ABYDIR, 'manifest.json')) && local.tag) { console.log(`vendor: adblock-for-youtube already present (${local.tag})`); return; }
  console.log('vendor: downloading Adblock for YouTube …');
  const crx = path.join(VENDOR, 'adblock-for-youtube.crx');
  await download(ABY_CRX_URL, crx);
  const crxStat = fs.statSync(crx);
  if (crxStat.size < 100 * 1024) throw new Error(`adblock-for-youtube.crx looks too small (${crxStat.size} bytes)`);
  const buf = fs.readFileSync(crx);
  if (buf.subarray(0, 4).toString() !== 'Cr24' || buf.readUInt32LE(4) !== 3) throw new Error('adblock-for-youtube.crx is not a CRX3 package');
  const headerLen = buf.readUInt32LE(8);
  const zip = path.join(VENDOR, 'adblock-for-youtube.zip');
  fs.writeFileSync(zip, buf.subarray(12 + headerLen));
  const tmp = path.join(VENDOR, 'aby-x');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const ps = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${tmp}' -Force`], { stdio: 'ignore', timeout: 300000 });
  if (ps.status !== 0) throw new Error('Could not extract the Adblock for YouTube crx (PowerShell failed)');
  const found = findDirRecursive(tmp, dir => fsSyncExists(path.join(dir, 'manifest.json')));
  if (!found) throw new Error('manifest.json not found inside the Adblock for YouTube package');
  fs.rmSync(ABYDIR, { recursive: true, force: true });
  fs.renameSync(found, ABYDIR);
  // Strip the store provenance folder: Electron's loader refuses a directory
  // that contains _metadata (it is not part of the extension root).
  try { fs.rmSync(path.join(ABYDIR, '_metadata'), { recursive: true, force: true }); } catch {}
  const manifest = JSON.parse(fs.readFileSync(path.join(ABYDIR, 'manifest.json'), 'utf8'));
  const name = (manifest.name || '').startsWith('__MSG_') ? 'Adblock for YouTube' : (manifest.name || '');
  fs.writeFileSync(path.join(ABYDIR, '.appversion'), JSON.stringify({ tag: manifest.version }));
  fs.rmSync(tmp, { recursive: true, force: true });
  try { fs.unlinkSync(zip); } catch {}
  try { fs.unlinkSync(crx); } catch {}
  console.log(`vendor: adblock-for-youtube ok (MV ${manifest.manifest_version} ${manifest.version})`);
}
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
  await ensureUblock();
  try { await ensureAdblockForYouTube(); } catch (error) { console.error('vendor: adblock-for-youtube fetch failed (continuing without it):', error.message); }
  await ensure(ytDlpUrl, path.join(VENDOR, 'yt-dlp.exe'), MIN_YTDLP_BYTES);
  await ensure(ffmpegZipUrl, path.join(VENDOR, 'ffmpeg.zip'), MIN_FFMPEG_BYTES);
  extractFfmpeg();
  console.log('vendor: ready');
})().catch(err => { console.error('vendor fetch failed:', err.message); process.exit(1); });
