'use strict';
/* =========================================================================
 * vote-pi.js —— V5.0：π 投票策略网络推理加载器（BC from decideVote）
 * 加载 models/vote-pi-v1.json（schema: vote-pi@1）；推理 = 逐候选打分 → argmax
 * 输入：13 维 voteFeatures（与训练同源——A-2 纪律：train/infer 特征一致）
 * 门控：VOTE_STRATEGY=pi 时由 bot-brain 调用；模型缺失/损坏 → fail-open null（调用方回退现有链）
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const { MLP } = require('./mlp');

const MODEL_PATH = process.env.MODEL_VOTE_PI || path.join(__dirname, '..', '..', 'models', 'vote-pi-v1.json');
const FEATURE_NAMES = ['seat_norm', 'ring_dist', 'talk_count', 'checked_wolf', 'checked_good', 'votes_against', 'prev_votes', 'claims_seer', 'claims_god', 'accused_count', 'counter_seer', 'vote_lead', 'bot_prev_same'];

let _model = null;
function loadPi() {
  if (_model) return _model;
  try {
    const m = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
    if (m.schema !== 'vote-pi@1') return null;
    if (!m.features || m.features.length !== FEATURE_NAMES.length) return null;
    // A-2：特征名逐一核对（train/infer 同源，禁止分叉）
    for (let i = 0; i < FEATURE_NAMES.length; i++) if (m.features[i] !== FEATURE_NAMES[i]) return null;
    m._mlp = MLP.fromJSON(m.mlp);
    return m;
  } catch (e) { return null; }
}
function isLoaded() { return loadPi() !== null; }
function resetModel() { _model = null; }

/** π 投票：对候选集逐候选打分 → argmax
 *  @param room      房间（room.players/messages/votes/lastVoteResult/actionLog——voteFeatures 消费）
 *  @param voterId   投票者 id
 *  @param state     候选 id 数组
 *  @returns { target, scores } | null（模型缺失/候选不足 → null，调用方回退） */
function piVote(room, voterId, state) {
  const m = loadPi();
  if (!m) return null;
  if (!state || state.length < 2) return null;
  const scores = {};
  let best = null, bs = -Infinity, second = -Infinity;
  for (const cid of state) {
    const feats = require('./features').voteFeatures(room, voterId, cid);
    if (!feats) continue;
    const p = m._mlp.predict(feats);
    scores[cid] = p;
    if (p > bs) { second = bs; bs = p; best = cid; }
    else if (p > second) second = p;
  }
  if (!best) return null;
  return { target: best, scores, margin: bs - second }; // margin：top1-top2（π 置信度——模糊局面回退 dv 的依据）
}

module.exports = { loadPi, isLoaded, resetModel, piVote, MODEL_PATH, FEATURE_NAMES };
