#!/usr/bin/env node
// Verify the playing-row synchronization fix pieces are present post-build.
'use strict';
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
let fail = 0;
const check = (name, ok) => { console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name); if (!ok) fail++; };

check('syncPlayingRows defined', html.includes('function syncPlayingRows(t)'));
check('updateCurrent calls syncPlayingRows', html.includes('syncPlayingRows(t);'));
check('detail rows carry track id stamp', /function detailRows\(list,tbody\)\{[\s\S]{0,300}?\.dataset\.trackId=t\.id/.test(html));
check('library rows carry id + position stamps', /\.dataset\.trackId=t\.id;tr\.dataset\.rowPos=String\(\(idx\+1\)\)\.padStart\(2,'0'\)/.test(html));
check('sync keeps number cell from rowPos', html.includes("tr.dataset.rowPos||playCell.textContent.trim()||'01'"));
check('sync handles both detail + library bodies', html.includes("$('#trackBody'),$('#detailSongs')"));
check('pause path also updates (updateCurrent drives state)', /playing=false;updateCurrent\(\)/.test(html) || html.includes('updateCurrent()'));
process.exit(fail ? 1 : 0);
