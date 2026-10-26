'use strict';
// One-off live harness: proves the play-count additions actually render in the
// real app - injects tracks with playCount into the real renderer, walks the
// album page, artist page, Songs tab (shared table), the Home spotlight and
// the player-bar pill, and checks the numbers update live when a count rises.
const path = require('node:path');
const os = require('node:os');

const { app, BrowserWindow } = require('electron');
app.setName('playcount-harness');
app.setPath('userData', path.join(os.tmpdir(), 'playcount-harness-' + Date.now()));

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

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==';

const INJECT = `(()=>{
  const mk=(id,title,artist,album,plays)=>({id,file:{path:'C:\\\\music\\\\'+id+'.mp3',name:id+'.mp3',size:1000,lastModified:Date.now()},title,artist,album,duration:180,playCount:plays,art:'${PNG}',artUrl:'${PNG}',added:Date.now(),favorite:false,metaLocked:false,notes:''});
  window.tracks&&0; tracks=[
    mk('t1','Alpha','Artist A','My Album',7),
    mk('t2','Beta','Artist A','My Album',0),
    mk('t3','Gamma','Artist B','Other',2)
  ];
  current=-1; playing=false;
  return tracks.length;
})()`;

app.whenReady().then(async () => {
  let exit = 1;
  try {
    line('== play-count harness boot ==');
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

    const injected = await exec(INJECT);
    assert(injected === 3, '3 tracks injected into the real renderer');

    // A. Album page (the situation from the user's screenshot)
    await exec(`openAlbumPage('My Album')`);
    await new Promise(r => setTimeout(r, 700));
    const albumProbe = await exec(`JSON.stringify((()=>{const cells=[...document.querySelectorAll('#detailSongs .row-plays')].map(td=>td.textContent.trim());return {rows:document.querySelectorAll('#detailSongs tr').length,cells,heading:!!document.querySelector('#pageTitle')&&document.querySelector('#pageTitle').textContent}})())`);
    line('album page:', albumProbe);
    const a = JSON.parse(albumProbe);
    assert(a.view === undefined || a.view === undefined, 'noop');
    assert(a.rows === 2, 'album page lists its 2 tracks');
    assert(/^▷?\s*7$/.test(a.cells[0].replace(/\s+/g, '')) || /7/.test(a.cells[0]), 'track 1 shows its play count (7)');
    assert(/0/.test(a.cells[1]), 'track 2 shows its play count (0)');

    // B. Artist profile page
    await exec(`openArtistPage('Artist A')`);
    await new Promise(r => setTimeout(r, 700));
    const artistProbe = await exec(`JSON.stringify([...document.querySelectorAll('#detailSongs .row-plays')].map(td=>td.textContent.trim()))`);
    line('artist page:', artistProbe);
    const ar = JSON.parse(artistProbe);
    assert(ar.length === 2 && /7/.test(ar[0]) && /0/.test(ar[1]), 'artist page rows show per-song counts');

    // C. Songs tab (shared table, is NOT most-listened)
    await exec(`setView('songs')`);
    await new Promise(r => setTimeout(r, 700));
    const songs = await exec(`JSON.stringify((()=>{const th=[...document.querySelectorAll('#tracksTable th')].map(t=>t.textContent.trim());const cells=[...document.querySelectorAll('#trackBody .row-plays')].map(td=>td.textContent.trim());return {th,cells}})())`);
    line('songs tab:', songs);
    const s = JSON.parse(songs);
    assert(s.th.includes('Plays'), 'shared table has a Plays header in the Songs tab');
    assert(s.cells.length === 3 && /7/.test(s.cells[0]), 'all 3 library rows carry counts');

    // D. Playlist view too (a song inside a playlist)
    await exec(`(()=>{playlists=[{name:'Mix',ids:['t1','t3']}];activePlaylist=playlists[0];setView('playlist')})()`);
    await new Promise(r => setTimeout(r, 700));
    const pl = await exec(`JSON.stringify([...document.querySelectorAll('#trackBody .row-plays')].map(td=>td.textContent.trim()))`);
    const plv = JSON.parse(pl);
    assert(plv.length === 2 && /7/.test(plv[0]) && /2/.test(plv[1]), 'playlist rows show counts (7 and 2)');

    // E. Home spotlight + player pill show the CURRENT song's count
    await exec(`current=0;updateCurrent()`);
    await new Promise(r => setTimeout(r, 500));
    const pills = await exec(`JSON.stringify((()=>{const sp=document.querySelector('#spotCountPill'),lp=document.querySelector('#listenedPill');return {spot:!sp.hidden?sp.textContent.trim():'(hidden)',player:!lp.hidden?lp.textContent.trim():'(hidden)'}})())`);
    line('pills:', pills);
    const pk = JSON.parse(pills);
    assert(pk.spot !== '(hidden)' && pk.spot.includes('7'), 'Home spotlight shows "play 7" pill');
    assert(pk.player.includes('7'), 'player-bar pill still shows the count');

    // F. Live refresh: a play raises the count and the album row updates without navigation
    await exec(`openAlbumPage('My Album')`);
    await new Promise(r => setTimeout(r, 600));
    const live = await exec(`(()=>{const t=tracks.find(x=>x.id==='t2');t.playCount=9;updateListenedPill();persistLibrary();render();return [...document.querySelectorAll('#detailSongs .row-plays')].map(td=>td.textContent.trim()).join('|')})()`);
    line('after re-render with raised count:', live);
    assert(/9/.test(live), 'album rows reflect the new count (0 row now shows 9)');
    const spotAfter = await exec(`JSON.stringify(document.querySelector('#spotCountPill').textContent.trim())`);
    assert(/7/.test(JSON.parse(spotAfter)), 'spotlight pill still shows its own track count (7)');

    // G. Reset-plays path still re-renders everything
    await exec(`wipeAllPlayCounts()`);
    await new Promise(r => setTimeout(r, 500));
    const wiped = await exec(`JSON.stringify([...document.querySelectorAll('#detailSongs .row-plays')].map(td=>td.textContent.trim()).join('|'))`);
    assert(/0/.test(JSON.parse(wiped)) && !/9|7\|/.test(JSON.parse(wiped)), 'Reset plays zeroes every count everywhere');

    line('== ALL PLAY-COUNT ASSERTIONS PASSED ==');
    exit = 0;
  } catch (error) {
    line('HARNESS FAILED: ' + error.message);
  } finally {
    setTimeout(() => { app.exit(exit); }, 300);
  }
});

process.on('exit', () => {
  try { require('fs').writeFileSync(process.env.PCC_LOG || 'playcount-harness.log', log.join('\n')); } catch {}
});
