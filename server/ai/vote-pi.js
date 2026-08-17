'use strict';
/* =========================================================================
 * vote-pi.js —— V5.0/5.2：π 投票策略网络推理加载器（BC from decideVote + RWR 微调）
 * 加载 models/vote-pi-belief-v1.json（schema: vote-pi@1）；推理 = 逐候选打分 → argmax
 * 输入：13 维 voteFeatures（纯快照版）或 13+4 维（信念版——第 14-17 维取 room._beliefEngine 信念状态）
 * A-2 纪律：train/infer 特征一致（按模型 features 长度自适应，特征名核对）
 * 门控：VOTE_STRATEGY=pi 时由 bot-brain 调用；模型缺失/损坏 → fail-open null（调用方回退现有链）
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const { MLP } = require('./mlp');
const { getBeliefs } = require('./belief-engine');

const MODEL_PATH = process.env.MODEL_VOTE_PI || path.join(__dirname, '..', '..', 'models', 'vote-pi-belief-v1.json');
const MODEL_PATH_SNAP = process.env.MODEL_VOTE_PI_SNAP || path.join(__dirname, '..', '..', 'models', 'vote-pi-snap-v1.json');
const FEATURE_NAMES = ['seat_norm', 'ring_dist', 'talk_count', 'checked_wolf', 'checked_good', 'votes_against', 'prev_votes', 'claims_seer', 'claims_god', 'accused_count', 'counter_seer', 'vote_lead', 'bot_prev_same'];
const BELIEF_NAMES = ['bel_posterior', 'bel_cred_cand', 'bel_cred_voter', 'bel_vote_share'];

let _models = new Map(); // key: 模型路径 → 模型对象（支持 per-bot 多代 π 池）
let _snapModels = new Map();
function loadPi(useSnap, modelPath) {
  const key = modelPath || (useSnap ? MODEL_PATH_SNAP : MODEL_PATH);
  const cache = useSnap ? _snapModels : _models;
  if (cache.has(key)) return cache.get(key);
  try {
    const m = JSON.parse(fs.readFileSync(key, 'utf8'));
    if (m.schema !== 'vote-pi@1') return null;
    const names = m.features || [];
    if (names.length !== FEATURE_NAMES.length && names.length !== FEATURE_NAMES.length + BELIEF_NAMES.length) return null;
    for (let i = 0; i < FEATURE_NAMES.length; i++) if (names[i] !== FEATURE_NAMES[i]) return null;
    if (names.length === 17) for (let i = 0; i < BELIEF_NAMES.length; i++) if (names[13 + i] !== BELIEF_NAMES[i]) return null;
    m._mlp = MLP.fromJSON(m.mlp);
    m._belief = names.length === 17;
    cache.set(key, m);
    return m;
  } catch (e) { return null; }
}
function isLoaded() { return loadPi(false) !== null; }
function resetModel() { _models = new Map(); _snapModels = new Map(); }

/** π 投票：对候选集逐候选打分 → argmax（可选 ε-贪心/温度采样）
 *  @param room      房间（room.players/messages/votes/lastVoteResult/actionLog + room._beliefEngine）
 *  @param voterId   投票者 id
 *  @param state     候选 id 数组
 *  @param useSnap   快照版（13 维，决策等价 dv）——生产默认；belief 版（17 维）实验
 *  @param rng       可选注入 RNG（LAB_PI_EPS/LAB_PI_TEMP 探索需要；缺省时退化为 argmax）
 *  @returns { target, scores, margin, explored } | null（模型缺失/候选不足 → null，调用方回退） */
function piVote(room, voterId, state, useSnap, rng, modelPath) {
  const m = loadPi(useSnap, modelPath);
  if (!m) return null;
  if (!state || state.length < 2) return null;
  const bel = m._belief && room._beliefEngine ? getBeliefs(room._beliefEngine) : null;
  const scores = {};
  let best = null, bs = -Infinity, second = -Infinity;
  for (const cid of state) {
    const feats = require('./features').voteFeatures(room, voterId, cid);
    if (!feats) continue;
    let fe = feats;
    if (m._belief) {
      if (!bel) return null; // 信念版需要 belief-engine（未挂载 → fail-open）
      const tot = {};
      for (const k of Object.keys(room.votes || {})) tot[room.votes[k]] = (tot[room.votes[k]] || 0) + 1;
      const n = Object.keys(tot).length || 1;
      fe = feats.concat([
        bel.posterior[cid] != null ? bel.posterior[cid] : 0.5,
        bel.credibility[cid] != null ? bel.credibility[cid] : 0.5,
        bel.credibility[voterId] != null ? bel.credibility[voterId] : 0.5,
        (tot[cid] || 0) / n,
      ]);
    }
    const p = m._mlp.predict(fe);
    scores[cid] = p;
    if (p > bs) { second = bs; bs = p; best = cid; }
    else if (p > second) second = p;
  }
  if (!best) return null;
  const explored = explorePi(scores, state, rng);
  if (explored) return explored;
  return { target: best, scores, margin: bs - second, explored: false };
}

/* V5.2 破局：π 探索（LAB_PI_EPS / LAB_PI_TEMP）
 * - LAB_PI_EPS=0.2 → 以 ε 概率随机选一个候选（均匀探索）
 * - LAB_PI_TEMP=1.5 → 用 softmax 温度采样（T=0 退化为 argmax）
 * 返回 null 表示不探索（走 argmax）。必须注入 rng，缺省不探索（确定性纪律）。 */
function explorePi(scores, state, rng) {
  const eps = parseFloat(process.env.LAB_PI_EPS || '0');
  const temp = parseFloat(process.env.LAB_PI_TEMP || '0');
  if ((eps <= 0 && temp <= 0) || !rng) return null;
  const cands = state.filter(id => scores[id] != null);
  if (!cands.length) return null;
  if (eps > 0 && rng.next() < eps) {
    const pick = cands[rng.int(cands.length)];
    return { target: pick, scores, margin: 0, explored: 'eps' };
  }
  if (temp > 0) {
    const logits = cands.map(id => scores[id] / Math.max(1e-9, temp));
    const mx = Math.max(...logits);
    const exps = logits.map(x => Math.exp(x - mx));
    const sum = exps.reduce((a, b) => a + b, 0);
    let r = rng.next() * sum;
    for (let i = 0; i < cands.length; i++) {
      r -= exps[i];
      if (r <= 0) {
        const pick = cands[i];
        const second = cands.filter(id => id !== pick).reduce((a, id) => Math.max(a, scores[id]), -Infinity);
        return { target: pick, scores, margin: scores[pick] - second, explored: 'temp' };
      }
    }
  }
  return null;
}

module.exports = { loadPi, isLoaded, resetModel, piVote, MODEL_PATH, MODEL_PATH_SNAP, FEATURE_NAMES, BELIEF_NAMES };
