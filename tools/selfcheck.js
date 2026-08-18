'use strict';
/* ============================================================
 * 狼人杀项目·代码自检工具（v2.1.0）
 * 用法：
 *   node tools/selfcheck.js                    # 默认：core 文件集静态自检
 *   node tools/selfcheck.js --quick            # 快速：语法+版本串+语义化核心项（改完即跑）
 *   node tools/selfcheck.js --tests            # 静态自检 + 全量自动化测试（并行执行器）
 *   node tools/selfcheck.js --scope=all        # 全项目文件集（含 tools/test/lab）
 *   node tools/selfcheck.js --skip=syntax,leftover   # 排除指定检查项
 *   node tools/selfcheck.js --json             # 结构化输出（人类日志走 stderr，JSON 走 stdout，可管道）
 *   node tools/selfcheck.js --strict-warnings  # 警告也按失败退出（退出码 1）
 * 退出码：0=通过；1=存在问题（或 --strict-warnings 下存在警告）
 * v2.1.0 变更：
 *   - 检查器模块化（注册表 + 可排除 + 耗时统计 + 汇总表）
 *   - 文件集按 scope 收集，core 纳入 loverCore.js 与 favens/*
 *   - 项目语义化检查：loverMode 三态（按文件职责期望子集）/ loverTest+loverLocked 注入链 / view 字段契约 / loverCore 接口-测试覆盖
 *   - --json 结构化输出（人类日志→stderr，JSON→stdout）；子进程统一 timeout；失败保留输出尾部
 * ============================================================ */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

/* ---------------- CLI 参数 ---------------- */
const OPT = {
  quick: args.includes('--quick'),
  tests: args.includes('--tests'),
  json: args.includes('--json'),
  strictWarnings: args.includes('--strict-warnings'),
  scope: 'core',
  skip: new Set(),
};
for (const a of args) {
  if (a.startsWith('--scope=')) OPT.scope = a.slice(8);
  if (a.startsWith('--skip=')) a.slice(7).split(',').forEach(x => OPT.skip.add(x.trim()));
}

/* ---------------- 输出（--json 时：人类日志→stderr，JSON→stdout） ---------------- */
const log = (...m) => (OPT.json ? console.error(...m) : console.log(...m));
const report = { tool: 'selfcheck', version: '2.1.0', scope: OPT.scope, checks: [], summary: {}, exitCode: 0 };
const stats = { problems: 0, warnings: 0 };
const t0 = Date.now();

/* ---------------- 文件收集 ---------------- */
function walkJs(dir, base, acc) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) { if (f !== 'node_modules' && f !== '.git') walkJs(p, base, acc); continue; }
    if (f.endsWith('.js')) acc.push(path.relative(base, p));
  }
}
function collect(scope) {
  const acc = [];
  if (scope === 'core') {
    for (const f of ['server.js', 'game.js', 'loverCore.js', 'bot-brain.js', 'public/sw.js', 'server/ai/belief-engine.js', 'server/ai/nlu-claims.js', 'server/ai/nlu-intent.js']) {
      if (fs.existsSync(path.join(root, f))) acc.push(f);
    }
    for (const dir of ['server/game', 'server/ai/bot-brain']) {
      if (fs.existsSync(path.join(root, dir))) walkJs(path.join(root, dir), root, acc);
    }
    const jsc = path.join(root, 'public', 'js');
    if (fs.existsSync(jsc)) {
      for (const f of fs.readdirSync(jsc)) if (f.endsWith('.js')) acc.push(path.join('public', 'js', f));
    }
    const fa = [];
    if (fs.existsSync(path.join(root, 'favens'))) walkJs(path.join(root, 'favens'), root, fa);
    acc.push(...fa.filter(f => f.startsWith('favens')));
  } else if (scope === 'all') walkJs(root, root, acc);
  else if (scope === 'server') {
    for (const f of ['server.js', 'game.js', 'loverCore.js', 'bot-brain.js']) if (fs.existsSync(path.join(root, f))) acc.push(f);
    for (const dir of ['server/game', 'server/ai/bot-brain']) {
      if (fs.existsSync(path.join(root, dir))) walkJs(path.join(root, dir), root, acc);
    }
  }
  else if (scope === 'favens') { if (fs.existsSync(path.join(root, 'favens'))) walkJs(path.join(root, 'favens'), root, acc); if (fs.existsSync(path.join(root, 'loverCore.js'))) acc.push('loverCore.js'); }
  else if (scope === 'tools') walkJs(path.join(root, 'tools'), root, acc);
  else if (scope === 'test') walkJs(path.join(root, 'test'), root, acc);
  else { console.error('未知 scope: ' + scope + '（可用：core/all/server/favens/tools/test）'); process.exit(1); }
  return acc.sort();
}
const FILES = collect(OPT.scope);
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const exists = p => fs.existsSync(path.join(root, p));
function readDirJs(relDir) {
  const base = path.join(root, relDir);
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return '';
  const parts = [];
  for (const f of fs.readdirSync(base).sort()) {
    if (f.endsWith('.js')) parts.push(read(path.join(relDir, f)));
  }
  return parts.join('\n');
}

/* ---------------- 工具 ---------------- */
function runNode(script, opts = {}) {
  try {
    const out = execFileSync(process.execPath, [path.join(root, script)], { stdio: 'pipe', timeout: opts.timeout || 120000 });
    return { ok: true, out: out.toString() };
  } catch (e) {
    const raw = (e.stdout || '') + (e.stderr || '');
    const tail = raw.split('\n').filter(Boolean).slice(-12).join('\n');
    return { ok: false, out: tail };
  }
}
function grepCount(src, re) { let n = 0, m; while ((m = re.exec(src))) n++; return n; }

/* ---------------- 检查器注册表 ---------------- */
const CHECKS = [];
const check = (id, title, quick, fn) => CHECKS.push({ id, title, quick, fn });
const ok = (m) => log('  ✓ ' + m);
const bad = (m) => { stats.problems++; log('  ✗ ' + m); };
const warn = (m) => { stats.warnings++; log('  ⚠ ' + m); };

/* ---------- 1. 语法检查 ---------- */
check('syntax', '语法检查（node --check）', true, () => {
  let synBad = 0;
  for (const f of FILES) {
    try { execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'pipe', timeout: 30000 }); }
    catch (e) { synBad++; bad(f + ': ' + String(e.stderr || '').split('\n')[0]); }
  }
  if (synBad === 0) ok('全部 ' + FILES.length + ' 个 JS 文件语法通过');
});

/* ---------- 2. 版本串一致性 ---------- */
check('version-sync', '版本串一致性（package.json/页脚/sw.js CACHE/README/公告）', true, () => {
  const r = runNode('test/check-version-sync.js');
  if (r.ok) ok('五处版本一致');
  else bad('版本串不一致：' + r.out.split('\n').slice(-3).join(' | '));
});

/* ---------- 3. 文档-代码一致性 ---------- */
check('docs-sync', '文档-代码一致性（已知事项/版本表格结构）', false, () => {
  const r = runNode('test/check-docs.js');
  if (r.ok) ok('已知事项/版本表格结构检查通过');
  else bad('文档检查未通过：' + r.out.split('\n').slice(-4).join(' | '));
});

/* ---------- 4. 遗留标记 ---------- */
check('leftover', '遗留标记（TODO/FIXME/HACK）', true, () => {
  let leftover = 0;
  for (const f of FILES) {
    const src = read(f);
    for (const m of src.matchAll(/(TODO|FIXME|HACK)[：:]?\s*(.*?)(?:\n|\r)/g)) { leftover++; warn(f + ': ' + m[1] + ' ' + m[2].trim().slice(0, 60)); }
  }
  if (leftover === 0) ok('未发现遗留标记');
});

/* ---------- 5. loverMode 三态一致性（按文件职责期望子集） ---------- */
check('lover-mode', 'loverMode 三态一致性（按文件职责期望子集）', true, () => {
  const targets = [
    { f: 'server/game', must: ['off', 'classic', 'v2'], note: '引擎三态开关（拆分后 server/game）' },
    { f: 'loverCore.js', must: ['v2'], note: 'v2 专用模块（off/classic 由 game.js 拦截）' },
    { f: 'favens/index.js', must: ['v2'], note: '策略路由（!== v2 视为非 v2 分支）' },
    { f: 'test/check-lover-v2.js', must: ['classic', 'v2'], note: '单测需覆盖拒绝与主路径' },
  ];
  let missing = 0;
  for (const t of targets) {
    const isDir = exists(t.f) && fs.statSync(path.join(root, t.f)).isDirectory();
    if (!exists(t.f)) { warn(t.f + ' 不存在（跳过 loverMode 检查）'); continue; }
    const s = isDir ? readDirJs(t.f) : read(t.f);
    for (const st of t.must) {
      const hasEq = new RegExp("loverMode\\s*(?:===|!==|:|=)\\s*['\"]" + st + "['\"]").test(s);
      const hasNeq = st === 'v2' && /loverMode\s*!==\s*['"]v2['"]/.test(s);
      if (!hasEq && !hasNeq) { missing++; warn(t.f + ': 缺少 loverMode ' + st + ' 分支（' + t.note + '）'); }
    }
  }
  if (missing === 0) ok('三态分支按文件职责覆盖');
});

/* ---------- 6. loverTest/loverLocked 注入链 ---------- */
check('lover-test-chain', 'loverTest/loverLocked 注入链（消费端 vs 使用端）', true, () => {
  const game = readDirJs('server/game') || (exists('game.js') ? read('game.js') : '');
  const consumed = new Set();
  for (const m of game.matchAll(/loverTest\s*===?\s*['\"]([^'\"]+)['\"]/g)) consumed.add(m[1]);
  const consumedLocked = exists('loverCore.js') && /loverLocked/.test(read('loverCore.js'));
  const used = new Set();
  let usedLocked = false;
  const files = [];
  if (exists('tools')) for (const f of fs.readdirSync(path.join(root, 'tools'))) if (f.endsWith('.js')) files.push('tools/' + f);
  if (exists('test')) { const tacc = []; walkJs(path.join(root, 'test'), root, tacc); files.push(...tacc); }
  for (const f of files) {
    if (!exists(f)) continue;
    const s = read(f);
    for (const m of s.matchAll(/--lover-test=([\w-]+)/g)) used.add(m[1]);
    for (const m of s.matchAll(/loverTest\s*[:=]\s*['\"]([\w-]+)['\"]/g)) used.add(m[1]);
    if (/loverLocked|--lover-locked/.test(s)) usedLocked = true;
  }
  if (consumed.size === 0 && !consumedLocked) { warn('game.js/loverCore.js 未消费任何注入（注入机制已移除？）'); return; }
  const unknown = [...used].filter(v => !consumed.has(v));
  const unused = [...consumed].filter(v => !used.has(v));
  if (unknown.length) bad('脚本使用了 game.js 不认识的注入值：' + unknown.join(', ') + '（注入不会生效！）');
  else ok('字符串注入双向一致：' + [...consumed].sort().join(' / '));
  if (consumedLocked && !usedLocked) warn('loverLocked（G3 解绑禁用）已被 loverCore 消费但无脚本固化使用');
  if (!consumedLocked && usedLocked) bad('脚本使用 loverLocked 但 loverCore 不消费（注入不会生效！）');
  for (const v of unused) warn('注入值 ' + v + ' 无脚本固化（若为手动命令行跑批可忽略，但不复现）');
  if (consumed.size && !grepCount(read('test/check-lover-v2.js'), /loverTest|loverLocked/)) warn('check-lover-v2.js 未覆盖任何注入路径');
});

/* ---------- 7. loverCore 接口-测试覆盖（宽松） ---------- */
check('lovercore-coverage', 'loverCore 接口-测试覆盖（导出方法 vs 单测引用，宽松）', true, () => {
  if (!exists('loverCore.js')) { warn('loverCore.js 不存在'); return; }
  if (!exists('test/check-lover-v2.js')) { warn('check-lover-v2.js 不存在'); return; }
  const lc = read('loverCore.js');
  const test = read('test/check-lover-v2.js');
  const methods = new Set();
  const meIdx = lc.indexOf('module.exports');
  const meSrc = meIdx >= 0 ? lc.slice(meIdx) : lc;
  for (const m of meSrc.matchAll(/^\s*(?:\w+\s*:\s*)?(\w+)\s*(?:\(|:|,)/gm)) {
    if (m[1] !== 'module' && m[1] !== 'exports' && !['function', 'const', 'let', 'var', 'return'].includes(m[1])) methods.add(m[1]);
  }
  const map = { unbind: 'unbind', applyGuard: 'guard', vengeanceDeclare: 'reveal', betrayalKill: 'betray', grantPower: 'power' };
  const uncovered = [];
  for (const name of methods) {
    const direct = new RegExp('loverCore\.' + name + '\s*\(').test(test);
    const hint = map[name] || name;
    const indirect = test.includes(name) || test.includes('lover_' + hint) || test.includes(hint);
    if (!direct && !indirect) uncovered.push(name);
  }
  if (uncovered.length) warn('loverCore 方法未被单测覆盖（?宽松判定）：' + uncovered.join(', '));
  else ok('loverCore 导出方法均有单测引用（' + [...methods].sort().join(' / ') + '）');
});

/* ---------- 8. view 字段契约（lover 聚焦） ---------- */
check('view-contract', 'view 字段契约（viewFor/viewState 透出 vs client.js 读取，lover 聚焦）', false, () => {
  const game = readDirJs('server/game') || (exists('game.js') ? read('game.js') : '');
  const client = readDirJs('public/js') || (exists('public/client.js') ? read('public/client.js') : '');
  if (!game || !client) { warn('server/game 或 public/js 缺失，跳过'); return; }
  const lc = exists('loverCore.js') ? read('loverCore.js') : '';
  const produced = new Set();
  const vfStart = game.indexOf('function viewFor');
  if (vfStart >= 0) {
    const open = game.indexOf('{', vfStart);
    let depth = 0, i = open;
    while (i < game.length && depth >= 0) { if (game[i] === '{') depth++; else if (game[i] === '}') depth--; i++; }
    const body = game.slice(vfStart, i);
    for (const m of body.matchAll(/^\s{4}(\w+)\s*:/gm)) produced.add(m[1]);
  }
  const vsStart = lc.indexOf('function viewState');
  if (vsStart >= 0) {
    const seg = lc.slice(vsStart, vsStart + 600);
    for (const m of seg.matchAll(/^\s{2}(\w+)\s*:/gm)) produced.add(m[1]);
  }
  const contract = ['loverMode', 'inLovers', 'canUnbind', 'unbindUsed', 'unbindBy', 'cupidDead', 'power', 'timeline', 'lover', 'myLover', 'myCouple', 'loverLocked'];
  const consumedLover = contract.filter(f => new RegExp('(?:v|view)\.' + f + '\b').test(client));
  const missing = consumedLover.filter(f => !produced.has(f));
  if (missing.length) bad('client.js 读取 view 不透出的 lover 字段（前端拿到 undefined）：' + missing.join(', '));
  else ok('lover 视图契约一致');
  const producedLover = [...produced].filter(f => contract.includes(f));
  const unread = producedLover.filter(f => !consumedLover.includes(f));
  if (unread.length) warn('view 透出但 client.js 未读取（?冗余或前端缺失处理）：' + unread.join(', '));
  if (/lover_unbind/.test(game) && !produced.has('canUnbind')) warn('game.js 有 lover_unbind 操作但 view 不透出 canUnbind（解绑按钮状态无契约字段）');
});

/* ---------- 9. 未使用标识符（宽松启发式，跨文件感知） ---------- */
check('unused', '未使用的函数/常量（宽松启发式，"?"=需人工确认）', false, () => {
  const escRe = s => s.replace(/[$( ){}.*+?^|\[\]\\]/g, '\\$&');
  let reported = 0;
  for (const f of FILES) {
    const src = read(f);
    const defs = new Map();
    for (const m of src.matchAll(/(?:^|\n)\s*(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*))\s*[=(]/g)) {
      const name = m[1] || m[2];
      if (!defs.has(name)) defs.set(name, m.index);
    }
    for (const name of defs.keys()) {
      if (/^(module|exports|require|process|console|setTimeout|setInterval)$/.test(name)) continue;
      let count = 0;
      const esc = escRe(name);
      const re2 = new RegExp(/^[A-Za-z_][\w]*$/.test(name) ? '\\b' + esc + '\\b' : '(?<![A-Za-z0-9_$])' + esc + '(?![A-Za-z0-9_$])', 'g');
      let mm; while ((mm = re2.exec(src))) count++;
      if (count > 0) count--;
      if (count === 0) {
        let cross = false;
        for (const f2 of FILES) { if (f2 === f) continue; if (new RegExp(escRe(name)).test(read(f2))) { cross = true; break; } }
        if (!cross) { reported++; warn(f + ': ' + name + ' 未在项目内被引用（?）'); }
      }
    }
  }
  if (reported === 0) ok('未发现未使用标识符');
});

/* ---------- 10. 重复 switch case（按 switch 块隔离） ---------- */
check('dup-case', '重复 switch case 检测', false, () => {
  let dup = 0;
  for (const f of FILES) {
    const src = read(f);
    for (const sm of src.matchAll(/switch\s*\([^)]*\)\s*\{/g)) {
      let i = sm.index + sm[0].length, depth = 1;
      while (i < src.length && depth > 0) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++; }
      const block = src.slice(sm.index, i);
      const cases = [...block.matchAll(/case\s+['\"]([^'\"]+)['\"]\s*:/g)].map(x => x[1]);
      const seen = new Set();
      for (const c of cases) {
        if (seen.has(c)) { dup++; bad(f + ': switch 内重复 case ' + c + '（第 2 个分支不可达）'); }
        seen.add(c);
      }
    }
  }
  if (dup === 0) ok('未发现重复 case');
});

/* ---------- 11. 规模概览 ---------- */
check('scale', '规模概览', false, () => {
  const show = (label, src) => {
    if (!src) return;
    const lines = src.split('\n').length;
    const kb = (Buffer.byteLength(src, 'utf8') / 1024).toFixed(1);
    log('    ' + label.padEnd(24) + String(lines).padStart(5) + ' 行  ' + kb + ' KB');
  };
  for (const f of ['server.js', 'game.js', 'loverCore.js', 'bot-brain.js', 'public/sw.js']) {
    if (exists(f)) show(f, read(f));
  }
  show('server/game/*.js', readDirJs('server/game'));
  show('server/ai/bot-brain/*.js', readDirJs('server/ai/bot-brain'));
  show('public/js/*.js', readDirJs('public/js'));
  if (exists('favens')) for (const f of fs.readdirSync(path.join(root, 'favens')).filter(x => x.endsWith('.js')).sort()) {
    show('favens/' + f, read('favens/' + f));
  }
});

/* ---------------- 执行 ---------------- */
log('==============================================');
log('  狼人杀在线版 · 代码自检 v2.1.0（scope=' + OPT.scope + (OPT.quick ? '，quick' : '') + '）');
log('==============================================');
for (const c of CHECKS) {
  if (OPT.skip.has(c.id)) { log('  - ' + c.title + '（已跳过）'); continue; }
  if (OPT.quick && !c.quick) continue;
  const ts = Date.now();
  log('\n[' + c.id + '] ' + c.title);
  try { c.fn(); } catch (e) { bad(c.id + ' 检查器异常：' + e.message); }
  report.checks.push({ id: c.id, title: c.title, status: 'done', durationMs: Date.now() - ts });
}

/* ---------- 全量测试（可选） ---------- */
if (OPT.tests) {
  log('\n[tests] 全量自动化测试（--tests）');
  const r = runNode('tools/parallel-tests.js', { timeout: 900000 });
  if (r.ok) ok('全量测试通过（并行）');
  else bad('全量测试未全部通过（详见上方并行执行器输出）');
}

/* ---------------- 汇总 ---------------- */
const durationMs = Date.now() - t0;
log('\n==============================================');
if (stats.problems === 0 && (!OPT.strictWarnings || stats.warnings === 0)) {
  log('  自检通过 ✔' + (stats.warnings ? '（' + stats.warnings + ' 条警告，请人工确认）' : '') + '  耗时 ' + (durationMs / 1000).toFixed(1) + 's');
} else {
  log('  自检发现 ' + stats.problems + ' 个问题、' + stats.warnings + ' 条警告' + (OPT.strictWarnings && stats.warnings ? '（strict-warnings）' : '') + '  耗时 ' + (durationMs / 1000).toFixed(1) + 's');
}
const ran = CHECKS.filter(c => !OPT.skip.has(c.id) && !(OPT.quick && !c.quick)).length;
report.summary = { pass: ran - stats.problems, fail: stats.problems, warnings: stats.warnings, durationMs };
report.exitCode = stats.problems > 0 || (OPT.strictWarnings && stats.warnings > 0) ? 1 : 0;
if (OPT.json) {
  report.files = FILES;
  console.log(JSON.stringify(report, null, 2));
}
process.exitCode = report.exitCode; // 不用 process.exit：管道模式下会抢跑 stdout flush
