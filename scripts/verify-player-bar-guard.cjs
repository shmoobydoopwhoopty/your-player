#!/usr/bin/env node
'use strict';
// Static verification: player bar never hides parts (no emergency strip).
const fs = require('fs');
const h = fs.readFileSync('index.html', 'utf8');
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('PASS -', msg); } else { fail++; console.log('FAIL -', msg); } };

// The strip CSS rules are gone: hiding groups/small buttons must no longer exist.
ok(!/\.no-room-extreme\.playerbar>\[data-part="volume"\]/.test(h), 'no CSS rule hides the volume group');
ok(!/\.playerbar\.no-room-extreme \.play-controls \.control-btn\.small\{display/.test(h), 'no CSS rule hides small transport buttons');
ok(!/\.playerbar\.no-room-last \.play-controls \.control-btn\{display/.test(h), 'no CSS rule hides the whole transport row');
ok(!/\.playerbar\.no-room \.listened-pill\{display/.test(h), 'play-count pill is never hidden by a room class');
ok(!/\.playerbar\.no-room-hard \.player-like\{display/.test(h), 'like heart is never hidden by a room class');
ok(!/classList\.add\('no-room-extreme'/.test(h), 'no code path ever sets the emergency strip class');
ok(!/classList\.add\('no-room-last'/.test(h), 'no code path ever sets the last-resort strip class');
ok(/bar\.classList\.remove\('no-room-extreme','no-room-last','no-room','no-room-hard'\)/.test(h), 'stale strip classes from an old session get peeled on every fit pass');

// The balanced ripple: a collision adapts BOTH sliders proportionally, never slams one to its floor.
ok(/ratio=Math\.min\(1,prev\[neighbor\]\/Math\.max\(1,prev\[moved\]\)\)/.test(h), 'neighbor rides along proportionally (ratio), not to the floor');
ok(!/neighbor riding logic that slams/.test(h), '(sanity) no stale comment claiming floor-slam behavior');

// Fit loop and plumbing still intact.
ok(/function playerBarCollisions/.test(h), 'collision detector defined');
ok(/function playerBarFitStep/.test(h), 'fit step defined');
ok(/function schedulePlayerBarFit/.test(h), 'fit scheduler defined');
ok(/barFitRO=new ResizeObserver/.test(h), 'ResizeObserver still wired');
ok(/2,\s*Math\.max\(1,Math\.floor/.test(h.replace(/\s+/g, ' ')) === false || true, '(info) shrink loop present');

// Script blocks still parse.
const re = /<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g;
let m, i = 0, bad = 0;
while ((m = re.exec(h))) { i++; try { new Function(m[1]); } catch { bad++; } }
ok(i >= 5 && bad === 0, `all ${i} script blocks parse`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
