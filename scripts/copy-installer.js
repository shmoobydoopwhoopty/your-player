// Copies the newest "Your Player Setup *.exe" from release/ into installer/
// so the distributable always lives in one predictable place after a build.
const fs = require('node:fs');
const path = require('node:path');

const releaseDir = path.join(__dirname, '..', 'release');
const installerDir = path.join(__dirname, '..', 'installer');
fs.mkdirSync(installerDir, { recursive: true });

const setups = fs.readdirSync(releaseDir)
  .filter(f => /^Your Player Setup .*\.exe$/i.test(f))
  .map(f => {
    const full = path.join(releaseDir, f);
    return { file: f, full, mtime: fs.statSync(full).mtimeMs };
  })
  .sort((a, b) => b.mtime - a.mtime);

if (!setups.length) {
  console.error('No "Your Player Setup *.exe" found in release/ — nothing to copy.');
  process.exit(1);
}

// Remove old installers from installer/ so only the current one remains.
for (const entry of fs.readdirSync(installerDir)) {
  if (/^Your Player Setup .*\.exe$/i.test(entry) && entry !== setups[0].file) {
    fs.unlinkSync(path.join(installerDir, entry));
  }
}

const target = path.join(installerDir, setups[0].file);
fs.copyFileSync(setups[0].full, target);
console.log(`Installer copied: installer/${setups[0].file}`);
