'use strict';
// Static verification of the context-aware downloader buttons (v1.9.12+).
// Checks the gating logic in index.html without launching Electron.
const fs = require('fs');

const h = fs.readFileSync('index.html', 'utf8');
let ok = true;
const ck = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name); if (!cond) ok = false; };
const RX = s => new RegExp(s);

const i = h.indexOf('function syncDownloadButtons');
ck('syncDownloadButtons found', i >= 0);
const body = h.slice(i, i + 900);

ck('video buttons gated on watch page',
  body.includes('isWatch') && body.includes('dlYtGetVideo') && body.includes('youtube\\.com'));
if (process.env.DEBUG_SLICE) console.log('body.slice:', JSON.stringify(body));
ck('playlist button shown only on playlist pages',
  RX('isPlaylist\\s*=').test(body) && body.includes('dlYtGetPlaylist') && body.includes('list='));
ck('watch-videos-from-playlist case: video button wins when ?v= is present',
  RX('&&\s*!/\\bv=/').test(body) || body.includes('\\bv='));
ck('playlist action queues real tracks (expandCollection)',
  h.includes('downloaderDownloadPlaylist') && h.includes('expandCollection'));
ck('playlist action extracts list id from live URL',
  RX('[?&]list=\\(\\[\\\\w-\\]\\+\\)/\\.exec\\(url\\)').test(h) || RX('list=.*\\.exec\\(url\\)').test(h));
ck('persistent webview written once in body markup (v1.9.13+ — never re-created/re-parented)' , h.includes('<webview id="dlYtPersistentView"'));
ck('downloader slot is empty (webview is overlaid, not rebuilt)', !/dlYtHost" style="position:absolute;inset:0"><webview/.test(h));
ck('no dynamic createElement webview', !RX('createElement\\([\'"]webview').test(h));

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
ck('package version is a semver (not pinned — stays valid across bumps)', /^\d+\.\d+\.\d+$/.test(pkg.version));

process.exit(ok ? 0 : 1);
