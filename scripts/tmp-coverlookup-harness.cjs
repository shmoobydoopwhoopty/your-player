'use strict';
// One-off live harness: proves the "Look up cover" button works - the click
// opens the Google-Images cover lookup modal that used to throw
// "clState is not defined" after the state declaration was lost in a
// refactor. Drives the REAL edit modal and button, then the modal's close.
const path = require('node:path');
const os = require('node:os');

const { app, BrowserWindow } = require('electron');
app.setName('cover-lookup-harness');
app.setPath('userData', path.join(os.tmpdir(), 'cover-lookup-harness-' + Date.now()));

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
  const mk=(id,title,artist,album)=>({id,file:{path:'C:\\\\\\\\music\\\\\\\\'+id+'.mp3',name:id+'.mp3',size:1000,lastModified:Date.now()},title,artist,album,duration:180,playCount:0,art:'${PNG}',artUrl:'${PNG}',added:Date.now(),favorite:false,metaLocked:false,notes:''});
  tracks=[mk('t1','Alpha','Mia','B Roads')];
  current=-1; playing=false;
  return {n:tracks.length};
})()`;

app.whenReady().then(async () => {
  let exit = 1;
  try {
    line('== cover-lookup harness boot ==');
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
    assert(inj.n === 1, 'track injected');

    await exec(`setView('songs')`);
    await new Promise(r => setTimeout(r, 400));

    // Drive the REAL edit modal and its "Look up cover" button.
    await exec(`openEditModal({track:tracks[0],type:'song'})`);
    await new Promise(r => setTimeout(r, 200));
    const pre = JSON.parse(await exec(`(()=>{
      const b=document.getElementById('editArtLookup');
      return JSON.stringify({btnExists:!!b,btnHidden:b?b.hidden:null,declared:typeof clState!=='undefined'});
    })()`));
    assert(pre.btnExists && !pre.btnHidden, 'Look up button exists and is not hidden');
    assert(pre.declared, 'clState is declared again (no undefined reference)');

    const r = await exec(`(()=>{try{document.getElementById('editArtLookup').click();return 'clicked'}catch(e){return 'THREW: '+e.message}})()`);
    assert(r === 'clicked', `button click ran without throwing (got: ${r})`);
    await new Promise(r2 => setTimeout(r2, 600));
    const opened = JSON.parse(await exec(`(()=>{
      const m=document.getElementById('coverLookupModal');
      return JSON.stringify({open:!!(m&&m.classList.contains('open')),phase:clState.phase,hasWebview:!!document.querySelector('#clWebview')});
    })()`));
    assert(opened.open, 'cover lookup modal opened');
    assert(opened.phase === 'web', 'lookup is in web phase');
    assert(opened.hasWebview, 'the Google Images webview is in the modal');
    const title = await exec(`(document.querySelector('#clTitle')||{}).textContent||''`);
    assert(/cover/i.test(title), 'modal shows the cover lookup title');

    // Close via the modal close button.
    await exec(`document.getElementById('clClose').click()`);
    await new Promise(r2 => setTimeout(r2, 300));
    const closed = JSON.parse(await exec(`(()=>{const m=document.getElementById('coverLookupModal');return JSON.stringify({open:!!(m&&m.classList.contains('open'))})})()`));
    assert(closed.open === false, 'lookup modal closes again');

    line('== ALL COVER-LOOKUP ASSERTIONS PASSED ==');
    exit = 0;
  } catch (error) {
    line('HARNESS FAILED: ' + error.message);
  } finally {
    setTimeout(() => { app.exit(exit); }, 300);
  }
});

process.on('exit', () => {
  try { require('fs').writeFileSync(process.env.CLH_LOG || 'cover-lookup-harness.log', log.join('\n')); } catch {}
});
