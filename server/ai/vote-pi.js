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
const FEATURE_NAMES = ['seat_norm', 'ring_dist', 'talk_count', 'checked_wolf', 'checked_good', 'votes_against', 'prev_votes', 'claims_seer', 'claims_god', 'accused_count', 'counter_seer', 'vote_lead', 'bot_prev_same'];
const BELIEF_NAMES = ['bel_posterior', 'bel_cred_cand', 'bel_cred_voter', 'bel_vote_share'];

let _model = null;
function loadPi() {
  if (_model) return _model;
  try {
    const m = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
    if (m.schema !== 'vote-pi@1') return null;
    const names = m.features || [];
    if (names.length !== FEATURE_NAMES.length && names.length !== FEATURE_NAMES.length + BELIEF_NAMES.length) return null;
    // A-2：特征名逐一核对（13 维纯快照 / 17 维快照+信念）
    for (let i = 0; i < FEATURE_NAMES.length; i++) if (names[i] !== FEATURE_NAMES[i]) return null;
    if (names.length === 17) for (let i = 0; i < BELIEF_NAMES.length; i++) if (names[13 + i] !== BELIEF_NAMES[i]) return null;
    m._mlp = MLP.fromJSON(m.mlp);
    m._belief = names.length === 17;
    return m;
  } catch (e) { return null; }
}
function isLoaded() { return loadPi() !== null; }
function resetModel() { _model = null; }

/** π 投票：对候选集逐候选打分 → argmax
 *  @param room      房间（room.players/messages/votes/lastVoteResult/actionLog + room._beliefEngine）
 *  @param voterId   投票者 id
 *  @param state     候选 id 数组
 *  @returns { target, scores, margin } | null（模型缺失/候选不足 → null，调用方回退） */
function piVote(room, voterId, state) {
  const m = loadPi();
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
  return { target: best, scores, margin: bs - second };
}

module.exports = { loadPi, isLoaded, resetModel, piVote, MODEL_PATH, FEATURE_NAMES, BELIEF_NAMES };
