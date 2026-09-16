'use strict';
/* tools/ai/eval-moe.js —— V5 MoE（A+F）离线配对验收：真实状态 + 胜方标签
 * 数据：V5_VALUE_SAMPLES=1 采集的 v5v 状态（同 A3 真实对照）+ lab 记录 winner
 * 对照：V3.1 / V4.2 / V5-intent（默认 models/value-hicvn-v4-intent-real.json，MOE_V5_MODEL 可换）
 *       / 静态 50:50 / MoE 门控融合 / 训练集网格搜索的静态权重上界
 * 口径：按对局分组 80/20（与 train-v5-value-real.js 同 seed 43 同 test 分组），只报留出组指标；
 *       AUC + Brier + LogLoss + McNemar(χ², 阈值 0.5) + 门控权重分布。
 * 用法：node tools/ai/eval-moe.js [--samples=... --records=... --no-grid --json=...]
 * 注意：MoE 的 V5 专家若为合成模型（默认 value-hicvn-v4-intent.json），结果无意义；验收须指向真实对照模型。 */
process.env.MOE_V5_MODEL = process.env.MOE_V5_MODEL || 'models/value-hicvn-v4-intent-real.json';
process.env.MOE_MODE = 'on';
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
const KNOWN = v4.KNOWN_CONFIGS;

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
if (!rows.length) { console.error('[moe-eval] 无可用样本'); process.exit(1); }

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

/* 与 A3 训练器同 seed/同分组口径 */
const rnd = mulberry32(43);
const groups = [...new Set(rows.map(r => r.g))];
const gtr = new Set(shuffle(groups, rnd).slice(0, Math.max(1, Math.floor(groups.length * 0.8))));
const train = rows.filter(r => gtr.has(r.g));
const test = rows.filter(r => !gtr.has(r.g));

function predict(rs) {
  const out = { v3: [], v4: [], v5: [], moe: [], avg: [], intent: [], sigma: [] };
  for (const r of rs) {
    const e = moe.explain(r.s, r.cfg);
    out.v3.push(e.val3); out.v4.push(e.val4);
    out.v5.push(e.val5 == null ? 0.5 : e.val5);
    out.moe.push(Math.max(0, Math.min(1, e.fused)));
    out.avg.push((e.val3 + e.val4) / 2);
    out.intent.push(e.intent);
    out.sigma.push(e.sigma);
  }
  return out;
}
const P = predict(test);
const y = test.map(r => r.y);
const metrics = {};
for (const k of ['v3', 'v4', 'v5', 'avg', 'moe']) metrics[k] = { auc: +auc(y, P[k]).toFixed(4), brier: +brier(y, P[k]).toFixed(4), logloss: +logloss(y, P[k]).toFixed(4) };

/* 门控权重分布（test 集） */
const wsum = { w3: 0, w4: 0, w5: 0 };
let wN = 0, v5Missing = 0;
for (const r of test) { const e = moe.explain(r.s, r.cfg); if (e.val5 == null) { v5Missing++; continue; } wsum.w3 += e.weights.w3; wsum.w4 += e.weights.w4; wsum.w5 += e.weights.w5; wN++; }
const weights = wN ? { w3: +(wsum.w3 / wN).toFixed(3), w4: +(wsum.w4 / wN).toFixed(3), w5: +(wsum.w5 / wN).toFixed(3), n: wN, v5Missing } : null;

/* McNemar：MoE vs V4.2（阈值 0.5 判对错） */
function mcnemar(pa, pb) {
  let b = 0, c = 0, both = 0, neither = 0;
  for (let i = 0; i < y.length; i++) {
    const ca = (pa[i] >= 0.5) === !!y[i], cb = (pb[i] >= 0.5) === !!y[i];
    if (ca && cb) both++; else if (!ca && !cb) neither++; else if (ca) b++; else c++;
  }
  const chi2 = (b + c) ? +(((Math.abs(b - c) - 1) ** 2) / (b + c)).toFixed(3) : 0;
  return { moeOnly: b, v4Only: c, both, neither, chi2, significant: chi2 > 3.841 };
}
const mcn = mcnemar(P.moe, P.v4);

/* 静态权重上界：训练集网格搜索（0.05 步长），迁移到留出组 */
let grid = null;
if (!args['no-grid']) {
  const TR = predict(train); const ty = train.map(r => r.y);
  let best = { auc: -1, w3: 0, w4: 1, w5: 0 };
  for (let w3 = 0; w3 <= 1.0001; w3 += 0.05) {
    for (let w4 = 0; w4 <= 1.0001 - w3; w4 += 0.05) {
      const w5 = 1 - w3 - w4;
      const p = ty.map((_, i) => w3 * TR.v3[i] + w4 * TR.v4[i] + w5 * TR.v5[i]);
      const a = auc(ty, p);
      if (a > best.auc) best = { auc: +a.toFixed(4), w3: +w3.toFixed(2), w4: +w4.toFixed(2), w5: +w5.toFixed(2) };
    }
  }
  const p = y.map((_, i) => best.w3 * P.v3[i] + best.w4 * P.v4[i] + best.w5 * P.v5[i]);
  grid = { trainBest: best, testAUC: +auc(y, p).toFixed(4), testBrier: +brier(y, p).toFixed(4) };
}

const report = {
  generatedAt: new Date().toISOString(),
  samples: path.relative(root, sampleFile), rows: rows.length, trainRows: train.length, testRows: test.length,
  gameGroups: groups.length, testGroups: groups.length - gtr.size,
  v5Model: process.env.MOE_V5_MODEL,
  metrics, weights, mcnemar: mcn, staticGrid: grid,
  note: 'V4.2/V3.1 为历史数据训练的生产模型；V5-intent 在训练组上训练、测试组为留出；MoE 权重为门控在留出组的均值。',
};
console.log(JSON.stringify(report, null, 2));
if (typeof args.json === 'string') { const p = path.resolve(root, args.json); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(report, null, 2)); }
