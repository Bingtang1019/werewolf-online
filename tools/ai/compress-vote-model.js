'use strict';
/**
 * compress-vote-model.js — vote-v2 模型瘦身工具（对已产出的 40MB 模型即时压缩，无需重训）。
 *
 * 根因：PAVA(isoTable) 输出未合并相邻同值台阶——score 连续唯一 → 每样本一条台阶，
 *      global/local/capLocal 共 11 张表 × 2.8-17 万台阶 × 格式化 JSON = 40MB
 *      （其中 ~95% 是报告用校准表——推理端不消费，v2 走 raw score 路径）。
 * 修复：isoCompress（相邻 cal 量化到 0.001 合并）+ 紧凑 JSON 重写。
 * 行为零变化：isoQuery 的 cal 偏差 ≤ 0.0005（校准验收阈值 0.10 的 1/200）。
 *
 * 用法：node tools/ai/compress-vote-model.js [--in models/adaboost-vote-v2.json]
 *       默认原位覆盖；--dry 只报告不写盘。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const IN = path.join(root, get('--in', 'models/adaboost-vote-v2.json'));
const DRY = args.includes('--dry');

/** 与 train-vote-v2.js isoCompress 同实现（工具独立，防训练脚本改动后工具失配） */
function isoCompress(table) {
  const out = [];
  for (const b of table) {
    const cal = Math.round(b.cal * 1000) / 1000;
    const last = out[out.length - 1];
    if (last && Math.abs(last.cal - cal) < 1e-9) {
      last.sMax = Math.max(last.sMax, b.sMax);
      last.n += b.n;
    } else {
      out.push({ sMin: b.sMin, sMax: b.sMax, cal, n: b.n });
    }
  }
  return out;
}

function walkTables(model) {
  const tables = [];
  const collect = (obj, keyPath) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj) && obj.length && obj[0] && typeof obj[0] === 'object' && 'cal' in obj[0] && 'sMin' in obj[0]) {
      tables.push({ obj, keyPath });
      return;
    }
    for (const k of Object.keys(obj)) collect(obj[k], keyPath + '.' + k);
  };
  collect(model, 'model');
  return tables;
}

const raw = fs.readFileSync(IN, 'utf8');
const model = JSON.parse(raw);
const before = Buffer.byteLength(raw, 'utf8');
const stats = [];

for (const { obj, keyPath } of walkTables(model)) {
  const beforeN = obj.length;
  const compressed = isoCompress(obj);
  obj.length = 0;
  for (const b of compressed) obj.push(b);
  stats.push({ keyPath, before: beforeN, after: obj.length });
}

const outJson = JSON.stringify(model);
const after = Buffer.byteLength(outJson, 'utf8');

console.log('=== vote-v2 模型压缩报告 ===');
console.log(`文件: ${IN}`);
console.log(`体积: ${(before / 1048576).toFixed(2)} MB → ${(after / 1048576).toFixed(2)} MB（-${((1 - after / before) * 100).toFixed(1)}%）`);
console.log('--- isoTable 压缩明细（前 15 张）---');
for (const s of stats.slice(0, 15)) console.log(`  ${s.keyPath}: ${s.before} → ${s.after} 台阶`);
if (stats.length > 15) console.log(`  ... 共 ${stats.length} 张表`);

if (!DRY) {
  const tmp = IN + '.tmp';
  fs.writeFileSync(tmp, outJson, 'utf8');
  fs.renameSync(tmp, IN);
  console.log('已覆盖写回（行为零变化：cal 量化误差 ≤0.0005）');
} else {
  console.log('--dry：未写盘');
}
