'use strict';
// Self-updater for Your Player.
//
// The app polls a plain JSON manifest at a configurable URL:
//   {
//     "version": "1.0.5",
//     "releaseDate": "2026-10-07T00:00:00.000Z",
//     "notes": "What changed",
//     "files": [ { "path": "index.html", "sha256": "<64 hex chars>" } ]
//   }
// File URLs resolve relative to the manifest URL, so the manifest and the files
// just sit side by side on any static host. Updates are downloaded to a staging
// folder in userData, verified with SHA-256, then swapped into the install
// folder (previous versions are backed up) and the app relaunches.
//
// The update source is chosen in this order:
//   1. YOUR_PLAYER_UPDATE_URL environment variable
//   2. The URL the user set in Settings → Update source (update-config.json)
//   3. DEFAULT_UPDATE_URL below

const { app, net } = require('electron');
const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

// Baked-in update channel for everyone who installs the app: the newest
// GitHub release's manifest. Ship updates by attaching manifest.json and the
// app files as assets of a new release (see scripts/publish-update.js).
const DEFAULT_UPDATE_URL = 'https://github.com/shmoobydoopwhoopty/your-player/releases/latest/download/manifest.json';

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

const UPDATES_DIR = () => path.join(app.getPath('userData'), 'updates');
const CONFIG_FILE = () => path.join(app.getPath('userData'), 'update-config.json');

let lastManifest = null;
let busy = false;

function normalizeRelPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.?\//, '').trim();
}

// Only app files may be replaced — never arbitrary paths.
function isAllowedPath(rel) {
  if (rel === 'index.html' || rel === 'package.json') return true;
  return /^electron\/[A-Za-z0-9._-]+\.cjs$/.test(rel);
}

function readConfigFile() {
  try { return JSON.parse(fsSync.readFileSync(CONFIG_FILE(), 'utf8')) || {}; } catch { return {}; }
}

function getConfig() {
  const stored = readConfigFile();
  const url = String(process.env.YOUR_PLAYER_UPDATE_URL || '').trim()
    || String(stored.url || '').trim()
    || DEFAULT_UPDATE_URL;
  return {
    url,
    hasSource: Boolean(url),
    portable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR),
    currentVersion: app.getVersion(),
  };
}

function setConfig(partial) {
  const value = partial && typeof partial === 'object' ? partial : {};
  const stored = readConfigFile();
  if (typeof value.url === 'string') stored.url = value.url.trim();
  else if (value.url === null) delete stored.url;
  try { fsSync.writeFileSync(CONFIG_FILE(), JSON.stringify(stored, null, 2)); } catch {}
  return getConfig();
}

function compareVersions(a, b) {
  const toParts = v => String(v || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pa = toParts(a);
  const pb = toParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function manifestUrlFor(cfg) {
  const url = String(cfg.url || '').trim();
  if (!url) return '';
  if (/\/manifest\.json(?:[?#].*)?$/i.test(url)) return url;
  return url.endsWith('/') ? `${url}manifest.json` : `${url}/manifest.json`;
}

async function fetchBuffer(url, capBytes) {
  if (/^file:\/\//i.test(url)) {
    const filePath = fileURLToPath(url);
    const stat = await fs.stat(filePath);
    if (capBytes && stat.size > capBytes) throw new Error('File is too large');
    return fs.readFile(filePath);
  }
  const doFetch = net && typeof net.fetch === 'function' ? net.fetch : global.fetch;
  const res = await doFetch(url, { headers: { 'User-Agent': 'Your-Player-Updater/1' }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const length = Number(res.headers.get('content-length') || 0);
  if (capBytes && length > capBytes) throw new Error('File is too large');
  const bytes = Buffer.from(await res.arrayBuffer());
  if (capBytes && bytes.length > capBytes) throw new Error('File is too large');
  return bytes;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('Manifest is not valid JSON');
  if (typeof manifest.version !== 'string' || !/^\d+(\.\d+)*$/.test(manifest.version)) throw new Error('Manifest has no valid version');
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 64) throw new Error('Manifest has no file list');
  for (const entry of manifest.files) {
    const rel = normalizeRelPath(entry && entry.path);
    if (!isAllowedPath(rel)) throw new Error(`Manifest tried to update a blocked path: ${rel || '(unknown)'}`);
    if (entry.sha256 && !/^[0-9a-fA-F]{64}$/.test(String(entry.sha256))) throw new Error(`Bad checksum for ${rel}`);
    if (entry.url && !/^(https?|file):\/\//i.test(String(entry.url))) throw new Error(`Bad URL for ${rel}`);
  }
}

async function checkForUpdate() {
  const cfg = getConfig();
  const base = {
    currentVersion: app.getVersion(),
    hasSource: cfg.hasSource,
    portable: cfg.portable,
    checkedAt: new Date().toISOString(),
  };
  if (!cfg.hasSource) return { ...base, state: 'no-source' };
  try {
    const manifestUrl = manifestUrlFor(cfg);
    const raw = await fetchBuffer(`${manifestUrl}${manifestUrl.includes('?') ? '&' : '?'}t=${Date.now()}`, MAX_MANIFEST_BYTES);
    const manifest = JSON.parse(raw.toString('utf8'));
    validateManifest(manifest);
    lastManifest = manifest;
    const isNewer = compareVersions(manifest.version, app.getVersion()) > 0;
    return {
      ...base,
      state: isNewer ? 'available' : 'up-to-date',
      latestVersion: manifest.version,
      notes: typeof manifest.notes === 'string' ? manifest.notes.slice(0, 400) : '',
      releaseDate: typeof manifest.releaseDate === 'string' ? manifest.releaseDate : '',
      fileCount: manifest.files.length,
    };
  } catch (error) {
    return { ...base, state: 'error', error: String(error && error.message ? error.message : error).slice(0, 200) };
  }
}

async function downloadUpdate(manifest, onProgress) {
  const stagingRoot = path.join(UPDATES_DIR(), 'staging');
  await fs.rm(stagingRoot, { recursive: true, force: true });
  const versionDir = path.join(stagingRoot, manifest.version);
  const manifestUrl = manifestUrlFor(getConfig());
  const base = manifestUrl.replace(/[?#].*$/, '');
  const entries = [];
  const fileCount = manifest.files.length;
  for (const [index, entry] of manifest.files.entries()) {
    const rel = normalizeRelPath(entry.path);
    if (!isAllowedPath(rel)) throw new Error(`Blocked path in manifest: ${rel}`);
    const url = entry.url ? String(entry.url) : new URL(entry.path, base).href;
    if (onProgress) onProgress({ state: 'downloading', version: manifest.version, percent: Math.round(index / fileCount * 100), file: rel });
    const bytes = await fetchBuffer(url, MAX_FILE_BYTES);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (entry.sha256 && hash !== String(entry.sha256).toLowerCase()) throw new Error(`Checksum mismatch for ${rel}`);
    const target = path.join(versionDir, ...rel.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    entries.push({ path: rel, sha256: hash, size: bytes.length });
  }
  await fs.writeFile(
    path.join(UPDATES_DIR(), 'pending.json'),
    JSON.stringify({ version: manifest.version, stagedAt: new Date().toISOString(), files: entries }, null, 2),
  );
  return entries;
}

function applyFailureMessage(reason, detail) {
  if (reason === 'portable') return 'Portable builds cannot self-update — download the new installer instead.';
  if (reason === 'dev') return 'Updates only apply to installed builds. Set YOUR_PLAYER_ALLOW_DEV_UPDATE=1 to test in development.';
  if (reason === 'error') return detail || 'The update could not be applied.';
  return 'The update could not be applied.';
}

// Swap staged files into the app folder. Backs up every replaced file so a
// failed apply can roll back, and deletes staging only after a clean apply.
async function applyPendingUpdate() {
  const pendingFile = path.join(UPDATES_DIR(), 'pending.json');
  let pending;
  try {
    pending = JSON.parse(await fs.readFile(pendingFile, 'utf8'));
  } catch {
    return { applied: false, reason: 'no-pending' };
  }
  if (!pending || !Array.isArray(pending.files) || !pending.files.length) {
    await fs.rm(pendingFile, { force: true }).catch(() => {});
    return { applied: false, reason: 'invalid-pending' };
  }
  if (process.env.PORTABLE_EXECUTABLE_DIR) return { applied: false, reason: 'portable', version: pending.version };
  if (!app.isPackaged && process.env.YOUR_PLAYER_ALLOW_DEV_UPDATE !== '1') {
    return { applied: false, reason: 'dev', version: pending.version };
  }
  const appRoot = app.getAppPath();
  const stagingRoot = path.join(UPDATES_DIR(), 'staging', pending.version);
  const backupRoot = path.join(UPDATES_DIR(), 'backups', app.getVersion());
  const applied = [];
  try {
    for (const entry of pending.files) {
      const rel = normalizeRelPath(entry.path);
      if (!isAllowedPath(rel)) throw new Error(`Blocked path: ${rel}`);
      const source = path.join(stagingRoot, ...rel.split('/'));
      const bytes = await fs.readFile(source);
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      if (entry.sha256 && hash !== String(entry.sha256).toLowerCase()) throw new Error(`Checksum mismatch for ${rel}`);
      const target = path.join(appRoot, ...rel.split('/'));
      try {
        const current = await fs.readFile(target);
        const backupTarget = path.join(backupRoot, ...rel.split('/'));
        await fs.mkdir(path.dirname(backupTarget), { recursive: true });
        await fs.writeFile(backupTarget, current);
      } catch {}
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
      applied.push(rel);
    }
  } catch (error) {
    for (const rel of applied) {
      try {
        const backup = await fs.readFile(path.join(backupRoot, ...rel.split('/')));
        await fs.writeFile(path.join(appRoot, ...rel.split('/')), backup);
      } catch {}
    }
    return { applied: false, reason: 'error', error: String(error && error.message ? error.message : error), version: pending.version };
  }
  await fs.rm(pendingFile, { force: true }).catch(() => {});
  await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  return { applied: true, version: pending.version, files: applied };
}

async function installLatestUpdate(onProgress) {
  if (busy) return { state: 'error', error: 'An update is already in progress.', currentVersion: app.getVersion() };
  busy = true;
  const send = payload => { try { if (onProgress) onProgress(payload); } catch {} };
  try {
    let manifest = lastManifest && compareVersions(lastManifest.version, app.getVersion()) > 0 ? lastManifest : null;
    if (!manifest) {
      const check = await checkForUpdate();
      if (check.state !== 'available') {
        return { state: check.state, error: check.error || '', latestVersion: check.latestVersion || '', currentVersion: app.getVersion() };
      }
      manifest = lastManifest;
    }
    send({ state: 'downloading', version: manifest.version, percent: 0 });
    await downloadUpdate(manifest, send);
    send({ state: 'applying', version: manifest.version, percent: 100 });
    const result = await applyPendingUpdate();
    if (!result.applied) {
      return { state: 'error', error: applyFailureMessage(result.reason, result.error), version: manifest.version, currentVersion: app.getVersion() };
    }
    return { state: 'applied', version: manifest.version, currentVersion: app.getVersion(), files: result.files };
  } catch (error) {
    return { state: 'error', error: String(error && error.message ? error.message : error).slice(0, 200), currentVersion: app.getVersion() };
  } finally {
    busy = false;
  }
}

function isBusy() {
  return busy;
}

module.exports = {
  getConfig,
  setConfig,
  checkForUpdate,
  installLatestUpdate,
  applyPendingUpdate,
  isBusy,
  compareVersions,
};
