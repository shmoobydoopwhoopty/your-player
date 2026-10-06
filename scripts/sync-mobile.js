#!/usr/bin/env node
'use strict';
// Copies index.html (the single-file app) into www/ so the Android WebView serves
// the exact same UI as the desktop build. Run before every Android build.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'index.html');
const www = path.join(root, 'www');

fs.mkdirSync(www, { recursive: true });
fs.copyFileSync(src, path.join(www, 'index.html'));
console.log('Synced index.html -> www/index.html');
