const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');

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

// The user can rename the app (“Tree” by default) from settings; the renderer
// persists the choice in localStorage and we mirror it for native titles.
const BRAND_KEY = 'treeplayer.brand.v1';
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
const foldersSettingsFile = path.join(app.getPath('userData'), 'tree-folders.json');
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
  'tree player', 'tree-player', 'treeplayer', 'tree media',
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
let treeProgressLastSent = 0;

ipcMain.handle('tree:downloader-init', (_event, payload) => {
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
  if (effectiveDownloads) process.env.TREE_PLAYER_DOWNLOADS_DIR = effectiveDownloads;
  else delete process.env.TREE_PLAYER_DOWNLOADS_DIR;
  if (typeof musicDir === 'string' && musicDir.trim()) {
    process.env.TREE_PLAYER_MUSIC_DIR = musicDir.trim();
  } else {
    try { process.env.TREE_PLAYER_MUSIC_DIR = app.getPath('music'); } catch {}
  }
  return downloader.ensureDirectories();
});

ipcMain.handle('tree:get-downloads-dir', () => {
  const stored = loadStoredFolders();
  return (typeof stored.downloadsDir === 'string' && stored.downloadsDir.trim()) || '';
});

ipcMain.handle('tree:set-downloads-dir', (_event, dir) => {
  const clean = typeof dir === 'string' ? dir.trim() : '';
  const stored = loadStoredFolders();
  if (clean) {
    stored.downloadsDir = clean;
    process.env.TREE_PLAYER_DOWNLOADS_DIR = clean;
  } else {
    delete stored.downloadsDir;
    delete process.env.TREE_PLAYER_DOWNLOADS_DIR;
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

ipcMain.handle('tree:search', async (_event, query) => downloader.searchYouTube(query));
ipcMain.handle('tree:suggest', (_event, query) => downloader.fetchYouTubeSuggestions(query));

ipcMain.handle('tree:download', async (event, payload) => {
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
      if (now - treeProgressLastSent < 250) return;
      treeProgressLastSent = now;
      if (!event.sender.isDestroyed()) event.sender.send('tree:progress', data);
    },
  });
  if (!event.sender.isDestroyed()) event.sender.send('tree:progress', downloader.activeData());
  const result = { id: item.id, kind: item.kind, status: item.status, title: item.title, filePath: item.filePath || '', file: null, error: item.error || '' };
  if (item.status === 'done' && item.kind === 'audio' && item.filePath) {
    result.file = await describeAudioFile(item.filePath);
  }
  return result;
});

ipcMain.handle('tree:active', () => downloader.activeData());
ipcMain.handle('tree:cancel', (_event, id) => downloader.cancelDownload(id || null));
ipcMain.handle('tree:list-media', () => downloader.listDownloadsFolder('video'));
ipcMain.handle('tree:apply-brand', (_event, value) => {
  const clean = typeof value === 'string' ? value.trim().slice(0, 28) : '';
  if (clean) {
    brandPrefix = titleCaseBrandPrefix(clean);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(`${brandPrefix} Player`);
  }
  return brandPrefix || BRAND_FALLBACK_PREFIX;
});
ipcMain.handle('tree:media-url', async (_event, filePath) => {
  const absolutePath = path.resolve(String(filePath || ''));
  const mediaRoot = path.resolve(await downloader.getMediaRoot());
  if (path.dirname(absolutePath) !== mediaRoot) throw new Error(`That video is not part of ${safeBrandPrefix()} Media.`);
  return pathToFileURL(absolutePath).href;
});
ipcMain.handle('tree:media-delete', async (_event, filePath) => downloader.removeMediaItem(filePath, await downloader.getMediaRoot()));

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
