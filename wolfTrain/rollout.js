'use strict';
/* =========================================================================
 * wolfTrain/rollout.js —— 夜刀候选 × 模拟"刀后 1 白天投票结算"（v1.7.7 α4，对齐点③）
 * simFn(world, pid) → 'wolf' | 'good' | null（复用现有 1 轮投票模拟的狼胜判定）
 * 调用顺序：decideNightKill 先出候选池（top-3 置信度）→ rollout 精排 → 选胜率最高。
 * 成本：3 候选 × n 模拟/夜刀；n=60 时 ≈180 局等效/夜刀（325 局/s 下 +0.6s/夜刀，可接受）。
 * ========================================================================= */
async function rolloutNightKill(world, candidates, simFn, { n = 30 } = {}) {
  const out = [];
  for (const pid of candidates) {
    let wolfWins = 0, draws = 0;
    for (let k = 0; k < n; k++) {
      const end = await simFn(world, pid);
      if (end === 'wolf') wolfWins++;
      else if (end === null || end === undefined) draws++;
    }
    out.push({ pid, winRate: wolfWins / (n - draws || 1), draws });
  }
  return out.sort((a, b) => b.winRate - a.winRate);
}
module.exports = { rolloutNightKill };
