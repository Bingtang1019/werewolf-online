'use strict';
/* =========================================================================
 * 1.7.0（B1-4）：vote 模型加载器——fail-open（缺失/损坏 → null，回退旧逻辑）
 * modelProb(m, features) → P(wolf)（AdaBoost 决策函数 + Platt 校准）
 * 模型：models/adaboost-vote-v1.json（tools/ai/train-vote-adaboost.js 训练，随仓分发）
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const { FEATURE_NAMES } = require('./features.js'); // 1.7.3（P1-1）：特征数量/名称联动校验（features.js 无副作用依赖，require 安全）
const MODEL_PATH = path.join(__dirname, '..', '..', 'models', 'adaboost-vote-v1.json');
const V2_MODEL_PATH = path.join(__dirname, '..', '..', 'models', 'adaboost-vote-v2.json');
const NLU_ENABLED = process.env.NLU_VOTE !== '0'; // 1.8.x：NLU 默认生产开启，NLU_VOTE=0 可关闭
const V3_NLU_MODEL_PATH = process.env.V3_MODEL_PATH || path.join(__dirname, '..', '..', 'models', 'adaboost-vote-v3-nlu-prod.json'); // 1.8.x：NLU 生产模型（真实预言家重训）
const V3_CLASSIC_MODEL_PATH = process.env.V3_MODEL_PATH || path.join(__dirname, '..', '..', 'models', 'adaboost-vote-v3-v2.json'); // 1.7.18+：vote-v3 干净数据重训版
/* 1.8.x：NLU 模型只用于有人类玩家的房间（真人聊天可被 NLU 抽取）；全 bot 房间走经典模型，避免 bot-only 失衡 */
function isNluRoom(room) {
  if (process.env.NLU_VOTE === '0') return false;
  if (!room || !Array.isArray(room.players)) return false;
  if ((room.cap || room.playerCap || 0) < 12) return false; // NLU 模型目前按 12 人局训练/验证，小配置继续走经典
  return room.players.some(p => p && !p.isBot);
}
const V4_MODEL_PATH = path.join(__dirname, '..', '..', 'models', 'adaboost-vote-v4.json'); // 1.7.18+：vote-v4 蒸馏版（MLP，25d AdaBoost → 概率输出）
/* 1.7.18+：回退链（三级）——v3 → v2 → v1+iso过渡 → v1原始 → heuristic（null）
 * VOTE_MODEL_MODE: v3（1.7.18+ 生产默认，干净数据版 v3v2）| v2（env 一键回退）| adaboost（v1+iso过渡）| heuristic（纯信念，最后保底） */
let _nluModel = null, _nluTried = false;
let _classicModel = null, _classicTried = false;
/* v1.7.16：schema@2 校验——9 配置路由 + 特征联动 + local/capLocal 结构 */
function validModelV2(m) {
  if (!m || m.schema !== 'adaboost-vote@2') return false;
  if (!Array.isArray(m.features) || m.features.length !== FEATURE_NAMES.length) return false;
  for (let i = 0; i < m.features.length; i++) if (m.features[i] !== FEATURE_NAMES[i]) return false;
  if (!m.global || !Array.isArray(m.global.stumps) || !m.global.stumps.length) return false;
  const okStumps = sts => Array.isArray(sts) && sts.length && sts.every(st => st && typeof st.f === 'number' && st.f >= 0 && st.f < m.features.length && typeof st.thr === 'number' && isFinite(st.thr) && (st.dir === 1 || st.dir === -1) && typeof st.alpha === 'number' && isFinite(st.alpha));
  if (!okStumps(m.global.stumps)) return false;
  if (m.local) for (const k of Object.keys(m.local)) { if (!m.local[k].useLocal) continue; if (!okStumps(m.local[k].stumps)) return false; }
  if (m.capLocal) for (const k of Object.keys(m.capLocal)) { if (!m.capLocal[k].useLocal) continue; if (!okStumps(m.capLocal[k].stumps)) return false; }
  return true;
}
/* v2 configKey 路由：preset标签（12a）→ local；cap级（12p）→ capLocal；无匹配 → global */
function pickV2(m, configKey) {
  if (configKey && m.local && m.local[configKey]) return m.local[configKey].useLocal ? m.local[configKey] : m.global;
  if (configKey && m.capLocal && m.capLocal[configKey]) return m.capLocal[configKey].useLocal ? m.capLocal[configKey] : m.global;
  return m.global;
}
/* v1.7.18：schema@3 校验——vote-v3（分箱 AdaBoost，25 维特征：13 快照 + 12 信念）
 * configs 结构：{ [presetKey]: { local: { stumps, useLocal } } } + global；cap 级走 global fallback（v3 未训 cap 专属）
 * 特征校验：前 13 维必须与 FEATURE_NAMES 一致（前缀），总维 = m.features.length（25）——
 * 信念特征（后 12 维）由 bot-brain 实时构造（belief-engine 输出），模型文件自描述 */
function validModelV4(m) {
  if (!m || m.schema !== 'vote-mlp@1') return false;
  if (!Array.isArray(m.features) || m.features.length < FEATURE_NAMES.length) return false;
  for (let i = 0; i < FEATURE_NAMES.length; i++) if (m.features[i] !== FEATURE_NAMES[i]) return false; // 前缀校验（13 快照）
  if (!m.norm || !Array.isArray(m.norm.mean) || !Array.isArray(m.norm.std) || m.norm.mean.length !== m.features.length || m.norm.std.length !== m.features.length) return false;
  if (!m.params || !Array.isArray(m.params.W1T) || !Array.isArray(m.params.W2T) || !Array.isArray(m.params.b1)) return false;
  if (typeof m.params.b2 !== 'number' || !isFinite(m.params.b2)) return false;
  const h = m.hidden;
  if (!Number.isInteger(h) || h <= 0 || m.params.W1T.length !== h * m.features.length || m.params.W2T.length !== h || m.params.b1.length !== h) return false;
  return true;
}

// 1.7.18+：vote-v4 MLP 前向（sigmoid 概率输出——消费端直接当概率用）
function mlpProb(m, features) {
  const { mean, std } = m.norm;
  const d = mean.length, h = m.hidden;
  const p = m.params;
  let acc2 = p.b2;
  for (let j = 0; j < h; j++) {
    let acc = p.b1[j];
    for (let k = 0; k < d; k++) acc += ((features[k] - mean[k]) / std[k]) * p.W1T[j * d + k];
    const a = acc > 0 ? acc : 0;
    acc2 += a * p.W2T[j];
  }
  return 1 / (1 + Math.exp(-acc2));
}

function validModelV3(m) {
  if (!m || m.schema !== 'adaboost-vote@3') return false;
  if (!Array.isArray(m.features) || m.features.length < FEATURE_NAMES.length) return false;
  for (let i = 0; i < FEATURE_NAMES.length; i++) if (m.features[i] !== FEATURE_NAMES[i]) return false; // 前缀校验（13 快照）
  if (!m.global || !Array.isArray(m.global.stumps) || !m.global.stumps.length) return false;
  const okStumps = sts => Array.isArray(sts) && sts.length && sts.every(st => st && typeof st.f === 'number' && st.f >= 0 && st.f < m.features.length && typeof st.thr === 'number' && isFinite(st.thr) && (st.dir === 1 || st.dir === -1) && typeof st.alpha === 'number' && isFinite(st.alpha));
  if (!okStumps(m.global.stumps)) return false;
  if (!m.configs || typeof m.configs !== 'object') return false;
  for (const k of Object.keys(m.configs)) {
    const c = m.configs[k];
    if (!c || !c.local || !c.local.useLocal || !okStumps(c.local.stumps)) return false;
  }
  return true;
}
/* v3 configKey 路由：preset标签（12a）→ configs[key].local；无匹配 → global（v3 未训 cap 级专属） */
function pickV3(m, configKey) {
  if (configKey && m.configs && m.configs[configKey]) return m.configs[configKey].local.useLocal ? m.configs[configKey].local : m.global;
  return m.global;
}
/* v1.7.2（C）：加载后 schema 校验——stump 的 f 越界/platt 非有限数/alpha 非法时视为损坏（fail-open），
 * 否则 features[st.f] 返回 undefined → NaN 静默传播 */
function validModel(m) {
  if (!m || !Array.isArray(m.stumps) || !m.platt) return false;
  if (!Array.isArray(m.features) || !m.features.length) return false;
  // 1.7.3（P1-1）：特征数量与名称必须与当前 FEATURE_NAMES 完全一致——
  // features.js 改维度后旧模型若照常加载，features[st.f] 全部合法但语义错位，静默用错特征（不报错不 NaN）
  if (m.features.length !== FEATURE_NAMES.length) return false;
  for (let i = 0; i < m.features.length; i++) if (m.features[i] !== FEATURE_NAMES[i]) return false;
  if (typeof m.platt.A !== 'number' || typeof m.platt.B !== 'number' || !isFinite(m.platt.A) || !isFinite(m.platt.B)) return false;
  for (const st of m.stumps) {
    if (!st || typeof st.f !== 'number' || st.f < 0 || st.f >= m.features.length) return false;
    if (typeof st.thr !== 'number' || !isFinite(st.thr)) return false;
    if (st.dir !== 1 && st.dir !== -1) return false;
    if (typeof st.alpha !== 'number' || !isFinite(st.alpha)) return false;
  }
  return true;
}
function loadVoteModel(mode, v3Path) {
  let m = null;
  try {
    if (mode === 'v3-fast') {
      m = JSON.parse(fs.readFileSync(V4_MODEL_PATH, 'utf8'));
      if (validModelV4(m)) return m;
      m = null;
    }
  } catch (e) { m = null; }
  try {
    if (mode === 'v3' || mode === 'v3-fast') {
      m = JSON.parse(fs.readFileSync(v3Path, 'utf8'));
      if (validModelV3(m)) return m;
      m = null;
    }
  } catch (e) { m = null; }
  try {
    if (mode === 'v2' || mode === 'v3') {
      m = JSON.parse(fs.readFileSync(V2_MODEL_PATH, 'utf8'));
      if (validModelV2(m)) return m;
      m = null;
    }
  } catch (e) { m = null; }
  try {
    const m1 = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
    if (validModel(m1)) return m1;
  } catch (e) { /* fallthrough */ }
  return null;
}
/* 1.8.x：按房间选择模型——有人类玩家 → NLU v3 生产模型；全 bot → 经典 adaboost（保持旧平衡） */
function getVoteModel(room) {
  const useNlu = isNluRoom(room);
  if (useNlu) {
    if (_nluTried) return _nluModel;
    _nluTried = true;
    if (process.env.LAB_NO_MODEL === '1' || process.env.VOTE_MODEL_MODE === 'heuristic') { _nluModel = null; return _nluModel; }
    const mode = process.env.VOTE_MODEL_MODE || 'v3';
    _nluModel = loadVoteModel(mode, V3_NLU_MODEL_PATH);
    return _nluModel;
  }
  if (_classicTried) return _classicModel;
  _classicTried = true;
  if (process.env.LAB_NO_MODEL === '1' || process.env.VOTE_MODEL_MODE === 'heuristic') { _classicModel = null; return _classicModel; }
  const mode = process.env.VOTE_MODEL_MODE || 'adaboost'; // 全 bot 默认保持旧 adaboost 平衡
  _classicModel = loadVoteModel(mode, V3_CLASSIC_MODEL_PATH);
  return _classicModel;
}
function modelProb(m, features, configKey) {
  if (!m || !Array.isArray(features)) return null;
  let s = 0;
  let stumps = m.stumps;
  if (m.schema === 'adaboost-vote@2') stumps = pickV2(m, configKey).stumps; // 1.7.16：v2 configKey 路由（local/cap/global）
  if (m.schema === 'adaboost-vote@3') stumps = pickV3(m, configKey).stumps; // 1.7.18：v3 configKey 路由（configs.local/global）
  if (m.schema === 'vote-mlp@1') return mlpProb(m, features); // 1.7.18+：vote-v4 MLP 概率输出（sigmoid 内建）
  for (const st of stumps) {
    const pred = (features[st.f] < st.thr ? 1 : -1) * st.dir;
    s += st.alpha * pred;
  }
  if (m.schema === 'adaboost-vote@2' || m.schema === 'adaboost-vote@3') return s; // v2/v3：raw score（未校准——禁止概率下游消费，bot-brain 侧仅做单调 sigmoid 供排序）
  if (m.schema === 'vote-mlp@1') return s; // 不会到达（上方已 return）
  const p = 1 / (1 + Math.exp(-(m.platt.A * s + m.platt.B)));
  return p;
}

// 1.7.18：v1 独立缓存——v3 混合实验用（LAB_V3_BLEND 时与 v3 输出做线性混合）
let _v1Model = null, _v1Tried = false;
function getVoteModelV1() {
  if (_v1Tried) return _v1Model;
  _v1Tried = true;
  try {
    const m = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
    if (validModel(m)) _v1Model = m; else _v1Model = null;
  } catch (e) { _v1Model = null; }
  return _v1Model;
}

// 1.7.18：v2 模型独立缓存——per-config 回退用（12c 劣化配置：v3 特征在特殊机制上误导投票 → 分配置回退 v2）
let _v2Model = null, _v2Tried = false;
function getVoteModelV2() {
  if (_v2Tried) return _v2Model;
  _v2Tried = true;
  try {
    const p = process.env.MODEL_VOTE_V2 || path.join(__dirname, '..', '..', 'models', 'adaboost-vote-v2.json');
    if (!fs.existsSync(p)) { _v2Model = null; return _v2Model; }
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!validModelV2(m)) { _v2Model = null; return _v2Model; }
    _v2Model = m;
  } catch (e) { _v2Model = null; }
  return _v2Model;
}
module.exports = { getVoteModel, getVoteModelV1, getVoteModelV2, modelProb, MODEL_PATH, isNluRoom };
