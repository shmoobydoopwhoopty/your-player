#!/usr/bin/env node
'use strict';
// One-command release: build → update channel → GitHub release → verify.
//
//   npm run release -- --notes "What changed"
//   npm run release -- --notes-file notes.md --skip-build
//   npm run release -- --dry-run            (build + channel, no upload)
//
// What it does:
//   1. checks the git state (warns about uncommitted / unpushed work)
//   2. builds the NSIS installer + portable exe with electron-builder
//   3. refuses to publish artifacts that are older than the code they should contain
//   4. regenerates release/update-channel/ from a clean folder, pointing at this tag
//   5. creates or updates the GitHub release and uploads every asset
//   6. downloads the published manifest back and checks the hashes the app will see
//
// Flags: --notes <text> --notes-file <path> --skip-build --allow-stale --dry-run
//        --verify-only --repo owner/name --tag vX.Y.Z --version X.Y.Z --channel-dir <dir>
//
// --verify-only re-checks an already published release (hashes + downloads)
// without building or uploading anything.

const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const has = name => args.includes(name);
const flag = (name, fallback = '') => {
  const i = args.indexOf(name);
  const next = i >= 0 ? args[i + 1] : undefined;
  return next && !next.startsWith('--') ? next : fallback;
};

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = flag('--version', pkg.version);
const tag = flag('--tag', `v${version}`).replace(/^v/, '');
const tagWithV = `v${tag}`;
const dryRun = has('--dry-run');
const skipBuild = has('--skip-build');

function detectRepo() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (m) return `${m[1]}/${m[2]}`;
  } catch {}
  return 'shmoobydoopwhoopty/your-player';
}

const repo = flag('--repo', detectRepo()).replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
const channelDir = path.resolve(ROOT, flag('--channel-dir', 'release/update-channel'));
const relPath = p => path.relative(ROOT, p).split(path.sep).join('/');

// Notes travel through a file so long text never has to survive shell quoting.
const notesFile = path.join(ROOT, 'release', '.release-notes.txt');
let notes = flag('--notes');
if (flag('--notes-file')) notes = fs.readFileSync(path.resolve(ROOT, flag('--notes-file')), 'utf8');
if (notes) {
  fs.mkdirSync(path.dirname(notesFile), { recursive: true });
  fs.writeFileSync(notesFile, notes);
}

function step(msg) { console.log(`\n=== ${msg} ===`); }
function ok(msg) { console.log(`  ok  ${msg}`); }
function warn(msg) { console.log(`  !!  ${msg}`); }
function die(msg) { console.error(`\nRelease stopped: ${msg}`); process.exit(1); }

function git(commandArgs) {
  try { return execFileSync('git', commandArgs, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

function checkGit() {
  step('Git state');
  const dirty = git(['status', '--porcelain']);
  if (dirty) {
    warn('working tree has uncommitted changes — the release will not match the repo:');
    for (const line of dirty.split('\n')) console.log(`        ${line}`);
  } else {
    ok('working tree clean');
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!upstream) {
    warn(`branch ${branch} has no upstream — push it first: git push -u origin ${branch}`);
  } else {
    const ahead = git(['rev-list', '--count', `${upstream}..HEAD`]);
    if (ahead && ahead !== '0') warn(`${ahead} commit(s) not pushed to ${upstream} — run git push, or the release won't match the repo`);
    else ok(`in sync with ${upstream}`);
  }
}

function build() {
  if (skipBuild) { step('Build skipped (--skip-build)'); return; }
  step(`Building Your Player ${version} (installer + portable exe)`);
  const res = spawnSync('npm run dist', { cwd: ROOT, stdio: 'inherit', shell: true });
  if (res.status !== 0) die(`npm run dist exited with ${res.status}`);
}

function packagedSources() {
  const sources = ['index.html', 'package.json'];
  const electronDir = path.join(ROOT, 'electron');
  if (fs.existsSync(electronDir)) {
    for (const f of fs.readdirSync(electronDir)) if (f.endsWith('.cjs')) sources.push(path.join('electron', f));
  }
  return sources;
}

function artifactPaths() {
  const setup = path.join(ROOT, 'release', `Your Player Setup ${version}.exe`);
  const portable = path.join(ROOT, 'release', `Your Player ${version}.exe`);
  const blockmap = `${setup}.blockmap`;
  return { setup, portable, blockmap };
}

function checkArtifacts({ freshness = true, required = true } = {}) {
  step(`Artifacts for ${version}`);
  const { setup, portable, blockmap } = artifactPaths();
  for (const f of [setup, portable]) {
    if (!fs.existsSync(f)) {
      if (required) die(`missing ${relPath(f)} — build it (drop --skip-build) or fix the version number`);
      warn(`missing ${relPath(f)} — skipped`);
      continue;
    }
    ok(`${path.basename(f)} — ${(fs.statSync(f).size / 1048576).toFixed(1)} MB`);
  }
  const files = [setup, portable].filter(f => fs.existsSync(f));
  if (fs.existsSync(blockmap)) { files.splice(1, 0, blockmap); ok(path.basename(blockmap)); }
  else warn('no .blockmap found — the release works, it just has no differential update data');
  if (!freshness) return files;

  // An installer built before the last source edit ships old code. Catch that here
  // rather than after it's published.
  const newest = packagedSources()
    .filter(rel => fs.existsSync(path.join(ROOT, rel)))
    .map(rel => ({ rel, mtime: fs.statSync(path.join(ROOT, rel)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  const builtAt = fs.statSync(setup).mtimeMs;
  if (newest && newest.mtime > builtAt) {
    const message = `${newest.rel} was edited ${new Date(newest.mtime).toLocaleString()} but the installer was built ${new Date(builtAt).toLocaleString()} — it does not contain that change`;
    if (has('--allow-stale')) warn(`${message} (continuing because of --allow-stale)`);
    else die(`${message}. Rebuild without --skip-build, or pass --allow-stale if you know better.`);
  } else {
    ok('installer is newer than every packaged source file');
  }
  return files;
}

function buildChannel() {
  step('Update channel');
  const scriptArgs = ['--github', repo, '--tag', tagWithV, '--clean', '--out', relPath(channelDir)];
  if (notes) scriptArgs.push('--notes-file', relPath(notesFile));
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'publish-update.js'), ...scriptArgs], { cwd: ROOT, stdio: 'inherit' });
  if (res.status !== 0) die(`publish-update.js exited with ${res.status}`);

  const manifest = JSON.parse(fs.readFileSync(path.join(channelDir, 'manifest.json'), 'utf8'));
  if (manifest.version !== version) die(`the manifest says ${manifest.version} but package.json says ${version}`);
  ok(`manifest v${manifest.version} with ${manifest.files.length} app files`);
  for (const f of manifest.files) {
    if (!f.url.includes(`/${tagWithV}/`)) die(`manifest entry ${f.path} points at ${f.url}, not at ${tagWithV}`);
  }
  return manifest;
}

function upload(files) {
  step(dryRun ? `Would publish release ${tagWithV}` : `Publishing release ${tagWithV} on ${repo}`);
  const scriptArgs = ['--repo', repo, '--tag', tagWithV, '--dir', relPath(channelDir)];
  for (const f of files) scriptArgs.push('--file', f);
  if (notes) scriptArgs.push('--notes-file', relPath(notesFile));
  if (dryRun) scriptArgs.push('--dry-run');
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'upload-release-assets.cjs'), ...scriptArgs], { cwd: ROOT, stdio: 'inherit' });
  if (res.status !== 0) die(`upload-release-assets.cjs exited with ${res.status}`);
}

function get(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: extraHeaders || {} }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), extraHeaders));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error(`timed out fetching ${url}`)));
  });
}

// Fetch what the app itself will fetch and confirm it matches what we built.
// `strict` is on right after an upload (the local exe is what we just published);
// when re-checking an older release, a size difference just means a rebuild.
async function verify(files, { strict = true } = {}) {
  step('Verifying what GitHub serves');
  const latest = await get(`https://github.com/${repo}/releases/latest/download/manifest.json`);
  if (latest.status !== 200) die(`releases/latest/download/manifest.json returned ${latest.status}`);
  const live = JSON.parse(latest.body.toString('utf8'));
  if (live.version !== version) die(`releases/latest serves v${live.version}, expected v${version}`);
  ok(`releases/latest serves v${live.version}`);

  for (const entry of live.files) {
    const name = entry.path.split('/').pop();
    const res = await get(entry.url);
    if (res.status !== 200) die(`${name} download returned ${res.status}`);
    const sha = crypto.createHash('sha256').update(res.body).digest('hex');
    if (sha !== entry.sha256) die(`${name} hash mismatch — GitHub serves ${sha.slice(0, 12)}…, the manifest promises ${entry.sha256.slice(0, 12)}…`);
    ok(`${name} matches its manifest hash`);
  }

  for (const f of files) {
    const name = path.basename(f).replace(/\s+/g, '.');
    const res = await get(`https://github.com/${repo}/releases/download/${tagWithV}/${encodeURIComponent(name)}`, { Range: 'bytes=0-0' });
    if (res.status !== 200 && res.status !== 206) die(`${name} returned ${res.status}`);
    const range = /bytes 0-0\/(\d+)/.exec(res.headers['content-range'] || '');
    const size = range ? Number(range[1]) : Number(res.headers['content-length'] || 0);
    if (!size) die(`${name} is served with no size — the upload looks broken`);
    const expected = fs.statSync(f).size;
    if (size !== expected) {
      const message = `${name}: GitHub serves ${size} bytes, the local build is ${expected}`;
      if (strict) die(`${message} — the uploaded asset does not match the build`);
      warn(`${message} — normal if you rebuilt since publishing; the asset itself is fine`);
    }
    ok(`${name} downloadable (${(size / 1048576).toFixed(1)} MB)`);
  }
}

async function main() {
  console.log(`Your Player ${version} → ${repo} (${tagWithV})${dryRun ? '  [dry run]' : ''}`);
  if (has('--verify-only')) {
    checkGit();
    step('Verify only — no build, no upload');
    await verify(checkArtifacts({ freshness: false, required: false }), { strict: false });
    console.log(`\nRelease v${version} on GitHub matches this checkout.`);
    return;
  }
  checkGit();
  build();
  const files = checkArtifacts();
  buildChannel();
  upload(files);
  if (dryRun) {
    console.log('\nDry run: the channel was rebuilt and no release was touched.');
    console.log(`Publish for real with: npm run release${skipBuild ? '' : ' --skip-build'}${notes ? '' : ' --notes "What changed"'}`);
    return;
  }
  await verify(files);
  console.log(`\nReleased v${version}: https://github.com/${repo}/releases/tag/${tagWithV}`);
  console.log('Installed apps pick it up from releases/latest/download/manifest.json.');
}

main().catch(e => { console.error(e); process.exit(1); });
