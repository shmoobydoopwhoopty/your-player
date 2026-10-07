'use strict';
// Downloader — yt-dlp powered YouTube search + downloads for Your Player.
// Audio downloads land in the downloads folder and behave like any other song.
// Video downloads land in <downloads folder>\Your Media and play in the Media tab.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv']);
const YOUTUBE_URL_RE = /(?:youtube\.com\/(?:watch\?.*v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/i;
const VIDEO_TOKEN_RE = /(?:^|[?&])v=([\w-]{11})/i;
// yt-dlp's output template names files "Title [dQw4w9WgXcQ].mp4" — pull the id out of that.
const YOUTUBE_FILENAME_ID_RE = /\[([\w-]{11})\](?:\.[a-z0-9]+)?$/i;

const DOWNLOAD_CONCURRENCY = 3;
const SEARCH_TIMEOUT_MS = 45000;
const MAX_SEARCH_RESULTS = 25;
const DOWNLOADS_DIR_NAME = 'Your Player Downloads';
const MEDIA_DIR_NAME = 'Your Media';

function isVideoFile(name) { return VIDEO_EXTENSIONS.has(path.extname(String(name || '')).toLowerCase()); }
function isAudioFile(name) { return AUDIO_EXTENSIONS.has(path.extname(String(name || '')).toLowerCase()); }

function sanitizeFileName(name) {
  const cleaned = String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/&/g, 'and')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'untitled').slice(0, 160).replace(/[ .]+$/, '') || 'untitled';
}

function isPlainYouTubeUrl(input) {
  return /^(https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/|youtu\.be\/)/i.test(String(input || '').trim());
}

function extractYouTubeId(input) {
  const text = String(input || '').trim();
  if (/^[\w-]{11}$/.test(text)) return text;
  const m = text.match(YOUTUBE_URL_RE) || text.match(VIDEO_TOKEN_RE) || text.match(YOUTUBE_FILENAME_ID_RE);
  return m ? m[1] : '';
}

// YouTube cookies collected from the app's sign in window, if any.
let youtubeCookieHeader = '';
function setYouTubeCookies(header) { youtubeCookieHeader = String(header || '').trim(); }
function youtubeCookieArgs() {
  if (!youtubeCookieHeader) return [];
  const cookieFile = path.join(os.tmpdir(), `your-player-cookies-${process.pid}.txt`);
  try {
    const lines = ['# Netscape HTTP Cookie File'];
    for (const pair of youtubeCookieHeader.split('; ')) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) continue;
      lines.push(['.youtube.com', 'TRUE', '/', 'TRUE', '9999999999', name, value].join('\t'));
    }
    fs.writeFileSync(cookieFile, lines.join('\n') + '\n');
    return ['--cookies', cookieFile];
  } catch { return []; }
}

let cachedTools = null;
async function resolveTools() {
  if (cachedTools) return cachedTools;
  const isWin = process.platform === 'win32';
  const probe = async (candidates) => {
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        await fsp.access(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
    return '';
  };
  const which = (cmd) => {
    const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const exts = isWin ? ['.cmd', '.bat', '.exe', '.ps1', ''] : [''];
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = path.join(dir, cmd + ext);
        try { if (fs.existsSync(candidate)) return candidate; } catch {}
      }
    }
    return '';
  };
  const envDir = String(process.env.YOUR_PLAYER_TOOLS_DIR || '').trim();
  const ytCandidates = [
    envDir && path.join(envDir, isWin ? 'yt-dlp.exe' : 'yt-dlp'),
    which('yt-dlp'),
    isWin ? 'C:\\Program Files\\yt-dlp\\yt-dlp.exe' : '/usr/local/bin/yt-dlp',
    isWin ? 'C:\\Program Files (x86)\\yt-dlp\\yt-dlp.exe' : '/usr/bin/yt-dlp',
  ];
  const ffCandidates = [
    envDir && path.join(envDir, isWin ? 'ffmpeg.exe' : 'ffmpeg'),
    which('ffmpeg'),
    isWin ? 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe' : '/usr/local/bin/ffmpeg',
  ];
  const ytDlpPath = await probe(ytCandidates);
  const ffmpegPath = await probe(ffCandidates);
  if (!ytDlpPath) {
    throw new Error('yt-dlp was not found. Install it ("pip install -U yt-dlp" or "winget install yt-dlp") or set YOUR_PLAYER_TOOLS_DIR to its folder.');
  }
  cachedTools = { ytDlpPath, ffmpegPath };
  return cachedTools;
}

function runYtDlpJson(toolPath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(toolPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { child.kill(); } catch {} reject(new Error('yt-dlp timed out')); }
    }, timeoutMs);
    child.stdout.on('data', chunk => { out += chunk; if (out.length > 40 * 1024 * 1024) { try { child.kill(); } catch {} } });
    child.stderr.on('data', chunk => { if (err.length < 20000) err += chunk; });
    child.on('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const last = err.trim().split('\n').filter(Boolean).pop() || `yt-dlp exited with code ${code}`;
        return reject(new Error(last));
      }
      const results = [];
      for (const line of out.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { results.push(JSON.parse(line)); } catch {}
      }
      if (!results.length) {
        try {
          const parsed = JSON.parse(out);
          if (Array.isArray(parsed)) results.push(...parsed);
          else results.push(parsed);
        } catch (error) {
          return reject(new Error(`Could not parse yt-dlp output: ${error.message}`));
        }
      }
      resolve(results);
    });
  });
}

function normalizeEntry(entry) {
  if (!entry) return null;
  const type = entry._type;
  if (type === 'playlist' || type === 'multi_video') {
    const entries = (entry.entries || []).map(normalizeEntry).filter(Boolean);
    return entries.length ? entries : null;
  }
  const id = String(entry.id || '');
  if (!id) return null;
  let thumbnail = entry.thumbnail || '';
  if (!thumbnail && Array.isArray(entry.thumbnails) && entry.thumbnails.length) {
    thumbnail = entry.thumbnails[entry.thumbnails.length - 1].url || '';
  }
  let channel = entry.channel || entry.uploader || entry.uploader_id || '';
  if (/^https?:\/\//i.test(channel)) channel = '';
  return {
    id,
    url: entry.webpage_url || entry.url || `https://www.youtube.com/watch?v=${id}`,
    title: String(entry.title || 'Untitled'),
    channel: String(channel),
    duration: Number.isFinite(entry.duration) ? Number(entry.duration) : null,
    views: Number.isFinite(entry.view_count) ? Number(entry.view_count) : null,
    isLive: Boolean(entry.is_live || entry.live_status === 'is_live'),
    thumbnail,
  };
}

async function searchYouTube(query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return [];
  const { ytDlpPath } = await resolveTools();
  const cookieArgs = youtubeCookieArgs();
  if (isPlainYouTubeUrl(trimmed)) {
    const results = await runYtDlpJson(ytDlpPath, [...cookieArgs, '--no-warnings', '--flat-playlist', '--skip-download', '--dump-json', trimmed], SEARCH_TIMEOUT_MS);
    return results.map(normalizeEntry).flat().filter(Boolean).slice(0, MAX_SEARCH_RESULTS);
  }
  const results = await runYtDlpJson(
    ytDlpPath,
    [...cookieArgs, '--no-warnings', '--flat-playlist', '--skip-download', '--dump-json', `ytsearch${MAX_SEARCH_RESULTS}:${trimmed}`],
    SEARCH_TIMEOUT_MS,
  );
  return results.map(normalizeEntry).flat().filter(Boolean).slice(0, MAX_SEARCH_RESULTS);
}

const SUGGEST_TIMEOUT_MS = 4000;

// Google's public YouTube autocomplete endpoint — no API key needed.
async function fetchYouTubeSuggestions(query) {
  const q = String(query || '').trim();
  if (q.length < 2 || q.length > 80) return [];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUGGEST_TIMEOUT_MS);
    const res = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(q)}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data) || !Array.isArray(data[1])) return [];
    return data[1].map(item => String(item)).filter(Boolean).slice(0, 8);
  } catch {
    return [];
  }
}

async function resolveEntry(url) {
  const { ytDlpPath } = await resolveTools();
  const entries = await runYtDlpJson(ytDlpPath, ['--no-warnings', '--skip-download', '--flat-playlist', '--dump-json', url], SEARCH_TIMEOUT_MS);
  const normalized = entries.map(normalizeEntry).flat().filter(Boolean);
  return normalized.find(item => item.id) || null;
}

const activeDownloads = new Map();
let nextDownloadId = 0;

function parseByteString(text) {
  const m = String(text || '').match(/([\d.]+)\s*(B|KiB|MiB|GiB|TiB|KB|MB|GB|TB)?/i);
  if (!m) return 0;
  const value = parseFloat(m[1]);
  if (!Number.isFinite(value)) return 0;
  const multipliers = { B: 1, KB: 1e3, KIB: 1024, MB: 1e6, MIB: 1024 ** 2, GB: 1e9, GIB: 1024 ** 3, TB: 1e12, TIB: 1024 ** 4 };
  return Math.round(value * (multipliers[(m[2] || 'B').toUpperCase()] || 1));
}

function activeData() {
  const data = [];
  for (const item of activeDownloads.values()) {
    data.push({
      id: item.id, url: item.url, kind: item.kind, title: item.title, channel: item.channel,
      status: item.status, stage: item.stage, percent: item.percent, received: item.received,
      speed: item.speed, eta: item.eta, error: item.error, startedAt: item.startedAt, finishedAt: item.finishedAt,
    });
  }
  return data;
}

function listFilesIn(folder, wantedExtensions) {
  return fsp.readdir(folder, { withFileTypes: true }).then(entries => {
    const results = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!wantedExtensions.has(ext)) continue;
      const full = path.join(folder, entry.name);
      try {
        const stat = fs.statSync(full);
      const baseName = path.basename(entry.name, ext);
      const youtubeId = extractYouTubeId(entry.name);
      results.push({
        id: youtubeId || path.basename(entry.name, ext),
        title: baseName.replace(/\s*\[[\w-]{11}\]\s*$/, '').trim() || baseName,
        path: full,
        filename: entry.name,
        kind: wantedExtensions === VIDEO_EXTENSIONS ? 'video' : 'audio',
        size: stat.size,
        addedAt: stat.mtimeMs,
        url: youtubeId ? `https://www.youtube.com/watch?v=${youtubeId}` : '',
      });
      } catch {}
    }
    return results;
  }).catch(() => []);
}

async function listDownloadsFolder(kind) {
  const root = await getDownloadsRoot();
  const target = kind === 'video' ? path.join(root, MEDIA_DIR_NAME) : root;
  return listFilesIn(target, kind === 'video' ? VIDEO_EXTENSIONS : AUDIO_EXTENSIONS);
}

async function findVideoForYouTubeId(id) {
  if (!id) return null;
  const media = await listDownloadsFolder('video');
  const token = ` [${id}]`;
  return media.find(item => item.filename.includes(token)) || null;
}

async function removeMediaItem(filePath, expectedDir) {
  const absolute = path.resolve(String(filePath || ''));
  if (expectedDir && path.dirname(absolute) !== path.resolve(expectedDir)) {
    throw new Error(`This item is not inside the ${MEDIA_DIR_NAME} folder.`);
  }
  await fsp.unlink(absolute);
  return true;
}

const OUTPUT_PATH_RE = /\.(mp3|m4a|mp4|webm|mkv|opus|ogg|wav|flac)$/i;

function baseYtDlpArgs() {
  return [
    '--no-warnings', '--no-playlist', '--windows-filenames',
    '--no-mtime', '--embed-thumbnail', '--embed-metadata', '--newline',
    '--no-simulate', '--print', 'after_move:filepath',
    '--progress', '--progress-template', 'download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress._total_bytes_estimate_str)s|%(progress.downloaded_bytes)s',
  ];
}

async function findNewestOutput(dir, sinceMs, extensions) {
  let entries = [];
  try { entries = await fsp.readdir(dir); } catch { return ''; }
  let newest = '';
  let newestTime = 0;
  for (const name of entries) {
    if (!extensions.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const stat = await fsp.stat(full);
      if (stat.isFile() && stat.mtimeMs >= sinceMs - 5000 && stat.mtimeMs > newestTime) {
        newest = full;
        newestTime = stat.mtimeMs;
      }
    } catch {}
  }
  return newest;
}

function startDownload(options) {
  return new Promise((resolve, reject) => {
    resolveTools().then(tools => {
      if (!tools.ffmpegPath) {
        throw new Error('ffmpeg was not found. Install it ("winget install Gyan.FFmpeg") — yt-dlp needs it to convert audio and merge videos.');
      }
      const isVideo = options.kind === 'video';
      const outputDir = isVideo ? options.mediaDir : options.audioDir;
      const formatArgs = isVideo
        ? ['-f', 'bv*[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]/b[vcodec^=avc1][height<=1080]/bv*[ext=mp4][height<=1080]+ba/b[height<=1080]/bv*+ba/b', '--merge-output-format', 'mp4']
        : ['-f', 'bestaudio/best', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0'];
      const template = isVideo ? '%(title)s [%(id)s].%(ext)s' : '%(title)s.%(ext)s';
      const args = [...youtubeCookieArgs(), ...baseYtDlpArgs(), '--ffmpeg-location', tools.ffmpegPath, ...formatArgs, '-o', path.join(outputDir, template), options.url];
      const child = spawn(tools.ytDlpPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

      const item = {
        id: `dl-${++nextDownloadId}`,
        url: options.url,
        kind: options.kind,
        title: options.title || options.url,
        channel: options.channel || '',
        status: 'downloading',
        stage: 'Starting…',
        percent: 0,
        received: 0,
        speed: '',
        eta: '',
        error: '',
        filePath: '',
        startedAt: Date.now(),
        finishedAt: null,
        child,
      };
      activeDownloads.set(item.id, item);

      let lastErrorLine = '';
      let settled = false;
      child.on('error', error => {
        if (settled) return;
        settled = true;
        item.status = 'error';
        item.error = error.message;
        item.finishedAt = Date.now();
        reject(error);
      });
      child.stderr.on('data', chunk => {
        for (const line of chunk.toString().split(/\r?\n/)) {
          if (/ERROR:/i.test(line)) lastErrorLine = line.replace(/^.*?ERROR:\s*/i, '').trim().slice(0, 400);
        }
      });
      child.stdout.on('data', chunk => {
        for (const line of chunk.toString().split(/\r?\n/)) {
          if (!line) continue;
          if (line.startsWith('download:')) {
            const [percentPart, speedPart, etaPart, sizePart, receivedPart] = line.slice(9).split('|').map(p => p.trim());
            item.stage = 'Downloading';
            if (percentPart) item.percent = Math.max(0, Math.min(100, parseFloat(percentPart) || 0));
            item.speed = speedPart || '';
            item.eta = etaPart || '';
            item.received = Number(receivedPart) || 0;
            if (sizePart) item.expectedBytes = parseByteString(sizePart);
            if (options.onProgress) options.onProgress(activeData());
          } else if (/^\[(ExtractAudio|Merger|Metadata|EmbedThumbnail|VideoRemuxer)\]/.test(line)) {
            item.stage = isVideo ? 'Merging video and audio…' : 'Converting to MP3…';
            if (options.onProgress) options.onProgress(activeData());
          } else if (!line.startsWith('[') && !line.startsWith('WARNING')) {
            const candidate = line.trim();
            if (OUTPUT_PATH_RE.test(candidate) && path.isAbsolute(candidate)) item.filePath = candidate;
          }
        }
      });
      child.on('close', async code => {
        if (item.status !== 'canceled') {
          item.status = code === 0 ? 'done' : 'error';
          item.percent = code === 0 ? 100 : item.percent;
          item.error = code === 0 ? '' : (lastErrorLine || `yt-dlp exited with code ${code}`);
        }
        item.stage = '';
        item.finishedAt = Date.now();
        if (item.status === 'done' && !item.filePath) {
          item.filePath = await findNewestOutput(outputDir, item.startedAt, OUTPUT_PATH_RE);
        }
        if (options.onProgress) options.onProgress(activeData());
        resolve(item);
      });
    }).catch(reject);
  });
}

const queue = [];
let runningCount = 0;

function pumpQueue() {
  while (runningCount < DOWNLOAD_CONCURRENCY && queue.length) {
    const next = queue.shift();
    runningCount++;
    next.task().then(() => {
      runningCount--;
      pumpQueue();
    }).catch(() => {
      runningCount--;
      pumpQueue();
    });
  }
}

function enqueueDownload(options) {
  return new Promise((resolve, reject) => {
    queue.push({
      task: () => startDownload(options).then(
        item => { resolve(item); },
        error => { reject(error); },
      ),
    });
    pumpQueue();
  });
}

function cancelDownload(id) {
  if (!id) return cancelAllDownloads();
  const item = activeDownloads.get(String(id));
  if (!item || item.status !== 'downloading') return;
  item.status = 'canceled';
  item.stage = '';
  item.finishedAt = Date.now();
  try { item.child && item.child.kill(); } catch {}
}

function cancelAllDownloads() {
  for (const item of activeDownloads.values()) {
    if (item.status === 'downloading') {
      try { item.child && item.child.kill(); } catch {}
      item.status = 'canceled';
      item.stage = '';
      item.finishedAt = Date.now();
    }
  }
}

function guessMusicFolder() {
  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [path.join(home, 'Music'), path.join(home, 'Desktop', 'Music')]
    : [path.join(home, 'Music')];
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isDirectory()) return candidate; } catch {}
  }
  return home;
}

async function getDownloadsRoot() {
  const configured = String(process.env.YOUR_PLAYER_DOWNLOADS_DIR || '').trim();
  if (configured) return configured;
  const music = String(process.env.YOUR_PLAYER_MUSIC_DIR || '').trim() || guessMusicFolder();
  return path.join(music, DOWNLOADS_DIR_NAME);
}

async function getMediaRoot() {
  return path.join(await getDownloadsRoot(), MEDIA_DIR_NAME);
}

async function ensureDirectories() {
  const root = await getDownloadsRoot();
  const media = await getMediaRoot();
  await fsp.mkdir(root, { recursive: true });
  await fsp.mkdir(media, { recursive: true });
  return { root, media };
}

module.exports = {
  setYouTubeCookies,
  resolveTools,
  ensureDirectories,
  getDownloadsRoot,
  getMediaRoot,
  searchYouTube,
  fetchYouTubeSuggestions,
  resolveEntry,
  listDownloadsFolder,
  findVideoForYouTubeId,
  removeMediaItem,
  enqueueDownload,
  activeData,
  cancelDownload,
  cancelAllDownloads,
  isVideoFile,
  isAudioFile,
  sanitizeFileName,
  extractYouTubeId,
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
};
