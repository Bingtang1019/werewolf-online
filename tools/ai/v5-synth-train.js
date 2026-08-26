'use strict';
/* tools/ai/v5-synth-train.js —— V5 A2/A5 合成数据端到端训练冒烟
 * 生成 21 维（13 基础 + 8 意图）合成样本，训练一个 π 版 MLP，输出合成模型与 AUC。
 * 仅用于验证训练/推理链路，不代表生产模型。 */
const path = require('path');
const { MLP } = require('../../server/ai/mlp.js');
const { V5_FEATURE_NAMES } = require('../../server/ai/intent-features.js');
const root = path.resolve(__dirname, '..', '..');

function mulberry32(a) {
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function auc(y, p) {
  const idx = p.map((v, i) => i).sort((a, b) => p[a] - p[b]);
  let rs = 0, nPos = 0, nNeg = 0;
  for (let i = 0; i < y.length; i++) { if (y[i] > 0) nPos++; else nNeg++; }
  for (let k = 0; k < idx.length; k++) { if (y[idx[k]] > 0) rs += k + 1; }
  return (rs - nPos * (nPos + 1) / 2) / (nPos * nNeg);
}

const N = 3000, D = V5_FEATURE_NAMES.length;
const rnd = mulberry32(42);
const X = [], y = [];
for (let i = 0; i < N; i++) {
  const x = Array.from({ length: D }, () => rnd());
  // 简单非线性合成规则：攻击/投票/查验信号 → 正类
  const score = x[0] * 0.8 + x[5] * 1.1 + x[6] * 0.9 - 0.9;
  X.push(x);
  y.push(score > 0 ? 1 : 0);
}
const split = Math.floor(N * 0.8);
const trX = X.slice(0, split), trY = y.slice(0, split);
const teX = X.slice(split), teY = y.slice(split);
const m = new MLP({ hidden: 48, epochs: 30, lr: 1e-3, batch: 64, l2: 1e-4, seed: 7 });
m.fit(trX, trY, teX.slice(0, 200), teY.slice(0, 200), null, null);
const pred = teX.map(x => m.predict(x));
const a = auc(teY, pred);
const outPath = path.join(root, 'models', 'v5-pi-synthetic.json');
const out = {
  schema: 'vote-pi@1',
  features: V5_FEATURE_NAMES,
  synthetic: true,
  hidden: 48,
  epochs: 30,
  trainSamples: split,
  testSamples: teX.length,
  testAUC: +a.toFixed(4),
  trainedAt: new Date().toISOString(),
  mlp: m.toJSON(),
};
require('fs').writeFileSync(outPath, JSON.stringify(out));
console.log(JSON.stringify({ N, D, testAUC: +a.toFixed(4), output: outPath }, null, 2));
