'use strict';
// One-off live harness: proves Favorites sorting end to end in the real app.
// Injects favorite tracks + favorite album/artist name lists, then walks the
// real sort menu: Song name (songs section on top), Album name (favorite
// album cards on top), Artist name (favorite artist cards on top), each with
// Ascending + Descending, asserting both the section order and the row/card
// order for every setting.
const path = require('node:path');
const os = require('node:os');

const { app, BrowserWindow } = require('electron');
app.setName('favgsort-harness');
app.setPath('userData', path.join(os.tmpdir(), 'favsort-harness-' + Date.now()));

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
  const mk=(id,title,artist,album,fav)=>({id,file:{path:'C:\\\\music\\\\'+id+'.mp3',name:id+'.mp3',size:1000,lastModified:Date.now()},title,artist,album,duration:180,playCount:0,art:'${PNG}',artUrl:'${PNG}',added:Date.now(),favorite:fav,metaLocked:false,notes:''});
  tracks=[
    mk('t1','Alpha','Mia','B Roads',true),
    mk('t2','Beta','Mia','A Roads',true),
    mk('t3','Gamma','Ava','C Roads',true),
    mk('t4','Notfav','Zed','Z Roads',false)
  ];    favAlbums=['C Roads','A Roads'];
  favArtists=['Mia','Ava'];
  current=-1; playing=false;
  return {n:tracks.length,a:favAlbums.length,r:favArtists.length};
})()`;

// Layout probe: which comes first in the DOM, the collections host or the
// song table; plus ordered texts of headings/cards/rows.
const PROBE = `JSON.stringify((()=>{
  const host=document.querySelector('#favCollectionsHost');
  const table=document.querySelector('#tracksTable');
  const order=host&&table
    ? ((table.compareDocumentPosition(host)&4)?'collections-after-table'
      :((table.compareDocumentPosition(host)&2)?'collections-before-table':'same-node?'))
    : (host?'table-missing':'host-missing');
  const headings=[...(host?host.querySelectorAll('.section-heading h3'):[])].map(h=>h.textContent.trim());
  const albumNames=[...(host?host.querySelectorAll('#favCollectionsHost ~ * .album-grid .album-title,#favCollectionsHost .album-grid .album-title'):[...document.querySelectorAll('.album-grid .album-title')])].map(e=>e.textContent.trim());
  const cardAlbums=host?([...host.querySelectorAll('.album-grid .album-title')].map(e=>e.textContent.trim())):null;
  const cardArtists=host?([...host.querySelectorAll('.artist-grid .artist-name')].map(e=>e.textContent.trim())):null;
  const rows=[...document.querySelectorAll('#trackBody .track-title')].map(e=>e.textContent.trim());
  const label=(document.querySelector('#sortButton')||{}).textContent||'';
  return {order,headings,cardAlbums,cardArtists,rows,label};
})())`;

async function pick(key, dir) {
  // Open the real sort menu and click the items, exactly like a user.
  await exec(`(()=>{const b=document.querySelector('#sortButton');if(b)b.click();'ok'})()`);
  await new Promise(r => setTimeout(r, 250));
  if (key) {
    const r = await exec(`(()=>{const menu=document.querySelector('#artistPhotoMenu');const b=menu&&menu.querySelector('button[data-sort-key="${key}"]');if(!b){return 'NO-KEY'}b.click();return 'ok'})()`);
    if (r !== 'ok') throw new Error('sort key button missing: ' + key + ' got ' + r);
  }
  if (dir) {
    await exec(`(()=>{const b=document.querySelector('#sortButton');if(b)b.click();'ok'})()`);
    await new Promise(r => setTimeout(r, 250));
    const r = await exec(`(()=>{const menu=document.querySelector('#artistPhotoMenu');const b=menu&&menu.querySelector('button[data-sort-dir="${dir}"]');if(!b){return 'NO-DIR'}b.click();return 'ok'})()`);
    if (r !== 'ok') throw new Error('sort dir button missing: ' + dir);
  }
  await new Promise(r => setTimeout(r, 400));
}

app.whenReady().then(async () => {
  let exit = 1;
  try {
    line('== favorites-sort harness boot ==');
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

    const inj = await exec(INJECT);
    line('injected:', inj);
    assert(inj.n === 4 && inj.a === 2 && inj.r === 2, '4 tracks + 2 fav albums + 2 fav artists injected');

    await exec(`setView('favorites')`);
    await new Promise(r => setTimeout(r, 700));

    // Default favorites sort = Song name ascending → songs section on top
    let p = JSON.parse(await exec(PROBE));
    line('default:', JSON.stringify(p));
    assert(p.order === 'collections-after-table', 'with Song name sort the songs table is at the top');
    assert(JSON.stringify(p.rows) === JSON.stringify(['Alpha', 'Beta', 'Gamma']), 'song rows alphabetical ascending (non-favorite excluded)');
    assert(p.cardAlbums.join() === 'A Roads,C Roads', 'album cards alphabetical ascending below');

    // Album name sort → favorite album cards at the top
    await pick('album');
    p = JSON.parse(await exec(PROBE));
    line('album:', JSON.stringify(p));
    assert(p.order === 'collections-before-table', 'with Album name sort the collections are at the top');
    assert(p.headings[0] === 'Favorite albums', 'album section leads the collections block');
    assert(p.cardAlbums.join() === 'A Roads,C Roads', 'album cards alphabetical ascending');
    assert(p.label.includes('Album name'), 'sort button reads Album name');

    // ...and descending reverses both
    await pick(null, 'desc');
    p = JSON.parse(await exec(PROBE));
    line('album desc:', JSON.stringify(p));
    assert(p.cardAlbums.join() === 'C Roads,A Roads', 'album cards descending');
    assert(p.rows.join() === 'Gamma,Alpha,Beta', 'song rows follow album name descending (C,B,A)');

    // Artist name sort → favorite artist cards at the top
    await pick('artist', 'asc');
    p = JSON.parse(await exec(PROBE));
    line('artist:', JSON.stringify(p));
    assert(p.order === 'collections-before-table', 'with Artist name sort the collections are at the top');
    assert(p.headings[0] === 'Favorite artists', 'artist section leads the collections block');
    assert(p.cardArtists.join() === 'Ava,Mia', 'artist cards alphabetical ascending');
    assert(p.rows.join() === 'Gamma,Alpha,Beta', 'song rows follow artist name ascending (Ava group first)');

    // Back to Song name, ascending again
    await pick('title', 'asc');
    p = JSON.parse(await exec(PROBE));
    line('song asc:', JSON.stringify(p));
    assert(p.order === 'collections-after-table', 'with Song name sort the songs table is back on top');
    assert(p.rows.join() === 'Alpha,Beta,Gamma', 'song rows alphabetical ascending');

    line('== ALL FAVORITES-SORT ASSERTIONS PASSED ==');
    exit = 0;
  } catch (error) {
    line('HARNESS FAILED: ' + error.message);
  } finally {
    setTimeout(() => { app.exit(exit); }, 300);
  }
});

process.on('exit', () => {
  try { require('fs').writeFileSync(process.env.FSV_LOG || 'favorites-sort-harness.log', log.join('\n')); } catch {}
});
