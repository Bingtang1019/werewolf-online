'use strict';
/* 客户端渲染 harness：Node + DOM stub 直接执行 client.js 的渲染链
 * 用于定位"夜晚无行动按钮/频道消失"的真实崩溃点 */
const fs = require('fs');
const path = require('path');
const proj = path.resolve(__dirname, '..');

/* ---------- 浏览器 API stub ---------- */
function elStub() {
  return {
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty() {}, removeProperty() {} },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    innerHTML: '', textContent: '', value: '', placeholder: '', disabled: false, checked: false,
    addEventListener() {}, removeEventListener() {}, focus() {}, select() {}, click() {},
    appendChild() {}, removeChild() {}, insertBefore() {}, firstChild: null, lastChild: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    animate: () => ({ cancel() {} }),
    dataset: {}, width: 0, height: 0, src: '', href: '', scrollIntoView() {},
  };
}
const elMap = new Map();
global.document = {
  getElementById: id => { if (!elMap.has(id)) elMap.set(id, elStub()); return elMap.get(id); },
  querySelector: () => elStub(),
  querySelectorAll: () => [],
  createElement: () => elStub(),
  addEventListener() {},
  body: elStub(),
  documentElement: elStub(),
  title: '',
};
global.window = global;
global.self = global;
global.addEventListener = () => {};
global.removeEventListener = () => {};
global.matchMedia = () => ({ matches: false, addEventListener() {} });
global.innerWidth = 800; global.innerHeight = 600;
global.scrollTo = () => {};
global.location = { href: 'http://localhost/', origin: 'http://localhost', pathname: '/', search: '', protocol: 'http:', reload() {}, assign() {} };
global.history = { pushState() {}, replaceState() {} };
global.localStorage = { _s: {}, getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
Object.defineProperty(global, 'navigator', { value: { clipboard: undefined, vibrate() {}, share() {}, serviceWorker: undefined, userAgent: 'test', onLine: true, language: 'zh-CN' }, configurable: true });
global.fetch = async () => ({ json: async () => ({}), ok: true, status: 200 });
global.EventSource = class { constructor() {} close() {} };
global.setInterval = () => 0; global.clearInterval = () => {};
global.requestAnimationFrame = () => 0;
global.performance = { now: () => Date.now() };
global.AudioContext = undefined;
global.URLSearchParams = URLSearchParams;
global.Promise = Promise;
global.Math = Math;

/* ---------- eval public/js 拆分模块（跳过末尾 init() 调用，仅加载函数定义） ---------- */
const JS_ORDER = ['core.js', 'delegate.js', 'render.js', 'chat.js', 'game-actions.js', 'fx-sound.js', 'music.js', 'main.js'];
let code = JS_ORDER.map(f => fs.readFileSync(path.join(proj, 'public/js', f), 'utf8')).join('\n');
code = code.replace(/^'use strict'\s*;?\s*/gm, ''); // 严格模式下顶层函数声明不泄漏到 global，harness 需剥离
code = code.replace(/\ninit\(\);\s*$/, '\n// init() skipped in harness\n');
let evalErr = null;
try { (0, eval)(code); } catch (e) { evalErr = e; }
if (evalErr) { console.error('public/js 顶层执行异常:', evalErr.stack); process.exit(1); }
console.log('✓ public/js 顶层执行无异常（eval 成功）');
if (typeof global.renderPanel !== 'function') { console.error('renderPanel 未定义'); process.exit(1); }
console.log('✓ renderPanel/renderNight 已加载');

module.exports = { renderPanel: global.renderPanel, applyView: global.applyView, render: global.render, renderNight: global.renderNight, renderChat: global.renderChat, getEl: id => elMap.get(id) };
