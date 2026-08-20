'use strict';
/* server/ai/bot-brain/chaos.js —— 混沌层共享实现（1.8.x）
 * main/smart/memory 三个投票入口共用同一套低置信“上头/犹豫”逻辑：
 *   - LAB_NO_CHAOS=1 关闭；
 *   - CHAOS_STRENGTH / CHAOS_THRESHOLD 可调；
 *   - 有界偏移 top3；
 *   - 狼人不投狼队友；
 *   - 狼恋人不投自己的好恋人。
 */
const shared = require('./shared');
const ctx = shared.ctx;
const S = shared.S;

function chaosStrength() {
  return process.env.CHAOS_STRENGTH != null ? parseFloat(process.env.CHAOS_STRENGTH) : 0.6;
}
function chaosThreshold() {
  return process.env.CHAOS_THRESHOLD != null ? parseFloat(process.env.CHAOS_THRESHOLD) : 0.8;
}

/**
 * 对当前投票目标做一次有界混沌偏移。
 * @param {object} room
 * @param {object} bot
 * @param {object} world buildVoteWorld 产物（需含 scores/sellTarget）
 * @param {string[]} candidateIds 候选 id 列表（不含自己）
 * @param {object} currentTarget 当前目标玩家对象
 * @param {object|null} lp loverPartner 结果
 * @param {{threshold?:number,strength?:number}} [opts]
 * @returns {object} 可能偏移后的目标玩家对象
 */
function maybeChaosVote(room, bot, world, candidateIds, currentTarget, lp, opts) {
  if (process.env.LAB_NO_CHAOS === '1') return currentTarget;
  if (!currentTarget || !currentTarget.id || !room || !bot) return currentTarget;
  if (world && world.sellTarget && currentTarget.id === world.sellTarget) return currentTarget;
  if (ctx.isCheckedTarget(room, currentTarget)) return currentTarget;
  const threshold = opts && opts.threshold != null ? opts.threshold : chaosThreshold();
  const strength = opts && opts.strength != null ? opts.strength : chaosStrength();
  const conf = S.confidenceOf(room, bot, currentTarget.id);
  if (conf >= threshold) return currentTarget;
  if (ctx.rng().next() >= ((threshold - conf) * strength + 0.02)) return currentTarget;
  const ranked = (candidateIds || [])
    .map(id => ({ q: ctx.byId(room, id), s: (world && world.scores && world.scores[id]) || 0.5 }))
    .filter(x => x.q)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);
  const pool = ranked
    .map(x => x.q)
    .filter(q => q.id !== currentTarget.id
      && !(lp && !lp.isWolf && q.id === lp.id)
      && !(ctx.campOf(bot) === 'wolf' && ctx.campOf(q) === 'wolf'));
  const other = ctx.pick(pool);
  return other || currentTarget;
}

module.exports = { maybeChaosVote, chaosStrength, chaosThreshold };
