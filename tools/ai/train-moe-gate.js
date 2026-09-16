'use strict';
/* tools/ai/train-moe-gate.js —— MoE D：堆叠/学习型门控（离线验收优先）
 * 动机：MoE A 的启发式门控在真实留出组上把 57% 权重给了最弱的 V3.1（AUC 0.574），
 *       融合 0.613 < 最强单专家 V5-intent 0.688 → 固定先验失效，需要让门控从数据里学。
 * 特征：三位专家 logit(±8 截断) + V4.2 σ + 意图强度（可选 cfg one-hot）
 * 训练：L2 逻辑回归，全批量梯度下降（纯 JS，无依赖）；早停按训练 AUC 的 5 轮平滑。
 * 口径：按对局分组 80/20（seed 43，与 train-v5-value-real.js / eval-moe.js 同分组），只报留出组。
 * 输出：models/moe-gate-v1.json（供 moe-value.js 的 MOE_GATE_MODEL 消费）
 * 用法：node tools/ai/train-moe-gate.js [--samples=... --records=... --out=... --epochs=800] */
process.env.MOE_V5_MODEL = process.env.MOE_V5_MODEL || 'models/value-hicvn-v4-intent-real.json';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const v3 = require(path.join(root, 'server/ai/value-model.js'));
const v4 = require(path.join(root, 'server/ai/value-model-v4.js'));
const moe = require(path.join(root, 'server/ai/moe-value.js'));
const args = {};
process.argv.slice(2).forEach(a => { const m = a.match(/^--([^=]+)=(.*)$/); if (m) args[m[1]] = m[2]; else if (a.startsWith('--')) args[a.slice(2)] = true; });
const sampleFile = path.resolve(root, args.samples || 'data/vote-v3-v5/samples-val-big.jsonl');
const recordFile = path.resolve(root, args.records || 'data/v5-records-val-big.jsonl');
const outFile = path.resolve(root, args.out || 'models/moe-gate-v1.json');
const epochs = parseInt(args.epochs || '800', 10) || 800;

/* ---------- 数据 ---------- */
function readJsonl(f) { const out = []; try { for (const l of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) { try { out.push(JSON.parse(l)); } catch (e) {} } } catch (e) {} return out; }
const winners = {};
for (const o of readJsonl(recordFile)) if (o && o.gameId && o.result) winners[o.gameId] = o.result.winner;
const rows = [];
for (const o of readJsonl(sampleFile)) {
  if (!o || o.v5v !== true || !o.state || !o.gameId) continue;
  const w = winners[o.gameId];
  if (w !== 'good' && w !== 'wolf') continue;
  rows.push({ g: o.gameId, s: o.state, cfg: o.config || '12p', y: w === 'good' ? 1 : 0 });
}
if (!rows.length) { console.error('[moe-gate] 无可用样本'); process.exit(1); }

function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffle(a, rnd) { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }
const rnd = mulberry32(43);
const groups = [...new Set(rows.map(r => r.g))];
const gtr = new Set(shuffle(groups, rnd).slice(0, Math.max(1, Math.floor(groups.length * 0.8))));
const train = rows.filter(r => gtr.has(r.g));
const test = rows.filter(r => !gtr.has(r.g));

const logit = p => { const q = Math.max(1e-4, Math.min(1 - 1e-4, p)); return Math.log(q / (1 - q)); };
function auc(y, p) {
  const idx = p.map((v, i) => i).sort((a, b) => p[a] - p[b]);
  let nPos = 0, nNeg = 0, rs = 0;
  for (let i = 0; i < y.length; i++) { if (y[i] > 0) nPos++; else nNeg++; }
  for (let k = 0; k < idx.length; k++) if (y[idx[k]] > 0) rs += k + 1;
  return (nPos && nNeg) ? (rs - nPos * (nPos + 1) / 2) / (nPos * nNeg) : 0.5;
}
const brier = (y, p) => y.reduce((a, yi, i) => a + (p[i] - yi) ** 2, 0) / y.length;
const logloss = (y, p) => -y.reduce((a, yi, i) => a + (yi * Math.log(Math.max(1e-9, p[i])) + (1 - yi) * Math.log(Math.max(1e-9, 1 - p[i]))), 0) / y.length;

/* ---------- 专家特征（每行一次，供训练/评估复用） ---------- */
function feats(rs) {
  const F = [];
  for (const r of rs) {
    const e = moe.explain(r.s, r.cfg);
    const l3 = logit(e.val3), l4 = logit(e.val4), l5 = e.val5 == null ? 0 : logit(e.val5);
    const has5 = e.val5 == null ? 0 : 1;
    const cfgVec = v4.KNOWN_CONFIGS.map(k => (k === r.cfg ? 1 : 0));
    F.push({ x: [1, l3, l4, l5, e.sigma, e.intent, has5, ...cfgVec], y: r.y, base: [e.val3, e.val4, e.val5] });
  }
  return F;
}
const TR = feats(train), TE = feats(test);
const D = TR[0].x.length;

/* ---------- L2 逻辑回归（全批量 GD） ---------- */
const w = new Array(D).fill(0);
const lr = 0.05, l2 = 1e-3;
const sig = z => 1 / (1 + Math.exp(-z));
function predictF(F, ww) { return F.map(r => sig(r.x.reduce((a, x, i) => a + x * ww[i], 0))); }
let prevTrainAuc = 0, best = null;
for (let ep = 1; ep <= epochs; ep++) {
  const g = new Array(D).fill(0);
  for (const r of TR) {
    const p = sig(r.x.reduce((a, x, i) => a + x * w[i], 0));
    const err = p - r.y;
    for (let i = 0; i < D; i++) g[i] += err * r.x[i];
  }
  for (let i = 0; i < D; i++) w[i] -= lr * (g[i] / TR.length + l2 * (i === 0 ? 0 : w[i]));
  if (ep % 50 === 0 || ep === epochs) {
    const a = auc(TR.map(r => r.y), predictF(TR, w));
    const smooth = prevTrainAuc * 0.8 + a * 0.2;
    if (!best || a > best.auc) best = { auc: +a.toFixed(4), ep, w: w.slice() };
    prevTrainAuc = smooth;
  }
}
const finalW = best ? best.w : w;

const yTe = TE.map(r => r.y), yTr = TR.map(r => r.y);
const pGateTe = predictF(TE, finalW), pGateTr = predictF(TR, finalW);
const pV5Te = TE.map(r => (r.base[2] == null ? 0.5 : r.base[2]));
const pV5Tr = TR.map(r => (r.base[2] == null ? 0.5 : r.base[2]));
const pV4Te = TE.map(r => r.base[1]);

const report = {
  generatedAt: new Date().toISOString(),
  rows: rows.length, trainRows: train.length, testRows: test.length, testGroups: groups.length - gtr.size,
  v5Model: process.env.MOE_V5_MODEL,
  gate: { dim: D, epochs, l2, bestEpoch: best ? best.ep : null, weights: finalW.map(v => +v.toFixed(4)), featureNames: ['bias', 'logit_v3', 'logit_v4', 'logit_v5', 'sigma', 'intent', 'hasV5', ...v4.KNOWN_CONFIGS.map(k => 'cfg_' + k)] },
  train: { auc: +auc(yTr, pGateTr).toFixed(4), brier: +brier(yTr, pGateTr).toFixed(4) },
  test: {
    gate: { auc: +auc(yTe, pGateTe).toFixed(4), brier: +brier(yTe, pGateTe).toFixed(4), logloss: +logloss(yTe, pGateTe).toFixed(4) },
    v5Only: { auc: +auc(yTe, pV5Te).toFixed(4), brier: +brier(yTe, pV5Te).toFixed(4), logloss: +logloss(yTe, pV5Te).toFixed(4) },
    v4Only: { auc: +auc(yTe, pV4Te).toFixed(4), brier: +brier(yTe, pV4Te).toFixed(4), logloss: +logloss(yTe, pV4Te).toFixed(4) },
  },
};
fs.writeFileSync(outFile, JSON.stringify({ schema: 'moe-gate@1', featureNames: report.gate.featureNames, weights: finalW, v5Model: process.env.MOE_V5_MODEL, meta: report }, null, 2));
console.log(JSON.stringify(report, null, 2));
