'use strict';
/* tools/ai/train-v5-lab.js —— 用 lab 采集的 V5 样本（v5:true，21 维）训练 π 意图版 MLP
 * 用法：node tools/ai/train-v5-lab.js [--input=data/vote-v3-v5/samples.jsonl] [--out=models/v5-pi-lab.json]
 * 仅用于验证真实 lab 数据训练链路；样本量小，不作为生产模型。 */
const fs = require('fs');
const path = require('path');
const { MLP } = require('../../server/ai/mlp.js');
const { V5_FEATURE_NAMES } = require('../../server/ai/intent-features.js');
const root = path.resolve(__dirname, '..', '..');
const args = {};
process.argv.slice(2).forEach(a => { const m = a.match(/^--([^=]+)=(.*)$/); if (m) args[m[1]] = m[2]; });
const input = path.resolve(root, args.input || 'data/vote-v3-v5/samples.jsonl');
const outFile = path.resolve(root, args.out || 'models/v5-pi-lab.json');

function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function auc(y, p) {
  const idx = p.map((v, i) => i).sort((a, b) => p[a] - p[b]);
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
if (!rows.length) { console.error(`[v5-lab] 无 V5 样本: ${input}`); process.exit(1); }
const rnd = mulberry32(42);
for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
const split = Math.floor(rows.length * 0.8);
const trX = rows.slice(0, split).map(r => r.x), trY = rows.slice(0, split).map(r => r.y);
const teX = rows.slice(split).map(r => r.x), teY = rows.slice(split).map(r => r.y);
const m = new MLP({ hidden: 32, epochs: 40, lr: 1e-3, batch: 16, l2: 1e-4, seed: 7 });
m.fit(trX, trY, teX.slice(0, Math.min(teX.length, 100)), teY.slice(0, Math.min(teY.length, 100)), null, null);
const pred = teX.map(x => m.predict(x));
const a = teY.length ? auc(teY, pred) : 0.5;
const out = { schema: 'vote-pi@1', features: V5_FEATURE_NAMES, synthetic: false, lab: true, hidden: 32, epochs: 40, trainSamples: trX.length, testSamples: teX.length, testAUC: +a.toFixed(4), trainedAt: new Date().toISOString(), mlp: m.toJSON() };
fs.writeFileSync(outFile, JSON.stringify(out));
console.log(JSON.stringify({ input, rows: rows.length, train: trX.length, test: teX.length, testAUC: +a.toFixed(4), output: outFile }, null, 2));
