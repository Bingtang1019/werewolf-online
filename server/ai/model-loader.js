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
function getVoteModel() {
  if (_tried) return _model;
  _tried = true;
  if (process.env.LAB_NO_MODEL === '1') { _model = null; return _model; } // 1.7.0（B1-4）：对照实验禁用模型（lab 平台）
  try { _model = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8')); } catch (e) { _model = null; }
  return _model;
}
function modelProb(m, features) {
  if (!m || !Array.isArray(features) || !Array.isArray(m.stumps) || !m.platt) return null;
  let s = 0;
  for (const st of m.stumps) {
    const pred = (features[st.f] < st.thr ? 1 : -1) * st.dir;
    s += st.alpha * pred;
  }
  const p = 1 / (1 + Math.exp(-(m.platt.A * s + m.platt.B)));
  return p;
}
module.exports = { getVoteModel, modelProb, MODEL_PATH };
