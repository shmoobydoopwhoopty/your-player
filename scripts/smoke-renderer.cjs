// Runtime smoke test: executes the whole main script of index.html with a minimal
// DOM shim and prints the first runtime error, if any. Node only, no Electron needed.
const fs = require('fs');
const s = fs.readFileSync('index.html', 'utf8');
const scripts = [...s.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const main = scripts[scripts.length - 1];

function El(tag) {
  this.tagName = tag; this.children = []; this.dataset = {};
  this.style = { setProperty() {}, removeProperty() {} };
  this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  this._html = ''; this._text = ''; this.hidden = false; this.value = ''; this.handlers = {}; this._src = '';
}
El.prototype = {
  get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; this.children = []; },
  get textContent() { return this._text; }, set textContent(v) { this._text = v; },
  get src() { return this._src; }, set src(v) { this._src = v; },
  append(c) { this.children.push(c); },
  insertAdjacentText() {}, insertAdjacentHTML() {},
  addEventListener(t, f) { (this.handlers[t] = this.handlers[t] || []).push(f); },
  setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
  querySelector() { return null; }, querySelectorAll() { return []; },
  getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 30, left: 0, top: 0, right: 100, bottom: 30 }; },
  closest() { return null; }, focus() {}, scrollIntoView() {}, remove() {},
  replaceChildren() { this.children = []; },
  setPointerCapture() {}, releasePointerCapture() {},
  contains() { return false; }, matches() { return false; },
  cloneNode() { return new El(this.tagName); }, load() {}, pause() {},
  play() { return Promise.resolve(); },
};
const registry = {};
global.document = {
  documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, removeAttribute() {} },
  body: { dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, append() {}, style: {} },
  querySelector(sel) { if (!registry[sel]) registry[sel] = new El('div'); return registry[sel]; },
  querySelectorAll() { return []; },
  createElement(t) { return new El(t); },
  getElementById(id) { if (!registry['#' + id]) registry['#' + id] = new El('div'); return registry['#' + id]; },
  addEventListener() {}, title: '',
};
global.window = {
  addEventListener() {}, removeEventListener() {}, innerWidth: 1400, innerHeight: 900,
  location: { href: 'file://x' },
  matchMedia() { return { matches: false, addEventListener() {} }; },
  requestAnimationFrame() { return 0; }, AudioContext: null, webkitAudioContext: null,
};
global.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
global.indexedDB = { open() { const r = { onsuccess: null, onerror: null, onupgradeneeded: null, result: null, error: null }; setTimeout(() => { if (r.onsuccess) r.onsuccess(); }, 0); return r; } };
global.navigator = { userAgent: 'node', platform: 'win32', mediaSession: {} };
global.fetch = async () => { throw new Error('offline'); };
global.Element = El;
global.HTMLElement = El;
global.Image = class { set src(v) {} set onerror(f) {} };
global.URL.createObjectURL = () => 'blob:x';
global.crypto = require('crypto').webcrypto;
global.Worker = class { postMessage() {} terminate() {} };
global.Blob = class {};
global.File = class { constructor() { this.name = 'a.mp3'; this.size = 1; this.lastModified = 1; this.path = 'C:/x'; } };
global.confirm = () => true;
global.EventSource = class {};
global.CustomEvent = class {};
global.requestAnimationFrame = () => 0;
global.Node = El;

try {
  new Function(main)();
  console.log('MAIN_SCRIPT_EXECUTED_WITHOUT_RUNTIME_ERROR');
} catch (e) {
  console.log('RUNTIME_ERROR:', e.message);
  console.log('at:', (e.stack || '').split('\n').slice(1, 4).join(' | '));
}
process.exit(0);
