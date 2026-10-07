#!/usr/bin/env node
'use strict';
// Extract <script> blocks from index.html (skipping type="text/plain" worker sources)
// and syntax-check each one with node --check.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
let m, i = 0, failed = 0;
const tmpDir = path.join(__dirname, '..', 'release', '.syntax-check');
fs.mkdirSync(tmpDir, { recursive: true });
while ((m = re.exec(html))) {
  const attrs = m[1] || '';
  if (/type\s*=\s*["']text\/plain["']/.test(attrs)) continue;
  if (/\ssrc\s*=/.test(attrs)) continue;
  i++;
  const file = path.join(tmpDir, `block-${i}.js`);
  fs.writeFileSync(file, m[2]);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    console.error(`Script block ${i} failed syntax check:`);
    const out = String(err.stderr || err.message || '');
    console.error(out.split('\n').slice(0, 12).join('\n'));
  }
}
if (failed) {
  console.error(`${failed} of ${i} script blocks failed.`);
  process.exit(1);
}
console.log(`All ${i} inline script blocks passed node --check.`);
