'use strict';
/* tools/ai/eval-strategy-moe.js —— MoE B（策略层）离线配对验收：投票决策专家融合
 * 专家：v3v3 AdaBoost（A2） + π MLP（A5），同特征（V5 21 维）、同标签（候选是否为狼）。
 * 口径：按对局分组 80/20（seed 43），只报留出组；AUC/Brier/LogLoss + 静态均值 + 训练集学到的
 *       logit 堆叠门控（2 专家）+ 网格最优静态权重。
 * 结论用途：判断“策略层多专家融合”是否值得接线进 buildVoteWorld 的 modelProb 消费端。
 * 用法：node tools/ai/eval-strategy-moe.js [--input=... --epochs=40 --rounds=80 --json=...] */
const fs = require('fs');
const path = require('path');
const { AdaBoost } = require('../../wolfTrain/adaboost.js');
const { MLP } = require('../../server/ai/mlp.js');
const { V5_FEATURE_NAMES } = require('../../server/ai/intent-features.js');
const root = path.resolve(__dirname, '..', '..');
const args = {};
process.argv.slice(2).forEach(a => { const m = a.match(/^--([^=]+)=(.*)$/); if (m) args[m[1]] = m[2]; else if (a.startsWith('--')) args[a.slice(2)] = true; });
const input = path.resolve(root, args.input || 'data/vote-v3-v5/samples-big2.jsonl');
const epochs = parseInt(args.epochs || '40', 10) || 40;
const rounds = parseInt(args.rounds || '80', 10) || 80;

const rows = [];
for (const line of fs.readFileSync(input, 'utf8').trim().split('\n').filter(Boolean)) {
  const o = JSON.parse(line);
  if (o && o.v5 === true && Array.isArray(o.features) && o.features.length === V5_FEATURE_NAMES.length && typeof o.label === 'number') {
    rows.push({ x: o.features, y: Number(o.label), g: o.gameId || 'x' });
  }
}
if (!rows.length) { console.error(`[strategy-moe] 无样本: ${input}`); process.exit(1); }

function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffle(a, rnd) { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }
function auc(y, p) {
  const idx = p.map((v, i) => i).sort((a, b) => p[a] - p[b]);
  let nPos = 0, nNeg = 0, rs = 0;
  for (let i = 0; i < y.length; i++) { if (y[i] > 0) nPos++; else nNeg++; }
  for (let k = 0; k < idx.length; k++) if (y[idx[k]] > 0) rs += k + 1;
  return (nPos && nNeg) ? (rs - nPos * (nPos + 1) / 2) / (nPos * nNeg) : 0.5;
}
const brier = (y, p) => y.reduce((a, yi, i) => a + (p[i] - yi) ** 2, 0) / y.length;
const logloss = (y, p) => -y.reduce((a, yi, i) => a + (yi * Math.log(Math.max(1e-9, p[i])) + (1 - yi) * Math.log(Math.max(1e-9, 1 - p[i]))), 0) / y.length;
const logit = p => { const q = Math.max(1e-4, Math.min(1 - 1e-4, p)); return Math.log(q / (1 - q)); };
const sig = z => 1 / (1 + Math.exp(-z));

/* 分组切分（与 A2/A5/A3 同 seed 43 口径） */
const rnd = mulberry32(43);
const groups = [...new Set(rows.map(r => r.g))];
const gtr = new Set(shuffle(groups, rnd).slice(0, Math.max(1, Math.floor(groups.length * 0.8))));
const train = rows.filter(r => gtr.has(r.g));
const test = rows.filter(r => !gtr.has(r.g));

/* 专家 1：AdaBoost（A2 同构） */
const ada = new AdaBoost({ rounds, bins: 20 }).fit(train.map(r => r.x), train.map(r => r.y));
/* 专家 2：π MLP（A5 同构；验证集来自训练侧分组） */
const rnd2 = mulberry32(99);
const trGroups = [...new Set(train.map(r => r.g))];
const gVal = new Set(shuffle(trGroups, rnd2).slice(0, Math.max(1, Math.floor(trGroups.length * 0.15))));
const fitRows = train.filter(r => !gVal.has(r.g));
const valRows = train.filter(r => gVal.has(r.g));
const pi = new MLP({ hidden: 32, epochs, lr: 1e-3, batch: 16, l2: 1e-4, seed: 7 });
pi.fit(fitRows.map(r => r.x), fitRows.map(r => r.y), valRows.map(r => r.x), valRows.map(r => r.y), null, null);

const yTr = train.map(r => r.y), yTe = test.map(r => r.y);
/* 概率化：AdaBoost v3v3 输出为 raw score（运行时也仅做单调 sigmoid 排序）→ 训练组上 Platt 校准；
 * π 已是 sigmoid 概率，但仍过同一校准层，保证两专家概率口径一致、融合指标可比。 */
function platt(raws, ys, epochs2 = 400, lr2 = 0.1) {
  let A = 1, B = 0;
  for (let ep = 0; ep < epochs2; ep++) {
    let gA = 0, gB = 0;
    for (let i = 0; i < raws.length; i++) { const e = sig(A * raws[i] + B) - ys[i]; gA += e * raws[i]; gB += e; }
    A -= lr2 * gA / raws.length; B -= lr2 * gB / raws.length;
  }
  return r => sig(A * r + B);
}
const rawA_tr = train.map(r => ada.predict(r.x)), rawA_te = test.map(r => ada.predict(r.x));
const rawP_tr = train.map(r => pi.predict(r.x)), rawP_te = test.map(r => pi.predict(r.x));
const calA = platt(rawA_tr, yTr), calP = platt(rawP_tr, yTr);
const pA_tr = rawA_tr.map(calA), pA_te = rawA_te.map(calA);
const pP_tr = rawP_tr.map(calP), pP_te = rawP_te.map(calP);

/* 融合 1：静态 50:50 */
const mean_te = pA_te.map((v, i) => (v + pP_te[i]) / 2);
/* 融合 2：训练集网格最优静态权重 */
let bestW = 0.5, bestAuc = -1;
for (let w = 0; w <= 1.0001; w += 0.05) {
  const a = auc(yTr, pA_tr.map((v, i) => w * v + (1 - w) * pP_tr[i]));
  if (a > bestAuc) { bestAuc = a; bestW = w; }
}
const grid_te = pA_te.map((v, i) => bestW * v + (1 - bestW) * pP_te[i]);
/* 融合 3：logit 堆叠门控（2 特征 + bias，L2 逻辑回归） */
const Xtr = train.map((_, i) => [1, logit(pA_tr[i]), logit(pP_tr[i])]);
const Xte = test.map((_, i) => [1, logit(pA_te[i]), logit(pP_te[i])]);
const wg = [0, 0, 0];
for (let ep = 0; ep < 600; ep++) {
  const g = [0, 0, 0];
  for (let i = 0; i < Xtr.length; i++) {
    const p = sig(Xtr[i][0] * wg[0] + Xtr[i][1] * wg[1] + Xtr[i][2] * wg[2]);
    const err = p - yTr[i];
    for (let k = 0; k < 3; k++) g[k] += err * Xtr[i][k];
  }
  for (let k = 0; k < 3; k++) wg[k] -= 0.05 * (g[k] / Xtr.length + (k ? 1e-3 * wg[k] : 0));
}
const stack_te = Xte.map(x => sig(x[0] * wg[0] + x[1] * wg[1] + x[2] * wg[2]));
const stack_tr = Xtr.map(x => sig(x[0] * wg[0] + x[1] * wg[1] + x[2] * wg[2]));

const M = (p) => ({ auc: +auc(yTe, p).toFixed(4), brier: +brier(yTe, p).toFixed(4), logloss: +logloss(yTe, p).toFixed(4) });
const report = {
  generatedAt: new Date().toISOString(), input: path.relative(root, input),
  rows: rows.length, trainRows: train.length, testRows: test.length, testGroups: groups.length - gtr.size,
  experts: {
    adaV3v3: M(pA_te),
    piIntent: M(pP_te),
  },
  fusion: {
    mean5050: M(mean_te),
    gridBest: { wAda: +bestW.toFixed(2), wPi: +(1 - bestW).toFixed(2), trainAUC: +bestAuc.toFixed(4), test: M(grid_te) },
    stackedGate: { weights: wg.map(v => +v.toFixed(4)), train: { auc: +auc(yTr, stack_tr).toFixed(4), brier: +brier(yTr, stack_tr).toFixed(4) }, test: M(stack_te) },
  },
  verdict: null,
};
const bestSingle = Math.max(report.experts.adaV3v3.auc, report.experts.piIntent.auc);
const bestFusion = Math.max(report.fusion.mean5050.auc, report.fusion.gridBest.test.auc, report.fusion.stackedGate.test.auc);
const singleLL = Math.min(report.experts.adaV3v3.logloss, report.experts.piIntent.logloss);
const fusionLL = report.fusion.stackedGate.test.logloss;
const llGain = +(singleLL - fusionLL).toFixed(4);
report.verdict = {
  bestSingleAUC: +bestSingle.toFixed(4), bestFusionAUC: +bestFusion.toFixed(4), gain: +(bestFusion - bestSingle).toFixed(4),
  loglossGainOfStack: llGain,
  recommend: (bestFusion - bestSingle > 0.01) ? 'worth-wiring-ranking'
    : (llGain > 0.02 ? 'calibration-only' : 'no-gain-yet'),
};
console.log(JSON.stringify(report, null, 2));
if (typeof args.json === 'string') { const p = path.resolve(root, args.json); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(report, null, 2)); }
