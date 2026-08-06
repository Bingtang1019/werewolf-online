'use strict';
/* =========================================================================
 * wolfTrain/kill.js —— 夜刀决策（v1.7.7 α3，替换 bot-brain 狼分支的 argmin）
 * 候选评分 = 刀神分类器置信度 + 0.5×自称神职价值序加成（killPriority）
 * fail-open：model 为 null 时回退 argmin（刀最像好人，等价现状 decideNightKill）
 * world 接口（对齐点①构造）：{ aliveIds, features: Map<pid, 13维>, roleClaims: Map<pid, 角色>|null }
 * ========================================================================= */
function decideNightKill(world, model, { killPriority = {} } = {}) {
  const alive = (world.aliveIds || []).filter(id => {
    const r = world.roles && world.roles.get ? world.roles.get(id) : null;
    return r !== 'wolf' && r !== 'wolfBeauty';
  });
  if (!alive.length) return null;
  // 无模型 → 回退 argmin（刀最像好人——现状语义）
  if (!model) {
    let best = null, bestS = Infinity;
    for (const pid of alive) {
      const base = world.features && world.features.get ? world.features.get(pid) : null;
      if (!base) continue;
      const s = base[0]; // seat_norm 占位——实际用置信度，见下
      if (s < bestS) { bestS = s; best = pid; }
    }
    return best;
  }
  let best = null, bestScore = -Infinity;
  for (const pid of alive) {
    const base = world.features && world.features.get ? world.features.get(pid) : null;
    if (!base) continue;
    const pGod = model.predict(base);
    const claim = world.roleClaims && world.roleClaims.get ? (world.roleClaims.get(pid) || null) : null;
    const claimBoost = claim && killPriority[claim] != null ? killPriority[claim] : (claim ? 1 : 0);
    const score = pGod + 0.5 * claimBoost;
    if (score > bestScore) { bestScore = score; best = pid; }
  }
  return best;
}
module.exports = { decideNightKill };
