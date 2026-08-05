'use strict';
/* =========================================================================
 * 1.7.0（B1-5）：rollout 规划层——投票决策的轻量前瞻
 * 深度分层：只模拟到"本轮投票结束"（放逐结果），不展开后续夜晚（预算可控）
 * 信念采样：按各候选 P(wolf)（world.scores）伯努利采样隐藏身份，多次采样取期望
 * 快策略：模拟其他玩家投票——好人投"模型分最高"候选，狼投"模型分最低非队友"
 * 关键修正（B1-5 二期）：逐候选评估"假设我投 X"的后果（me 的票参与结算），
 *   否则排除 me 后投 X 无法影响结果，得分无区分度
 * 纪律：纯函数（绝不 mutate 真实 room）；派生 RNG 保证确定性；预算不足自动降 worlds
 * ========================================================================= */
const { createRng } = require('./rng.js');

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * world: { faction, teammates, scores:{id:Pwolf}, votes:{voter:target}, allVoters:[id], me }
 * state: 候选 id 数组
 * 返回：推荐投的候选 id（或 null）
 */
function rolloutVote(world, state, rng, { worlds = 64 } = {}) {
  if (!state || state.length < 2) return null;
  const r = rng || createRng((Date.now() >>> 0) || 1);
  const isWolf = world.faction === 'wolf';
  const teammates = world.teammates || [];
  const pool = state.filter(id => !(isWolf && teammates.includes(id)));
  if (!pool.length) return null;
  const allVoters = (world.allVoters || []).filter(id => id !== world.me);
  if (allVoters.length < 2) return null;
  const sc = world.scores || {};

  const W = pool.length > 10 ? Math.max(4, worlds >> 1) : worlds; // 预算感知
  const score = {};
  for (const x of pool) score[x] = 0;

  for (let w = 0; w < W; w++) {
    // 1) 采样隐藏身份（伯努利，按 P(wolf)）
    const wolfSet = new Set();
    for (const x of pool) {
      const p = clamp(sc[x] == null ? 0.3 : sc[x], 0.05, 0.95);
      if (r.next() < p) wolfSet.add(x);
    }
    // 2) 模拟其他玩家投票（不含 me）
    const counts = {};
    for (const voter of allVoters) {
      let pick = null;
      if (wolfSet.has(voter)) {
        let bv = Infinity;
        for (const c of pool) { if (teammates.includes(c)) continue; const s = sc[c] == null ? 0.5 : sc[c]; if (s < bv) { bv = s; pick = c; } }
      } else {
        let bv = -Infinity;
        for (const c of pool) { const s = sc[c] == null ? 0.5 : sc[c]; if (s > bv) { bv = s; pick = c; } }
      }
      if (pick) counts[pick] = (counts[pick] || 0) + 1;
    }
    // 3) 逐候选评估"假设我投 X"（me 的票参与结算）——收益按"X 是否被放逐 + X 的狼概率"计分：
    //    搭便车修正：若其他人已把 X 投成最高票，投 X 的得分仍按"X 被放逐"计（协作而非规避）；
    //    风险修正：X 被放逐且是好人 → 投 X 扣分（避免投死好人）；top≠X → 0（投 X 未促成 X 放逐）
    for (const x of pool) {
      const c = Object.assign({}, counts, { [x]: (counts[x] || 0) + 1 });
      let top = null, topN = 0;
      for (const k of Object.keys(c)) if (c[k] > topN) { topN = c[k]; top = k; }
      if (!top) continue;
      if (top === x) { if (wolfSet.has(x)) score[x] += 2; else score[x] -= 1; } // 放逐狼收益 +2 / 误放逐好人损失 -1（不对称：好人不冒险）
    }
  }
  // 返回得分最高候选（平局用 rng 打破——派生 RNG 保证确定性）
  let best = null, bs = -Infinity;
  for (const x of pool) {
    const s = score[x];
    if (s > bs || (s === bs && r.next() < 0.5)) { bs = s; best = x; }
  }
  return best;
}

module.exports = { rolloutVote };
