'use strict';
/* =========================================================================
 * wolfTrain/features.js —— 狼侧刀神特征（v1.7.7 α3，对齐点①）
 * 直接复用 voteFeatures 的 13 维（已含 claims_god 索引8：候选自称神职次数）
 * ——无需重复新增第14维；语义自动翻转（adaboost 学"votes_against 高→民、
 * claims_seer 高→神"等反向权重，狼刀视角天然反好人视角）。
 * 只读公开信息（B1-7②）；label 由 collector 用真实身份打标。
 * ========================================================================= */
const { voteFeatures } = require('../server/ai/features.js');

function wolfGodFeatures(room, wolfBotId, pid) {
  return voteFeatures(room, wolfBotId, pid); // 13 维
}
module.exports = { wolfGodFeatures };
