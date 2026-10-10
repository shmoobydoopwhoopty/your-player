#!/usr/bin/env node
// Verify custom-colors grouping landed with intact behavior.
'use strict';
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const flat = html.replace(/\n/g, ' ');
function check(name, ok) { console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name); if (!ok) process.exitCode = 1; }

check('groups defined (Songs first)', /const CUSTOM_COLOR_GROUPS=\[\s*\['Songs',/.test(flat));
check('Songs group holds rowBg', /'Songs',\s*\[\s*\['rowBg','Song rows'\]/.test(flat));
check('Albums & artists group', /'Albums & artists',\s*\[\s*\['cardBg'/.test(flat));
check('Player group', /'Player',\s*\[\s*\['player','Player'\]/.test(flat));
check('App group', /'App',\s*\[\s*\['accent','Accent'\]/.test(flat));
check('Text group', /'Text',\s*\[\s*\['text','Text'\]/.test(flat));
check('defs derive from groups', /CUSTOM_COLOR_DEFS=CUSTOM_COLOR_GROUPS\.flatMap/.test(flat));
check('labels map exposes pairs', /CUSTOM_COLOR_LABELS=new Map\(CUSTOM_COLOR_DEFS\)/.test(flat));
check('grouped renderer loop', flat.includes('for(const [groupName,rows] of CUSTOM_COLOR_GROUPS)'));
check('item factory built', fs.readFileSync('index.html','utf8').includes('function makeColorItem(key,label)'));
check('old flat render loop removed', !fs.readFileSync('index.html','utf8').includes('for(const [key,label] of CUSTOM_COLOR_DEFS){'));
check('reset iterates full def list', fs.readFileSync('index.html','utf8').includes('for(const [key] of CUSTOM_COLOR_DEFS)delete customColors[key]'));
check('persistence load covers all keys', /for\(const \[key\] of CUSTOM_COLOR_DEFS\)if\(typeof savedCustom\[key\]/.test(flat));
check('surfaces palette reset path intact', /for\(const \[key\] of CUSTOM_COLOR_DEFS\)delete customColors\[key\];/.test(flat));

process.exit(process.exitCode || 0);
