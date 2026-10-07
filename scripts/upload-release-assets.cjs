#!/usr/bin/env node
'use strict';
// Upload the update channel (and the installers) to a GitHub release.
// Creates the release if the tag doesn't exist yet, and replaces assets that
// are already there so re-publishing the same version stays idempotent.
//
//   node scripts/upload-release-assets.cjs [--tag v1.0.8] [--dir release/update-channel]
//        [--file "release/Your Player Setup 1.0.8.exe"] [--file ...]
//        [--notes "What changed"] [--notes-file notes.md]
//        [--repo owner/name] [--dry-run] [--only-missing] [--no-latest]
//
// Publishing marks the release as GitHub's latest by default, which is what the
// app's update check reads (releases/latest/download/manifest.json).
//
// Auth: set GITHUB_TOKEN (or GH_TOKEN), or just be signed in with the gh CLI —
// the token is read from `gh auth token` when the environment has none.

const { execFileSync } = require('node:child_process');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const args = process.argv.slice(2);
const has = name => args.includes(name);
const flag = (name, fallback = '') => {
  const i = args.indexOf(name);
  const next = i >= 0 ? args[i + 1] : undefined;
  return next && !next.startsWith('--') ? next : fallback;
};
const flagAll = name => {
  const out = [];
  args.forEach((a, i) => {
    const next = args[i + 1];
    if (a === name && next && !next.startsWith('--')) out.push(next);
  });
  return out;
};

function detectRepo() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (m) return `${m[1]}/${m[2]}`;
  } catch {}
  return 'shmoobydoopwhoopty/your-player';
}

// Prefer the environment, then fall back to a signed-in gh CLI so publishing
// works without exporting anything by hand.
function resolveToken() {
  const fromEnv = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (fromEnv) return { token: fromEnv, from: 'environment' };
  const candidates = [
    process.env.GH_BIN,
    'gh',
    path.join(os.homedir(), '.gh-cli', 'bin', process.platform === 'win32' ? 'gh.exe' : 'gh'),
    '/usr/local/bin/gh',
    '/opt/homebrew/bin/gh',
  ].filter(Boolean);
  for (const gh of candidates) {
    try {
      const token = execFileSync(gh, ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (token) return { token, from: `gh CLI (${gh})` };
    } catch {}
  }
  return null;
}

const repo = flag('--repo', detectRepo()).replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
const tag = flag('--tag', `v${pkg.version}`).replace(/^v/, '');
const tagWithV = `v${tag}`;
const dir = path.resolve(ROOT, flag('--dir', 'release/update-channel'));
const dryRun = has('--dry-run');
const onlyMissing = has('--only-missing');
const makeLatest = !has('--no-latest');
const notes = flag('--notes') || (flag('--notes-file') ? fs.readFileSync(path.resolve(ROOT, flag('--notes-file')), 'utf8') : '');
// Resolve once — spawning the gh CLI per API call would add a second each time.
const auth = resolveToken();

function api(callPath, method, body, isJson) {
  return new Promise((resolve, reject) => {
    const data = body || null;
    const headers = { 'Authorization': `token ${auth ? auth.token : ''}`, 'User-Agent': 'your-player-release-script' };
    if (isJson) headers['Content-Type'] = 'application/json';
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ hostname: 'api.github.com', path: callPath, method, headers }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(out); } catch { return null; } })(), raw: out }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function collectFiles() {
  const fromDir = fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, full: path.resolve(dir, e.name) }))
    : [];
  const extra = flagAll('--file').map(f => ({
    name: path.basename(f),
    full: path.isAbsolute(f) ? f : path.resolve(ROOT, f),
  }));
  for (const f of [...fromDir, ...extra]) {
    if (!fs.existsSync(f.full)) { console.error(`Missing file: ${f.full}`); process.exit(1); }
  }
  return [...fromDir, ...extra];
}

async function main() {
  if (!fs.existsSync(dir)) console.error(`Warning: channel folder ${dir} does not exist — only --file assets will be uploaded.`);
  const files = collectFiles();
  if (!files.length) { console.error('Nothing to upload.'); process.exit(1); }

  console.log(`\nRelease ${tagWithV} on ${repo}`);
  console.log(`Assets (${files.length}):`);
  for (const f of files) console.log(`  ${f.name}  (${(fs.statSync(f.full).size / 1048576).toFixed(2)} MB)`);

  if (!auth && !dryRun) {
    console.error('\nNo GitHub token found. Either set GITHUB_TOKEN, or sign in once with the gh CLI (gh auth login).');
    process.exit(1);
  }
  console.log(auth ? `Auth: ${auth.from}` : 'Auth: none (unauthenticated request)');

  if (dryRun) {
    const rel = await api(`/repos/${repo}/releases/tags/${tagWithV}`, 'GET');
    console.log(`\nDry run — found ${rel.status === 200 ? 'an existing release' : `no release (${rel.status})`}, would upload ${files.length} asset(s)${makeLatest ? ' and mark it latest' : ''}. Nothing was changed.`);
    return;
  }

  let rel = await api(`/repos/${repo}/releases/tags/${tagWithV}`, 'GET');
  if (rel.status === 404) {
    console.log(`\nrelease ${tagWithV} not found — creating it`);
    rel = await api(`/repos/${repo}/releases`, 'POST', JSON.stringify({
      tag_name: tagWithV,
      name: tagWithV,
      body: notes || '',
      draft: false,
      prerelease: false,
    }), true);
    if (rel.status !== 201) { console.error('Could not create release:', rel.status, rel.raw.slice(0, 300)); process.exit(1); }
  } else if (rel.status !== 200) {
    console.error('Could not look up release:', rel.status, rel.raw.slice(0, 200));
    process.exit(1);
  } else if (notes) {
    const patched = await api(`/repos/${repo}/releases/${rel.json.id}`, 'PATCH', JSON.stringify({ body: notes }), true);
    console.log(`updated release notes: ${patched.status}`);
  }

  const releaseId = rel.json.id;
  // GitHub normalizes asset names (spaces become dots) — compare normalized.
  const assetKey = n => String(n).replace(/\s+/g, '.').toLowerCase();
  const existingByName = new Map(rel.json.assets.map(a => [assetKey(a.name), a]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (onlyMissing) console.log('(--only-missing: assets already on the release with the same size are left alone)');

  for (const { name: file, full } of files) {
    const bytes = fs.statSync(full).size;
    const asset = existingByName.get(assetKey(file));
    if (asset && onlyMissing && asset.size === bytes) {
      console.log(`skipped ${file} — already uploaded at the same size (${bytes} bytes)`);
      continue;
    }
    if (asset) {
      const del = await api(`/repos/${repo}/releases/assets/${asset.id}`, 'DELETE');
      console.log(`deleted existing ${file}: ${del.status}`);
      await sleep(1500);
    }
    const upload = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'uploads.github.com',
        path: `/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(file)}`,
        method: 'POST',
        headers: {
          'Authorization': `token ${auth.token}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': bytes,
          'User-Agent': 'your-player-release-script',
        },
      }, res => {
        let out = '';
        res.on('data', c => out += c);
        res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(out); } catch { return null; } })() }));
      });
      req.on('error', reject);
      // Stream from disk so big installers don't sit in memory.
      fs.createReadStream(full).pipe(req);
    });
    console.log(`uploaded ${file}: ${upload.status} ${upload.json && upload.json.state ? upload.json.state : ''}`);
    if (upload.status !== 201) { console.error(`upload failed for ${file} — stopping so it can be retried`); process.exit(1); }
    await sleep(1500);
  }

  if (makeLatest) {
    const latest = await api(`/repos/${repo}/releases/${releaseId}`, 'PATCH', JSON.stringify({ make_latest: 'true' }), true);
    console.log(`marked ${tagWithV} as the latest release: ${latest.status}`);
  } else {
    console.log('(--no-latest: left the latest pointer alone.)');
    console.log(`GitHub still treats the newest release as latest, so if this tag is newer than`);
    console.log(`the release your users run, re-point it: gh release edit <tag> --latest`);
  }

  const check = await api(`/repos/${repo}/releases/tags/${tagWithV}`, 'GET');
  console.log('\nassets now:');
  for (const a of check.json.assets) console.log(`  ${a.name} (${a.size} bytes)`);
  console.log(`\nhttps://github.com/${repo}/releases/tag/${tagWithV}`);
}

main().catch(e => { console.error(e); process.exit(1); });
