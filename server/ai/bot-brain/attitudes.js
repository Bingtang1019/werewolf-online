// bot-brain 拆分：attitudes 模块（态度模型）
'use strict';
const shared = require('./shared');
const ctx = shared.ctx;
const register = shared.register;
const S = shared.S;

function getStyleKey(bot) {
  const s = (bot.botStyle || 'balanced').toLowerCase();
  return S.TRANSFER_5[s] ? s : 'balanced';
}

function normalize(arr) {
  const sum = arr.reduce((a, b) => a + b, 0);
  if (sum === 0) arr.fill(0.2);
  else for (let i = 0; i < arr.length; i++) arr[i] /= sum;
}

function vectorMatrixMul(vector, matrix) {
  const result = new Array(5).fill(0);
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      result[j] += vector[i] * matrix[i][j];
    }
  }
  return result;
}

function targetDistFromEvidence(ev) {
  const raw = [];
  for (let i = 0; i < 5; i++) raw.push(Math.exp(ev * (i - 2)));
  normalize(raw);
  return raw;
}

function getLearningRate(bot) {
  const style = getStyleKey(bot);
  switch (style) {
    case 'conservative': return 0.15;
    case 'aggressive': return 0.35;
    default: return 0.25;
  }
}

function getDynamicMatrix(styleKey, nightNum) {
  const base = S.TRANSFER_5[styleKey];
  if (nightNum < 3) return base.map(r => r.slice());
  const f = Math.min(0.4, (nightNum - 2) * 0.1);
  const mat = base.map(r => r.slice());
  for (let i = 0; i < 5; i++) {
    const oldDiag = mat[i][i];
    const newDiag = Math.min(0.95, oldDiag + f);
    const factor = (1 - newDiag) / (1 - oldDiag);
    mat[i][i] = newDiag;
    for (let j = 0; j < 5; j++) if (j !== i) mat[i][j] *= factor;
  }
  return mat;
}

function initAttitudes5(room, bot) {
  if (bot.botMemory.attitudes) return;
  const att = {};
  const initialDist = [0.05, 0.15, 0.60, 0.15, 0.05];
  for (const p of room.players) {
    if (p.id !== bot.id) att[p.id] = { dist: initialDist.slice() };
  }
  bot.botMemory.attitudes = att;
}

function updateAttitude5(room, bot, targetId, evidenceType, strength) {
  const att = bot.botMemory.attitudes[targetId];
  if (!att) return;
  const P = getDynamicMatrix(getStyleKey(bot), room.nightNum);
  const evolved = vectorMatrixMul(att.dist, P);
  let ev = 0;
  switch (evidenceType) {
    case S.EVIDENCE.VOTE_AGAINST: ev = -1.5; break;
    case S.EVIDENCE.CHAT_BAD: ev = -1.0; break;
    case S.EVIDENCE.DEATH: ev = 0.5; break;
    case S.EVIDENCE.CHAT_GOOD: ev = 1.0; break;
    case S.EVIDENCE.WITCH_SAVE: ev = 0.8; break;
    case S.EVIDENCE.SHERIFF: ev = 0.6; break;
    case S.EVIDENCE.POISON: ev = -0.8; break;
    default: ev = 0.0;
  }
  ev *= strength;
  const target = targetDistFromEvidence(ev);
  const lambda = getLearningRate(bot);
  for (let i = 0; i < 5; i++) {
    att.dist[i] = (1 - lambda) * evolved[i] + lambda * target[i];
  }
  normalize(att.dist);
}

function distToSuspectScore(dist) {
  return dist[0] * 1.0 + dist[1] * 0.75 + dist[2] * 0.5 + dist[3] * 0.25 + dist[4] * 0.0;
}

function predictAttitude5(room, bot, targetId, steps) {
  const att = bot.botMemory.attitudes[targetId];
  if (!att) return 0.5;
  let dist = att.dist.slice();
  const P = getDynamicMatrix(getStyleKey(bot), room.nightNum);
  for (let i = 0; i < steps; i++) dist = vectorMatrixMul(dist, P);
  return distToSuspectScore(dist);
}

function sigmoidMap(value) {
  const s = 1 / (1 + Math.exp(-8 * (value - 0.5)));
  return 0.3 + 0.4 * s;
}

function simulatedScoreV2(room, bot, targetId) {
  const bayes = ctx.wolfProb(room, bot, targetId);
  const predicted = predictAttitude5(room, bot, targetId, 2);
  const mappedBayes = sigmoidMap(bayes);
  const mappedPredicted = sigmoidMap(predicted);
  const styleKey = getStyleKey(bot);
  const aggressiveness = styleKey === 'aggressive' ? 0.8 : styleKey === 'conservative' ? 0.3 : 0.5;
  return mappedBayes * aggressiveness + mappedPredicted * (1 - aggressiveness);
}

function processAdditionalEvidence(room, bot) {
  const mem = bot.botMemory;
  // 死亡证据（项目：deadBy 字段区分死因；去重）
  if (!mem.attDead) mem.attDead = {};
  for (const p of room.players) {
    if (p.alive || mem.attDead[p.id]) continue;
    mem.attDead[p.id] = true;
    if (p.deadBy === 'wolf') updateAttitude5(room, bot, p.id, S.EVIDENCE.DEATH, 1);
    else if (p.deadBy === 'poison') updateAttitude5(room, bot, p.id, S.EVIDENCE.POISON, 1);
  }
  // 警长票（项目：sheriff_vote 的 votes 保留到下一轮，lastVoteResult.kind==='sheriff' 标记）
  if (room.lastVoteResult && room.lastVoteResult.kind === 'sheriff' && mem.lastSheriffRound !== room.dayNum) {
    mem.lastSheriffRound = room.dayNum;
    for (const k of Object.keys(room.votes || {})) {
      const t = room.votes[k];
      if (!t || k === bot.id || t === bot.id) continue;
      updateAttitude5(room, bot, t, S.EVIDENCE.SHERIFF, 1);
    }
  }
}


module.exports = { getStyleKey, normalize, vectorMatrixMul, targetDistFromEvidence, getLearningRate, getDynamicMatrix, initAttitudes5, updateAttitude5, distToSuspectScore, predictAttitude5, sigmoidMap, simulatedScoreV2, processAdditionalEvidence };