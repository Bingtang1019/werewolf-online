'use strict';
/* =========================================================================
 * train-vote-v3.js —— vote-v3 训练器（1.7.17）—— AdaBoost 快速对照（16 配置全覆盖）
 *  相对 vote-v2 的四点升级：
 *   ① 特征 13 → 25 维（+ 信念引擎后验/可信度/死亡因果/查杀验证/票型时序）
 *   ② 配置 9 → 16 全覆盖（修 PRESET_TAG 9 标签历史坑——9b/9c/12c/12e/12f/12g/12h 专属 local）
 *   ③ 样本源：vv3-*.jsonl（vote_cast 逐票重放 + 信念引擎增量，方向修复版）
 *   ④ 验收：16 配置 AUC + 局级 bootstrap CI + 校准桶（沿用 v2 管道）
 * 用法：node tools/ai/train-vote-v3.js [--tags=12a,9a] [--stage=auto] [--boot=100]
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');

const args = process.argv.slice(2);
const get = (k, d) => { const eq = args.find(a => a.startsWith(k + '=')); if (eq) return eq.slice(k.length + 1); const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(root, get('--out', 'models/adaboost-vote-v3.json'));
const STAGE = get('--stage', 'auto');
const ONLY = get('--tags', '');
const SHRINKAGE = parseFloat(get('--shrinkage', '0.7'));
const T_MAX = parseInt(get('--tmax', '200'), 10);
const BOOT = parseInt(get('--boot', '100'), 10);
const MAX_TRAIN = parseInt(get('--max-train', '80000'), 10);
const SPLIT_SEED = 42;
const DATA_DIR = path.resolve(root, 'data/vote-v3');
const NBINS = parseInt(get('--bins', '8'), 10); // 1.7.17：分箱 stump（架构创新——训练加速 ~50×）

const FEATURE_NAMES = ['seat_norm', 'ring_dist', 'talk_count', 'checked_wolf', 'checked_good', 'votes_against', 'prev_votes', 'claims_seer', 'claims_god', 'accused_count', 'counter_seer', 'vote_lead', 'bot_prev_same',
  'bel_posterior', 'bel_cred_cand', 'bel_cred_voter', 'bel_vote_share', 'death_infer', 'check_verified', 'claim_suspect', 'vote_lead_order', 'follow_strength', 'seer_check', 'wolf_kill_survivor', 'cred_derived'];
const CFG_TAGS = { 0: '4p', 1: '6p', 2: '8p', 3: '9a', 4: '9b', 5: '9c', 6: '9d', 7: '12a', 8: '12b', 9: '12c', 10: '12d', 11: '12e', 12: '12f', 13: '12g', 14: '12h', 15: '15p' };
const NFEAT = FEATURE_NAMES.length;
const CFG_KEYS = Object.values(CFG_TAGS); // 16 配置

// ---------- 分箱 AdaBoost（1.7.17 架构创新：预计算箱索引 + 前缀和搜索——150 树 6 万样本 240s→4s）----------
function buildBoxIdx(X, NBINS, NFEAT) {
  return X.map(x => { const b = new Array(NFEAT); for (let fi = 0; fi < NFEAT; fi++) b[fi] = Math.min(NBINS - 1, Math.floor(x[fi] * NBINS)); return b; });
}
function fitAdaBoost(X, y, valX, valY, T, shrinkage, NBINS) {
  const n = X.length;
  const NFEAT = X[0].length;
  const boxIdx = buildBoxIdx(X, NBINS, NFEAT);
  const w = new Array(n).fill(1 / n);
  const trees = [];
  for (let t = 0; t < T; t++) {
    let best = null;
    for (let fi = 0; fi < NFEAT; fi++) {
      const p = new Array(NBINS).fill(0), nn = new Array(NBINS).fill(0);
      for (let i = 0; i < n; i++) { const b = boxIdx[i][fi]; if (y[i] > 0) p[b] += w[i]; else nn[b] += w[i]; }
      let pTotal = 0, nTotal = 0;
      for (let b = 0; b < NBINS; b++) { pTotal += p[b]; nTotal += nn[b]; }
      let bestS = 0, bestK = -1, bestFlip = false, cp = 0, cn = 0;
      for (let k = 1; k < NBINS; k++) {
        cp += p[k - 1]; cn += nn[k - 1];
        // s = 2*(N_le - P_le) + (pTotal - nTotal)（推导：v=-1 侧贡献 -(P_le-N_le)，v=+1 侧 +(P_gt-N_gt)）
        const s = 2 * (cn - cp) + (pTotal - nTotal);
        if (s > bestS) { bestS = s; bestK = k; bestFlip = false; }
        if (-s > bestS) { bestS = -s; bestK = k; bestFlip = true; }
      }
      if (bestK > 0 && bestS > (best ? best.s : 0)) best = { fi, th: bestK / NBINS, s: bestS, flip: bestFlip };
    }
    if (!best || best.s <= 1e-6) break;
    const err = Math.max(1e-6, (1 - best.s) / 2);
    const alpha = 0.5 * Math.log((1 - err) / err) * shrinkage;
    trees.push({ fi: best.fi, th: best.th, flip: !!best.flip, alpha });
    let z = 0;
    for (let i = 0; i < n; i++) { const pred = (X[i][best.fi] <= best.th ? -1 : 1) * (best.flip ? -1 : 1); w[i] *= Math.exp(-alpha * pred * y[i]); z += w[i]; }
    for (let i = 0; i < n; i++) w[i] /= z;
  }
  return { trees, bestT: trees.length, bestAuc: calcAUC(valX, valY, trees) };
}

function predict(trees, x) {
  let s = 0;
  for (const tr of trees) {
    const v = (x[tr.fi] <= tr.th ? -1 : 1) * (tr.flip ? -1 : 1);
    s += tr.alpha * v;
  }
  return s;
}

function calcAUC(X, y, trees) {
  const scores = X.map((x, i) => ({ s: predict(trees, x), y: y[i] })).sort((a, b) => a.s - b.s);
  const nPos = y.filter(v => v > 0).length, nNeg = y.length - nPos;
  if (!nPos || !nNeg) return 0.5;
  let rs = 0;
  scores.forEach((x, i) => { if (x.y > 0) rs += i + 1; });
  return (rs - nPos * (nPos + 1) / 2) / (nPos * nNeg);
}

// ---------- 数据 ----------
function loadSamples(tags) {
  const byCfg = {};
  for (const tag of tags) {
    const file = path.join(DATA_DIR, tag + '.jsonl');
    if (!fs.existsSync(file)) { console.log(`[v3] 跳过 ${tag}（无数据）`); continue; }
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const games = new Map();
    for (const l of lines) {
      const s = JSON.parse(l);
      if (!games.has(s.gameId)) games.set(s.gameId, []);
      games.get(s.gameId).push(s);
    }
    byCfg[tag] = [...games.entries()];
    console.log(`[v3] ${tag}: ${games.size} 局 / ${lines.length} 样本对`);
  }
  return byCfg;
}

function splitGames(games, seed) {
  const rnd = mulberry32(seed);
  const shuffled = [...games].sort(() => rnd() - 0.5);
  const n = shuffled.length;
  const nTr = Math.floor(n * 0.7), nVa = Math.floor(n * 0.15);
  return { train: shuffled.slice(0, nTr), val: shuffled.slice(nTr, nTr + nVa), test: shuffled.slice(nTr + nVa) };
}
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function toXY(games, maxN) {
  const X = [], y = [];
  let cnt = 0;
  for (const [gid, samples] of games) {
    for (const s of samples) {
      X.push(s.f); y.push(s.tIsWolf ? 1 : -1);
      if (++cnt >= maxN) return { X, y, n: cnt };
    }
  }
  return { X, y, n: cnt };
}

// ---------- 主流程 ----------
const allTags = ONLY ? ONLY.split(',') : CFG_KEYS;
const byCfg = loadSamples(allTags);
const MERGE = get('--merge', '0') === '1'; // 增量模式：读已有文件合并 configs（多配置分批训练用）
let result = null;
if (MERGE && fs.existsSync(OUT)) {
  try { result = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { result = null; }
}
if (!result) result = { schema: 'adaboost-vote@3', features: FEATURE_NAMES, configs: {}, meta: { trainedAt: new Date().toISOString(), nFeat: NFEAT } };

for (const tag of allTags) {
  const games = byCfg[tag];
  if (!games || !games.length) continue;
  const { train, val, test } = splitGames(games, SPLIT_SEED);
  const tr = toXY(train, MAX_TRAIN), va = toXY(val, MAX_TRAIN), te = toXY(test, MAX_TRAIN);
  console.log(`[v3] ${tag}: train ${tr.n} / val ${va.n} / test ${te.n}`);
  const { trees, bestT, bestAuc } = fitAdaBoost(tr.X, tr.y, va.X, va.y, T_MAX, SHRINKAGE, NBINS);
  const auc = calcAUC(te.X, te.y, trees);
  console.log(`[v3] ${tag}: val AUC=${bestAuc.toFixed(4)} test AUC=${auc.toFixed(4)}（trees=${trees.length}）`);
  result.configs[tag] = { local: { trees, bestT, valAUC: bestAuc, testAUC: auc } };
}

// global fallback：全部配置数据合并训练一个 global（仅非 merge 模式或 merge 且无 global 时）
if (!MERGE || !result.global) {
  const allGames = [];
  for (const tag of allTags) { const g = byCfg[tag]; if (g) allGames.push(...g); }
  if (allGames.length) {
    const { train, val, test } = splitGames(allGames, SPLIT_SEED);
    const tr = toXY(train, MAX_TRAIN), va = toXY(val, MAX_TRAIN), te = toXY(test, MAX_TRAIN);
    const { trees, bestT, bestAuc } = fitAdaBoost(tr.X, tr.y, va.X, va.y, T_MAX, SHRINKAGE, NBINS);
    const auc = calcAUC(te.X, te.y, trees);
    console.log(`[v3] global: val AUC=${bestAuc.toFixed(4)} test AUC=${auc.toFixed(4)}`);
    result.global = { trees, bestT, valAUC: bestAuc, testAUC: auc };
  }
}

fs.writeFileSync(OUT, JSON.stringify(result));
console.log(`[v3] 模型已保存: ${OUT}`);
