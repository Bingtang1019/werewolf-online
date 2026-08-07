'use strict';
/**
 * v4-smoke.js — V4 组件单元自测（无依赖，秒级）
 *  1) GBDT 在合成数据上的学习能力（train AUC 应接近 1）
 *  2) MLP  在合成数据上的学习能力（train AUC 应显著 > 0.5）
 *  3) GBDT/MLP 序列化 roundtrip：toJSON → fromJSON → predict 逐位一致
 *  4) 集成 sigma 基本行为（std ≥ 0）
 * 用法：node tools/ai/v4-smoke.js
 * 退出码：0 = 全部通过；1 = 有失败项
 */
const { GBDT } = require('../../server/ai/gbdt');
const { MLP } = require('../../server/ai/mlp');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}  ${detail || ''}`); }
}

function auc(y, s) {
  const n = y.length, idx = Array.from({ length: n }, (_, i) => i);
  idx.sort((a, b) => s[a] - s[b]);
  let sp = 0, np = 0, nn = 0;
  for (let i = 0; i < n; i++) { if (y[i] === 1) np++; else nn++; }
  for (let i = 0; i < n; i++) { if (y[idx[i]] === 1) sp += i + 1; }
  return np > 0 && nn > 0 ? (sp - np * (np + 1) / 2) / (np * nn) : 0.5;
}

// 合成数据：y = sign(2x0 − 3x1 + 0.5)（确定性线性可分——测“学习能力”须用无标签噪声数据；
// 原伯努利采样（rnd()<p）引入标签噪声，MLP val 早停在噪声下训练集 AUC 仅 ~0.88，非实现缺陷）
function synth(n) {
  let seed = 123;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const X = [], y = [];
  for (let i = 0; i < n; i++) {
    const x0 = rnd() * 2 - 1, x1 = rnd() * 2 - 1, x2 = rnd();
    const z = 2 * x0 - 3 * x1 + 0.5;
    X.push([x0, x1, x2]);
    y.push(z > 0 ? 1 : 0);
  }
  return { X, y };
}

function main() {
  console.log('[v4-smoke] 1) GBDT 学习能力');
  const { X, y } = synth(2000);
  const g = new GBDT({ trees: 100, depth: 3, bins: 32, minLeaf: 10, lr: 0.1, seed: 42 });
  g.fit(X, y);
  const gPred = X.map(x => g.predict(x));
  const gAuc = auc(y, gPred);
  check('GBDT train AUC > 0.95（合成线性可分）', gAuc > 0.95, `AUC=${gAuc.toFixed(4)}`);

  console.log('[v4-smoke] 2) MLP 学习能力');
  const m = new MLP({ hidden: 32, lr: 5e-3, epochs: 60, batch: 128, l2: 1e-4, seed: 42 });
  m.fit(X, y, X.slice(0, 200), y.slice(0, 200));
  const mPred = X.map(x => m.predict(x));
  const mAuc = auc(y, mPred);
  check('MLP train AUC > 0.90', mAuc > 0.90, `AUC=${mAuc.toFixed(4)}`);

  console.log('[v4-smoke] 3) 序列化 roundtrip');
  const g2 = GBDT.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
  const m2 = MLP.fromJSON(JSON.parse(JSON.stringify(m.toJSON())));
  let gMax = 0, mMax = 0;
  for (let i = 0; i < 100; i++) {
    gMax = Math.max(gMax, Math.abs(g.predict(X[i]) - g2.predict(X[i])));
    mMax = Math.max(mMax, Math.abs(m.predict(X[i]) - m2.predict(X[i])));
  }
  check('GBDT roundtrip 逐位一致', gMax === 0, `maxDiff=${gMax}`);
  check('MLP  roundtrip 逐位一致', mMax === 0, `maxDiff=${mMax}`);

  console.log('[v4-smoke] 4) 集成 sigma 基本行为');
  const ms = [
    new MLP({ hidden: 16, lr: 5e-3, epochs: 20, batch: 128, seed: 1 }),
    new MLP({ hidden: 16, lr: 5e-3, epochs: 20, batch: 128, seed: 2 }),
  ];
  for (const mm of ms) mm.fit(X, y, X.slice(0, 200), y.slice(0, 200));
  const vs = ms.map(mm => mm.predict(X[0]));
  const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
  const sd = Math.sqrt(vs.reduce((a, b) => a + (b - mean) ** 2, 0) / vs.length);
  check('sigma = 成员 std ≥ 0 且 < 0.5', sd >= 0 && sd < 0.5, `sigma=${sd.toFixed(4)}`);

  console.log(failures === 0 ? '\n[v4-smoke] 全部通过 ✓' : `\n[v4-smoke] ${failures} 项失败 ✗`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
