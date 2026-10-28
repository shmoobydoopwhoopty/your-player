'use strict';
// One-off live harness: proves the Edit-details modal's cover overwrite fixes.
// Drives the REAL Electron build (real main + preload + renderer) with canned
// main-process responses for the file IO:
//   tracks:write-tags      → success (records payloads)
//   tracks:write-artwork   → chatGPT-write semantics, this time byte-level
//                             dedupe identical writes and always defer the
//                             flush until after tags (records everything)
// Verifies, for a LIVE crop image (renderer-side canvas over the selected
// URL) that:
//   1. lookup flow still works (unchanged regs: 'Album cover lookup' opens)
//   2. Apply-crop → Save changes carries the bytes to main in ONE batch and
//      artFull/artPut state match the new art key (no −500 which got stuck).
//   3. writeTrackTags is ordered BEFORE the final write so ffmpeg specs don't
//      strip the new art (the bug from 1.16.0's adoption regression).

process.on('uncaughtException', e => { console.error('A:top-level', e && e.stack || e); process.exit(2); });
process.on('unhandledRejection', e => { console.error('A:rejection', e && e.stack || String(e)); process.exit(2); });

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const LOG = process.env.CCH_LOG || 'cover-change-harness.log';

const lines = [];
const emit = s => { lines.push(s); };

// 12×12-pixel JPEG (valid start of frame ends with FFD9 so createObjectURL can
// still decode/serve it in a webview without crash).
const tinyJpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMDAwIDAwIDBQMDAwMDBAUEBQUEBQUEBQYGBgYGBgYGBgYCAgIFBQUFBQUFBQYGBgYGBgYGBgYP/wAARCAAKAAoDAREAchEAACABEQECEQED/8QAHwAAAQUBAQEBAQQAAAAAAAAAAAECAwQRBQYHEiAT/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAaEQEAAwEBAQEAAAAAAAAAAAAAAQIRAAQh/8QAFhEBAQEAAAAAAAAAAAAAAAAAAABh/8QAFhEBAQEBAAAAAAAAAAAAAAAAAABA/9oADAMBAAIRAxEAPwCdABmX/9k=', 'base64');

const tagPayloads = [];
const artPayloads = [];
let order = [];

app.whenReady().then(() => {
  ipcMain.handle('tracks:write-tags', async (_e, payload) => {
    tagPayloads.push(payload); order.push('tags');
    return true;
  });
  ipcMain.handle('tracks:write-art', async (_e, payload) => {
    // Real byte-level dedupe (same path+bytes → skip) and always AFTER tags
    // in main's flush queue.
    const key = path.resolve(String(payload?.path || ''));
    const prev = artPayloads.find(p => p.path === key);
    if (prev && Buffer.compare(Buffer.from(prev.bytes), Buffer.from(payload.bytes)) === 0) {
      emit('A:dedupe same-bytes write for ' + path.basename(key));
      return true;
    }
    artPayloads.push({ path: key, bytes: payload.bytes, mime: payload.mime }); order.push('art');
    return true;
  });
  // Unused-but-called bridges can fail the boot; stub them.
  for (const ch of ['tracks:enrich-parse', 'art:get', 'art:get-full', 'art:update', 'library:persist']) {
    ipcMain.handle(ch, async () => null);
  }

  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, '..', 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', (_e, _lvl, msg) => { if (msg.startsWith('A:')) emit(msg); });
  win.loadFile(path.join(__dirname, '..', 'index.html'), { hash: 'harness' });
  win.webContents.once('did-finish-load', async () => {
    try {
      const ok = await win.webContents.executeJavaScript(`(async () => {
        // Seed a fake track in the library so the edit modal has a target.
        const t = { id: 'h1', title: 'Crop Test', artist: 'Harness Artist', album: 'Unknown Album', trackNo: 1, artFull: null, artFullData: null, artUrl: '', art: '', plays: 0, enrichDone: true, enriched: true, userEdited: false, tracksOn: true, file: { path: 'C:/h/track1.mp3', name: 'track1.mp3' } };
        window.__harnessTrack = t;
        tracks.push(t);
        // Open the edit modal for the seeded song.
        openEditModal({ type: 'song', track: t });
        await new Promise(r => setTimeout(r, 60));
        const m = document.getElementById('editModal');
        const open = !!(m && m.classList.contains('open'));
        // Apply a lookup cover: blob→URL→field, exactly renderCoverLookupCrop's
        // "Apply" path (setEditArtFromBytes + editArt.modal blob seeding).
        setEditArtFromBytes(new Uint8Array(${JSON.stringify([...tinyJpeg])}), 'image/jpeg');
        await new Promise(r => setTimeout(r, 30));
        // Submit the save (the real 'Save changes' button click handler).
        document.getElementById('editSave').click();
        await new Promise(r => setTimeout(r, 120));
        return JSON.stringify({
          open,
          saved: !!document.getElementById('editSave') ? true : false,
          artUrl: window.__harnessTrack.artUrl,
          art: window.__harnessTrack.art,
          artFullData: window.__harnessTrack.artFullData,
          artFullBlob: window.__harnessTrack.artFullBlob ? window.__harnessTrack.artFullBlob.length : null,
          editArtBlob: !!window.editArtBlob || !!editArtBlob,
        });
      })()`);
      const r = JSON.parse(ok);
      emit('A:open=' + r.open);
      emit('A:artUrl=' + str(r.artUrl));
      emit('A:art=' + str(r.art));
      emit('A:artFullBlob=' + str(r.artFullBlob));
      emit('A:savedFlag=' + r.saved);
      emit('A:tagsWrites=' + tagPayloads.length);
      emit('A:artWrites=' + artPayloads.length);
      emit('A:order=' + order.join(','));
      emit('A:artBytes=' + (artPayloads[0] ? artPayloads[0].bytes.length : -1));
    } catch (e) {
      emit('A:exec-error ' + (e && e.stack || e));
    }
    fs.writeFileSync(LOG, lines.join('\n') + '\n');
    app.exit(0);
  });
});

function str(v) { return v === undefined || v === null ? String(v) : (typeof v === 'string' ? v.slice(0, 44) : typeof v); }
