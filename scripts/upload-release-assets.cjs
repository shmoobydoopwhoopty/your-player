const https = require('https');
const fs = require('fs');
const path = require('path');

const token = process.env.GITHUB_TOKEN;
const repo = 'shmoobydoopwhoopty/your-player';
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : ''; };
const tag = flag('--tag') || 'v1.0.7';
const dir = path.resolve(__dirname, '..', flag('--dir') || 'release/update-channel');
const extraFiles = flag('--file') ? [flag('--file')] : [];
const notes = flag('--notes');

function api(callPath, method, body, isJson) {
  return new Promise((resolve, reject) => {
    const data = body || null;
    const headers = { 'Authorization': `token ${token}`, 'User-Agent': 'your-player-release-script' };
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

async function main() {
  let rel = await api(`/repos/${repo}/releases/tags/${tag}`, 'GET');
  if (rel.status === 404) {
    console.log(`release ${tag} not found — creating it`);
    rel = await api(`/repos/${repo}/releases`, 'POST', JSON.stringify({
      tag_name: tag,
      name: tag,
      body: notes || '',
      draft: false,
      prerelease: false,
    }), true);
    if (rel.status !== 201) { console.error('Could not create release:', rel.status, rel.raw.slice(0, 300)); process.exit(1); }
  } else if (rel.status !== 200) {
    console.error('Could not look up release:', rel.status, rel.raw.slice(0, 200));
    process.exit(1);
  }
  const releaseId = rel.json.id;
  const channelFiles = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name);
  const files = [...channelFiles.map(f => ({ name: f, full: path.resolve(dir, f) })), ...extraFiles.map(f => ({ name: path.basename(f), full: path.isAbsolute(f) ? f : path.resolve(__dirname, '..', f) }))];
  // GitHub normalizes asset names (spaces become dots) — compare normalized.
  const assetKey = n => String(n).replace(/\s+/g, '.').toLowerCase();
  const existingByName = new Map(rel.json.assets.map(a => [assetKey(a.name), a]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (const { name: file, full } of files) {
    const bytes = fs.readFileSync(full);
    const asset = existingByName.get(assetKey(file));
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
          'Authorization': `token ${token}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': bytes.length,
          'User-Agent': 'your-player-release-script',
        },
      }, res => {
        let out = '';
        res.on('data', c => out += c);
        res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(out); } catch { return null; } })() }));
      });
      req.on('error', reject);
      req.write(bytes);
      req.end();
    });
    console.log(`uploaded ${file}: ${upload.status} ${upload.json && upload.json.state ? upload.json.state : ''}`);
    if (upload.status !== 201) { console.error(`upload failed for ${file} — stopping so it can be retried`); process.exit(1); }
    await sleep(1500);
  }
  const check = await api(`/repos/${repo}/releases/tags/${tag}`, 'GET');
  console.log('assets now:', check.json.assets.map(a => `${a.name} (${a.size} bytes)`).join(', '));
}

main().catch(e => { console.error(e); process.exit(1); });
