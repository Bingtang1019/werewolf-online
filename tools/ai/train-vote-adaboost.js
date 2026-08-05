'use strict';
/* =========================================================================
 * 1.7.0（B1-3）：vote 决策头训练器——决策树桩 AdaBoost + Platt scaling
 * 用法：node tools/ai/train-vote-adaboost.js <samples.jsonl> -o models/adaboost-vote-v1.json [-t 200] [--split-seed 42]
 * 样本行：{gameId, day, botId, candId, features:[...], label}（features 与 server/ai/features.js 的 FEATURE_NAMES 对齐）
 * 纪律：
 *   - 按 gameId 分层划分训练/留出（同局样本高度相关，随机划分=泄漏）
 *   - 只含公开信息特征（features.js 已保证）；label 才用真实身份（B1-7②）
 *   - 类别不平衡（狼:好≈3:10）：初始权重按类平衡 + Platt 校准兑住
 * 验收三件套（写死）：留出集 Brier < 0.22 && AUC > 0.6 && avgPWolf - avgPGood > 0.2——哪个不过都别上线
 * 输出：models/adaboost-vote-v1.json（纯数据随仓分发、零依赖、可快照；运行时 fail-open 回退旧逻辑）
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const { FEATURE_NAMES } = require('../../server/ai/features.js');

const args = {};
const posArgs = [];
process.argv.slice(2).forEach((a, i, arr) => {
  if (a === '-o') { args.out = arr[i + 1]; return; }
  if (a === '-t') { args.t = arr[i + 1]; return; }
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) args[m[1]] = m[2];
  else posArgs.push(a);
});
const inFile = posArgs.filter(p => p !== 'out' && p !== 't')[0];
const outFile = args.out || 'models/adaboost-vote-v1.json';
const T = parseInt(args.t || '200', 10);
const splitSeed = parseInt(args['split-seed'] || '42', 10);
if (!inFile || !fs.existsSync(inFile)) { console.error(`用法: node tools/ai/train-vote-adaboost.js <samples.jsonl> -o models/adaboost-vote-v1.json [-t 200] [--split-seed 42]`); process.exit(1); }

// ---------- 数据 ----------
function loadSamples(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try {
      const r = JSON.parse(line);
      if (Array.isArray(r.features) && (r.label === 0 || r.label === 1)) {
        if (r.features.length < FEATURE_NAMES.length) r.features = r.features.concat(new Array(FEATURE_NAMES.length - r.features.length).fill(0)); // 旧样本补 0（仅迁移期兼容；正式训练用新采集样本）
        rows.push(r);
      }
    } catch (e) {}
  }
  return rows;
}
function splitByGame(rows, seed) { // gameId 分层：训练/留出不共享同一局（防泄漏）
  const games = [...new Set(rows.map(r => r.gameId))];
  let h = seed >>> 0;
  const rnd = () => { h = (h * 1664525 + 1013904223) >>> 0; return h / 4294967296; };
  for (let i = games.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [games[i], games[j]] = [games[j], games[i]]; }
  const hold = new Set(games.slice(0, Math.max(1, Math.floor(games.length * 0.2))));
  const train = rows.filter(r => !hold.has(r.gameId));
  const test = rows.filter(r => hold.has(r.gameId));
  return { train, test };
}

// ---------- 决策树桩（加权最小错误） ----------
function trainStump(X, y, w, nFeat) {
  let best = null, bestErr = Infinity;
  const totalW = w.reduce((a, b) => a + b, 0);
  for (let f = 0; f < nFeat; f++) {
    const order = X.map((x, i) => ({ v: x[f], i })).sort((a, b) => a.v - b.v);
    let wPos = 0, wNeg = 0;
    for (let k = 0; k < order.length; k++) if (y[order[k].i] === 1) wPos += w[order[k].i]; else wNeg += w[order[k].i];
    let lPos = 0, lNeg = 0, prev = order[0].v;
    for (let k = 0; k < order.length; k++) {
      const { v, i } = order[k];
      if (v !== prev) {
        const thr = (prev + v) / 2;
        // 错误定义：左预测 1（狼）右预测 -1（好）→ 错=左好(lNeg)+右狼(wPos-lPos)；反之 → 错=左狼(lPos)+右好(wNeg-lNeg)
        const errPosLeft = (lNeg + (wPos - lPos)) / totalW;
        const errPosRight = (lPos + (wNeg - lNeg)) / totalW;
        if (errPosLeft < bestErr) { bestErr = errPosLeft; best = { f, thr, dir: 1 }; }
        if (errPosRight < bestErr) { bestErr = errPosRight; best = { f, thr, dir: -1 }; }
        prev = v;
      }
      if (y[i] === 1) lPos += w[i]; else lNeg += w[i];
    }
  }
  return best || { f: 0, thr: 0, dir: 1 };
}
function stumpPredict(st, x) { return (x[st.f] < st.thr ? 1 : -1) * st.dir; }

// ---------- AdaBoost ----------
function trainAdaBoost(X, y, nFeat, T) {
  const n = X.length;
  let pos = 0, neg = 0;
  for (const v of y) if (v === 1) pos++; else neg++;
  const w = y.map(v => (v === 1 ? 1 / (2 * pos) : 1 / (2 * neg))); // 类平衡初始权重
  const stumps = [];
  const errTrace = [];
  for (let t = 0; t < T; t++) {
    const st = trainStump(X, y, w, nFeat);
    let err = 0;
    for (let i = 0; i < n; i++) if (stumpPredict(st, X[i]) !== (y[i] === 1 ? 1 : -1)) err += w[i];
    err = Math.max(Math.min(err, 0.5 - 1e-9), 1e-9);
    if (t === 0) console.log(`[diag] 轮0桩: f=${st.f}（${FEATURE_NAMES[st.f] || st.f}） thr=${st.thr.toFixed(3)} dir=${st.dir} err=${err.toFixed(4)}`);
    errTrace.push(err);
    const alpha = 0.5 * Math.log((1 - err) / err);
    stumps.push({ f: st.f, thr: st.thr, dir: st.dir, alpha });
    let z = 0;
    for (let i = 0; i < n; i++) {
      const sign = y[i] === 1 ? 1 : -1;
      w[i] *= Math.exp(-alpha * sign * stumpPredict(st, X[i]));
      z += w[i];
    }
    for (let i = 0; i < n; i++) w[i] /= z;
  }
  console.log(`[diag] err 轨迹: ${errTrace.slice(0, 8).map(e => e.toFixed(3)).join(' ')} ... 末=${errTrace[errTrace.length - 1].toFixed(3)}`);
  return stumps;
}
function adaboostScore(stumps, x) { let s = 0; for (const st of stumps) s += st.alpha * stumpPredict(st, x); return s; }

// ---------- Platt scaling（留出集拟合） ----------
function plattFit(scores, y) {
  let A = 1, B = 0;
  const n = scores.length;
  for (let it = 0; it < 300; it++) {
    let gA = 0, gB = 0;
    for (let i = 0; i < n; i++) {
      const p = 1 / (1 + Math.exp(-(A * scores[i] + B)));
      gA += (y[i] - p) * scores[i];
      gB += (y[i] - p);
    }
    A += 0.02 * gA / n;
    B += 0.02 * gB / n;
  }
  return { A, B };
}
function plattProb(A, B, s) { return 1 / (1 + Math.exp(-(A * s + B))); }

// ---------- 指标 ----------
function brierScore(probs, y) { return probs.reduce((s, p, i) => s + (p - y[i]) ** 2, 0) / probs.length; }
function auc(probs, y) {
  const items = probs.map((p, i) => ({ p, y: y[i] })).sort((a, b) => a.p - b.p); // 升序：低分在前，高分在后（正例高分 → rank 大 → AUC 高）
  let pos = 0, neg = 0;
  for (const v of y) if (v === 1) pos++; else neg++;
  if (!pos || !neg) return 0.5;
  let rankSum = 0;
  for (let i = 0; i < items.length; i++) if (items[i].y === 1) rankSum += i + 1;
  return (rankSum - pos * (pos + 1) / 2) / (pos * neg);
}

// ---------- 主流程 ----------
console.log(`[train] 加载 ${inFile}`);
const rows = loadSamples(inFile);
const { train, test } = splitByGame(rows, splitSeed);
const X = train.map(r => r.features), y = train.map(r => r.label);
const nFeat = X[0].length;
console.log(`[train] 样本 训练 ${train.length} / 留出 ${test.length}（按 gameId 分层，seed=${splitSeed}） 轮 ${T} 特征 ${nFeat}`);
const t0 = Date.now();
const stumps = trainAdaBoost(X, y, nFeat, T);
console.log(`[train] AdaBoost 完成（${stumps.length} 桩，${((Date.now() - t0) / 1000).toFixed(1)}s）`);
// 诊断：训练集上的 f 分布（若训练集 f≈0 则是训练器 bug；若训练集有值而留出≈0 则是泛化问题）
{
  const ts = X.map(x => adaboostScore(stumps, x));
  const q = a => { const s = a.slice().sort((x, y) => x - y); return { p1: s[Math.floor(s.length * .01)], p50: s[Math.floor(s.length * .5)], p99: s[Math.floor(s.length * .99)], avg: s.reduce((x2, y2) => x2 + y2, 0) / s.length }; };
  console.log(`[diag] 训练集 f: p1=${q(ts).p1.toFixed(3)} p50=${q(ts).p50.toFixed(3)} p99=${q(ts).p99.toFixed(3)} avg=${q(ts).avg.toFixed(3)}`);
}
// Platt 用留出集
const tScores = test.map(r => adaboostScore(stumps, r.features));
const tY = test.map(r => r.label);
// 诊断：raw score 的狼/好平均差（未校准——判断判别力是否被 Platt 压平）
{
  const wS = [], gS = [];
  for (let i = 0; i < tScores.length; i++) (tY[i] === 1 ? wS : gS).push(tScores[i]);
  const avg = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length * p)]; };
  console.log(`[diag] raw 狼 n=${wS.length} avg=${avg(wS).toFixed(4)} p10=${q(wS, .1).toFixed(3)} p50=${q(wS, .5).toFixed(3)} p90=${q(wS, .9).toFixed(3)}`);
  console.log(`[diag] raw 好 n=${gS.length} avg=${avg(gS).toFixed(4)} p10=${q(gS, .1).toFixed(3)} p50=${q(gS, .5).toFixed(3)} p90=${q(gS, .9).toFixed(3)}`);
  const all = tScores.slice().sort((a, b) => a - b);
  console.log(`[diag] f 全局 p1=${q(all,.01).toFixed(3)} p50=${q(all,.5).toFixed(3)} p99=${q(all,.99).toFixed(3)}`);
}
const platt = plattFit(tScores, tY);
const tProbs = tScores.map(s => plattProb(platt.A, platt.B, s));
const brier = brierScore(tProbs, tY);
const a = auc(tProbs, tY);
const posProbs = tProbs.filter((p, i) => tY[i] === 1);
const negProbs = tProbs.filter((p, i) => tY[i] === 0);
const avgPWolf = posProbs.reduce((s, p) => s + p, 0) / (posProbs.length || 1);
const avgPGood = negProbs.reduce((s, p) => s + p, 0) / (negProbs.length || 1);
console.log(`\n--- 三件套验收（留出集 ${test.length} 条）---`);
console.log(`Brier = ${brier.toFixed(4)}（要求 <0.22）${brier < 0.22 ? '✔' : '✗'}`);
console.log(`AUC = ${a.toFixed(4)}（要求 >0.6）${a > 0.6 ? '✔' : '✗'}`);
console.log(`avgPWolf - avgPGood = ${(avgPWolf - avgPGood).toFixed(4)}（要求 >0.2）${avgPWolf - avgPGood > 0.2 ? '✔' : '✗'}`);
const pass = brier < 0.22 && a > 0.6 && (avgPWolf - avgPGood) > 0.2;
if (!pass) { console.error('验收未达标——调特征/样本量，不输出模型'); process.exit(1); }
const model = {
  schema: 'adaboost-vote@1', features: FEATURE_NAMES, stumps, platt,
  metrics: { brier: +brier.toFixed(4), auc: +a.toFixed(4), avgPWolf: +avgPWolf.toFixed(4), avgPGood: +avgPGood.toFixed(4) },
  nTrain: train.length, nTest: test.length, T: stumps.length, threshold: 0.5, trainedAt: new Date().toISOString(),
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(model));
console.log(`✔ 全部达标 → ${outFile}（${(fs.statSync(outFile).size / 1024).toFixed(0)}KB）`);
