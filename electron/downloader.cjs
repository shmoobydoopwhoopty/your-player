'use strict';
// Downloader : yt-dlp powered YouTube search + downloads for Your Player.
// Audio downloads land in the downloads folder and behave like any other song.
// Video downloads land in <downloads folder>\Your Media and play in the Media tab.

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv']);
const YOUTUBE_URL_RE = /(?:youtube\.com\/(?:watch\?.*v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/i;
const VIDEO_TOKEN_RE = /(?:^|[?&])v=([\w-]{11})/i;
// yt-dlp's output template names files "Title [dQw4w9WgXcQ].mp4" : pull the id out of that.
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
  // Tools bundled with the installer ship in resources/vendor (packaged) or
  // <repo>/vendor (dev) - checked first so a fresh install just works.
  const bundledDir = path.join(process.resourcesPath || path.join(__dirname, '..'), 'vendor');
  const bundledDevDir = path.join(__dirname, '..', 'vendor');
  const ytCandidates = [
    envDir && path.join(envDir, isWin ? 'yt-dlp.exe' : 'yt-dlp'),
    path.join(bundledDir, isWin ? 'yt-dlp.exe' : 'yt-dlp'),
    path.join(bundledDevDir, isWin ? 'yt-dlp.exe' : 'yt-dlp'),
    which('yt-dlp'),
    isWin ? 'C:\\Program Files\\yt-dlp\\yt-dlp.exe' : '/usr/local/bin/yt-dlp',
    isWin ? 'C:\\Program Files (x86)\\yt-dlp\\yt-dlp.exe' : '/usr/bin/yt-dlp',
  ];
  const ffCandidates = [
    envDir && path.join(envDir, isWin ? 'ffmpeg.exe' : 'ffmpeg'),
    path.join(bundledDir, isWin ? 'ffmpeg.exe' : 'ffmpeg'),
    path.join(bundledDevDir, isWin ? 'ffmpeg.exe' : 'ffmpeg'),
    which('ffmpeg'),
    isWin ? 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe' : '/usr/local/bin/ffmpeg',
  ];
  const fpCandidates = ffCandidates.map(p => p ? p.replace(/ffmpeg(\.exe)?$/i, m2 => /\./.test(m2) ? 'ffprobe.exe' : 'ffprobe') : p);
  const ytDlpPath = await probe(ytCandidates);
  const ffmpegPath = await probe(ffCandidates);
  const ffprobePath = await probe(fpCandidates);
  if (!ytDlpPath) {
    throw new Error('yt-dlp was not found. Install it ("pip install -U yt-dlp" or "winget install yt-dlp") or set YOUR_PLAYER_TOOLS_DIR to its folder.');
  }
  cachedTools = { ytDlpPath, ffmpegPath, ffprobePath };
  return cachedTools;
}

// After the in-app yt-dlp updater swaps the binary, drop the memoized tools so
// the next download actually uses the fresh one.
function resetToolsCache() {
  cachedTools = null;
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

// yt-dlp's output template names files "Title [dQw4w9WgXcQ].mp4" : pull the id out of that.
// YouTube's web search accepts an "sp" filter parameter; EgIQAw== is Filters →
// YouTube Music #albums results (MPRE… browse ids) are proper artist albums.
const PLAYLIST_SEARCH_FILTER = 'EgIQAw%3D%3D';
const MAX_COLLECTION_RESULTS = 12;
const MAX_COLLECTION_TRACKS = 200;

// YouTube Music album search results expose only an MPRE… browse id in flat
// mode (no title/thumbnail) - the real name appears when the album page is
// expanded, hand those cards the browse URL so titles arrive on open.
// Classify what a collection most likely is. YouTube Music album pages carry
// MPREb… ids; uploaded "full album" mixes are just one long video, so they are
// handled as single videos and the UI's audio/MP3 buttons; everything else is a
// plain user playlist.
function looksLikeAlbum(collection) {
  if (collection.source === 'ytmusic' || /^MPRE[\w-]/.test(collection.id)) return true;
  const text = `${collection.title || ''} ${collection.description || ''}`.toLowerCase();
  if (/\[(19|20)\d\d\]/.test(text)) return true;
  // "Full album" in the title of a ≥4-track playlist is an album upload split
  // into tracks; a 1-entry playlist with that phrase is just one long video
  // and should stay a playlist card (expand will show its single video).
  if (!/\b(full[ -]album|official album|album playlist|complete album|album with lyrics)\b/.test(text)) return false;
  const count = collection.trackCount;
  return count == null || count >= 4;
}

// Turn a yt-dlp flat entry into whatever the renderer expects. Playlist-type
// entries become collection cards; ytsearch-style single URLs stay videos.
function normalizeCollection(entry) {
  const id = String(entry.id || '');
  if (!id) return null;
  const listId = listIdFromUrl(entry.url || entry.webpage_url || '');
  const channel = entry.channel || entry.uploader || entry.uploader_id || '';
  const isYtmAlbum = /^MPRE[\w-]/.test(id) || String(entry.url || '').includes('music.youtube.com');
  return {
    id: listId || id,
    kind: 'playlist',
    source: isYtmAlbum ? 'ytmusic' : 'youtube',
    url: entry.url || entry.webpage_url || `https://www.youtube.com/playlist?list=${listId || id}`,
    title: String(entry.title || 'Untitled collection'),
    channel: String(channel && !/^https?:\/\//.test(channel) ? channel : ''),
    trackCount: Number.isFinite(entry.playlist_count) ? entry.playlist_count : null,
    thumbnail: collectionThumb(entry),
    isAlbum: false, // refined by callers that have context
  };
}

function collectionThumb(entry) {
  let thumbnail = entry.thumbnail || '';
  if (!thumbnail && Array.isArray(entry.thumbnails) && entry.thumbnails.length) {
    thumbnail = entry.thumbnails[entry.thumbnails.length - 1].url || '';
  }
  return thumbnail;
}

function listIdFromUrl(url) {
  const m = String(url || '').match(/[?&]list=([\w-]+)/);
  return m ? m[1] : '';
}

// Search YouTube for playlists/browse collections matching a query. Runs a
// video search, a playlist-filtered web search and a YouTube Music album search
// in parallel and interleaves the results so mixed cards feel natural.
async function searchYouTubeCollections(query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return [];
  const { ytDlpPath } = await resolveTools();
  const cookieArgs = youtubeCookieArgs();
  const playlistUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(trimmed)}&sp=${PLAYLIST_SEARCH_FILTER}`;
  const albumsUrl = `https://music.youtube.com/search?q=${encodeURIComponent(trimmed)}#albums`;
  // runYtDlpJson resolves to an array of parsed records - --dump-single-json
  // emits one playlist object, so unwrap [0] and read .entries from there.
  const run = (url, limit) => runYtDlpJson(ytDlpPath, [...cookieArgs, '--no-warnings', '--flat-playlist', '--skip-download', '--dump-single-json', '--playlist-end', String(limit), url], SEARCH_TIMEOUT_MS)
    .then(list => {
      const payload = (Array.isArray(list) ? list[0] : list) || {};
      return Array.isArray(payload.entries) ? payload.entries : [];
    })
    .catch(error => { console.warn('Collection search failed for', url, error.message); return []; });
  const [web, albums] = await Promise.all([
    run(playlistUrl, 10),
    run(albumsUrl, 6),
  ]);
  const collections = [];
  const seen = new Set();
  const push = (entry, isAlbum) => {
    const item = normalizeCollection(entry);
    if (!item || seen.has(item.id)) return;
    seen.add(item.id);
    item.isAlbum = isAlbum || looksLikeAlbum(item);
    collections.push(item);
  };
  for (const entry of albums) {
    if (/^MPRE[\w-]/.test(String(entry.id || '')) && !String(entry.title || '')) {
      // Untitled YTM album stub: fetch its real title/track count cheaply by
      // expanding the album page up front (tracks are not needed yet, but the
      // expanded payload carries the proper name + artwork), cap to keep search
      // snappy.
      try {
        const detail = await expandCollection(String(entry.url || entry.id));
        const info = detail && detail[0];
        if (info && info.tracks && info.tracks.length) {
          const item = normalizeCollection({ ...entry, title: info.title.replace(/^Album - /i, ''), thumbnail: info.tracks[0].thumbnail, playlist_count: info.tracks.length, uploader: info.channel });
          if (item && !seen.has(item.id)) { seen.add(item.id); item.isAlbum = true; collections.push(item); }
        }
      } catch {}
      continue;
    }
    if (String(entry.id || '').startsWith('MPRE') || String(entry.url || '').includes('music.youtube.com')) push(entry, true);
  }
  for (const entry of web) push(entry, false);
  return collections.slice(0, MAX_COLLECTION_RESULTS);
}

// Expand a collection into its individual videos so the UI can download them
// one by one. Album pages come through with per-track titles already; plain
// playlists list flat video entries the same way single searches do.
async function expandCollection(url) {
  const { ytDlpPath } = await resolveTools();
  const payload = await runYtDlpJson(
    ytDlpPath,
    [...youtubeCookieArgs(), '--no-warnings', '--flat-playlist', '--skip-download', '--dump-single-json', '--playlist-end', String(MAX_COLLECTION_TRACKS), url],
    SEARCH_TIMEOUT_MS,
  );
  // --dump-single-json returns one object; expect a playlist container.
  const container = (Array.isArray(payload) ? payload[0] : payload) || {};
  const entryList = Array.isArray(container.entries) ? container.entries : [];
  const collection = {
    id: listIdFromUrl(url) || String(container.id || ''),
    title: String(container.title || 'Collection'),
    channel: String(container.uploader || container.channel || ''),
    isAlbum: /^MPRE[\w-]/.test(String(container.id || '')) || String(url).includes('music.youtube.com') || looksLikeAlbum({ title: container.title, description: '' }),
  };
  const tracks = entryList.map(normalizeEntry).flat().filter(Boolean).slice(0, MAX_COLLECTION_TRACKS);
  return [{ ...collection, tracks }];
}

// ── Playlist → album metadata inference ─────────────────────────────────────
// A pasted playlist link is most likely a full-album upload: the playlist
// title names the release ("Artist – Album (Year)"), the uploader is the
// artist, and each video title looks like "Artist - Song (Official Audio)".
// These pure helpers turn that sketch into real album/artist/song metadata
// the tracks get tagged with, so the sweep lands as a proper album in library.

const JUNK_TITLE_RE = /\b(?:official( (music |lyric(s)? )?(video|audio|visualizer|film))?|music video|lyric(s)? video|lyrics?|video oficial|audio|video|visualizer|full[ -]album|complete album|album playlist|album with lyrics|full[ -]playlist|remaster(ed)?( version)?( (19|20)\d{2})?|hd|hq|4k|explicit|m\/v|mv|topic|sub espa\w+|high quality|premiere galaxia)\b/i;
const JUNK_ONLY_RE = /^(?:\(? ?(?:19|20)\d{2} ?\)?)$/i;

function isJunkGroup(inner) {
  return JUNK_TITLE_RE.test(inner) || JUNK_ONLY_RE.test(inner);
}

// Turn one video title into a bare song name: peel trailing bracket groups
// made of junk words (keeping useful ones like "(feat. Ada Lea)"), drop a
// leading copy of the artist's name, and trim leftover quotes/whitespace.
function cleanSongTitle(rawTitle, artist) {
  const original = String(rawTitle || '').trim();
  let text = original;
  for (;;) {
    const m = text.match(/\s*[\(\[\{]\s*([^\)\]}]{0,80})[\)\]\}]\s*$/);
    if (m && isJunkGroup(m[1])) { text = text.slice(0, m.index).trim(); continue; }
    break;
  }
  if (artist) {
    const escaped = artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp('^' + escaped + '\\s*[-\u2013\u2014|:]\\s*'), '').trim();
  }
  // Un-bracketed junk tails too: "Song - 4K Music Video" loses "4K Music Video".
  let segments = text.split(/\s+[-\u2013\u2014|]\s+/);
  while (segments.length > 1 && isJunkGroup(segments[segments.length - 1])) segments.pop();
  text = segments.join(' - ').trim();
  text = text.replace(/["\u201C\u201D]+/g, '').trim()
    .replace(/\s*[-\u2013\u2014|:]\s*$/, '').trim();
  return text || original || 'Untitled';
}

// Infer album + artist from a playlist title / uploader / track titles.
// Returns { artist, album, year, songs: [ bare song names ] }.
function inferAlbumMeta(rawPlaylistTitle, rawChannel, rawTrackTitles) {
  const trackTitles = (rawTrackTitles || []).map(t => String(t || ''));
  let album = String(rawPlaylistTitle || '').trim()
    .replace(/[\(\[\{]\s*(?:19|20)\d{2}\s*[\)\]\}]/g, ' ') // standalone years
    .replace(/\b(?:full[ -]?album|official album|album playlist|complete album|album with lyrics|full[ -]?playlist|playlist|album|remaster(ed)?|hd|hq|4k|official|audio|video|download)\b/ig, ' ')
    .replace(/\s*[\[\(\{]\s*[\]\)\}]/g, ' ') // brackets emptied by the strip above
    .replace(/["\u201C\u201D]/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/^[-\u2013\u2014|:,.]+/, '').replace(/[-\u2013\u2014|:,.]+$/, '').trim();
  const yearMatch = String(rawPlaylistTitle || '').match(/(?:19|20)\d{2}/);
  const year = yearMatch ? yearMatch[0] : '';

  // 1. "Artist - Topic" uploader channels are YouTube's auto-generated artist
  //    profiles: the strongest artist signal there is.
  let artist = '';
  const channel = String(rawChannel || '').trim();
  if (/-\s*topic$/i.test(channel)) artist = channel.replace(/-\s*topic$/i, '').trim();
  // 2. Over half the track titles starting with the same "X - " prefix means
  //    X is the artist, even if the uploader is some data channel.
  if (!artist && trackTitles.length) {
    const counts = new Map();
    for (const t of trackTitles) {
      const parts = t.split(/\s+[-\u2013\u2014|:]\s+/);
      if (parts.length > 1 && parts[0].trim() && parts[0].trim().length <= 40) {
        const key = parts[0].trim().toLowerCase();
        const hit = counts.get(key) || { count: 0, label: parts[0].trim() };
        hit.count++;
        counts.set(key, hit);
      }
    }
    let best = null;
    for (const hit of counts.values()) if (!best || hit.count > best.count) best = hit;
    const need = Math.max(2, Math.ceil(trackTitles.length * 0.5));
    if (best && best.count >= need) artist = best.label;
  }
  // 3. "Artist - Album" split inside the playlist title itself, unless the
  //    left side is a generic aggregator name ("Various", "Playlist"…).
  if (!artist) {
    const parts = album.split(/\s+[-\u2013\u2014|]\s+/);
    if (parts.length > 1) {
      const candidate = parts[0].trim();
      if (candidate && !/^(?:various(?: artists)?|playlist|compilation|music|full album|best of|topic)$/i.test(candidate)) artist = candidate;
      album = parts.slice(1).join(' - ').trim();
    }
  }
  // 4. The uploader itself, unless it is a generic aggregator name.
  if (!artist && channel && !/^(?:various(?: artists)?|playlist|compilation|music|full album|best of|topic)$/i.test(channel)) {
    artist = channel;
  }
  album = album || String(rawPlaylistTitle || '').trim() || 'Unknown album';
  return {
    artist: artist || 'Unknown artist',
    album,
    year,
    songs: trackTitles.map(t => cleanSongTitle(t, artist || '')),
  };
}

// One IPC-sized call: expand a playlist link into its tracks AND the inferred
// album/artist/song metadata the renderer shows for a quick edit + downloads.
async function playlistAlbumInfo(url) {
  const clean = String(url || '').trim();
  if (!/[?&]list=([\w-]+)/i.test(clean) && !/music\.youtube\.com/i.test(clean) && !/^MPRE[\w-]+$/.test(clean)) {
    throw new Error('Paste a YouTube playlist link: youtube.com/playlist?list=… or a music.youtube.com album link.');
  }
  const lists = await expandCollection(clean);
  const collection = lists && lists[0];
  if (!collection || !Array.isArray(collection.tracks) || !collection.tracks.length) {
    throw new Error('Could not read any tracks from that playlist.');
  }
  const meta = inferAlbumMeta(collection.title, collection.channel, collection.tracks.map(t => t.title));
  const thumbnail = (collection.tracks[0] && collection.tracks[0].thumbnail) || '';
  const tracks = collection.tracks.map((track, index) => ({
    id: track.id,
    url: track.url || `https://www.youtube.com/watch?v=${track.id}`,
    title: track.title,
    channel: track.channel || '',
    duration: track.duration,
    track: index + 1,
    song: meta.songs[index] || track.title,
  }));
  return {
    url: collection.url || clean,
    playlistTitle: collection.title,
    thumbnail,
    isAlbum: Boolean(collection.isAlbum),
    album: meta.album,
    artist: meta.artist,
    year: meta.year,
    trackCount: tracks.length,
    tracks,
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

// Google's public YouTube autocomplete endpoint : no API key needed.
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

// Direct stream URL for in-app previews: the embedded player can no longer be
// used (YouTube's embedder check rejects the app's file:// origin with
// "Error 153"), so previews stream the progressive mp4 via yt-dlp instead -
// same engine and cookies the downloads already use.
async function resolveStreamUrl(url) {
  const { ytDlpPath } = await resolveTools();
  // YouTube's default web client only ships split DASH/HLS streams now; the
  // android client still exposes the muxed 360p mp4 (format 18) that a plain
  // <video> element can play, so try it first, then fall back to any muxed
  // https stream the default client offers.
  const attempts = [
    // Muxed single-file streams only (the in-app preview is a plain <video>
    // element : no DASH/HLS support). YouTube rotates which player clients
    // still expose muxed formats, so walk the ladder: android still ships
    // format 18 (360p mp4), tv/ios/mweb keep working when Google blocks one
    // client, and the default web client is the last resort.
    ['--extractor-args', 'youtube:player_client=android', '-f', '18/b[acodec!=none][vcodec!=none][protocol^=https]'],
    ['--extractor-args', 'youtube:player_client=android', '-f', 'b[acodec!=none][vcodec!=none][protocol^=https]'],
    ['--extractor-args', 'youtube:player_client=tv', '-f', '18/b[acodec!=none][vcodec!=none][protocol^=https]'],
    ['--extractor-args', 'youtube:player_client=tv', '-f', 'b[acodec!=none][vcodec!=none][protocol^=https]'],
    ['--extractor-args', 'youtube:player_client=ios', '-f', 'b[acodec!=none][vcodec!=none][protocol^=https]'],
    ['--extractor-args', 'youtube:player_client=mweb', '-f', 'b[acodec!=none][vcodec!=none][protocol^=https]'],
    ['-f', 'b[acodec!=none][vcodec!=none][protocol^=https]'],
  ];
  let lastError = null;
  // Each attempt is an extra yt-dlp metadata run (~3-8s); a hard timeout keeps
  // the preview spinner from lasting half a minute if the network stalls.
  const ATTEMPT_TIMEOUT_MS = 15000;
  for (const attempt of attempts) {
    try {
      const results = await runYtDlpJson(
        ytDlpPath,
        [...youtubeCookieArgs(), '--no-warnings', '--no-playlist', '--skip-download', ...attempt, '--dump-json', url],
        ATTEMPT_TIMEOUT_MS,
      );
      const urls = results.flatMap(r => [r && r.url, ...(((r && r.requested_formats) || []).map(f => f && f.url))]).filter(Boolean);
      if (urls.length) return urls[0];
    } catch (error) {
      lastError = error;
      const msg = String(error && error.message || error);
      // 'Requested format is not available' just means this client has no muxed
      // stream : keep walking the ladder without remembering a slow timeout.
      if (/Requested format is not available/i.test(msg)) lastError = error;
    }
  }
  throw lastError || new Error('No stream URL found for this video');
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

function ytDlpEscape(s) {
  return String(s || '').replace(/([&\\/])/g, '\\$1');
}
// Naming-dialog metadata. yt-dlp's --replace-in-metadata proved unreliable for
// artist/album on the vendored build, so only the FILENAME is derived here;
// the actual ID3 tagging happens in ffTagOutput() with ffmpeg after the file
// finishes (copy-mode, no re-encode).
function metadataArgs(metadata, isVideo) {
  if (!metadata || typeof metadata !== 'object') return { renameTo: null, tags: null };
  const song = String(metadata.song || '').trim();
  const artist = String(metadata.artist || '').trim();
  const album = String(metadata.album || '').trim();
  const track = Math.max(0, Math.min(999, Number(metadata.track) || 0));
  if (!song && !artist && !album && !track) return { renameTo: null, tags: null };
  const renameTo = `${track ? String(track).padStart(2, '0') + ' - ' : ''}${artist ? artist + ' - ' : ''}${song || 'Unknown title'}`;
  const tags = isVideo ? null : { title: song || null, artist: artist || null, album: album || null, track: track || null };
  return { renameTo, tags };
}

// Rewrite ID3/MP4 tags on a finished download WITHOUT re-encoding. The cover
// art yt-dlp embedded travels through as a copied stream.
function ffTagOutput(ffprobePath, ffmpegPath, filePath, tags) {
  return new Promise(resolve => {
    execFile(ffprobePath, ['-v', 'error', '-show_entries', 'format_tags=title,artist,album,track', '-of', 'json', filePath], (err, stdout) => {
      const existing = (!err && stdout) ? safeJson(stdout) : {};
      const fmtTags = existing.format || {};
      const pick = (key, fallback) => (String(fmtTags[key] || '').trim() || fallback);
      const wantedTitle = tags.title || pick('title', 'Unknown title');
      const wantedArtist = tags.artist || pick('artist', '');
      const wantedAlbum = tags.album;
      const wantedTrack = String(tags.track || '').trim();
      const args = ['-y', '-i', filePath, '-map', '0', '-c', 'copy',
        '-map_metadata', '-1',
        '-metadata', `title=${wantedTitle}`,
        '-metadata', `artist=${wantedArtist}`,
        '-metadata', `album=${wantedAlbum || 'Single'}`,
        '-metadata', wantedTrack ? `track=${wantedTrack}` : 'track=',
        '-id3v2_version', '3'];
      // The temp file must keep a real media extension (mp3/m4a/…) or ffmpeg
      // can't pick a muxer ("Unable to choose an output format for '*.tagtmp'").
      const tmp = filePath.replace(/(\.[A-Za-z0-9]{2,5})$/, '.tagtmp$1');
      execFile(ffmpegPath, [...args, tmp], { windowsHide: true }, err2 => {
        if (err2) return resolve(false);
        fsp.rename(tmp, filePath).then(() => resolve(true)).catch(() => resolve(false));
      });
    });
  });
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

function startDownload(options) {
  return new Promise((resolve, reject) => {
    resolveTools().then(tools => {
      if (!tools.ffmpegPath) {
        throw new Error('ffmpeg was not found. Install it ("winget install Gyan.FFmpeg") - yt-dlp needs it to convert audio and merge videos.');
      }
      const isVideo = options.kind === 'video';
      const outputDir = isVideo ? options.mediaDir : options.audioDir;
      const formatArgs = isVideo
        ? ['-f', 'bv*[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]/b[vcodec^=avc1][height<=1080]/bv*[ext=mp4][height<=1080]+ba/b[height<=1080]/bv*+ba/b', '--merge-output-format', 'mp4']
        : ['-f', 'bestaudio/best', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0'];
      const template = isVideo ? '%(title)s [%(id)s].%(ext)s' : '%(title)s.%(ext)s';
      // Playlist/album downloads can carry the collection's title so the audio
      // gets tagged with the album (yt-dlp's metadata postprocessor reads
      // these --parse-metadata overrides at convert time).
      const metaArgs = !isVideo && options.albumTitle ? [
        '--parse-metadata', `album:(?s)^${String(options.albumTitle).replace(/([&\\/])/g, '\\$1')}$`,
      ] : [];
      // Naming-dialog metadata: explicit song/artist/album/track override the
      // YouTube ones, and the final file gets a friendly name.
      const { renameTo, tags } = metadataArgs(options.metadata, isVideo);
      const args = [...youtubeCookieArgs(), ...baseYtDlpArgs(), '--ffmpeg-location', tools.ffmpegPath, ...formatArgs, ...metaArgs, '-o', path.join(outputDir, template), options.url];
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
        // Naming dialog: tag the file (ffmpeg, copy-mode) then friendly-rename
        // to "NN - Artist - Song". A tag/rename hiccup never fails the download.
        if (item.status === 'done' && renameTo && item.filePath) {
          try {
            if (tags) await ffTagOutput(tools.ffprobePath, tools.ffmpegPath, item.filePath, tags);
            let finalPath = item.filePath;
            try {
              const target = path.join(path.dirname(finalPath), renameTo + path.extname(finalPath));
              let bump = 1;
              let dest = target;
              while (fs.existsSync(dest) && path.resolve(dest) !== path.resolve(finalPath)) {
                dest = path.join(path.dirname(target), `${renameTo} (${bump})${path.extname(target)}`);
                bump++;
              }
              if (path.resolve(dest) !== path.resolve(finalPath)) await fsp.rename(finalPath, dest);
              finalPath = dest;
            } catch { /* keep the original name */ }
            item.filePath = finalPath;
            if (tags) item.title = renameTo;
          } catch { /* keep the original file rather than failing a finished download */ }
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
  searchYouTubeCollections,
  expandCollection,
  playlistAlbumInfo,
  inferAlbumMeta,
  cleanSongTitle,
  setYouTubeCookies,
  resolveTools,
  resetToolsCache,
  ensureDirectories,
  getDownloadsRoot,
  getMediaRoot,
  searchYouTube,
  fetchYouTubeSuggestions,
  resolveEntry,
  resolveStreamUrl,
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
