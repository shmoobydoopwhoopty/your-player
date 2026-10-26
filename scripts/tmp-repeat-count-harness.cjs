'use strict';
// One-off harness: verify repeat-one now increments the play counter each
// loop. Boots index.html with the real preload, plants a synthetic track,
// plays a short silent WAV with repeatMode=2, and waits for 3 natural
// 'ended' loops. Counts at loop boundaries must be 1 -> 2 -> 3 -> 4.
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { app, BrowserWindow } = require('electron');
app.setName('repeat-count-harness');
app.setPath('userData', path.join(os.tmpdir(), 'repeat-count-harness-' + Date.now()));

const log = [];
function line(...a) { const s = a.join(' '); log.push(s); console.log(s); }

// ~0.35 s silent 8-bit mono PCM wav.
function wavDataUrl() {
  const sr = 8000, n = 2800;
  const dataSize = n, fileSize = 36 + dataSize;
  const b = Buffer.alloc(44 + dataSize);
  b.write('RIFF', 0); b.writeUInt32LE(fileSize, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr, 28);
  b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36);
  b.writeUInt32LE(dataSize, 40); // samples already zero
  return 'data:audio/wav;base64,' + b.toString('base64');
}

let win = null;
app.whenReady().then(async () => {
  let exit = 1;
  try {
    win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, webviewTag: true,
    } });
    await win.loadFile(path.join(__dirname, '..', 'index.html'));
    line('index.html loaded');
    const ready = await win.webContents.executeJavaScript(`typeof window.setView==='function'&&!!document.querySelector('#audio')`, true);
    if (!ready) throw new Error('renderer not ready');
    line('renderer ready, running repeat-one play-count test');

    const result = await win.webContents.executeJavaScript(`(async()=>{
  const url='${wavDataUrl()}';
  const fake={id:'test-repeat-1',title:'Repeat counter test',artist:'Test',album:'Test',art:'',artUrl:'',duration:'',
    file:{path:'',name:'test.wav'},playCount:0,favorite:false,metaLocked:false,added:Date.now()};
  tracks.push(fake);
  audio.volume=0;
  // A loop boundary starts counting only from a fresh flag; capture observed
  // counters each time the song ends naturally.
  const counts=[];
  audio.addEventListener('ended',()=>counts.push(fake.playCount));
  repeatMode=2;$('#repeatBtn').classList.add('selected');
  current=tracks.indexOf(fake);
  playSessionCounted=false;
  audio.src=url;
  await audio.play();
  await new Promise(r=>{
    let n=0;
    const h=()=>{if(++n>=3){audio.removeEventListener('ended',h);r()}};
    audio.addEventListener('ended',h);
    setTimeout(r,12000);
  });
  // Wait for the final loop's replay to run its 'play' handler before
  // reading the total (a bare 'ended' read races the +1 increment).
  await new Promise(r=>{audio.addEventListener('play',function h(){audio.removeEventListener('play',h);setTimeout(r,50)});setTimeout(r,3000)});
  audio.pause();
  return {counts,final:fake.playCount,pillApplies:typeof updateListenedPill==='function'};
})()`, true);
    line('observed counts at each ended loop: ' + JSON.stringify(result.counts));
    line('final playCount: ' + result.final);
    // First play counts 1; each of the 3 loops is a restart and must count +1.
    const expected = [1, 2, 3];
    const okCounts = expected.every((want, i) => result.counts[i] === want);
    if (!okCounts) throw new Error('expected [1,2,3] at loop boundaries, got ' + JSON.stringify(result.counts));
    if (result.final !== 4) throw new Error('final playCount should be 4 (first play + 3 repeats), got ' + result.final);
    line('== ALL ASSERTIONS PASSED ==');
    exit = 0;
  } catch (error) {
    line('HARNESS FAILED: ' + (error.stack || error.message));
  } finally {
    try { fs.writeFileSync(process.env.RC_LOG || 'repeat-count-harness.log', log.join('\n')); } catch {}
    setTimeout(() => app.exit(exit), 300);
  }
});
