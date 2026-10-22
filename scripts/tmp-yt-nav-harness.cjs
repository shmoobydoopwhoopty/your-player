'use strict';
// One-off live harness: verifies the Downloader tab's new browser-style
// Back/Forward arrows actually navigate the embedded YouTube webview.
// Runs with its own userData dir + entrypoint so the real app's
// single-instance lock never blocks it.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { app, BrowserWindow } = require('electron');
app.setName('yt-nav-harness');
app.setPath('userData', path.join(os.tmpdir(), 'yt-nav-harness-' + Date.now()));

let win = null;
const log = [];
function line(...a) { const s = a.join(' '); log.push(s); console.log(s); }

async function exec(code) {
  return win.webContents.executeJavaScript(code, true);
}

async function waitFor(fn, what, ms = 45000) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await exec(`(${fn})()`); } catch {}
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what);
    await new Promise(r => setTimeout(r, 500));
  }
}

app.whenReady().then(async () => {
  let exit = 1;
  try {
    line('== harness boot ==');
    win = new BrowserWindow({
      show: false,
      width: 1400, height: 900,
      webPreferences: {
        preload: path.join(__dirname, '..', 'electron', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: true,
      },
    });
    await win.loadFile(path.join(__dirname, '..', 'index.html'));
    line('index.html loaded');

    // Wait until the renderer has booted far enough to expose setView/render.
    await waitFor(`()=>typeof window.setView==='function'&&!!document.querySelector('#workspace')`, 'renderer boot');
    line('renderer booted');

    // Open the Downloader tab with the real desktop bridge present.
    // (Retry loop: setView + settle, since the first tick can race the render.)
    let struct = null;
    for (let i = 0; i < 10 && !struct; i++) {
      struct = await exec(`(async()=>{let caught=null;try{if(typeof window['setView']!=='function'){}setView('downloader')}catch(e){caught=String(e&&e.stack||e)}await new Promise(r=>setTimeout(r,600));const q=s=>document.querySelector(s);return {nav:!!q('#dlYtNav'),back:!!q('#dlYtBack'),fwd:!!q('#dlYtFwd'),backDisabled:q('#dlYtBack')?.disabled??null,fwdDisabled:q('#dlYtFwd')?.disabled??null,v:window['view'],caught,areaLen:(document.querySelector('#collectionArea')||{innerHTML:''}).innerHTML.length,areaHead:(document.querySelector('#collectionArea')||{innerHTML:''}).innerHTML.slice(0,80)}})()`);
      line('struct attempt '+i+': '+JSON.stringify(struct));
      if (struct && struct.back) break;
      if (!struct || !struct.back) struct = null;
    }
    if (!struct) throw new Error('Downloader view never rendered the nav toolbar');
    line('toolbar present:', JSON.stringify(struct));
    if (!struct.nav || !struct.back || !struct.fwd) throw new Error('nav toolbar missing from Downloader view');
    if (!struct.backDisabled || !struct.fwdDisabled) throw new Error('arrows should start disabled with no history');

    // Wait for the persistent webview to actually load youtube.com.
    await waitFor(`()=>{const w=document.getElementById('dlYtPersistentView');return w&&!w.hidden&&w.getURL&&/^https:\\/\\/www\\.youtube\\.com\\/?$/.test(w.getURL())}`, 'youtube home loaded');
    line('youtube home loaded in webview');

    // Search for something (pushes /results into webview history).
    await exec(`(()=>{const w=document.getElementById('dlYtPersistentView');w.loadURL('https://www.youtube.com/results?search_query=lofi+hip+hop');'ok'})()`);
    await waitFor(`()=>{const u=document.getElementById('dlYtPersistentView')?.getURL?.()||'';return u.includes('results?search_query')}`, 'search results page');

    // Open a plain navigable watch page (no autoplays into more URLs).
    await exec(`(()=>{const w=document.getElementById('dlYtPersistentView');w.loadURL('https://www.youtube.com/watch?v=jNQXAC9IVRw');'ok'})()`);
    await waitFor(`()=>{const u=document.getElementById('dlYtPersistentView')?.getURL?.()||'';return /[?&]v=jNQXAC9IVRw/.test(u)}`, 'watch page');
    line('watch page loaded');

    // Back enabled by now (home→results→watch = 2 back steps).
    await exec(`setView('downloader');'ok'`);
    const mid = await exec(`(()=>{const b=document.querySelector('#dlYtBack'),f=document.querySelector('#dlYtFwd');const w=document.querySelector('#dlYtPersistentView');const can=()=>{try{return {back:w.canGoBack(),fwd:w.canGoForward()}}catch(e){return {err:String(e)}}};return{backEnabled:!b.disabled,fwdEnabled:!f.disabled,can:can()}})()`);
    line('mid-history state:', JSON.stringify(mid));
    if (!mid.backEnabled) throw new Error('Back arrow should be ENABLED after navigating to a video');

    // Click Back, expect URL to move to the results page.
    await exec(`(()=>{document.getElementById('dlYtBack').click();'ok'})()`);
    await waitFor(`()=>{const u=document.getElementById('dlYtPersistentView')?.getURL?.()||'';
      try{const w=document.getElementById('dlYtPersistentView');return u.includes('results?search_query')&&w&&w.canGoForward()}catch{return false}}`, 'back-click lands on results w/ forward enabled');
    await new Promise(r => setTimeout(r, 1600)); // let the nav-sync tick fire
    const afterBack = await exec(`(()=>{const w=document.querySelector('#dlYtPersistentView');const b=document.querySelector('#dlYtFwd');return{url:w.getURL(),fwdEnabled:!b.disabled}})()`);
    line('after Back:', JSON.stringify(afterBack));
    if (!afterBack.url.includes('results?search_query') || !afterBack.fwdEnabled) throw new Error('Back did not navigate or Forward did not enable');

    // Click Forward, expect back on the watch URL.
    await exec(`(()=>{document.getElementById('dlYtFwd').click();'ok'})()`);
    await waitFor(`()=>{const u=document.getElementById('dlYtPersistentView')?.getURL?.()||'';return /[?&]v=jNQXAC9IVRw/.test(u)}`, 'forward-click lands on watch page');
    await new Promise(r => setTimeout(r, 1600)); // let the nav-sync tick fire
    const afterFwd = await exec(`(()=>{const w=document.querySelector('#dlYtPersistentView');return{url:w.getURL(),backEnabled:!document.querySelector('#dlYtBack').disabled,fwdEnabled:!document.querySelector('#dlYtFwd').disabled}})()`);
    line('after Forward:', JSON.stringify(afterFwd));
    if (!/[?&]v=jNQXAC9IVRw/.test(afterFwd.url) || !afterFwd.backEnabled || afterFwd.fwdEnabled) throw new Error('Forward did not land on watch page with correct arrow states');

    line('== ALL ASSERTIONS PASSED ==');
    exit = 0;
  } catch (error) {
    line('HARNESS FAILED: ' + error.message);
  } finally {
    try { fs.writeFileSync(process.env.YT_NAV_LOG || 'yt-nav-harness.log', log.join('\n')); } catch {}
    setTimeout(() => { app.exit(exit); }, 300);
  }
});
