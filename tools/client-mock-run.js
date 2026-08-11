// 最小 DOM mock 执行 client.js——定位运行时崩溃点
const fs = require('fs');
const path = require('path');
const proj = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(proj, 'public', 'client.js'), 'utf8');

// --- 最小 DOM mock ---
const elements = new Map();
function mkEl(id) {
  return {
    id, value: '', textContent: '', innerHTML: '', className: '', classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    style: {}, dataset: {}, checked: false, disabled: false,
    addEventListener(type, fn) { (this._ls = this._ls || {})[type] = fn; },
    removeEventListener() {},
    appendChild() {}, removeChild() {}, insertBefore() {}, replaceChild() {},
    setAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, focus() {}, click() {}, blur() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
    scrollTop: 0, scrollHeight: 0, clientHeight: 0, offsetTop: 0, offsetHeight: 0,
    files: [], options: [], children: [], parentElement: null,
    _ls: {}
  };
}
global.document = {
  getElementById(id) { if (!elements.has(id)) elements.set(id, mkEl(id)); return elements.get(id); },
  createElement(tag) { return mkEl('__' + tag + '_' + Math.random()); },
  addEventListener() {}, removeEventListener() {},
  querySelector() { return null; }, querySelectorAll() { return []; },
  body: mkEl('body'), head: mkEl('head'), documentElement: mkEl('html'),
  title: '', cookie: '', hidden: false, visibilityState: 'visible',
  execCommand() { return false; }
};
global.window = global;
global.location = { href: 'http://localhost:3000/', origin: 'http://localhost:3000', protocol: 'http:', host: 'localhost:3000', hostname: 'localhost', port: '3000', pathname: '/', search: '', hash: '', reload() {}, replace() {} };
global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
global.navigator = { userAgent: 'mock', language: 'zh', clipboard: { writeText() { return Promise.resolve(); } }, sendBeacon() { return true; }, onLine: true, mediaDevices: {}, vibrate() {} };
global.fetch = (url) => {
  // 歌单返回空数组；其他返回 404
  if (String(url).includes('playlist')) return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
};
global.Audio = function () { this.play = () => Promise.resolve(); this.pause = () => {}; this.load = () => {}; this.src = ''; this.volume = 1; this.currentTime = 0; this.duration = 0; this.addEventListener = () => {}; this.removeEventListener = () => {}; this.muted = false; this.loop = false; };
global.Notification = function () {}; global.Notification.requestPermission = () => Promise.resolve('denied');
global.setInterval = () => 1; global.clearInterval = () => {}; global.setTimeout = () => 1; global.clearTimeout = () => {};
global.requestAnimationFrame = () => 1;
global.performance = { now: () => Date.now() };
global.Math.random = () => 0.5;
global.confirm = () => true; global.alert = () => {}; global.prompt = () => null;
global.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
global.URL = require('url').URL;
global.crypto = require('crypto');
global.Blob = function () {}; global.FileReader = function () {};
global.EventSource = function () { this.addEventListener = () => {}; this.close = () => {}; };

// --- 执行 client.js，捕获异常 ---
try {
  const fn = new Function(src + '\n;global.__RUN_RESULT__ = { ok: true };');
  fn();
  console.log('✅ client.js 顶层执行完成，无异常');
  // 检查关键绑定是否存在
  const btn = global.document.getElementById('btn-music');
  console.log('btn-music 绑定:', btn._ls && btn._ls.click ? '✅' : '❌');
  const play = global.document.getElementById('mp-play');
  console.log('mp-play 绑定:', play._ls && play._ls.click ? '✅' : '❌');
  const create = global.document.getElementById('card-create');
  console.log('card-create 绑定:', create._ls && create._ls.click ? '✅' : '❌');
  const join = global.document.getElementById('btn-join-go');
  console.log('btn-join-go 绑定:', join._ls && join._ls.click ? '✅' : '❌');
} catch (e) {
  console.log('❌ 顶层执行崩溃:');
  console.log('   ' + e.message);
  console.log('   堆栈:', (e.stack || '').split('\n').slice(0, 4).join('\n    '));
}
