'use strict';
/* ============================================================
 * 狼人杀项目·代码自检工具（v1.6.3）
 * 用法：
 *   node tools/selfcheck.js            # 静态自检（语法/版本串/死代码/重复case/遗留标记/文档-代码一致）
 *   node tools/selfcheck.js --tests    # 静态自检 + 跑全部自动化测试（约 5~8 分钟）
 *   node tools/selfcheck.js --quick    # 只做快速自检（语法 + 版本串 + 已知事项），适合每次改完跑
 * 退出码：0=全部通过；1=存在问题
 * 说明：未使用标识符检测为“宽松启发式”——只报告最可能的冗余，
 *       导出/事件属性/字符串拼接等误报会以“?”标注，需人工确认。
 * ============================================================ */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const RUN_TESTS = args.includes('--tests');

let problems = 0;
let warnings = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { problems++; console.error('  ✗ ' + m); };
const warn = (m) => { warnings++; console.log('  ⚠ ' + m); };

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

console.log('==============================================');
console.log('  狼人杀在线版 · 代码自检');
console.log('==============================================');

/* ---------- 0. 文件收集 ---------- */
const jsFiles = [];
function walk(dir, base) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) { if (f !== 'node_modules' && f !== '.git') walk(p, base); continue; }
    if (f.endsWith('.js')) jsFiles.push(path.relative(base, p));
  }
}
walk(root, root);
const core = ['server.js', 'game.js', 'bot-brain.js', 'public/client.js', 'public/sw.js'];

/* ---------- 1. 语法检查 ---------- */
console.log('\n[1] 语法检查（node --check）');
let synBad = 0;
for (const f of jsFiles) {
  try { execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'pipe' }); }
  catch (e) { synBad++; console.error('    ✗ ' + f + ': ' + ((e.stderr || '').toString().split('\n')[0])); }
}
if (synBad === 0) ok('全部 ' + jsFiles.length + ' 个 JS 文件语法通过');
else bad(synBad + ' 个文件语法错误');

if (QUICK) { console.log('\n快速自检结束（语法阶段后继续跑版本串与已知事项）……'); }
else {
  /* ---------- 2. 未使用标识符（宽松启发式） ---------- */
  console.log('\n[2] 未使用的函数/常量（宽松启发式，"?"=需人工确认）');
  const seen = {};
  for (const f of core) if (exists(f)) seen[f] = read(f);
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const f of Object.keys(seen)) {
    const src = seen[f];
    // 收集定义：function name / const NAME = / let NAME = / var NAME =
    const defs = new Map();
    for (const m of src.matchAll(/(?:^|\n)\s*(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*))\s*[=(]/g)) {
      const name = m[1] || m[2];
      if (!defs.has(name)) defs.set(name, m.index);
    }
    for (const name of defs.keys()) {
      if (/^(module|exports|require|process|console|setTimeout|setInterval)$/.test(name)) continue;
      // 边界：含 $ 或非单词字符的名字不能用 \b（$ 不是 \w）
      const esc = escRe(name);
      const re2 = new RegExp(/^[A-Za-z_][\w]*$/.test(name) ? '\\b' + esc + '\\b' : '(?<![A-Za-z0-9_$])' + esc + '(?![A-Za-z0-9_$])', 'g');
      let count = 0, mm;
      while ((mm = re2.exec(src))) count++;
      if (count > 0) count--; // 减去定义处（函数提升：引用可能在定义之前，不能按位置排除）
      if (count === 0) warn(`${f}: ${name} 未在文件内被引用（?）`);
    }
  }
  /* ---------- 3. 重复 switch case（按 switch 块隔离） ---------- */
  console.log('\n[3] 重复 switch case 检测');
  let dup = 0;
  for (const f of Object.keys(seen)) {
    const src = seen[f];
    for (const sm of src.matchAll(/switch\s*\([^)]*\)\s*\{/g)) {
      let i = sm.index + sm[0].length, depth = 1;
      while (i < src.length && depth > 0) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++; }
      const block = src.slice(sm.index, i);
      const cases = [...block.matchAll(/case\s+['"]([^'"]+)['"]\s*:/g)].map(x => x[1]);
      const uniq = new Set();
      for (const c of cases) {
        if (uniq.has(c)) { dup++; bad(`${f}: switch 内重复 case '${c}'（第 2 个分支不可达）`); }
        uniq.add(c);
      }
    }
  }
  if (dup === 0) ok('未发现重复 case');
}

/* ---------- 4. 版本串一致性 ---------- */
console.log('\n[4] 版本串一致性（package.json / 页脚 / sw.js CACHE / README / 更新公告）');
try {
  execFileSync(process.execPath, [path.join(root, 'test', 'check-version-sync.js')], { stdio: 'pipe' });
  ok('五处版本一致');
} catch (e) {
  bad('版本串不一致：' + ((e.stdout || '').toString().split('\n').filter(Boolean).slice(-2).join(' | ')));
}

/* ---------- 5. 文档与代码一致性（已知事项等） ---------- */
console.log('\n[5] 文档-代码一致性（更新公告“已知事项” vs 实现）');
try {
  execFileSync(process.execPath, [path.join(root, 'test', 'check-docs.js')], { stdio: 'pipe' });
  ok('已知事项/版本表格结构检查通过');
} catch (e) {
  bad('文档检查未通过：' + ((e.stdout || '').toString().split('\n').filter(Boolean).slice(-3).join(' | ')));
}

/* ---------- 6. 遗留标记 ---------- */
console.log('\n[6] 遗留标记（TODO/FIXME/HACK）');
let leftover = 0;
for (const f of core) {
  if (!exists(f)) continue;
  const src = read(f);
  for (const m of src.matchAll(/(TODO|FIXME|HACK)[：:]?\s*(.*?)(?:\n|\r)/g)) {
    leftover++;
    warn(`${f}: ${m[1]} ${m[2].trim().slice(0, 60)}`);
  }
}
if (leftover === 0) ok('未发现遗留标记');
else warn(`共 ${leftover} 处遗留标记（可能是有意为之，请确认）`);

/* ---------- 7. 规模概览 ---------- */
console.log('\n[7] 规模概览');
for (const f of core) {
  if (exists(f)) {
    const src = read(f);
    const lines = src.split('\n').length;
    const bytes = Buffer.byteLength(src, 'utf8');
    console.log(`    ${f.padEnd(20)} ${String(lines).padStart(5)} 行  ${(bytes / 1024).toFixed(1)} KB`);
  }
}

/* ---------- 8. 全量测试（可选） ---------- */
if (RUN_TESTS) {
  console.log('\n[8] 全量自动化测试（--tests）');
  const testDir = path.join(root, 'test');
  const tests = fs.readdirSync(testDir).filter(f => f.endsWith('.js') && f !== '_harness-dom.js');
  let pass = 0;
  for (const t of tests) {
    const start = Date.now();
    try {
      execFileSync(process.execPath, [path.join(testDir, t)], { stdio: 'pipe', timeout: 150000 });
      pass++;
      console.log(`    PASS ${t} (${Date.now() - start}ms)`);
    } catch (e) {
      bad(`测试失败 ${t}`);
    }
  }
  console.log(`    测试 ${pass}/${tests.length} 通过`);
}

/* ---------- 汇总 ---------- */
console.log('\n==============================================');
if (problems === 0) {
  console.log('  自检通过 ✔' + (warnings ? `（${warnings} 条警告，请人工确认）` : ''));
  process.exit(0);
} else {
  console.log(`  自检发现 ${problems} 个问题、${warnings} 条警告`);
  process.exit(1);
}
