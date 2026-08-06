'use strict';
/* =========================================================================
 * 1.7.0（B1-4）：vote 模型加载器——fail-open（缺失/损坏 → null，回退旧逻辑）
 * modelProb(m, features) → P(wolf)（AdaBoost 决策函数 + Platt 校准）
 * 模型：models/adaboost-vote-v1.json（tools/ai/train-vote-adaboost.js 训练，随仓分发）
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const MODEL_PATH = path.join(__dirname, '..', '..', 'models', 'adaboost-vote-v1.json');

let _model = null;
let _tried = false;
/* v1.7.2（C）：加载后 schema 校验——stump 的 f 越界/platt 非有限数/alpha 非法时视为损坏（fail-open），
 * 否则 features[st.f] 返回 undefined → NaN 静默传播 */
function validModel(m) {
  if (!m || !Array.isArray(m.stumps) || !m.platt) return false;
  if (!Array.isArray(m.features) || !m.features.length) return false;
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
  try { const m = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8')); _model = validModel(m) ? m : null; } catch (e) { _model = null; }
  return _model;
}
function modelProb(m, features) {
  if (!m || !Array.isArray(features)) return null;
  let s = 0;
  for (const st of m.stumps) {
    const pred = (features[st.f] < st.thr ? 1 : -1) * st.dir;
    s += st.alpha * pred;
  }
  const p = 1 / (1 + Math.exp(-(m.platt.A * s + m.platt.B)));
  return p;
}
module.exports = { getVoteModel, modelProb, MODEL_PATH };
