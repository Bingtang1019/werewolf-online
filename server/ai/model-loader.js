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
/* 1.7.16：回退链（三级）——v2 → v1+iso过渡 → v1原始 → heuristic（null）
 * VOTE_MODEL_MODE: v2（默认生产目标）| adaboost（v1+iso过渡）| heuristic（纯信念，最后保底） */
let _model = null;
let _tried = false;
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
function getVoteModel() {
  if (_tried) return _model;
  _tried = true;
  if (process.env.LAB_NO_MODEL === '1') { _model = null; return _model; } // 1.7.0（B1-4）：对照实验禁用模型（lab 平台）
  if (process.env.VOTE_MODEL_MODE === 'heuristic') { _model = null; return _model; } // 1.7.15：感知层门控（审计止血）——启发式
  const mode = process.env.VOTE_MODEL_MODE || 'v2'; // v1.7.16：生产默认 v2（分层 AdaBoost；adaboost=v1+iso 过渡对照）
  // 1.7.16：v2 优先（schema@2），故障回退 v1（iso 过渡层由 bot-brain 挂载），再回退原始 v1，最后 null（heuristic）
  try {
    if (mode === 'v2') {
      _model = JSON.parse(fs.readFileSync(V2_MODEL_PATH, 'utf8'));
      if (validModelV2(_model)) return _model;
      _model = null; // v2 损坏 → 回退 v1 路径（下方重新加载）
    }
  } catch (e) { _model = null; }
  try {
    const m = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
    if (validModel(m)) { _model = m; return _model; }
    _model = null;
  } catch (e) { _model = null; }
  return _model;
}
function modelProb(m, features, configKey) {
  if (!m || !Array.isArray(features)) return null;
  let s = 0;
  const stumps = m.schema === 'adaboost-vote@2' ? pickV2(m, configKey).stumps : m.stumps; // 1.7.16：v2 configKey 路由（local/cap/global）
  for (const st of stumps) {
    const pred = (features[st.f] < st.thr ? 1 : -1) * st.dir;
    s += st.alpha * pred;
  }
  if (m.schema === 'adaboost-vote@2') return s; // v2：raw score（未校准——禁止概率下游消费，bot-brain 侧仅做单调 sigmoid 供排序）
  const p = 1 / (1 + Math.exp(-(m.platt.A * s + m.platt.B)));
  return p;
}
module.exports = { getVoteModel, modelProb, MODEL_PATH };
