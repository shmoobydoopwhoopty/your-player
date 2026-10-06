const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');

const downloader = require('./downloader.cjs');
const updater = require('./updater.cjs');

const previousUserData = path.join(app.getPath('appData'), 'Afterglow Music Player');
const currentUserData = app.getPath('userData');
if (previousUserData !== currentUserData && !fsSync.existsSync(currentUserData) && fsSync.existsSync(previousUserData)) {
  app.setPath('userData', previousUserData);
}

const audioExtensions = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus', '.webm']);
const trackedFoldersStore = new Set();
const allowedAudioFiles = new Set();
let mainWindow;

// The user can rename the app (“Your” by default) from settings; the renderer
// persists the choice in localStorage and we mirror it for native titles.
const BRAND_KEY = 'yourplayer.brand.v1';
const BRAND_FALLBACK_PREFIX = 'Your';
let brandPrefix = null;
function readBrandFromStorage() {
  try {
    const stored = mainWindow?.webContents?.executeJavaScript(`localStorage.getItem(${JSON.stringify(BRAND_KEY)})`, true);
    if (stored && typeof stored.then === 'function') {
      stored.then(value => {
        const clean = String(value || '').trim().slice(0, 28);
        if (clean) {
          brandPrefix = titleCaseBrandPrefix(clean);
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(`${brandPrefix} Player`);
        }
      }).catch(() => {});
    }
  } catch {}
}
function safeBrandPrefix() {
  return brandPrefix || BRAND_FALLBACK_PREFIX;
}
function titleCaseBrandPrefix(value) {
  return String(value || '')
    .split(/\s+/)
    .map(word => (word ? word.charAt(0).toLocaleUpperCase() + word.slice(1) : ''))
    .join(' ');
}

// Stored folder choices (a dedicated downloads folder, separate from the user's
// music folders) live in a small JSON file in userData.
const foldersSettingsFile = path.join(app.getPath('userData'), 'folders.json');
const legacyFoldersSettingsFile = path.join(app.getPath('userData'), 'tree-folders.json');
try {
  // One-time rename from the old file name; nothing is lost for existing installs.
  if (!fsSync.existsSync(foldersSettingsFile) && fsSync.existsSync(legacyFoldersSettingsFile)) {
    fsSync.renameSync(legacyFoldersSettingsFile, foldersSettingsFile);
  }
} catch {}
function loadStoredFolders() {
  try { return JSON.parse(fsSync.readFileSync(foldersSettingsFile, 'utf8')) || {}; } catch { return {}; }
}
function saveStoredFolders(next) {
  try { fsSync.writeFileSync(foldersSettingsFile, JSON.stringify(next, null, 2)); } catch {}
}
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function addAudioFile(filePath) {
  const absolutePath = path.resolve(filePath);
  allowedAudioFiles.add(absolutePath);
  return absolutePath;
}

async function describeAudioFile(filePath) {
  try {
    const absolutePath = path.resolve(filePath);
    if (!audioExtensions.has(path.extname(absolutePath).toLowerCase())) return null;
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) return null;
    allowedAudioFiles.add(absolutePath);
    return { path: absolutePath, name: path.basename(absolutePath), size: stat.size, lastModified: stat.mtimeMs };
  } catch {
    return null;
  }
}

// Downloaded videos live outside the audio library; this registers them so the
// playable-url handler can serve them to the Media player.
const mediaFileExtensions = new Set([...audioExtensions, '.mp4', '.webm', '.mkv']);

async function describeMediaFile(filePath) {
  try {
    const absolutePath = path.resolve(filePath);
    if (!mediaFileExtensions.has(path.extname(absolutePath).toLowerCase())) return null;
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) return null;
    allowedAudioFiles.add(absolutePath);
    return { path: absolutePath, name: path.basename(absolutePath), size: stat.size, lastModified: stat.mtimeMs };
  } catch {
    return null;
  }
}

const FOLDER_SCAN_LIMIT = 5000;
const FOLDER_DIRECTORY_LIMIT = 15000;
const FOLDER_SCAN_BATCH_SIZE = 100;
const activeFolderScans = new Map();
let nextFolderScanId = 0;
const SKIPPED_FOLDERS = new Set([
  '$recycle.bin', 'system volume information', 'windows', 'program files', 'program files (x86)',
  '.freebuff', '.git', '.github', '.vscode', '.idea', '.cache', 'node_modules',
  'electron', 'release', 'dist', 'build', 'out', 'win-unpacked', 'coverage',
  'your player', 'your-player', 'yourplayer', 'your media',
  'afterglow music player', 'afterglow-player',
]);

async function findAudioFiles(folderPath, onBatch, onProgress, isCanceled) {
  const pending = [folderPath];
  let scannedFolders = 0;
  let scannedEntries = 0;
  let total = 0;
  let batch = [];
  let audioHits = [];
  while (pending.length && total < FOLDER_SCAN_LIMIT && scannedFolders < FOLDER_DIRECTORY_LIMIT && !isCanceled()) {
    const current = pending.pop();
    let directory;
    try {
      directory = await fs.opendir(current);
    } catch {
      continue;
    }
    scannedFolders++;
    onProgress({ total, scannedFolders, scannedEntries, currentFolder: current });
    try {
      for await (const entry of directory) {
        if (isCanceled() || total >= FOLDER_SCAN_LIMIT) break;
        scannedEntries++;
        if (scannedEntries % 250 === 0) onProgress({ total, scannedFolders, scannedEntries, currentFolder: current });
        const directoryName = entry.name.toLowerCase();
        if (directoryName.startsWith('.') || SKIPPED_FOLDERS.has(directoryName)) continue;
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) pending.push(entryPath);
        else if (entry.isFile() && audioExtensions.has(path.extname(entry.name).toLowerCase())) {
          audioHits.push(entryPath);
          if (audioHits.length >= 16) {
            const described = await Promise.all(audioHits.splice(0).map(item => describeAudioFile(item)));
            for (const item of described) {
              if (isCanceled() || total >= FOLDER_SCAN_LIMIT) break;
              if (!item) continue;
              batch.push(item);
              total++;
              if (batch.length >= FOLDER_SCAN_BATCH_SIZE) {
                onBatch(batch);
                batch = [];
              }
            }
            if (total % 50 === 0) onProgress({ total, scannedFolders, scannedEntries, currentFolder: current });
          }
        }
      }
    } catch {
      // Skip a folder that becomes unreadable while it is being scanned.
    }
  }
  if (audioHits.length) {
    const described = await Promise.all(audioHits.splice(0).map(item => describeAudioFile(item)));
    for (const item of described) {
      if (isCanceled() || total >= FOLDER_SCAN_LIMIT) break;
      if (!item) continue;
      batch.push(item);
      total++;
      if (batch.length >= FOLDER_SCAN_BATCH_SIZE) {
        onBatch(batch);
        batch = [];
      }
    }
  }
  if (batch.length) onBatch(batch);
  return { total, scannedFolders, scannedEntries, canceled: isCanceled(), truncated: pending.length > 0 || total >= FOLDER_SCAN_LIMIT || scannedFolders >= FOLDER_DIRECTORY_LIMIT };
}

function dialogParent() {
  return (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : undefined;
}

function createWindow() {
  const windowIcon = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '..', 'build', 'icon.ico');
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0b0d0e',
    title: `${BRAND_FALLBACK_PREFIX} Player`,
    autoHideMenuBar: true,
    frame: false,
    icon: fsSync.existsSync(windowIcon) ? windowIcon : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
  // The renderer owns the document title (brand + now playing); keep the native
  // title in sync with it instead of the default “<file> — Electron” behavior.
  mainWindow.on('page-title-updated', event => event.preventDefault());
  readBrandFromStorage();
  const sendMaximizedState = () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('win:maximized', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', sendMaximizedState);
  mainWindow.on('unmaximize', sendMaximizedState);
  const logRendererProblem = details => {
    const message = `[${new Date().toISOString()}] ${JSON.stringify(details)}\n`;
    fs.appendFile(path.join(app.getPath('userData'), 'your-player-crash.log'), message).catch(() => {});
  };
  mainWindow.webContents.on('render-process-gone', (_event, details) => logRendererProblem({ type: 'render-process-gone', ...details }));
  mainWindow.on('unresponsive', () => logRendererProblem({ type: 'window-unresponsive' }));
  mainWindow.on('responsive', () => logRendererProblem({ type: 'window-responsive' }));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Frameless window controls ───────────────────────────────────────────────
function windowRef() {
  return (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null;
}

ipcMain.on('win:minimize', () => windowRef()?.minimize());
ipcMain.on('win:maximize-toggle', () => {
  const win = windowRef();
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('win:close', () => windowRef()?.close());
ipcMain.handle('win:is-maximized', () => Boolean(windowRef()?.isMaximized()));

ipcMain.handle('afterglow:get-tracked-folders', () => Array.from(trackedFoldersStore));
ipcMain.handle('afterglow:remove-tracked-folder', (_event, folder) => {
  if (typeof folder !== 'string' || !folder) return false;
  const target = path.resolve(folder);
  const deleted = trackedFoldersStore.delete(target);
  if (!deleted) trackedFoldersStore.delete(folder);
  return true;
});

ipcMain.handle('afterglow:choose-audio', async () => {
  const result = await dialog.showOpenDialog(dialogParent(), {
    title: `Add music to ${safeBrandPrefix()} Player`,
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio files', extensions: [...audioExtensions].map(ext => ext.slice(1)) }],
  });
  if (result.canceled) return [];
  return (await Promise.all(result.filePaths.map(describeAudioFile))).filter(Boolean);
});

ipcMain.handle('afterglow:choose-folder', async (event) => {
  const result = await dialog.showOpenDialog(dialogParent(), {
    title: 'Choose a music folder',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true, total: 0, truncated: false };
  const scanId = ++nextFolderScanId;
  trackedFoldersStore.add(path.resolve(result.filePaths[0]));
  const state = { canceled: false, senderId: event.sender.id };
  activeFolderScans.set(scanId, state);
  let preScanned = 0;
  const musicRoot = result.filePaths[0];
  try {
    const summary = await findAudioFiles(musicRoot, batch => {
      preScanned += batch.length;
      if (!event.sender.isDestroyed()) event.sender.send('afterglow:folder-batch', batch);
    }, progress => {
      if (!event.sender.isDestroyed()) event.sender.send('afterglow:folder-progress', { ...progress, preScanned });
    }, () => state.canceled || event.sender.isDestroyed());
    if (!event.sender.isDestroyed()) event.sender.send('afterglow:folder-batch', { done: true, summary: { ...summary, folder: musicRoot } });
    return { ...summary, folder: musicRoot };
  } catch (error) {
    console.error('Music folder scan failed:', error);
    return { total: 0, truncated: false, error: error.message || 'The selected folder could not be scanned.' };
  } finally {
    activeFolderScans.delete(scanId);
  }
});

ipcMain.on('afterglow:cancel-folder', event => {
  for (const state of activeFolderScans.values()) {
    if (state.senderId === event.sender.id) state.canceled = true;
  }
});

let refreshScanActive = false;
ipcMain.handle('afterglow:refresh-files', async (event, folders) => {
  if (!Array.isArray(folders) || !folders.length) return [];
  if (refreshScanActive) return null;
  refreshScanActive = true;
  try {
    const results = [];
    for (const folder of folders) {
      if (typeof folder !== 'string' || !folder) continue;
      try {
        await findAudioFiles(folder, batch => {
          if (batch.length && !event.sender.isDestroyed()) event.sender.send('afterglow:refresh-batch', batch);
        }, () => {}, () => event.sender.isDestroyed());
        results.push(folder);
      } catch {
        // Skip a folder that is temporarily unavailable (e.g. unplugged drive).
      }
    }
    if (!event.sender.isDestroyed()) event.sender.send('afterglow:refresh-done', results);
    return results;
  } finally {
    refreshScanActive = false;
  }
});

ipcMain.handle('afterglow:restore-files', async (_event, paths) => {
  if (!Array.isArray(paths)) return [];
  const results = [];
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = await Promise.all(paths.slice(i, i + 100).filter(item => typeof item === 'string').map(describeAudioFile));
    results.push(...chunk.filter(Boolean));
  }
  return results;
});

ipcMain.handle('afterglow:read-bytes', async (_event, filePath, start, end) => {
  const absolutePath = path.resolve(String(filePath));
  if (!allowedAudioFiles.has(absolutePath)) throw new Error(`This audio file was not selected in ${safeBrandPrefix()} Player.`);
  const stat = await fs.stat(absolutePath);
  const from = Math.max(0, Math.min(stat.size, Number(start) || 0));
  const to = Math.max(from, Math.min(stat.size, Number(end) || from));
  if (to - from > 20 * 1024 * 1024) throw new Error('Audio metadata read exceeded the size limit.');
  const handle = await fs.open(absolutePath, 'r');
  try {
    const bytes = Buffer.alloc(to - from);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, from);
    return Uint8Array.from(bytes.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
});

ipcMain.handle('afterglow:playable-url', (_event, filePath) => {
  const absolutePath = path.resolve(String(filePath));
  if (!allowedAudioFiles.has(absolutePath)) throw new Error(`This audio file was not selected in ${safeBrandPrefix()} Player.`);
  return pathToFileURL(absolutePath).href;
});

// ── Image picker & app logo ──────────────────────────────────────────────────
ipcMain.handle('afterglow:choose-image', async (_event, title) => {
  const result = await dialog.showOpenDialog(dialogParent(), {
    title: typeof title === 'string' && title.trim() ? title.trim() : 'Choose a picture',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  try {
    const bytes = await fs.readFile(result.filePaths[0]);
    if (bytes.length > 25 * 1024 * 1024) return null;
    const ext = path.extname(result.filePaths[0]).toLowerCase().replace('.', '') || 'jpg';
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : ext === 'bmp' ? 'image/bmp' : 'image/jpeg';
    return { path: result.filePaths[0], bytes: Uint8Array.from(bytes), mime, name: path.basename(result.filePaths[0]) };
  } catch {
    return null;
  }
});

const appLogoPath = () => path.join(app.getPath('userData'), 'app-logo');
ipcMain.handle('app-logo:save', async (_event, payload) => {
  const bytes = payload && payload.bytes;
  if (!bytes || !bytes.length || bytes.length > 25 * 1024 * 1024) return null;
  try {
    const target = appLogoPath();
    await fs.writeFile(target, Buffer.from(bytes));
    return { path: target, url: pathToFileURL(target).href };
  } catch {
    return null;
  }
});
ipcMain.handle('app-logo:clear', async () => {
  try { await fs.rm(appLogoPath(), { force: true }); } catch {}
  return true;
});

// ── Artist photos ───────────────────────────────────────────────────────────
// Display-only artist picture lookup: the app searches a public music API for
// the artist's name and caches a photo locally. It never renames files, edits
// tags, or touches artist/album names. A user-chosen picture is stored as a
// separate "custom" file so an online re-lookup can never overwrite it.
const artistImagesDir = path.join(app.getPath('userData'), 'artist-images');
const artistPhotoInFlight = new Map();

function artistPhotoKey(name) {
  return createHash('sha1').update(String(name || '').trim().toLowerCase()).digest('hex');
}

function artistPhotoFilePath(name, custom) {
  return path.join(artistImagesDir, `${artistPhotoKey(name)}${custom ? '.custom' : ''}.jpg`);
}

async function ensureArtistImagesDir() {
  await fs.mkdir(artistImagesDir, { recursive: true });
}

async function fileExists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

function looksLikeImageBuffer(bytes) {
  if (!bytes || bytes.length < 12) return false;
  // JPEG or PNG magic numbers — enough to reject stray HTML/JSON responses.
  return (bytes[0] === 0xff && bytes[1] === 0xd8) || (bytes[0] === 0x89 && bytes[1] === 0x50);
}

async function fetchArtistPhotoBytes(name) {
  const query = encodeURIComponent(String(name || '').trim());
  if (!query) return null;
  const searchRes = await fetch(`https://api.deezer.com/search/artist?q=${query}&limit=5`, { signal: AbortSignal.timeout(10000) });
  if (!searchRes.ok) return null;
  const payload = await searchRes.json().catch(() => null);
  const candidates = Array.isArray(payload?.data) ? payload.data : [];
  if (!candidates.length) return null;
  const lower = String(name || '').trim().toLowerCase();
  const best = candidates.find(item => String(item?.name || '').toLowerCase() === lower)
    || candidates.find(item => String(item?.name || '').toLowerCase().startsWith(lower))
    || candidates[0];
  const imageUrl = best?.picture_xl || best?.picture_big || best?.picture_medium || '';
  if (!imageUrl) return null;
  const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
  if (!imgRes.ok) return null;
  const contentType = String(imgRes.headers.get('content-type') || '');
  if (contentType && !contentType.startsWith('image/')) return null;
  const bytes = Buffer.from(await imgRes.arrayBuffer());
  if (bytes.length < 1024 || bytes.length > 10 * 1024 * 1024 || !looksLikeImageBuffer(bytes)) return null;
  return bytes;
}

async function resolveArtistPhoto(name, { refetch = false } = {}) {
  const customPath = artistPhotoFilePath(name, true);
  const autoPath = artistPhotoFilePath(name, false);
  if (!refetch && await fileExists(customPath)) return pathToFileURL(customPath).href;
  if (!refetch && await fileExists(autoPath)) return pathToFileURL(autoPath).href;
  const cacheKey = `${String(name || '').trim().toLowerCase()}:${refetch ? 'refetch' : 'auto'}`;
  if (artistPhotoInFlight.has(cacheKey)) return artistPhotoInFlight.get(cacheKey);
  const job = (async () => {
    try {
      await ensureArtistImagesDir();
      const bytes = await fetchArtistPhotoBytes(name);
      if (!bytes) return null;
      await fs.writeFile(autoPath, bytes);
      return pathToFileURL(autoPath).href;
    } catch {
      return null;
    } finally {
      artistPhotoInFlight.delete(cacheKey);
    }
  })();
  artistPhotoInFlight.set(cacheKey, job);
  return job;
}

ipcMain.handle('artist-photo:get', (_event, name) => {
  if (typeof name !== 'string' || !name.trim()) return null;
  return resolveArtistPhoto(name);
});

ipcMain.handle('artist-photo:refetch', (_event, name) => {
  if (typeof name !== 'string' || !name.trim()) return null;
  return resolveArtistPhoto(name, { refetch: true });
});

ipcMain.handle('artist-photo:choose-custom', async (_event, name) => {
  if (typeof name !== 'string' || !name.trim()) return null;
  const result = await dialog.showOpenDialog(dialogParent(), {
    title: `Choose a picture for ${name.trim().slice(0, 40)}`,
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  try {
    const bytes = await fs.readFile(result.filePaths[0]);
    if (bytes.length > 25 * 1024 * 1024) return null;
    await ensureArtistImagesDir();
    const target = artistPhotoFilePath(name, true);
    await fs.writeFile(target, bytes);
    return pathToFileURL(target).href;
  } catch {
    return null;
  }
});

ipcMain.handle('artist-photo:remove', async (_event, name) => {
  if (typeof name !== 'string' || !name.trim()) return null;
  const customPath = artistPhotoFilePath(name, true);
  const hadCustom = await fileExists(customPath);
  try { await fs.rm(customPath, { force: true }); } catch {}
  if (hadCustom) {
    // Fall back to the auto-looked-up photo when one is cached.
    if (await fileExists(artistPhotoFilePath(name, false))) return pathToFileURL(artistPhotoFilePath(name, false)).href;
    return null;
  }
  try { await fs.rm(artistPhotoFilePath(name, false), { force: true }); } catch {}
  return null;
});

// ── Downloader & Media ──────────────────────────────────────────────────────
let dlProgressLastSent = 0;

ipcMain.handle('player:downloader-init', (_event, payload) => {
  let musicDir = null;
  let downloadsDir = null;
  if (typeof payload === 'string') musicDir = payload;
  else if (payload && typeof payload === 'object') {
    musicDir = payload.musicDir || null;
    downloadsDir = payload.downloadsDir || null;
  }
  const stored = loadStoredFolders();
  const effectiveDownloads = (typeof downloadsDir === 'string' && downloadsDir.trim())
    || (typeof stored.downloadsDir === 'string' && stored.downloadsDir.trim())
    || '';
  if (effectiveDownloads) process.env.YOUR_PLAYER_DOWNLOADS_DIR = effectiveDownloads;
  else delete process.env.YOUR_PLAYER_DOWNLOADS_DIR;
  if (typeof musicDir === 'string' && musicDir.trim()) {
    process.env.YOUR_PLAYER_MUSIC_DIR = musicDir.trim();
  } else {
    try { process.env.YOUR_PLAYER_MUSIC_DIR = app.getPath('music'); } catch {}
  }
  return downloader.ensureDirectories();
});

ipcMain.handle('player:get-downloads-dir', () => {
  const stored = loadStoredFolders();
  return (typeof stored.downloadsDir === 'string' && stored.downloadsDir.trim()) || '';
});

ipcMain.handle('player:set-downloads-dir', (_event, dir) => {
  const clean = typeof dir === 'string' ? dir.trim() : '';
  const stored = loadStoredFolders();
  if (clean) {
    stored.downloadsDir = clean;
    process.env.YOUR_PLAYER_DOWNLOADS_DIR = clean;
  } else {
    delete stored.downloadsDir;
    delete process.env.YOUR_PLAYER_DOWNLOADS_DIR;
  }
  saveStoredFolders(stored);
  return downloader.ensureDirectories();
});

// Plain directory picker (no scanning, no tracking) — used for the downloads folder.
ipcMain.handle('afterglow:choose-dir', async (_event, title) => {
  const result = await dialog.showOpenDialog(dialogParent(), {
    title: typeof title === 'string' && title.trim() ? title.trim() : 'Choose a folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return '';
  return result.filePaths[0];
});

ipcMain.handle('player:search', async (_event, query) => downloader.searchYouTube(query));
ipcMain.handle('player:suggest', (_event, query) => downloader.fetchYouTubeSuggestions(query));

ipcMain.handle('player:download', async (event, payload) => {
  const url = typeof payload?.url === 'string' ? payload.url.trim() : '';
  if (!url) throw new Error('A video link is required.');
  const kind = payload?.kind === 'video' ? 'video' : 'audio';
  const audioDir = await downloader.getDownloadsRoot();
  const mediaDir = await downloader.getMediaRoot();
  const item = await downloader.enqueueDownload({
    url,
    kind,
    audioDir,
    mediaDir,
    title: typeof payload?.title === 'string' && payload.title.trim() ? payload.title.trim() : url,
    channel: typeof payload?.channel === 'string' ? payload.channel : '',
    onProgress: data => {
      const now = Date.now();
      if (now - dlProgressLastSent < 250) return;
      dlProgressLastSent = now;
      if (!event.sender.isDestroyed()) event.sender.send('player:progress', data);
    },
  });
  if (!event.sender.isDestroyed()) event.sender.send('player:progress', downloader.activeData());
  const result = { id: item.id, kind: item.kind, status: item.status, title: item.title, filePath: item.filePath || '', file: null, error: item.error || '' };
  if (item.status === 'done' && item.kind === 'audio' && item.filePath) {
    result.file = await describeAudioFile(item.filePath);
  }
  return result;
});

ipcMain.handle('player:active', () => downloader.activeData());
ipcMain.handle('player:cancel', (_event, id) => downloader.cancelDownload(id || null));
ipcMain.handle('player:list-media', () => downloader.listDownloadsFolder('video'));
ipcMain.handle('player:get-cookie-header', async () => {
  try {
    const { session } = require('electron');
    const ses = session.fromPartition('persist:youtube-signin');
    const cookies = await ses.cookies.get({ url: 'https://www.youtube.com' });
    const header = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    if (header) downloader.setYouTubeCookies(header);
    return header;
  } catch { return ''; }
});
ipcMain.handle('player:apply-brand', (_event, value) => {
  const clean = typeof value === 'string' ? value.trim().slice(0, 28) : '';
  if (clean) {
    brandPrefix = titleCaseBrandPrefix(clean);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(`${brandPrefix} Player`);
  }
  return brandPrefix || BRAND_FALLBACK_PREFIX;
});
ipcMain.handle('player:media-url', async (_event, filePath) => {
  const absolutePath = path.resolve(String(filePath || ''));
  const mediaRoot = path.resolve(await downloader.getMediaRoot());
  if (path.dirname(absolutePath) !== mediaRoot) throw new Error(`That video is not part of ${safeBrandPrefix()} Media.`);
  return pathToFileURL(absolutePath).href;
});
ipcMain.handle('player:media-delete', async (_event, filePath) => downloader.removeMediaItem(filePath, await downloader.getMediaRoot()));
ipcMain.handle('player:media-list-with-thumbs', async () => {
  const items = await downloader.listDownloadsFolder('video');
  const ytdlp = await resolveYtDlpPathSafely();
  for (const item of items) {
    const id = downloader.extractYouTubeId(item.filename);
    if (id) {
      item.thumbnail = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
      item.id = id;
    } else if (ytdlp) {
      item.thumbnail = await probeEmbeddedThumbnail(ytdlp, item.path);
    }
  }
  return items;
});

let ytDlpPathCache = null;
async function resolveYtDlpPathSafely() {
  if (ytDlpPathCache !== null) return ytDlpPathCache;
  try { ytDlpPathCache = (await downloader.resolveTools()).ytDlpPath; } catch { ytDlpPathCache = ''; }
  return ytDlpPathCache;
}

function probeEmbeddedThumbnail(ytDlpPath, filePath) {
  return new Promise(resolve => {
    const child = spawn(ytDlpPath, ['--no-warnings', '--skip-download', '--print', 'thumbnail', filePath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { if (out.length < 4096) out += chunk; });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out.trim().split(/\r?\n/).filter(l => /^https?:\/\//.test(l)).pop() || ''));
    setTimeout(() => { try { child.kill(); } catch {} resolve(out.trim().split(/\r?\n/).filter(l => /^https?:\/\//.test(l)).pop() || ''); }, 12000);
  });
}

// ── Writing tags back into music files (uses ffmpeg) ────────────────────────
async function runFfmpegTool(args, timeoutMs = 60000) {
  const ffmpeg = (await findFfmpegPath()) || 'ffmpeg';
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('ffmpeg timed out')); }, timeoutMs);
    child.stderr.on('data', chunk => { if (err.length < 8000) err += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `ffmpeg exited with code ${code}`)); });
  });
}

async function findFfmpegPath() {
  const envDir = String(process.env.YOUR_PLAYER_TOOLS_DIR || '').trim();
  const isWin = process.platform === 'win32';
  const candidates = [
    envDir && path.join(envDir, isWin ? 'ffmpeg.exe' : 'ffmpeg'),
    isWin ? 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe' : '/usr/local/bin/ffmpeg',
  ];
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) for (const ext of exts) {
    try { const candidate = path.join(dir, 'ffmpeg' + ext); if (fsSync.existsSync(candidate)) return candidate; } catch {}
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { await fs.access(candidate); return candidate; } catch {}
  }
  return '';
}

const sanitizeTag = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 300);

// ── Trim songs & videos (ffmpeg) ──────────────────────────────────────────
ipcMain.handle('player:trim', async (_event, payload) => {
  const target = path.resolve(String(payload?.path || ''));
  const start = Number(payload?.start);
  const rawEnd = payload?.end;
  const end = rawEnd == null || rawEnd === '' ? null : Number(rawEnd);
  if (!Number.isFinite(start) || start < 0) throw new Error('Invalid start time.');
  if (end != null && (!Number.isFinite(end) || end <= start)) throw new Error('Invalid end time.');
  if (!fs.existsSync(target)) throw new Error('That file no longer exists.');
  const ext = path.extname(target).toLowerCase();
  const videoExtensions = new Set(['.mp4', '.webm', '.mkv']);
  const isAudio = audioExtensions.has(ext);
  const isVideo = videoExtensions.has(ext);
  if (isAudio) {
    if (!allowedAudioFiles.has(target)) throw new Error(`That file is not part of ${safeBrandPrefix()} Player.`);
  } else if (isVideo) {
    const mediaRoot = path.resolve(await downloader.getMediaRoot());
    if (!target.startsWith(mediaRoot)) throw new Error('That video is not part of Your Player Media.');
  } else {
    throw new Error('That file type cannot be trimmed.');
  }
  const ffmpegPath = await findFfmpegPath();
  if (!ffmpegPath) throw new Error('ffmpeg was not found, so trimming is unavailable. Install ffmpeg ("winget install Gyan.FFmpeg").');
  const dir = path.dirname(target);
  const base = path.basename(target, ext);
  let out = path.join(dir, `${base} (trimmed)${ext}`);
  for (let n = 2; fs.existsSync(out); n++) out = path.join(dir, `${base} (trimmed ${n})${ext}`);
  const attempt = async extraArgs => {
    const args = ['-hide_banner', '-y', '-ss', String(start), '-i', target];
    if (end != null) args.push('-t', String(end - start));
    args.push(...extraArgs, out);
    await runFfmpegTool(args, 15 * 60 * 1000);
  };
  try {
    await attempt(['-c', 'copy']);
  } catch (copyError) {
    const fallbackArgs = isVideo
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k']
      : ext === '.mp3' ? ['-c:a', 'libmp3lame', '-b:a', '192k']
      : ext === '.flac' ? ['-c:a', 'flac']
      : ext === '.wav' ? ['-c:a', 'pcm_s16le']
      : ['-c:a', 'aac', '-b:a', '192k'];
    try {
      await attempt(fallbackArgs);
    } catch (encodeError) {
      try { fs.unlinkSync(out); } catch {}
      throw new Error(`ffmpeg could not trim that file — ${String(encodeError?.message || encodeError).slice(0, 140)}`);
    }
  }
  return { ok: true, path: out };
});

ipcMain.handle('tracks:write-tags', async (_event, payload) => {
  const target = path.resolve(String(payload?.path || ''));
  if (!allowedAudioFiles.has(target)) throw new Error(`That file is not part of ${safeBrandPrefix()} Player.`);
  const ffmpegPath = await findFfmpegPath();
  if (!ffmpegPath) throw new Error('ffmpeg was not found, so tags could not be written. Install ffmpeg ("winget install Gyan.FFmpeg").');
  const ext = path.extname(target).toLowerCase();
  if (!audioExtensions.has(ext)) throw new Error('That file type cannot be edited.');
  const tmp = `${target}.your-player-edit.tmp${ext}`;
  const args = ['-y', '-i', target, '-map_metadata', '0', '-id3v2_version', '3'];
  if (typeof payload?.title === 'string' && payload.title.trim()) args.push('-metadata', `title=${sanitizeTag(payload.title)}`);
  if (typeof payload?.artist === 'string' && payload.artist.trim()) args.push('-metadata', `artist=${sanitizeTag(payload.artist)}`);
  if (typeof payload?.album === 'string' && payload.album.trim()) args.push('-metadata', `album=${sanitizeTag(payload.album)}`);
  if (Number.isFinite(Number(payload?.trackNo)) && Number(payload.trackNo) > 0) args.push('-metadata', `track=${Number(payload.trackNo)}`);
  if (ext === '.flac') args.push('-c', 'copy');
  else args.push('-c', 'copy');
  args.push(tmp);
  try {
    await runFfmpegTool(args, 120000);
    await fs.rename(tmp, target);
    return true;
  } catch (error) {
    try { await fs.rm(tmp, { force: true }); } catch {}
    throw error;
  }
});

ipcMain.handle('tracks:write-art', async (_event, payload) => {
  const target = path.resolve(String(payload?.path || ''));
  if (!allowedAudioFiles.has(target)) throw new Error(`That file is not part of ${safeBrandPrefix()} Player.`);
  const ffmpegPath = await findFfmpegPath();
  if (!ffmpegPath) throw new Error('ffmpeg was not found, so the picture could not be written.');
  const ext = path.extname(target).toLowerCase();
  if (!audioExtensions.has(ext)) throw new Error('That file type cannot be edited.');
  const tmp = `${target}.your-player-art.tmp${ext}`;
  let args;
  if (!payload.bytes || !payload.bytes.length) {
    args = ['-y', '-i', target, '-map', '0:a', '-c', 'copy', '-map_metadata', '0', '-id3v2_version', '3', tmp];
  } else {
    const artTmp = `${target}.your-player-art-src.tmp`;
    await fs.writeFile(artTmp, Buffer.from(payload.bytes));
    const mime = String(payload.mime || 'image/jpeg');
    const isPng = mime.includes('png');
    if (ext === '.mp3') {
      args = ['-y', '-i', target, '-i', artTmp, '-map', '0:0', '-map', '1:0', '-c', 'copy', '-id3v2_version', '3', '-metadata:s:v', 'title=Album cover', '-metadata:s:v', `comment=Cover (front)`, tmp];
    } else if (ext === '.flac') {
      args = ['-y', '-i', target, '-i', artTmp, '-map', '0:0', '-map', '1:0', '-c', 'copy', '-disposition:v', 'attached_pic', tmp];
    } else {
      args = ['-y', '-i', target, '-map', '0', '-c', 'copy', '-map_metadata', '0', tmp];
    }
    try { await runFfmpegTool(args, 120000); await fs.rename(tmp, target); }
    catch (error) { try { await fs.rm(tmp, { force: true }); } catch {} throw error; }
    finally { try { await fs.rm(artTmp, { force: true }); } catch {} }
    return true;
  }
  try { await runFfmpegTool(args, 120000); await fs.rename(tmp, target); }
  catch (error) { try { await fs.rm(tmp, { force: true }); } catch {} throw error; }
  return true;
});

// ── Library persistence on disk (survives re-installs and storage resets) ──
function libraryFilePath() { return path.join(app.getPath('userData'), 'library.json'); }

ipcMain.handle('library:load', async () => {
  try { return JSON.parse(fsSync.readFileSync(libraryFilePath(), 'utf8')); } catch { return null; }
});

ipcMain.handle('library:save', async (_event, data) => {
  try {
    const file = libraryFilePath();
    const temp = `${file}.tmp`;
    fsSync.writeFileSync(temp, JSON.stringify(data));
    fsSync.renameSync(temp, file);
    return true;
  } catch { return false; }
});

// ── YouTube sign in (cookies) ────────────────────────────────────────
let ytSignInWindow = null;

function readYouTubeCookieHeader() {
  try {
    const session = ytSignInWindow?.webContents?.session;
    if (!session) return '';
    const cookies = session.cookies.get({ url: 'https://www.youtube.com' });
    return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  } catch { return ''; }
}

ipcMain.handle('youtube:signin', async () => {
  if (ytSignInWindow && !ytSignInWindow.isDestroyed()) { ytSignInWindow.focus(); return { ok: true, signedIn: false, already: true }; }
  ytSignInWindow = new BrowserWindow({
    width: 460, height: 720, show: true, autoHideMenuBar: true,
    title: `Sign in to YouTube for ${safeBrandPrefix()} Player`,
    backgroundColor: '#111111',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'persist:youtube-signin' },
  });
  ytSignInWindow.loadURL('https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.youtube.com%2F&service=youtube');
  ytSignInWindow.once('ready-to-show', () => { try { ytSignInWindow.show(); ytSignInWindow.focus(); } catch {} });
  ytSignInWindow.on('closed', () => { ytSignInWindow = null; });
  return { ok: true, signedIn: false };
});

ipcMain.handle('youtube:signin-status', async () => {
  try {
    const { session } = require('electron');
    const ses = session.fromPartition('persist:youtube-signin');
    const cookies = await ses.cookies.get({ url: 'https://www.youtube.com' });
    const hasLogin = cookies.some(cookie => cookie.name === 'SID' || cookie.name === '__Secure-1PSID' || cookie.name === '__Secure-3PSID');
    return { signedIn: hasLogin, cookieHeader: hasLogin ? cookies.map(c => `${c.name}=${c.value}`).join('; ') : '' };
  } catch { return { signedIn: false, cookieHeader: '' }; }
});

ipcMain.handle('youtube:signout', async () => {
  try {
    const { session } = require('electron');
    const ses = session.fromPartition('persist:youtube-signin');
    const cookies = await ses.cookies.get({});
    for (const cookie of cookies) {
      try { await ses.cookies.remove(`https://${cookie.domain?.replace(/^\./, '') || 'youtube.com'}`, cookie.name); } catch {}
    }
  } catch {}
  return { ok: true };
});

// ── Self-update ─────────────────────────────────────────────────────────────
function pushUpdateStatus(extra = {}) {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!win) return;
  try { win.webContents.send('update:status', { currentVersion: app.getVersion(), ...extra }); } catch {}
}

let updateChecking = false;
async function runUpdateCheck() {
  if (updateChecking || updater.isBusy()) return;
  const cfg = updater.getConfig();
  if (!cfg.hasSource) {
    pushUpdateStatus({ state: 'no-source' });
    return;
  }
  updateChecking = true;
  try {
    pushUpdateStatus({ state: 'checking' });
    const result = await updater.checkForUpdate();
    pushUpdateStatus(result);
  } catch (error) {
    pushUpdateStatus({ state: 'error', error: String(error && error.message ? error.message : error).slice(0, 200) });
  } finally {
    updateChecking = false;
  }
}

ipcMain.handle('update:get-config', () => updater.getConfig());
ipcMain.handle('update:set-config', (_event, partial) => updater.setConfig(partial));
ipcMain.handle('update:check', () => runUpdateCheck());
ipcMain.handle('update:install', async () => {
  const result = await updater.installLatestUpdate(payload => pushUpdateStatus(payload));
  pushUpdateStatus(result);
  return result;
});
ipcMain.on('update:relaunch', () => {
  app.relaunch();
  app.exit(0);
});

app.whenReady().then(async () => {
  // Finish applying an update that was staged but interrupted, before the UI loads.
  try {
    const applied = await updater.applyPendingUpdate();
    if (applied && applied.applied) console.log(`Finished installing update ${applied.version}`);
  } catch {}
  // Restore saved YouTube cookies so the downloader stays signed in.
  try {
    const { session } = require('electron');
    const ses = session.fromPartition('persist:youtube-signin');
    const cookies = await ses.cookies.get({ url: 'https://www.youtube.com' });
    if (cookies.length) downloader.setYouTubeCookies(cookies.map(c => `${c.name}=${c.value}`).join('; '));
  } catch {}
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // Look for updates shortly after launch, then every 30 minutes.
  setTimeout(runUpdateCheck, 10000);
  setInterval(runUpdateCheck, 30 * 60 * 1000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
