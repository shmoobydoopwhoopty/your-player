#!/usr/bin/env node
// Guards: play counts are visible wherever a song is shown — album/artist
// detail rows, the shared songs table in every view, the Home spotlight, and
// the player bar / now-playing overlay (already shipped) — and they refresh
// live when a song is played.
'use strict';
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
let fail = 0;
const check = (name, ok) => { console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name); if (!ok) fail++; };
const fnSlice = (marker, len) => {
  const idx = html.indexOf(marker);
  return idx < 0 ? '' : html.slice(idx, idx + len);
};

const countCell = '<td class="table-muted row-plays"><span title=';

// Album/artist detail rows (detailRows)
const detail = fnSlice('function detailRows(list,tbody){', 2600);
check('album/artist detail rows show a play-count cell', detail.includes(countCell));
{
  const c = detail.indexOf('row-plays');
  const d = detail.indexOf('row-actions');
  check('detail row count cell comes before the actions cell', c >= 0 && d > c);

  // isolation: the cell introduced into the shared row template must also be
  // present in renderRows (same shape, unconditional this time)
  const rows = fnSlice('function renderRows(){', 2600);
  check('songs/playlist/search rows show a play-count cell unconditionally',
    rows.includes(countCell) && !rows.includes("view==='most-listened'?`<td class=\"table-muted\">"));
  check('shared table has an unconditional Plays header',
    fnSlice('function trackTable(){', 3000).includes('<th style="width:65px">Plays</th>') &&
    !html.includes("view==='most-listened'?'<th style=\"width:65px\">Plays</th>'"));
}

check('count cells carry a tooltip', countCell.includes('title='));
check('Home spotlight has a play-count pill', html.includes('id="spotCountPill"'));
{
  const upd = fnSlice('function updateListenedPill(){', 700);
  check('updateListenedPill fills the spotlight pill',
    upd.includes("const spot=$('#spotCountPill');") && upd.includes("spot.hidden=false") &&
    upd.includes("<b>${t.playCount||0}</b>"));
}
check('player bar pill untouched (still fills listenedPill + np overlay)',
  html.includes("const pill=$('#listenedPill');if(!pill)return") && html.includes('updateNpOverlayControls()'));
check('row counts refresh live on play in every row view',
  html.includes("updateListenedPill();persistLibrary();if(['songs','favorites','playlist','search','artist','album','most-listened'].includes(view))render()"));
check('most-listened view keeps its Reset plays control', html.includes('wipePlaysBtn') || fnSlice('function trackTable(){', 3000).includes('Reset plays'));
check('count cell styles exist', html.includes('.row-plays{width:56px}') && html.includes('.row-plays span{display:inline-flex;align-items:center;gap:4px}'));

process.exit(fail ? 1 : 0);
