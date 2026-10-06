const https = require('https');
const fs = require('fs');
const path = require('path');

const token = process.env.GITHUB_TOKEN;
const repo = 'shmoobydoopwhoopty/your-player';
const tag = 'v1.0.6';
const dir = path.join(__dirname, '..', 'release', 'update-channel');
const files = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name);

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
  const rel = await api(`/repos/${repo}/releases/tags/${tag}`, 'GET');
  if (rel.status !== 200) { console.error('Release not found:', rel.status, rel.raw.slice(0, 200)); process.exit(1); }
  const releaseId = rel.json.id;
  const existing = new Set(rel.json.assets.map(a => a.name));
  for (const file of files) {
    const full = path.join(dir, file);
    const bytes = fs.readFileSync(full);
    if (existing.has(file)) {
      const asset = rel.json.assets.find(a => a.name === file);
      const del = await api(`/repos/${repo}/releases/assets/${asset.id}`, 'DELETE');
      console.log(`deleted existing ${file}: ${del.status}`);
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
  }
  const check = await api(`/repos/${repo}/releases/tags/${tag}`, 'GET');
  console.log('assets now:', check.json.assets.map(a => `${a.name} (${a.size} bytes)`).join(', '));
}

main().catch(e => { console.error(e); process.exit(1); });
