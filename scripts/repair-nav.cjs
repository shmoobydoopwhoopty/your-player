// One off repair: restore the mangled $(fn) calls back to $('.nav-btn').forEach(fn)
const fs = require('fs');
let s = fs.readFileSync('index.html', 'utf8');
const before = s.length;

const mangledSimple = "$" + "(b=>b.classList.remove('active'))";
const fixedSimple = "$" + "('.nav-btn').forEach(b=>b.classList.remove('active'))";
const count0 = s.split(mangledSimple).length - 1;
s = s.split(mangledSimple).join(fixedSimple);

// $(b=>{...}) block style — three known sites, all iterate nav buttons.
const mangledBlock = "$" + "(b=>{";
const fixedBlock = "$" + "('.nav-btn').forEach(b=>{";
const count1 = s.split(mangledBlock).length - 1;
s = s.split(mangledBlock).join(fixedBlock);

fs.writeFileSync('index.html', s);
console.log('simple replacements:', count0, 'block replacements:', count1, 'size', before, '->', s.length);
