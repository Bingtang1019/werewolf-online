'use strict';
/* tools/ai/train-v5-vote-ada.js —— V5 A2：用 lab V5 样本训练 v3v3 风格 AdaBoost 投票模型
 * 输出 adaboost-vote@3 格式（global stumps），供 model-loader 消费；
 * 小样本 lab 模型，仅作训练通路验证，非生产。 */
const fs = require('fs');
const path = require('path');
const { AdaBoost } = require('../../wolfTrain/adaboost.js');
const { V5_FEATURE_NAMES } = require('../../server/ai/intent-features.js');
const root = path.resolve(__dirname, '..', '..');
const args = {};
process.argv.slice(2).forEach(a => { const m = a.match(/^--([^=]+)=(.*)$/); if (m) args[m[1]] = m[2]; });
const input = path.resolve(root, args.input || 'data/vote-v3-v5/samples.jsonl');
const outFile = path.resolve(root, args.out || 'models/adaboost-vote-v3-v5.json');

function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function auc(y, raw) {
  const idx = raw.map((v, i) => i).sort((a, b) => raw[a] - raw[b]);
  let nPos = 0, nNeg = 0, rs = 0;
  for (let i = 0; i < y.length; i++) { if (y[i] > 0) nPos++; else nNeg++; }
  for (let k = 0; k < idx.length; k++) if (y[idx[k]] > 0) rs += k + 1;
  return (rs - nPos * (nPos + 1) / 2) / (nPos * nNeg);
}

const rows = [];
for (const line of fs.readFileSync(input, 'utf8').trim().split('\n').filter(Boolean)) {
  const o = JSON.parse(line);
  if (o && o.v5 === true && Array.isArray(o.features) && o.features.length === V5_FEATURE_NAMES.length && typeof o.label === 'number') {
    rows.push({ x: o.features, y: Number(o.label) });
  }
}
if (!rows.length) { console.error(`[v5-ada] 无 V5 样本: ${input}`); process.exit(1); }
const rnd = mulberry32(42);
for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
const split = Math.floor(rows.length * 0.75);
const tr = rows.slice(0, split), te = rows.slice(split);
const model = new AdaBoost({ rounds: 80, bins: 20 }).fit(tr.map(r => r.x), tr.map(r => r.y));
const pred = te.map(r => model.predict(r.x));
const a = te.length ? auc(te.map(r => r.y), pred) : 0.5;
// 转换为 model-loader 的 adaboost-vote@3 全局格式
const stumps = model.models.map(m => ({ f: m.j, thr: m.th, dir: m.dir === 1 ? -1 : 1, alpha: m.alpha }));
const out = { schema: 'adaboost-vote@3', features: V5_FEATURE_NAMES, configs: {}, global: { stumps, useLocal: true, valAUC: +a.toFixed(4), testAUC: +a.toFixed(4) }, meta: { trainedAt: new Date().toISOString(), labV5: true, rows: rows.length, testAUC: +a.toFixed(4) } };
fs.writeFileSync(outFile, JSON.stringify(out));
console.log(JSON.stringify({ input, rows: rows.length, train: tr.length, test: te.length, testAUC: +a.toFixed(4), output: outFile }, null, 2));
