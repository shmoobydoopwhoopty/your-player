'use strict';
// Playlist downloader inference suite: the pure functions that turn a pasted
// YouTube playlist (title + uploader + video titles) into album / artist /
// song metadata. Run with: node scripts/verify-playlist-album.cjs
const filePath = require('path').join(__dirname, '..', 'electron', 'downloader.cjs');
const { cleanSongTitle, inferAlbumMeta } = require(filePath);

let fails = 0;
function check(name, ok) { console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name); if (!ok) fails++; }

// ── cleanSongTitle ──────────────────────────────────────────────────────────
check('junk suffix groups are peeled',
  cleanSongTitle('Exit Music (For a Film) (2016 Remastered Version) [Official Audio]', 'Radiohead') === 'Exit Music (For a Film)');
check('leading artist prefix is dropped',
  cleanSongTitle('Nature Boy - Ah! Bacchus (Official Music Video)', 'Nature Boy') === 'Ah! Bacchus');
check('useful credit groups are kept',
  cleanSongTitle('Silent Shout (feat. Dream Koala)', 'The Technn') === 'Silent Shout (feat. Dream Koala)');
check('bare title passes through unharmed',
  cleanSongTitle('Pyramid Song', '') === 'Pyramid Song');
check('year-only bracket group is dropped',
  cleanSongTitle('Grey Years (2017)', 'Needshes') === 'Grey Years');
check('empty title falls back', cleanSongTitle('', '') === 'Untitled');

// ── inferAlbumMeta: classic "Artist - Album (Year) Full Album" playlist ────
const radiohead = inferAlbumMeta(
  'Radiohead - OK Computer (1997) FULL ALBUM',
  'Some Uploads Channel',
  ['Airbag', 'Paranoid Android', 'Karma Police', 'Exit Music (For a Film)', 'No Surprises'],
);
check('title year is captured', radiohead.year === '1997');
check('playlist title artist prefix is split into the artist', radiohead.artist === 'Radiohead');
check('album junk words are stripped', radiohead.album === 'OK Computer');
check('song names keep inner parentheticals', radiohead.songs[3] === 'Exit Music (For a Film)');

// ── uploader "Artist - Topic" beats everything ──────────────────────────────
const topic = inferAlbumMeta('Music from channel uploads', 'The Microphones - Topic',
  ['The Glow Pt. 2', 'I Want Wind to Blow', 'The Moon']);
check('topic channel names the artist', topic.artist === 'The Microphones');

// ── common track-title prefix wins over a generic uploader ──────────────────
const prefix = inferAlbumMeta('cool mix collection', 'Musicdata',
  ['Daft Punk - One More Time', 'Daft Punk - Digital Love', 'Daft Punk - Voyager', 'Random unrelated song']);
check('shared track prefix names the artist', prefix.artist === 'Daft Punk');
check('track prefix stripped from song names', prefix.songs[1] === 'Digital Love' && prefix.songs[3] === 'Random unrelated song');

// ── junk media suffixes in every track title ────────────────────────────────
const junky = inferAlbumMeta('Whale - Full Album', 'Whale Records',
  ['Bare Bones (Official Audio)', 'Sleepy Eyes [Lyrics]', 'Low Tide - 4K Music Video']);
check('uploader names the artist', junky.artist === 'Whale Records');
check('"Full Album" disappears from the album name', junky.album === 'Whale');
check('official/audio/lyrics/4k junk stripped', junky.songs[0] === 'Bare Bones' && junky.songs[1] === 'Sleepy Eyes' && junky.songs[2] === 'Low Tide');

// ── generic uploader is not mistaken for the artist ────────────────────────
const generic = inferAlbumMeta('Various - Summer Collection 2004', 'Various Artists',
  ['The Sun - Gold', 'Nightwave - Coast']);
check('generic uploader rejected', generic.artist === 'Unknown artist');

// ── dash-less playlist title stays the album ────────────────────────────────
const plain = inferAlbumMeta('Yesterday Once More [Full Album]', 'Carpenters',
  ['Yesterday Once More', 'Top of the World']);
check('bracketed junk removed, title kept as album', plain.album === 'Yesterday Once More');
check('uploader fills the artist', plain.artist === 'Carpenters');

if (fails) { console.log(fails + ' failing'); process.exit(1); }
console.log('ALL PLAYLIST INFERENCE TESTS PASSED');
