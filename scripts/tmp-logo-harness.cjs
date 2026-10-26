'use strict';
// One-off live harness: proves the app-logo picker end to end in the real
// Electron build — the real Choose click path in the page, the desktop bridge,
// the main handler writing to userData, the corner logo rendering it,
// persistence across a reload, and clearing back to the default icon.
// It registers the SAME handlers electron/main.cjs does (copied behavior),
// replacing the file-choose dialog with a canned picture so the run is
// unattended.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fsP = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
app.setName('logo-harness');
app.setPath('userData', path.join(os.tmpdir(), 'logo-harness-' + Date.now()));

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// A second, different pixel art so a re-pick is visually distinguishable from
// the first picture (the cache bug shows up only on the second pick).
const PNG_B64_B = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const pngBytes = () => Uint8Array.from(Buffer.from(PNG_B64, 'base64'));
const pngBytesB = () => Uint8Array.from(Buffer.from(PNG_B64_B, 'base64'));

// ── main-process handlers, mirroring electron/main.cjs ──────────────────
const appLogoPath = () => path.join(app.getPath('userData'), 'app-logo');
ipcMain.handle('afterglow:choose-image', async (_event, title) => {
  // Stand-in for dialog.showOpenDialog: hand back a real picture without UI.
  // The stored path is ALWAYS the same (that is what the app does), but the
  // bytes alternate between picks so the second pick is new content at the
  // same URL -- exactly the case where the cached stale picture bug showed.
  return { path: appLogoPath() + '-chosen.png', bytes: (chooseCount++ % 2 === 0) ? pngBytes() : pngBytesB(), mime: 'image/png', name: 'chosen-logo.png' };
});
ipcMain.handle('app-logo:save', async (_event, payload) => {
  const bytes = payload && payload.bytes;
  if (!bytes || !bytes.length || bytes.length > 25 * 1024 * 1024) return null;
  try {
    const target = appLogoPath();
    await fsP.writeFile(target, Buffer.from(bytes));
    return { path: target, url: pathToFileURL(target).href };
  } catch { return null; }
});
let chooseCount = 0;
ipcMain.handle('app-logo:clear', async () => {
  try { await fsP.rm(appLogoPath(), { force: true }); } catch {}
  return true;
});

let win = null;
const log = [];
function line(...a) { const s = a.join(' '); log.push(s); console.log(s); }
function assert(cond, what) {
  line(cond ? 'PASS' : 'FAIL', '-', what);
  if (!cond) throw new Error('assertion failed: ' + what);
}
async function exec(code, ms = 30000) {
  // Bounded execution so a page-side hang surfaces as a diagnostics line
  // instead of silently stalling the whole run.
  try {
    return await Promise.race([
      win.webContents.executeJavaScript(code, true),
      new Promise((_, reject) => setTimeout(() => reject(new Error('exec timeout')), ms)),
    ]);
  } catch (e) {
    line('exec error for [' + String(code).slice(0, 140) + ']:', (e && e.message) || String(e));
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

function bootPage() {
  return win.loadFile(path.join(__dirname, '..', 'index.html'));
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
    await bootPage();
    line('index.html loaded');
    await waitFor(`()=>typeof window.setView==='function'&&!!document.querySelector('#workspace')`, 'renderer boot');
    line('renderer booted');

    // A. The desktop bridge exposes the logo APIs the click handler needs.
    const bridge = await exec(`(()=>{const d=window.afterglowDesktop;return {present:!!d,choose:d?typeof d.chooseImageFile:null,save:d?typeof d.saveAppLogo:null,clear:d?typeof d.clearAppLogo:null}})()`);
    line('bridge:', JSON.stringify(bridge));
    assert(bridge.present && bridge.choose === 'function' && bridge.save === 'function' && bridge.clear === 'function',
      'afterglowDesktop exposes chooseImageFile/saveAppLogo/clearAppLogo');

    // B. Open settings through the REAL button path (toggleSettingsPop builds
    //    the picker on first open) and confirm the App logo section.
    await exec(`(()=>{toggleSettingsPop();'ok'})()`);
    await new Promise(r => setTimeout(r, 700));
    const pop = await exec(`(()=>{const p=document.getElementById('settingsPop');const b=document.getElementById('logoChooseBtn');const row=document.getElementById('logoPathRow');return {built:p&&p.dataset.built,btn:!!b,row:!!row,rowText:row&&row.textContent}})()`);
    line('settings pop logo section:', JSON.stringify(pop));
    assert(pop.built === '1' && pop.btn && pop.row, 'App logo section present and picker built on first open');

    // C. REAL click path: click the actual Choose button; the stubbed
    //    choose-image returns a picture and the handler saves + applies it.
    const click = await exec(`(async()=>{const btn=document.getElementById('logoChooseBtn');let toast=null;try{btn.click();const t0=Date.now();while(Date.now()-t0<6000&&!toast){toast=(()=>{const els=[...document.querySelectorAll('.toast,#toast,[class*=toast]')];for(const e of els){const t=e.textContent||'';if(t&&t.trim())return t.trim()}})()||(window.__lastToast||null);await new Promise(r=>setTimeout(r,250))}
    }catch(e){return {clickErr:String(e&&e.stack||e)}}
    return {toast}})()`);
    line('after real Choose click:', JSON.stringify(click));
    assert(click && !click.clickErr, 'Choose button click ran its handler');

    await waitFor(`()=>{const img=document.querySelector('#brandIcon img');return img&&img.src.startsWith('file:')?{src:img.src}:null}`, 'corner logo switched to the custom picture');
    line('brandIcon src:', await exec(`JSON.stringify(document.querySelector('#brandIcon img')&&document.querySelector('#brandIcon img').getAttribute('src'))`));

    const appliedRow = await exec(`JSON.stringify(document.getElementById('logoPathRow').textContent)`);
    line('logo path row text:', appliedRow);
    assert(appliedRow && !/Default logo/i.test(appliedRow), 'path row shows the chosen picture');

    const onDisk = fs.existsSync(appLogoPath());
    assert(onDisk, 'main handler wrote the picture next to userData');

    // C2. THE CACHE RE-PICK: a second pick with NEW bytes at the SAME path
    //     must visibly swap the corner image. Before the fix the src never
    //     changed (same URL), so Chromium re-served the cached old picture.
    const src1 = await exec(`JSON.stringify(document.querySelector('#brandIcon img').getAttribute('src'))`);
    const click2 = await exec(`(async()=>{const btn=document.getElementById('logoChooseBtn');let toast=null;try{btn.click();const t0=Date.now();while(Date.now()-t0<6000&&!toast){toast=(()=>{const els=[...document.querySelectorAll('.toast,#toast,[class*=toast]')];for(const e of els){const t=e.textContent||'';if(t&&t.trim())return t.trim()}})()||(window.__lastToast||null);await new Promise(r=>setTimeout(r,250))}}catch(e){return {clickErr:String(e&&e.stack||e)}}return {toast}})()`);
    line('after second real Choose click:', JSON.stringify(click2));
    assert(click2 && !click2.clickErr, 'second Choose click ran its handler');
    const src2 = await exec(`JSON.stringify(document.querySelector('#brandIcon img').getAttribute('src'))`);
    line('src after first pick:', String(src1));
    line('src after second pick:', String(src2));
    assert(String(src1) !== String(src2), 'corner logo src actually changed on a re-pick (no stale cache)');
    assert(/(?:[?&])v=/.test(String(src2)), 'display URL is version-stamped for cache busting');

    // D. The pick persists across a restart.
    const storedAfter = await exec(`(()=>{try{const s=JSON.parse(localStorage.getItem('yourplayer.logo.v1')||'null');return s&&s.url||null}catch{return null}})()`);
    line('localStorage logo url:', storedAfter);
    assert(Boolean(storedAfter), 'pick stored in localStorage');

    await bootPage();
    await waitFor(`()=>typeof window.setView==='function'`, 'reboot');
    const shownAfterBoot = await exec(`(()=>{const img=document.querySelector('#brandIcon img');return img?img.src:null})()`);
    line('brandIcon src after reboot:', shownAfterBoot);
    assert(shownAfterBoot && shownAfterBoot.startsWith('file:'), 'custom logo survives a restart via localStorage');

    // E. Right-click (the documented clear gesture) restores the default.
    //    Picker listeners attach on first Settings open, so open it the real way.
    await exec(`(()=>{toggleSettingsPop();'ok'})()`);
    await new Promise(r => setTimeout(r, 700));
    await exec(`(()=>{document.getElementById('logoChooseBtn').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));'ok'})()`);
    await new Promise(r => setTimeout(r, 500));
    const cleared = await exec(`(()=>{const img=document.querySelector('#brandIcon img');return {src:img&&img.src,isAppIcon:img&&typeof APP_ICON==='string'&&img.src===APP_ICON}})()`);
    line('after clear:', JSON.stringify(cleared));
    assert(cleared.isAppIcon, 'clearing puts the default app icon back');
    const gone = !fs.existsSync(appLogoPath());
    assert(gone, 'the stored logo file was removed from disk');

    line('== ALL LOGO ASSERTIONS PASSED ==');
    exit = 0;
  } catch (error) {
    line('HARNESS FAILED: ' + error.message);
  } finally {
    setTimeout(() => { app.exit(exit); }, 300);
  }
});
