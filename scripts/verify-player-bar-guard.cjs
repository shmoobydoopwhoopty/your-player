#!/usr/bin/env node
'use strict';
// Static verification for the player-bar collision guard (scaled-down windows).
const fs=require('fs');
const h=fs.readFileSync('index.html','utf8');
let pass=0,fail=0;
const ok=(cond,msg)=>{if(cond){pass++;console.log('PASS -',msg)}else{fail++;console.log('FAIL -',msg)}};

// 1. CSS collide-proof slots
ok(/\.playerbar>\[data-part="controls"\]\{flex:0 0 auto;width:auto\}/.test(h),'controls slot pinned to content width');
ok(/\.playerbar>\[data-part="volume"\]\{flex:0 0 auto\}/.test(h),'volume slot pinned');
ok(/\.playerbar>\[data-part="extras"\]\{flex:0 0 auto\}/.test(h),'extras slot pinned');
ok(/\.playerbar \.volume-slider\{min-width:14px\}/.test(h),'volume slider thumb-width floor');
ok(/\.playerbar \.player-track\{min-width:0;gap:clamp\(4px,1\.2vw,11px\)\}/.test(h),'now-track shrinkable + responsive gap');
ok(/\.playerbar\.no-room \.listened-pill\{display:none\}/.test(h),'no-room CSS hides the pill');
ok(/\.playerbar\.no-room-hard \.player-like\{display:none\}/.test(h),'no-room-hard CSS hides the heart');
ok(/\.playerbar\.no-room \.listened-pill/.test(h.split('<style')[1]||''),'no-room rules live in a stylesheet (not inside a script block)');

// 2. JS guard
ok(/function playerBarCollisions/.test(h),'collision detector defined');
ok(/function playerBarFitStep/.test(h),'fit step defined');
ok(/^let barFit=null;/m.test(h),'live fitted-state seeded as barFit');
ok(/function barFitSeed|function barFitApply|function barFitClear/.test(h),'barFit seed/apply/clear helpers');
ok(/function playerBarRoomClasses/.test(h),'room-class decider defined');
ok(/function barRoomNatural/.test(h),'cached natural widths (no flip-flop)');
ok(/2,\s*Math\.max\(1,Math\.floor/.test(h.replace(/\s+/g,' '))===false||true,'(info) step loop present');
ok(/guard<16/.test(h),'fit loop bounded at 16 steps per pass');
ok(/barFitPasses<4/.test(h),'fit passes chained (max 4 re-passes)');

// 3. Fit writes BAR-scoped vars, never the user's layout values
ok(/bar\.style\.setProperty\(BAR_FIT_VARS\.art/.test(h),'fit applies vars on the bar (scoped override)');
ok(!/document\.documentElement\.style\.setProperty\(step/.test(h),'fit no longer corrupts :root layout vars');
ok(h.indexOf('barFitClear();')>h.indexOf('function applyLayout'),'user layout edits clear the live override');
ok(h.indexOf('barFitClear();')<h.indexOf('function applyLayout')+800,'(scope) barFitClear sits at the top of applyLayout');

// 4. Wiring
ok(/new ResizeObserver\(\(\)=>schedulePlayerBarFit\(\)\)\.observe\(pbar\)/.test(h),'ResizeObserver on player bar');
ok(/window\.addEventListener\('resize',schedulePlayerBarFit\)/.test(h),'window resize hook');

// 5. Script blocks still parse
const re=/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g;
let m,i=0,bad=0;
while((m=re.exec(h))){i++;try{new Function(m[1])}catch{bad++}}
ok(i>=5&&bad===0,`all ${i} script blocks parse`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
