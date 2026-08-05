'use strict';
/* 文档-代码一致性检查（v1.6.3）：
 * 1. 更新公告.md 版本总览表结构：正式版/rc 两分区、每行 6 列（版本/日期/原因/内容/方法/收益）、版本号单调递减（最新在前）
 * 2. 已知事项第一条与代码实现一致（快照持久化 rooms.json 存在 ↔ 公告声称一致）
 * 3. 版本总览中每个有 git 标签的版本，标签已创建（vX.Y.Z / v1.0.0-rc.N）
 * 运行：node test/check-docs.js
 */
const fs = require('fs');
const path = require('path');
const proj = path.resolve(__dirname, '..');
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };

const changelog = fs.readFileSync(path.join(proj, '更新公告.md'), 'utf8');
const serverSrc = fs.readFileSync(path.join(proj, 'server.js'), 'utf8');

/* ---------- 1. 版本总览表结构 ---------- */
// 找到两个分区表格（正式版 / 快速迭代版）
const stableSec = changelog.match(/### 正式版（v1\.0\.0 及以后）\s*\n\|.*\n(\|.*\n)+/);
const rcSec = changelog.match(/### 快速迭代版（rc 系列）\s*\n\|.*\n(\|.*\n)+/);
assert(!!stableSec, '版本总览包含“正式版（v1.0.0 及以后）”分区表格');
assert(!!rcSec, '版本总览包含“快速迭代版（rc 系列）”分区表格');

function parseTable(secText) {
  const rows = secText[0].split('\n').filter(l => l.startsWith('|'));
  // 去掉表头 + 分隔行
  const body = rows.slice(2).filter(l => /^\|/.test(l) && !/^\|[\s\-|]+\|$/.test(l));
  return body;
}
function colCount(row) {
  return row.split('|').length - 2;
}

if (stableSec) {
  const rows = parseTable(stableSec);
  assert(rows.length >= 20, '正式版表格行数 ≥ 20（实际 ' + rows.length + '）');
  // 版本号单调递减（最新在前）
  const vers = rows.map(r => { const m = r.match(/\|?\s*\[?v?([\d.]+)\]?/); return m ? m[1].split('.').map(Number) : null; }).filter(Boolean);
  let ordered = true;
  for (let i = 1; i < vers.length; i++) {
    const a = vers[i - 1], b = vers[i];
    if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) || (a[0] === b[0] && a[1] === b[1] && a[2] < b[2])) { ordered = false; break; }
  }
  assert(ordered, '正式版表格按版本号降序（最新在前）');
  const colsOk = rows.every(r => colCount(r) === 6);
  assert(colsOk, '正式版每行 6 列（版本/日期/原因/内容/方法/收益）');
}
if (rcSec) {
  const rows = parseTable(rcSec);
  assert(rows.length >= 6, 'rc 表格行数 ≥ 6（实际 ' + rows.length + '）');
  const nums = rows.map(r => { const m = r.match(/rc\.(\d+)/); return m ? Number(m[1]) : null; }).filter(n => n !== null);
  let ordered = true;
  for (let i = 1; i < nums.length; i++) if (nums[i - 1] < nums[i]) { ordered = false; break; }
  assert(ordered, 'rc 表格按 rc 号降序（rc.6 → rc.1，最新在前）');
  const colsOk = rows.every(r => colCount(r) === 6);
  assert(colsOk, 'rc 每行 6 列（版本/日期/原因/内容/方法/收益）');
}

/* ---------- 2. 已知事项与代码一致性 ---------- */
const knownSec = changelog.match(/## 📌 已知事项\n([\s\S]*)$/);
assert(!!knownSec, '存在“已知事项”章节');
if (knownSec) {
  const known = knownSec[1];
  // 第一条应描述快照持久化（不得残留“内存不持久化/重启会清空”过时描述）
  assert(!known.includes('内存不持久化') && !known.includes('重启会清空所有房间'), '已知事项第一条不再含过时描述（内存不持久化）');
  assert(known.includes('rooms.json'), '已知事项第一条提及 rooms.json');
  // 代码 ↔ 文档双向一致：公告声称快照持久化 ↔ server.js 确有实现
  const hasSnapshot = serverSrc.includes('rooms.json') && serverSrc.includes('loadSnapshot') && serverSrc.includes('saveSnapshot');
  assert(hasSnapshot, 'server.js 实现快照持久化（rooms.json + loadSnapshot + saveSnapshot），与公告一致');
}

/* ---------- 3. 版本标签与公告对应 ---------- */
const tags = new Set();
try {
  const out = require('child_process').execFileSync('git', ['tag'], { cwd: proj, encoding: 'utf8' });
  for (const t of out.split('\n').map(s => s.trim()).filter(Boolean)) tags.add(t);
} catch (e) { /* 非 git 环境跳过 */ }
if (tags.size) {
  const listed = [];
  if (stableSec) for (const r of parseTable(stableSec)) { const m = r.match(/v([\d.]+)/); if (m) listed.push('v' + m[1]); }
  if (rcSec) for (const r of parseTable(rcSec)) { const m = r.match(/v1\.0\.0-rc\.(\d+)/); if (m) listed.push('v1.0.0-rc.' + m[1]); }
  const missing = listed.filter(v => !tags.has(v) && !/^v1\.0\.0-rc\.[1-5]$/.test(v)); // rc.1–rc.5 为初始提交前迭代，无独立标签（公告已注明）
  assert(missing.length === 0, '表格中版本均有 git 标签（rc.1–rc.5 豁免）' + (missing.length ? '（缺: ' + missing.join(',') + '）' : ''));
}

if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
console.log('\n文档-代码一致性检查全部通过 ✔');
process.exit(0);
