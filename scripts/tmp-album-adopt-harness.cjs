'use strict';
// One-off live harness: proves that a song EDITED into an album that already
// has its own cover takes on that album's cover, in the real Electron app.
// Donor blobs get distinct sizes so assertions can prove WHICH sibling the
// cover was borrowed from. Scenarios:
//   A/B  same-album-name group with a single artist → borrows that group's
//        cover from the sibling that actually carries art
//   C  same artist+album sibling is the donor (its blob wins)
const path = require('node:path');
const os = require('node:os');

const { app, BrowserWindow } = require('electron');
app.setName('album-adopt-harness');
app.setPath('userData', path.join(os.tmpdir(), 'album-adopt-harness-' + Date.now()));

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
  const mk=(id,title,artist,album,blobSize)=>({id,file:{path:'C:\\\\\\\\music\\\\\\\\'+id+'.mp3',name:id+'.mp3',size:1000,lastModified:Date.now()},title,artist,album,duration:180,playCount:0,art:'${PNG}',artUrl:'${PNG}',artFullBlob:new Blob([new Uint8Array(blobSize)],{type:'image/png'}),added:Date.now(),favorite:false,metaLocked:false,notes:''});
  const plain=(id,title,artist,album)=>{const t=mk(id,title,artist,album,0);t.artUrl=null;t.art=null;t.artFullBlob=null;return t};
  tracks=[
    mk('t1','Alpha','Mia','B Roads',11),
    mk('t2','Beta','Mia','B Roads',12),
    mk('t3','Gamma','Zed','Q Roads',22),
    plain('t4','Notfav','Zed','Q Roads'),
    mk('t5','Song-E','Kit','R Roads',31),
    mk('t6','Song-F','Kit','R Roads',32),
    mk('t7','Song-G','Mia','C Roads',33)
  ];
  current=-1; playing=false;
  return {n:tracks.length, e:typeof adoptAlbumArtwork};
})()`;

// Move a track's album through the REAL edit modal save path.
async function moveAlbum(trackIdx, newAlbum) {
  await exec(`openEditModal({track:tracks[${trackIdx}],type:'song'})`);
  await exec(`(()=>{const f=document.getElementById('editAlbum');if(!f)throw new Error('editAlbum missing');f.value='${newAlbum}';return 'ok'})()`);
  await new Promise(r => setTimeout(r, 200));
  await exec(`(()=>{const b=document.getElementById('editSave');if(!b)throw new Error('editSave missing');b.click();return 'ok'})()`);
  // Save does tag-write IPC + adoption + persistence; give it room.
  await new Promise(r => setTimeout(r, 900));
}

function probe(idx) {
  return `(()=>{
    const t=tracks[${idx}];
    return JSON.stringify({
      title:t.title, album:t.album, artist:t.artist,
      artUrl:t.artUrl, art:t.art,
      isPlaceholderArt:(t.art||'').startsWith('data:image/svg+xml'),
      fullChecked:!!t.artFullChecked,
      blobSize:(t.artFullBlob&&t.artFullBlob.size)||0
    });
  })()`;
}

app.whenReady().then(async () => {
  let exit = 1;
  try {
    line('== album-adopt harness boot ==');
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
    line('injected:', JSON.stringify(inj));
    assert(inj.n === 7 && inj.e === 'function', '7 tracks injected, adoptAlbumArtwork defined');

    await exec(`setView('songs')`);
    await new Promise(r => setTimeout(r, 500));

    // ── A + B: t5 (Kit) joins 'Q Roads' ──
    // The Q Roads album-name group belongs to Zed alone (single artist), so
    // the donor is t3 Gamma (its blob is size 22).
    await moveAlbum(4, 'Q Roads');
    const a = JSON.parse(await exec(probe(4)));
    assert(a.album.toLowerCase() === 'q roads', 'A: moved into Q Roads');
    assert(a.artUrl.startsWith('blob:') && a.art === a.artUrl, 'A: shows the adopted album cover');
    assert(a.blobSize === 22, `A: borrowed t3's cover (blob 22), got ${a.blobSize}`);
    assert(a.fullChecked, 'A: full-art flag set so the cover survives restart');

    // t6 (Kit) joins 'B Roads': group is single-artist (Mia) → donor t1 (11).
    await moveAlbum(5, 'B Roads');
    const b = JSON.parse(await exec(probe(5)));
    assert(b.album.toLowerCase() === 'b roads', 'B: moved into B Roads');
    assert(b.artUrl.startsWith('blob:'), 'B: adopted blob cover URL');
    assert(b.blobSize === 11, `B: borrowed the Mia-t1 cover (blob 11), got ${b.blobSize}`);

    // ── C: same artist+album sibling is the donor ──
    // t7 (Mia) joins 'B Roads' where its own artist's sibling lives.
    await moveAlbum(6, 'B Roads');
    const c = JSON.parse(await exec(probe(6)));
    assert(c.artUrl.startsWith('blob:'), 'C: adopted a cover');
    assert(c.blobSize === 11, `C: took the artist sibling t1 cover (blob 11), got ${c.blobSize}`);

    // ── D: restore-like state ──
    // t8 joins an album whose only shared cover exists as an object URL on
    // the donors, with the donor's blob stored under its own art id (no
    // artFullBlob on the object) - the exact shape restored libraries have.
    const dSetup = 'noop';
    void dSetup;
    await exec(`(()=>{
      const mk=(id,title,artist,album)=>({id,file:{path:'C:\\\\music\\\\'+id+'.mp3',name:id+'.mp3',size:1000,lastModified:Date.now()},title,artist,album,duration:180,playCount:0,added:Date.now(),favorite:false,metaLocked:false,notes:''});
      const d1=mk('d1','Dawn','Ray','Dawn Road');
      tracks.push(d1);
      const blob=new Blob([new Uint8Array(44)],{type:'image/jpeg'});
      window.__dawnBlob=blob;
      d1.artUrl=URL.createObjectURL(blob);d1.art=d1.artUrl;
      artPut('d1',blob);
      artPutFull('d1',blob);
      return 'donor-ready';
    })()`);
    await exec(`(()=>{
      const mk=(id,title,artist,album)=>({id,file:{path:'C:\\\\music\\\\'+id+'.mp3',name:id+'.mp3',size:1000,lastModified:Date.now()},title,artist,album,duration:180,playCount:0,added:Date.now(),favorite:false,metaLocked:false,notes:''});
      const own=mk('d2','Diner','Ray','Other Side');
      own.artFullBlob=new Blob([new Uint8Array(7)],{type:'image/jpeg'});
      own.artUrl=URL.createObjectURL(own.artFullBlob);own.art=own.artUrl;
      tracks.push(own);
      return 'mover-ready'
    })()`);
    await moveAlbum(7, 'Dawn Road');
    const d = JSON.parse(await exec(probe(7)));
    assert(d.album.toLowerCase() === 'dawn road', 'D: moved into Dawn Road');
    assert(d.artUrl.startsWith('blob:') && d.blobSize === 44, `D: adopted the Donor Dawn cover (blob 44), got ${d.blobSize}`);

    line('== ALL ALBUM-ADOPT ASSERTIONS PASSED ==');
    exit = 0;
  } catch (error) {
    line('HARNESS FAILED: ' + error.message);
  } finally {
    setTimeout(() => { app.exit(exit); }, 300);
  }
});

process.on('exit', () => {
  try { require('fs').writeFileSync(process.env.ADH_LOG || 'album-adopt-harness.log', log.join('\n')); } catch {}
});
