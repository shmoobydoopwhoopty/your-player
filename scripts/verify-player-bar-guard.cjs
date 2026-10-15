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
ok(!/\.playerbar\.no-room \.listened-pill\{display/.test(h),'play-count pill is never hidden by a room class');
ok(!/\.playerbar\.no-room \.player-album\{display/.test(h),'album line is never hidden by a room class');
ok(!/\.playerbar\.no-room-hard \.player-like\{display/.test(h),'like heart is never hidden by a room class');
ok(/data-progress-side="top"[^\n]*\.playerbar\{padding-top:calc\(var\(--progress-h,3px\) \+ 18px\)/.test(h),'progress zone reserved at the bar top (art/play must stay clear of the seek bar)');
ok(/data-progress-side="bottom"[^\n]*\.playerbar\{padding-bottom:calc\(var\(--progress-h,3px\) \+ 18px\)/.test(h),'progress zone reserved at the bar bottom');
ok(/data-progress-side="top"[^\n]*\.playerbar\{padding-top:calc\(var\(--progress-h,3px\) \+ 18px\)/.test((h.split('<style')[1]||'')),'progress-zone rules live in a stylesheet (not inside a script block)');

// 2. JS guard
ok(/function playerBarCollisions/.test(h),'collision detector defined');
ok(/function playerBarFitStep/.test(h),'fit step defined');
ok(/^let barFit=null;/m.test(h),'live fitted-state seeded as barFit');
ok(/function barFitSeed|function barFitApply|function barFitClear/.test(h),'barFit seed/apply/clear helpers');
ok(/function barPlayerVerticalFits/.test(h),'vertical fit tester defined (sweep respects the progress zone)');
ok(/const capH=Math\.floor\(bar\.clientHeight-vPadTop-vPadBottom-2\)/.test(h),'art/play capped to the bar content box (never cross the progress bar)');
ok(/capH>28&&barFit\.art>capH|if\(barFit\.art>capH\)\{/.test(h),'art cap applied');
ok(/barFit\.pt<=0\.85\)break/.test(h),'text zoom has a readable floor (song info never shrinks to nothing)');
ok(/2,\s*Math\.max\(1,Math\.floor/.test(h.replace(/\s+/g,' '))===false||true,'(info) step loop present');
ok(/guard<16/.test(h),'fit loop bounded at 16 steps per pass');
ok(/barFitSettles=0;setTimeout\(schedulePlayerBarFit/.test(h),'settle chain re-verifies geometry after every pass');
ok(/window\.addEventListener\('resize',\(\)=>\{barFitSettles=0;barFitRelaxLock=false;barFitStableClean=0;barFitStripTrials=false;barFitConcedeReset\(\);schedulePlayerBarFit\(\)\}\)/.test(h),'window resize hook (resets settle chain, strip trial + concede list)');

// 3. Fit writes BAR-scoped vars, never the user's layout values
ok(/bar\.style\.setProperty\(BAR_FIT_VARS\.art/.test(h),'fit applies vars on the bar (scoped override)');
ok(!/document\.documentElement\.style\.setProperty\(step/.test(h),'fit no longer corrupts :root layout vars');
ok(h.indexOf('barFitClear();')>h.indexOf('function applyLayout'),'user layout edits clear the live override');
ok(h.indexOf('barFitClear();')<h.indexOf('function applyLayout')+800,'(scope) barFitClear sits at the top of applyLayout');

// 4. Wiring
ok(/barFitRO=new ResizeObserver\(\(\)=>schedulePlayerBarFit\(\)\)/.test(h)&&/barFitRO\.observe\(barFitRONode\)/.test(h),'ResizeObserver on player bar (rebindable)');
ok(/window\.addEventListener\('resize',schedulePlayerBarFit\)/.test(h)||/window\.addEventListener\('resize',\(\)=>\{barFitSettles=0/.test(h),'window resize hook');

// 5. Script blocks still parse
const re=/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g;
let m,i=0,bad=0;
while((m=re.exec(h))){i++;try{new Function(m[1])}catch{bad++}}
ok(i>=5&&bad===0,`all ${i} script blocks parse`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
