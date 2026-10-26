'use strict';
// One-off live harness: proves the Playlist downloader tab end to end in the
// real Electron build - the real preload bridge and the real renderer code,
// with canned main-process responses so the run needs no network:
//   player:playlist-info → a plausible full-album playlist payload
//   player:download      → instant success, and records every payload
// The harness then drives the actual UI: navigate to the tab, paste a link,
// fetch, check the inferred album/artist/song names, edit two song names,
// rename the album, download all, and assert every download call carried the
// right metadata and every row settled green.
const path = require('node:path');
const os = require('node:os');

const { app, BrowserWindow, ipcMain } = require('electron');
app.setName('pdl-harness');
app.setPath('userData', path.join(os.tmpdir(), 'pdl-harness-' + Date.now()));

const CANNED_PL = {
  url: 'https://www.youtube.com/playlist?list=PLffffffffffOKCOMPUTER',
  playlistTitle: 'RADIOHEAD - OK COMPUTER (1997) [FULL ALBUM]',
  thumbnail: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==',
  isAlbum: true,
  album: 'OK Computer',
  artist: 'Radiohead',
  year: '1997',
  trackCount: 3,
  tracks: [
    { id: 'vid1', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', title: 'Karma Police (2016 Remastered Version)', channel: '', duration: 266, track: 1, song: 'Karma Police' },
    { id: 'vid2', url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', title: 'No Surprises - Official Audio', channel: '', duration: 229, track: 2, song: 'No Surprises' },
    { id: 'vid3', url: 'https://www.youtube.com/watch?v=ccccccccccc', title: 'Airbag (feat. Ambient breeze intro)', channel: '', duration: 285, track: 3, song: 'Airbag (feat. Ambient breeze intro)' },
  ],
};
const downloadCalls = [];

// Canned main-process handlers (the renderer only sees these through the
// real preload bridge, exactly like a live run).
ipcMain.handle('player:playlist-info', async (_event, url) => {
  if (!/playlist\?list=/.test(String(url))) throw new Error('not a playlist link');
  return CANNED_PL;
});
ipcMain.handle('player:download', async (_event, payload) => {
  downloadCalls.push(payload);
  return { id: 'dl-x-' + downloadCalls.length, kind: payload.kind, status: 'done', title: payload.title, filePath: '/tmp/x.mp3', file: { path: '/tmp/x.mp3' }, error: '' };
});
ipcMain.handle('player:active', () => []);
ipcMain.handle('player:progress', () => {});
ipcMain.handle('player:get-downloads-dir', async () => os.tmpdir());
ipcMain.handle('afterglow:restore-files', async (_event, paths) => {
  return (paths || []).map(() => ({ path: String(paths[0]), name: 'x' }));
});

let win = null;
const log = [];
function line(...a) { const s = a.join(' '); log.push(s); console.log(s); }
function assert(cond, what) {
  line(cond ? 'PASS' : 'FAIL', '-', what);
  if (!cond) throw new Error('assertion failed: ' + what);
}
async function exec(code, ms = 30000) {
  try {
    return await Promise.race([
      win.webContents.executeJavaScript(code, true),
      new Promise((_, reject) => setTimeout(() => reject(new Error('exec timeout')), ms)),
    ]);
  } catch (e) {
    line('exec error for [' + String(code).slice(0, 120) + ']:', (e && e.message) || String(e));
    throw e;
  }
}
async function waitFor(fn, what, ms = 45000) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await exec(`JSON.stringify((${fn})())`); if (typeof v === 'string') v = JSON.parse(v); } catch {}
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what);
    await new Promise(r => setTimeout(r, 500));
  }
}

app.whenReady().then(async () => {
  let exit = 1;
  try {
    line('== playlist-dl harness boot ==');
    win = new BrowserWindow({
      show: false, width: 1400, height: 900,
      webPreferences: {
        preload: path.join(__dirname, '..', 'electron', 'preload.cjs'),
        contextIsolation: true, nodeIntegration: false, webviewTag: true,
      },
    });
    await win.loadFile(path.join(__dirname, '..', 'index.html'));
    await waitFor(`()=>typeof window.setView==='function'&&!!document.querySelector('#workspace')`, 'renderer boot');
    line('renderer booted');

    // A. The tab exists in the sidebar and proxies the playlist API.
    const bridge = await exec(`JSON.stringify({tab:!!document.querySelector('.nav-btn[data-view="playlistdl"]'),api:typeof (window.afterglowDesktop&&window.afterglowDesktop.playlistInfo)})`);
    line('bridge:', bridge);
    const b = JSON.parse(bridge);
    assert(b.tab, 'sidebar has a Playlist downloader tab');
    assert(b.api === 'function', 'desktop.playlistInfo is exposed');

    // B. Open the tab through the real sidebar button.
    await exec(`(()=>{document.querySelector('.nav-btn[data-view="playlistdl"]').click();'ok'})()`);
    await new Promise(r => setTimeout(r, 700));
    const opened = await exec(`JSON.stringify({view:document.body.dataset.view,heading:document.querySelector('#pageTitle')&&document.querySelector('#pageTitle').textContent,input:!!document.querySelector('#pdlUrlInput'),btn:!!document.querySelector('#pdlFetchBtn')})`);
    line('tab opened:', opened);
    const o = JSON.parse(opened);
    assert(o.view === 'playlistdl', 'sidebar button opens the playlistdl view');
    assert(o.heading === 'Playlist downloader', 'page title reads Playlist downloader');
    assert(o.input && o.btn, 'link input + fetch button rendered');

    // C. An invalid link fails with a toast, no network, no preview.
    await exec(`(()=>{const i=document.querySelector('#pdlUrlInput');i.value='c:\\\\not a link';document.querySelector('#pdlFetchBtn').click();'ok'})()`);
    await new Promise(r => setTimeout(r, 900));
    const badToast = JSON.parse(await exec(`JSON.stringify([...document.querySelectorAll('.toast,#toast,[class*=toast]')].some(e=>/Could not read/i.test(e.textContent||'')))`));
    assert(badToast, 'a bad link surfaces a friendly error toast');
    await exec(`(()=>{const b=document.querySelector('#pdlBody');if(b)b.innerHTML='';'ok'})()`);

    // D. Fetch a legit playlist link through the real handler.
    await exec(`(()=>{const i=document.querySelector('#pdlUrlInput');i.value='https://www.youtube.com/playlist?list=PLffffffffffOKCOMPUTER';document.querySelector('#pdlFetchBtn').click();'ok'})()`);
    await waitFor(`()=>document.querySelector('#pdlAlbumInput')&&document.querySelectorAll('.pdl-song-input').length===3`, 'preview rendered');
    await new Promise(r => setTimeout(r, 900));
    const preview = await exec(`JSON.stringify({album:document.querySelector('#pdlAlbumInput').value,artist:document.querySelector('#pdlArtistInput').value,songs:[...document.querySelectorAll('.pdl-song-input')].map(e=>e.value),cover:!!document.querySelector('.pdl-cover')&&document.querySelector('.pdl-cover').style.visibility!=='hidden',dlBtn:!!document.querySelector('#pdlDownloadAllBtn')})`);
    line('preview:', preview);
    const p = JSON.parse(preview);
    assert(p.album === 'OK Computer', 'album name prefilled from the inferred metadata');
    assert(p.artist === 'Radiohead', 'artist prefilled');
    assert(p.songs[0] === 'Karma Police', 'song 1 stripped of its remaster junk');
    assert(p.songs[1] === 'No Surprises', 'song 2 stripped of its official-audio junk');
    assert(p.songs[2].startsWith('Airbag (feat'), 'useful (feat…) credit kept');
    assert(p.cover, 'playlist cover art shows');
    assert(p.dlBtn, 'Download album button present');

    // E. User edits: album name + one song name, then downloads.
    await exec(`(()=>{const a=document.querySelector('#pdlAlbumInput');a.value='OK Computer (Deluxe)';a.dispatchEvent(new Event('change'));const s=document.querySelectorAll('.pdl-song-input')[1];s.value='No Surprises (Fixed Name)';s.dispatchEvent(new Event('change'));'ok'})()`);
    await new Promise(r => setTimeout(r, 300));
    await exec(`(()=>{document.querySelector('#pdlDownloadAllBtn').click();'ok'})()`);
    await waitFor(`()=>{const s=[...document.querySelectorAll('.pdl-state')];return s.length===3&&s.every(e=>/Saved/.test(e.textContent))}`, 'all rows saved');
    await new Promise(r => setTimeout(r, 600));

    line('download calls:', JSON.stringify(downloadCalls.map(c => ({ url: c.url, metadata: c.metadata, albumTitle: c.albumTitle }))));
    assert(downloadCalls.length === 3, 'exactly 3 audio downloads were queued');
    const byUrl = new Map(downloadCalls.map(c => [c.url, c]));
    const d1 = byUrl.get('https://www.youtube.com/watch?v=aaaaaaaaaaa');
    const d2 = byUrl.get('https://www.youtube.com/watch?v=bbbbbbbbbbb');
    const d3 = byUrl.get('https://www.youtube.com/watch?v=ccccccccccc');
    assert(!!d1 && !!d2 && !!d3, 'each playlist track got its own download call');
    assert(d1.kind === 'audio', 'downloads are audio');
    assert(d1.metadata.song === 'Karma Police' && d1.metadata.track === 1, 'track 1 tagged song+number');
    assert(d2.metadata.song === 'No Surprises (Fixed Name)', 'edited song name wins');
    assert(d3.metadata.song.startsWith('Airbag') && d3.metadata.track === 3, 'track 3 tagged');
    assert(d1.metadata.album === 'OK Computer (Deluxe)' && d2.metadata.artist === 'Radiohead', 'edited album + artist tag applied to every file');
    assert(d1.albumTitle === 'OK Computer (Deluxe)', 'album title rides along for yt-dlp metadata');
    assert(d1.metadata.track === 1 && d2.metadata.track === 2 && d3.metadata.track === 3, 'sequential track numbers');

    const doneNote = await exec(`(()=>{const n=document.querySelector('#pdlDoneNote');return n&&!n.hidden?n.querySelector('span').textContent:''})()`);
    line('done note:', doneNote);
    assert(/All 3 tracks saved/.test(String(doneNote)), 'completion note shows with the album name');

    line('== ALL PLAYLIST-DL ASSERTIONS PASSED ==');
    exit = 0;
  } catch (error) {
    line('HARNESS FAILED: ' + error.message);
  } finally {
    setTimeout(() => { app.exit(exit); }, 300);
  }
});

process.on('exit', () => {
  try { require('fs').writeFileSync(process.env.PDL_LOG || 'playlist-dl-harness.log', log.join('\n')); } catch {}
});
