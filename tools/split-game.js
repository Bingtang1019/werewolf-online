// game.js 拆分（B方案：ctx 注册表 + 跨模块调用自动改写）
// 用法：node tools/split-game.js
// 产物：server/game/*.js + game.js 改为薄入口
const fs = require('fs');
const path = require('path');
const proj = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(proj, 'game.js'), 'utf8');
if (!src.includes('function ') || src.includes('module.exports = require')) {
  console.error('[split-game] 检测到 game.js 已是薄入口（单体源码已不存在），禁止运行，避免覆盖 server/game/*');
  process.exit(1);
}
const lines = src.split('\n');

// ---------- 模块行区间 ----------
const SEGMENTS = [
  { file: 'shared', start: 1, end: 435 },
  { file: 'flow', start: 436, end: 1020 },
  { file: 'vote', start: 1021, end: 1417 },
  { file: 'chat', start: 1418, end: 1635 },
  { file: 'actions', start: 1636, end: 1917 },
  { file: 'bot', start: 1918, end: 2054 },
  { file: 'view', start: 2055, end: 2288 },
];

// ---------- 函数归属 ----------
const re = /^\s*function (\w+)/gm;
let m, fns = [];
while ((m = re.exec(src))) {
  const line = src.slice(0, m.index).split('\n').length;
  fns.push({ name: m[1], line });
}
const fnMod = {};
for (const f of fns) fnMod[f.name] = SEGMENTS.find(s => f.line >= s.start && f.line <= s.end).file;
const allFnNames = new Set(fns.map(f => f.name));

// ---------- shared 区顶层变量 ----------
const sharedTopVars = new Set();
for (let k = 0; k < 435; k++) {
  const mm = lines[k].match(/^(let|const|var)\s+(\w+)/);
  if (mm) sharedTopVars.add(mm[2]);
}
['crypto', 'fs'].forEach(x => sharedTopVars.delete(x)); // 仅 shared 内部用
// loverCore/clock/chatRecorder/voteFeatures/createRng/bot-brain 解构等被其他模块引用——保留导出
['createBotDecision', 'botWolfChat', 'resetBotPerGame', 'injectGrudge'].forEach(x => sharedTopVars.add(x));

// ---------- 模块处理（跨模块调用改写） ----------
function processModule(seg, body) {
  const myFns = new Set(fns.filter(f => f.line >= seg.start && f.line <= seg.end).map(f => f.name));
  // 需要改写的函数：其他模块的函数 + shared 区的函数（都进 ctx）
  const rewriteSet = new Set(fns.filter(f => fnMod[f.name] !== seg.file).map(f => f.name));
  // 不改写：本模块函数；shared 区函数在自己模块内不用 ctx（shared 是定义处）
  const outLines = [];
  for (const line of body.split('\n')) {
    let l = line;
    // 跳过注释行/字符串行（简单启发：trim 后以 * 或 // 开头）
    const t = l.trim();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) { outLines.push(l); continue; }
    // 1) 调用改写：函数名( → ctx.函数名(
    for (const fn of rewriteSet) {
      const rx = new RegExp('(?<![\\w.\\/\\/\\-])' + fn + '(?=\\s*\\()', 'g');
      l = l.replace(rx, 'ctx.' + fn);
    }
    // 2) 无括号引用改写：\b函数名\b（后面非 ( ）→ ctx.函数名（仅当行内出现且非定义处）
    for (const fn of rewriteSet) {
      if (myFns.has(fn)) continue;
      const rx2 = new RegExp('(?<![\\w.])' + fn + '(?![\\w(:])', 'g'); // 后跟 : 是属性键——跳过
      l = l.replace(rx2, 'ctx.' + fn);
    }
    outLines.push(l);
  }
  return outLines.join('\n');
}

// ---------- require 路径修正 ----------
function fixRequires(body) {
  // 原 game.js 在根目录的相对 require → server/game/ 下需加 ../../（除 ./game.js 自引用）
  const map = {
    "'./bot-brain'": "'../../bot-brain'",
    "'./loverCore.js'": "'../../loverCore.js'",
    "'./server/ai/features.js'": "'../../server/ai/features.js'",
    "'./server/ai/rng.js'": "'../../server/ai/rng.js'",
    "'./server/clock'": "'../../server/clock'",
    "'./chat-recorder'": "'../../chat-recorder'",
    "'./server/ai/belief-engine.js'": "'../../server/ai/belief-engine.js'",
    "'./game.js'": "'../../game.js'",
  };
  for (const [from, to] of Object.entries(map)) body = body.split(from).join(to);
  return body;
}

// ---------- 生成 ----------
const outDir = path.join(proj, 'server', 'game');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const hdr = (name) => '// 自动生成（game.js 拆分——' + name + '，勿手改，重新运行 tools/split-game.js）\n';

// shared.js（基础设施——同样做跨模块改写：shared 函数调用其他模块函数 → ctx.）
let sharedBody = lines.slice(0, 435).join('\n');
// 跨模块改写（shared 区函数调用 flow/vote/view 等的函数 → ctx.）
{
  const myFns = new Set(fns.filter(f => f.line <= 435).map(f => f.name));
  const rewriteSet = new Set(fns.filter(f => f.line > 435).map(f => f.name));
  const sLines = sharedBody.split('\n').map(line => {
    const t = line.trim();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return line;
    let l = line;
    for (const fn of rewriteSet) {
      const rx = new RegExp('(?<![\\w.\\/\\:\\-])' + fn + '(?=\\s*\\()', 'g');
      l = l.replace(rx, 'ctx.' + fn);
      const rx2 = new RegExp('(?<![\\w.])' + fn + '(?![\\w(:])', 'g');
      l = l.replace(rx2, 'ctx.' + fn);
    }
    return l;
  });
  sharedBody = sLines.join('\n');
}
sharedBody = fixRequires(sharedBody);
// 头部注入 ctx/register（放在 'use strict' 之后）
const strictIdx = sharedBody.indexOf("'use strict'");
const inject = "'use strict';\n\nconst ctx = {};\nfunction register(name, fn) { ctx[name] = fn; }\n";
if (strictIdx >= 0) sharedBody = sharedBody.slice(0, strictIdx) + inject + sharedBody.slice(strictIdx + "'use strict'".length);
// shared 区函数注册（bump/byId 等——跨模块 ctx 调用需要）
const sharedFns = fns.filter(f => f.line <= 435).map(f => f.name);
const sharedReg = sharedFns.map(n => 'register(' + JSON.stringify(n) + ', ' + n + ');').join('\n');
// 导出全部 shared 区变量 + require 模块 + bot-brain 解构 + setter
const sharedExports = [...sharedTopVars, 'loverCore', 'clock', 'chatRecorder', 'voteFeatures', 'createRng', 'createBotDecision', 'botWolfChat', 'resetBotPerGame', 'injectGrudge'].join(', ');
fs.writeFileSync(path.join(outDir, 'shared.js'), hdr('shared 基础设施 + ctx 注册表') + sharedBody + '\n\n' + sharedReg + '\n\n// 导出全部共享变量/模块/setter\nmodule.exports = { ctx, register, ' + sharedExports + ', setOnChange(fn) { onChange = fn; }, setOnBroken(fn) { onBroken = fn; } };\n', 'utf8');
console.log('✅ shared.js（注册 ' + sharedFns.length + ' 函数）');

// 其他模块
for (const seg of SEGMENTS.slice(1)) {
  let body = lines.slice(seg.start - 1, seg.end).join('\n');
  // view 区含原导出块（module.exports）——截断（导出由 index.js 统一）
  if (seg.file === 'view') {
    const expPos = body.indexOf('\nmodule.exports = {');
    if (expPos >= 0) body = body.slice(0, expPos);
  }
  body = processModule(seg, body);
  body = fixRequires(body);
  // 本模块引用的 shared 区变量（自动检测——函数体里出现的 shared 区顶层变量名）
  const usedShared = [];
  for (const v of sharedTopVars) {
    // 排除函数名（shared 区函数也被列在 sharedTopVars？不——sharedTopVars 是变量）
    if (new RegExp('\\b' + v + '\\b').test(body)) usedShared.push(v);
  }
  // 排除已在 shared 区定义的（body 里包含定义行）
  const localDefs = new Set();
  for (const l of body.split('\n')) {
    const mm = l.match(/^(let|const|var)\s+(\w+)/);
    if (mm) localDefs.add(mm[1]);
  }
  const needShared = usedShared.filter(v => !localDefs.has(v));
  const destructure = needShared.length ? 'const { ' + needShared.join(', ') + ' } = shared;\n' : '';
  // 本模块函数名（注册用）
  const myFns = fns.filter(f => f.line >= seg.start && f.line <= seg.end).map(f => f.name);
  const regLines = myFns.map(n => 'register(' + JSON.stringify(n) + ', ' + n + ');').join('\n');
  const content = hdr(seg.file + ' 模块') + '\nconst shared = require(\'./shared\');\nconst ctx = shared.ctx;\nconst { register } = shared;\n' + destructure + '\n' + body + '\n\n' + regLines + '\n\nmodule.exports = {};\n';
  fs.writeFileSync(path.join(outDir, seg.file + '.js'), content, 'utf8');
  console.log('✅ ' + seg.file + '.js（注册 ' + myFns.length + ' 函数）');
}

// index.js（聚合导出——从 ctx 取）
const expIdx = lines.findIndex(l => l.includes('module.exports'));
const expBlock = lines.slice(expIdx).join('\n');
// 简写属性名 → ctx.名（setOnChange 等方法保留原样——它们是 shared 区闭包函数）
const shorthandRe = /^\s{2}(\w+),?$/gm;
const fixedExp = expBlock.replace(shorthandRe, (match, name) => {
  if (name.startsWith('setOn')) return match; // setter 方法保留
  return '  ' + name + ': shared.ctx[' + JSON.stringify(name) + '],';
});
// 多行简写（ROLE_INFO, rooms, createRoom, ... 同一行）——改为 名字: ctx[名字]
const inlineRe = /(\w+),/g;
const fixedExp2 = fixedExp.split('\n').map(l => {
  if (/^module\.exports|^};|^\s{2}setOn/.test(l)) return l;
  return l.replace(inlineRe, (mm, name) => {
    if (['debugRoom', 'ROLE_INFO', 'rooms', 'createRoom', 'joinRoom', 'handleAction', 'handleChat', 'handleAdvance', 'handleLeave', 'handleKick', 'viewFor', 'resumeRoom', 'byToken', 'removePlayer', 'handleMusic', 'checkWin', 'addMessage', 'flushLabSamples'].includes(name)) {
      return name + ': shared.ctx[' + JSON.stringify(name) + '],';
    }
    return mm;
  });
}).join('\n');
// 需要从 shared 直接拿的（非函数——ctx 只注册函数）
const sharedVals = ['rooms', 'ROLE_INFO'];
const indexContent = hdr('index 聚合导出') + `
const shared = require('./shared');
require('./flow');
require('./vote');
require('./chat');
require('./actions');
require('./bot');
require('./view');

` + fixedExp2.replace('setOnChange(fn) { onChange = fn; },', 'setOnChange: shared.setOnChange,').replace('setOnBroken(fn) { onBroken = fn; },', 'setOnBroken: shared.setOnBroken,').split('\n').map(l => {
  for (const v of sharedVals) {
    l = l.replace(new RegExp('\\b' + v + ': shared\.ctx\\[' + JSON.stringify(v) + '\\]'), v + ': shared.' + v);
  }
  return l;
}).join('\n') + `
`;
fs.writeFileSync(path.join(outDir, 'index.js'), indexContent, 'utf8');
console.log('✅ index.js（聚合导出）');

// game.js 薄入口
const thin = '// game.js（薄入口——已拆分为 server/game/，勿手改）\nmodule.exports = require(\'./server/game\');\n';
fs.writeFileSync(path.join(proj, 'game.js'), thin, 'utf8');
console.log('✅ game.js → 薄入口');

console.log('\n完成。下一步：语法 + 加载 + 全量测试');
