#!/usr/bin/env node
'use strict';
// Build a self-update channel folder for Your Player.
//
// Usage:
//   node scripts/publish-update.js [--out release/update-channel] [--version 1.0.5] [--notes "..."]
//   node scripts/publish-update.js --github owner/repo --tag v1.0.5 [--out release/update-channel] [--notes "..."]
//
// Without --github: the output folder holds manifest.json next to the app files
// using their real paths — host it on any static server and point the app's
// Settings → Update source at <url>/manifest.json.
//
// With --github: the output folder holds FLAT release assets (index.html,
// main.cjs, …) and the manifest points each file at its absolute GitHub
// release-download URL, because GitHub release assets cannot contain slashes.
// Upload the folder's contents as assets of the given release tag.

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const UPDATE_FILES = [
  'index.html',
  'package.json',
  'electron/main.cjs',
  'electron/preload.cjs',
  'electron/downloader.cjs',
  'electron/updater.cjs',
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[name] = '';
    else { out[name] = next; i++; }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const version = args.version || pkg.version;
  const outDir = path.resolve(ROOT, args.out || 'release/update-channel');
  const github = args.github ? String(args.github).trim().replace(/\/+$/, '') : '';
  const tag = (args.tag || `v${version}`).replace(/^v/, '');
  const tagWithV = `v${tag}`;

  if (github && !/^[\w.-]+\/[\w.-]+$/.test(github)) {
    throw new Error(`--github expects "owner/repo", got "${github}"`);
  }

  const seenAssets = new Set();
  const files = [];
  for (const rel of UPDATE_FILES) {
    const source = path.join(ROOT, rel);
    let bytes;
    try { bytes = await fs.readFile(source); } catch {
      console.warn(`Skipping missing file: ${rel}`);
      continue;
    }
    const entry = { path: rel, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    if (github) {
      // GitHub release assets are flat — upload under the basename and link
      // each manifest entry to its absolute download URL.
      const asset = path.basename(rel);
      if (seenAssets.has(asset)) throw new Error(`Two update files share the asset name "${asset}"`);
      seenAssets.add(asset);
      entry.url = `https://github.com/${github}/releases/download/${tagWithV}/${asset}`;
      await fs.writeFile(path.join(outDir, asset), bytes);
    } else {
      await fs.mkdir(path.dirname(path.join(outDir, ...rel.split('/'))), { recursive: true });
      await fs.writeFile(path.join(outDir, ...rel.split('/')), bytes);
    }
    files.push(entry);
  }
  if (!files.length) throw new Error('No app files found to publish.');

  const manifest = {
    version,
    releaseDate: new Date().toISOString(),
    notes: args.notes || '',
    files,
  };
  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Update channel v${manifest.version} written to ${outDir}`);
  console.log(`Files: ${files.map(f => f.path).join(', ')}`);
  if (github) {
    console.log('');
    console.log('Next steps:');
    console.log(`  1. Attach every file in ${outDir} (manifest.json included) as assets`);
    console.log(`     of GitHub release ${tagWithV}, e.g.:`);
    console.log(`     gh release create ${tagWithV} ${outDir}/* --title "${tagWithV}" --notes "..."`);
    console.log(`  2. Installed apps fetch https://github.com/${github}/releases/latest/download/manifest.json`);
  } else {
    console.log('');
    console.log('Next steps:');
    console.log('  1. Host this folder over HTTP(S) (any static host works).');
    console.log('  2. In the app: Settings → Update source → set <url>/manifest.json.');
    console.log('     (Or bake the URL in as DEFAULT_UPDATE_URL in electron/updater.cjs,');
    console.log('      or set the TREE_PLAYER_UPDATE_URL environment variable.)');
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
