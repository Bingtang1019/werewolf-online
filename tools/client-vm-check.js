// 用 vm.runInThisContext 执行 client.js（真实作用域语义）+ 完整 mock
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const proj = path.resolve(__dirname, '..');
const _order = ['core.js','render.js','chat.js','game-actions.js','fx-sound.js','music.js','main.js'];
const src = _order.map(f => fs.readFileSync(path.join(proj, 'public', 'js', f), 'utf8')).join('\n');

// ---------- mock ----------
const elements = new Map();
function mkEl(id) {
  return {
    id, value: '', textContent: '', innerHTML: '', className: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    addEventListener(t, f) { (this._ls = this._ls || {})[t] = f; },
    removeEventListener() {}, appendChild() {}, removeChild() {}, insertBefore() {}, replaceChild() {},
    setAttribute() {}, getAttribute() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, focus() {}, click() {}, blur() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
    files: [], children: [], parentElement: null, _ls: {}
  };
}
const document = {
  getElementById(id) { if (!elements.has(id)) elements.set(id, mkEl(id)); return elements.get(id); },
  createElement(t) { return mkEl('__' + t); }, addEventListener() {}, removeEventListener() {},
  querySelector() { return null; }, querySelectorAll() { return []; },
  body: mkEl('body'), head: mkEl('head'), documentElement: mkEl('html'),
  title: '', cookie: '', hidden: false, visibilityState: 'visible'
};
const location = { href: 'http://localhost:3000/', origin: 'http://localhost:3000', protocol: 'http:', host: 'localhost:3000', hostname: 'localhost', port: '3000', pathname: '/', search: '', hash: '' };
const localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
const navigator = { userAgent: 'm', language: 'zh', clipboard: { writeText() { return Promise.resolve(); } }, sendBeacon() { return true; }, onLine: true, mediaDevices: {}, vibrate() {} };
const fetch = (u) => String(u).includes('playlist')
  ? Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
  : Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
function Audio() { this.play = () => Promise.resolve(); this.pause = () => {}; this.load = () => {}; this.src = ''; this.volume = 1; this.currentTime = 0; this.duration = 0; this.addEventListener = () => {}; this.muted = false; this.loop = false; }
function Notification() {} Notification.requestPermission = () => Promise.resolve('denied');
function EventSource() { this.addEventListener = () => {}; this.close = () => {}; }

// 沙箱
const sandbox = {
  document, window: null, location, localStorage, navigator, fetch, Audio, Notification, EventSource,
  setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {},
  requestAnimationFrame: () => 1, performance: { now: () => Date.now() },
  Math, Date, JSON, Object, Array, String, Number, Boolean, RegExp, Promise, console, URL, crypto: require('crypto'),
  confirm: () => true, alert: () => {}, prompt: () => null, matchMedia: () => ({ matches: false }),
  Blob: function () {}, FileReader: function () {}, FormData: function () {}, Map, Set, Error, TypeError, parseInt, parseFloat, isFinite, isNaN, encodeURIComponent, decodeURIComponent
};
sandbox.window = sandbox;

try {
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: 'client.js' });
  console.log('✅ client.js 顶层执行完成，无异常');
  const btn = document.getElementById('btn-music');
  console.log('btn-music:', btn._ls && btn._ls.click ? '✅ 绑定' : '❌');
  console.log('mp-play:', document.getElementById('mp-play')._ls && document.getElementById('mp-play')._ls.click ? '✅ 绑定' : '❌');
  console.log('card-create:', document.getElementById('card-create')._ls && document.getElementById('card-create')._ls.click ? '✅ 绑定' : '❌');
  console.log('btn-join-go:', document.getElementById('btn-join-go')._ls && document.getElementById('btn-join-go')._ls.click ? '✅ 绑定' : '❌');
} catch (e) {
  console.log('❌ 崩溃:', e.message);
  console.log((e.stack || '').split('\n').slice(0, 5).join('\n'));
}
