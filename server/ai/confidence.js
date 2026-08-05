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

function suspicionVariance(mem) {
  const s = (mem && mem.suspicion) || {};
  const vals = Object.values(s);
  if (vals.length < 2) return 1; // 信息太少 → 方差视为大（低置信）
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vals.length;
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

/* confidenceOf(bot, targetId) => 0..1
 * - 方差项：最可疑者越突出（嫌疑方差大）→ 越确定（“看准了”）；全部接近（方差≈0）→ 分不清谁最可疑 → 低置信
 * - 目标项：目标嫌疑相对全场均值越高 → 置信越高（“看准了才下手”）
 * 两者加权，避免只有方差时“全都怀疑/全都不怀疑”的局置信度失真。 */
function confidenceOf(bot, targetId) {
  if (!bot || !targetId) return MIN_C;
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
