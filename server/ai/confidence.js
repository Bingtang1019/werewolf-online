'use strict';
/* =========================================================================
 * 统一置信度入口 confidenceOf(bot, targetId) => 0..1（v1.6.4，A5-1）
 *
 * 定位：全项目唯一的“置信度”来源（跨系列约束③）——
 *   - A2-4 不确定性表达（投票波动）：置信度低时随机/跟风/情绪化犯错，高置信才准
 *   - C1 混沌层（v1.8.0）：熵驱动犹豫/有界偏移，直接消费本接口
 *   - B1 感知层（v1.7.0）：只替换内部实现为 Platt 概率，调用方零改动
 * 一期实现：suspicion 方差版——bot 对全场的嫌疑分布越“集中”（方差低），
 * 对“最可疑目标”的判断越有把握；信息少/意见分散 → 低置信。
 * 归一化映射到 0.15..0.95（避免极端值让“出错”与“果断”完全消失）。
 * 零依赖、纯函数、可快照（只读 botMemory，不 mutate）。
 * ========================================================================= */
const MIN_C = 0.15, MAX_C = 0.95;
/* 1.7.3（F2）：Platt 派生置信度——模型可用时，波动层/混沌层直接消费模型对目标 P(wolf) 的确定性。
 * 公式 1 - |2P-1|：P=0.85 → 0.70（高置信不波动），P=0.5 → 0.10（低置信可波动），P=0.99 → 0.98。
 * 否则模型给出 P(wolf)=0.85 的高置信决策，但 suspicion 方差版算出 conf<0.55，波动层照样把这一票打飞
 * ——模型精度被波动层系统性浪费（paired +24pp 是“被波动浪费后”的结果）。 */
const { getVoteModel, modelProb } = require('./model-loader.js');
const { voteFeatures } = require('./features.js');

function suspicionVariance(mem) {
  const s = (mem && mem.suspicion) || {};
  const vals = Object.values(s);
  if (vals.length < 2) return 1; // 信息太少 → 方差视为大（低置信）
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vals.length;
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

/* confidenceOf(room, bot, targetId) => 0..1
 * - 模型可用：Platt 派生置信度（1-|2P-1|），波动/混沌零改动受益（A5-1“B1 只替换内部实现”闭环）
 * - 模型不可用（fail-open / LAB_NO_MODEL）：回退 suspicion 方差版
 *   · 方差项：最可疑者越突出（嫌疑方差大）→ 越确定；全部接近 → 低置信
 *   · 目标项：目标嫌疑相对全场均值越高 → 置信越高
 * 两者加权，避免只有方差时“全都怀疑/全都不怀疑”的局置信度失真。 */
function confidenceOf(room, bot, targetId) {
  if (!bot || !targetId) return MIN_C;
  const m = getVoteModel(room); // 1.8.x：与投票决策同一套按房间模型选择（NLU/经典）
  if (m && room) {
    const f = voteFeatures(room, bot.id, targetId);
    if (f) {
      const p = modelProb(m, f);
      if (p != null) return clamp(1 - Math.abs(2 * p - 1), MIN_C, MAX_C);
    }
  }
  const mem = bot.botMemory || {};
  const v = suspicionVariance(mem);
  // 方差归一化（经验量级：suspicion 0~100+，方差 400 以上视为“非常突出”）
  const varTerm = clamp(v / 400, 0, 1);
  const s = (mem.suspicion || {});
  const vals = Object.values(s);
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  const t = s[targetId] || 0;
  const targetTerm = clamp(0.5 + (t - mean) / (mean + 60), 0.25, 0.9);
  return clamp(varTerm * 0.55 + targetTerm * 0.45, MIN_C, MAX_C);
}

/* 有界候选（A5-2，供 C1 混沌层执行层使用）：置信度高 → 只允许在前 1~2 候选内“上头”；
 * 置信度低 → 允许偏移到前 3。返回偏移后的目标（boundedPick 的“有界”实现）。 */
function boundedCandidates(room, bot, pool, scoreFn, topN) {
  if (!pool || !pool.length) return [];
  const sorted = pool.slice().sort((a, b) => scoreFn(b) - scoreFn(a));
  const n = Math.max(1, Math.min(topN || 3, sorted.length));
  return sorted.slice(0, n);
}

module.exports = { confidenceOf, boundedCandidates };
