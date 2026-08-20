// bot-brain.js 拆分脚本（B 方案：ctx 注册表 + 跨模块调用改写）
// 用法：node tools/split-bot-brain.js
// 生成 server/ai/bot-brain/{shared,memory,vote,smart,talk,attitudes,main,index}.js + 根目录 bot-brain.js 薄入口
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'bot-brain.js'), 'utf8');
if (!src.includes('function ') || src.includes('module.exports = require')) {
  console.error('[split-bot-brain] 检测到 bot-brain.js 已是薄入口（单体源码已不存在），禁止运行，避免覆盖 server/ai/bot-brain/*');
  process.exit(1);
}
const lines = src.split('\n');

// 1. 函数清单（0 缩进）
const fns = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^ {0,2}function (\w+)/);
  if (m) fns.push({ name: m[1], line: i + 1 });
}
const modOf = (line) => {
  if (line <= 140) return 'shared';
  if (line <= 505) return 'memory';
  if (line <= 838) return 'vote';
  if (line <= 1082) return 'smart';
  if (line <= 1434) return 'talk';
  if (line <= 1569) return 'attitudes';
  return 'main';
};
// module.exports 起始行
const expIdx = src.indexOf('module.exports');
const expLineNo = src.slice(0, expIdx).split('\n').length; // 行号（1-based）
// 函数行区间
const fnRanges = fns.map((f, i) => ({
  name: f.name,
  start: f.line - 1,
  end: Math.min((i + 1 < fns.length ? fns[i + 1].line - 1 : expLineNo - 1) - 1, expLineNo - 2),
  mod: modOf(f.line)
}));
// shared 模块：行 1..140 全部内容 + 全部顶层常量（TALK_*/EVIDENCE/TRANSFER_5/LEVEL_MAP/_voteIso/dynW/wb——定义在函数之间，统一提取到 shared）
const sharedEndLine = 140; // shared 区边界（行号）
let sharedText = lines.slice(0, sharedEndLine).join('\n');
// 提取函数之间的顶层常量声明（多行——从 const 行到下一个顶层 const/function 前）
const extraConstNames = ['TALK_FLAVOR', 'TALK_PRESSURE', 'TALK_DEBATE_SEER', 'TALK_DEBATE_WOLF', 'TALK_WOLF_NIGHT', 'TALK_LAST_PLAIN', 'EVIDENCE', 'TRANSFER_5', 'LEVEL_MAP'];
for (const cn of extraConstNames) {
  const ci = lines.findIndex((l, i) => i >= sharedEndLine - 1 && l.match(new RegExp('^(?:const|let|var)\\s+' + cn + '\\b')));
  if (ci >= 0) {
    // 常量可能多行（对象/数组）——提取到下一个 0 缩进 const/let/function 前
    let end = ci + 1;
    while (end < lines.length && !/^(?:const|let|var|function)\s/.test(lines[end]) && !/^ {0,2}function/.test(lines[end])) end++;
    // 但要在下一个函数定义前停止（常量定义可能紧跟函数）
    sharedText += '\n' + lines.slice(ci, end).join('\n');
  }
}
// require 路径修正
sharedText = sharedText
  .replace(/require\('\.\/server\/ai\/legacy\/decide\.js'\)/g, "require('../legacy/decide.js')")
  .replace(/require\('\.\/server\/ai\/([^']+)'\)/g, "require('../$1')")
  .replace(/require\('\.\/wolfTrain\/([^']+)'\)/g, "require('../../../wolfTrain/$1')")
  .replace(/require\('\.\/favens\/index\.js'\)/g, "require('../../../favens/index.js')");

// 其他模块的函数体（从 sharedEndLine 之后开始）
const restFns = fnRanges.filter(fr => fr.mod !== 'shared' && fr.start >= sharedEndLine - 1);

// 2. 每个函数体文本 + 归属
const bodies = {};
for (const m of ['shared', 'memory', 'vote', 'smart', 'talk', 'attitudes', 'main']) bodies[m] = [];
for (const fr of fnRanges) bodies[fr.mod].push({ name: fr.name, body: lines.slice(fr.start, fr.end + 1).join('\n') });

// 3. 跨模块调用改写：函数 X（模块 A）体内调用函数 Y（模块 B≠A）→ ctx.Y(
const allFns = fns.map(f => f.name);
const modOfFn = (name) => { const f = fns.find(x => x.name === name); return f ? modOf(f.line) : null; };
// 跨模块变量改写：顶层变量名 → S.变量名（S = shared 的共享状态对象）
const sharedVars = ['_getBeliefsRef', '_belMod', 'LEXICON', 'CUR_RNG', 'fs', 'path', '_vModel', '_wolfGodModel', 'wolfKillDecide',
  // require 解构命名导入（跨模块共享）——仅顶层解构（AdaBoost/wolfGodFeatures 是函数体内局部 require，不在此列）
  'confidenceOf', 'getVoteModel', 'getVoteModelV2', 'modelProb', 'buildRoomVoteState', 'voteFeatures13', 'voteFeatures', 'rolloutVote', 'piVote', 'decideVote', 'decideNightKill', 'createRng',
  // 顶层常量/状态（跨模块引用）——wb/dynW 是 vote 区局部使用（不改写，避免与函数内局部变量冲突）
  '_voteIso', 'TALK_FLAVOR', 'TALK_PRESSURE', 'TALK_DEBATE_SEER', 'TALK_DEBATE_WOLF', 'TALK_WOLF_NIGHT', 'TALK_LAST_PLAIN', 'EVIDENCE', 'TRANSFER_5', 'LEVEL_MAP'];
function rewriteVars(body) {
  let out = body;
  for (const v of sharedVars) {
    // 跳过定义行（const/let X = ...）——定义在 shared.js 已提取，模块内不重复
    const declRe = new RegExp('^(?:const|let|var)\\s+' + v + '\\b', 'm');
    const lines2 = out.split('\n');
    const newLines = lines2.map(l => {
      if (declRe.test(l)) return l; // 定义行保留（理论上模块内不会有——shared 已提取）
      // 排除 S. 前缀、字符串/注释（粗略：\b 边界 + 非 . 前缀）
      const re = new RegExp('(?<![\\w.])' + v + '(?![\\w])', 'g');
      return l.replace(re, 'S.' + v);
    });
    out = newLines.join('\n');
  }
  return out;
}
function rewriteCalls(body, myMod) {
  let out = body;
  for (const fnName of allFns) {
    const fm = modOfFn(fnName);
    if (!fm || fm === myMod) continue; // 本模块/未知不改
    // 调用模式：fnName( （前面不是 . 或 字母）
    const re = new RegExp('(?<![\\w.])' + fnName + '\\s*\\(', 'g');
    out = out.replace(re, 'ctx.' + fnName + '(');
  }
  return out;
}

// 4. 生成模块文件
const MOD_HEADER = {
  shared: '// bot-brain 拆分：shared 模块（基础设施 + ctx 注册表）——勿手改，重新运行 tools/split-bot-brain.js',
  memory: '// bot-brain 拆分：memory 模块（记忆/信念/低级决策）',
  vote: '// bot-brain 拆分：vote 模块（投票/查验/表态）',
  smart: '// bot-brain 拆分：smart 模块（普通档决策）',
  talk: '// bot-brain 拆分：talk 模块（发言生成）',
  attitudes: '// bot-brain 拆分：attitudes 模块（态度模型）',
  main: '// bot-brain 拆分：main 模块（决策入口/聚合）'
};
const outDir = path.join(root, 'server/ai/bot-brain');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// shared.js：头部+shared区（整体切片）——顶层变量包裹进 S 对象（供跨模块引用）
let sharedText2 = sharedText;
// 把顶层 let/const 声明包装为 S 对象属性（简化：在 shared.js 末尾追加 S 定义——变量声明保留原样，S 引用它们）
const sharedContent = MOD_HEADER.shared + '\n\n' + sharedText2 + '\n\n' +
  '// ---- ctx 注册表 ----\n' +
  'const ctx = {};\n' +
  'function register(name, fn) { ctx[name] = fn; }\n' +
  '// 共享状态对象（跨模块变量访问——其他模块通过 S.xxx 读写）\n' +
  'const S = { _getBeliefsRef, _belMod, LEXICON, CUR_RNG, fs, path, _vModel, _wolfGodModel, wolfKillDecide, confidenceOf, getVoteModel, getVoteModelV2, modelProb, buildRoomVoteState, voteFeatures13, voteFeatures, rolloutVote, piVote, decideVote, decideNightKill, createRng, TALK_FLAVOR, TALK_PRESSURE, TALK_DEBATE_SEER, TALK_DEBATE_WOLF, TALK_WOLF_NIGHT, TALK_LAST_PLAIN, EVIDENCE, TRANSFER_5, LEVEL_MAP };\n' +
  'module.exports = { ctx, register, S };\n' +
  '// 导出 shared 区函数（供 index.js 注册到 ctx）\n' +
  'module.exports.sharedFns = { ' + fnRanges.filter(f => f.mod === 'shared').map(f => f.name).join(', ') + ' };\n';
fs.writeFileSync(path.join(outDir, 'shared.js'), sharedContent);

// 其他模块：require shared + 模块内代码（常量区+函数）+ 跨模块改写 + 导出
const modBounds = {}; // 每个模块的起止行（含函数间常量）
const modOrder = ['memory', 'vote', 'smart', 'talk', 'attitudes', 'main'];
const modRanges = { memory: [141, 505], vote: [507, 838], smart: [840, 1082], talk: [1083, 1434], attitudes: [1435, 1569], main: [1571, expLineNo - 1] };
for (const m of ['memory', 'vote', 'smart', 'talk', 'attitudes', 'main']) {
  const [s, e] = modRanges[m];
  const parts = [MOD_HEADER[m], "'use strict';", "const shared = require('./shared');", "const ctx = shared.ctx;", "const register = shared.register;", 'const S = shared.S;', ''];
  // 模块内所有行（常量 + 函数 + 函数间代码）——整体切片，逐函数做跨模块改写
  const modFns = fnRanges.filter(f => f.mod === m && f.start >= s - 1 && f.start <= e);
  let cursor = s - 1; // 行索引起点
  for (const fr of modFns) {
    // 函数前的常量/代码段（原样）
    if (fr.start > cursor) parts.push(lines.slice(cursor, fr.start).join('\n'));
    // 函数体（改写）
    let body = lines.slice(fr.start, fr.end + 1).join('\n');
    body = rewriteCalls(body, m);
    body = rewriteVars(body);
    parts.push(body);
    cursor = fr.end + 1;
  }
  // 模块尾部代码（常量等）
  if (cursor < e) parts.push(lines.slice(cursor, e).join('\n'));
  parts.push('');
  parts.push('module.exports = { ' + modFns.map(f => f.name).join(', ') + ' };');
  fs.writeFileSync(path.join(outDir, m + '.js'), parts.join('\n'));
}

// 5. index.js：聚合（require 各模块 → 注册到 ctx → 导出）
const modNames = ['memory', 'vote', 'smart', 'talk', 'attitudes', 'main'];
const indexContent = '// bot-brain 拆分：index.js 聚合入口——勿手改，重新运行 tools/split-bot-brain.js\n' +
  "'use strict';\n" +
  "const shared = require('./shared');\n" +
  "const ctx = shared.ctx;\n" +
  modNames.map(m => 'const mod' + m[0].toUpperCase() + m.slice(1) + ' = require(\'./' + m + '\');').join('\n') + '\n\n' +
  '// 注册全部函数到 ctx（供跨模块引用）\n' +
  'for (const k of Object.keys(shared.sharedFns || {})) ctx[k] = shared.sharedFns[k];\n' +
  modNames.map(m => 'for (const k of Object.keys(mod' + m[0].toUpperCase() + m.slice(1) + ')) ctx[k] = mod' + m[0].toUpperCase() + m.slice(1) + '[k];').join('\n') + '\n\n' +
  '// 聚合导出（与原 bot-brain.js 的 module.exports 一致）\n' +
  'module.exports = { createBotDecision: ctx.createBotDecision, botWolfChat: ctx.botWolfChat, factionOf: ctx.factionOf, loverPartner: ctx.loverPartner, resetBotPerGame: ctx.resetBotPerGame, injectGrudge: ctx.injectGrudge };\n';
fs.writeFileSync(path.join(outDir, 'index.js'), indexContent);

// 6. 根目录 bot-brain.js 薄入口
const thin = "'use strict';\n// bot-brain.js 薄入口（v1.7.31 拆分）——实际逻辑在 server/ai/bot-brain/——勿手改\nmodule.exports = require('./server/ai/bot-brain');\n";
fs.writeFileSync(path.join(root, 'bot-brain.js'), thin);

console.log('拆分完成：server/ai/bot-brain/{shared,memory,vote,smart,talk,attitudes,main,index}.js + 薄入口');
console.log('函数分布:', JSON.stringify(Object.fromEntries(['shared','memory','vote','smart','talk','attitudes','main'].map(m => [m, bodies[m].length]))));
