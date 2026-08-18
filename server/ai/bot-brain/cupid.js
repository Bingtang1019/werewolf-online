'use strict';
/* =========================================================================
 * cupid.js —— 丘比特智能化选人（神眷者训练）
 * 规则依据（rules.md）：
 *   - 首夜丘比特不知道身份，随机连人（默认不连自己，提高人狼恋概率）；
 *   - 情侣全灭后每夜可重新指定情侣；丘比特可得知自己当前阵营；
 *   - 重选轮丘比特若在情侣中，新阵营 = 丘比特当前阵营 + 被连者；
 *     若不在情侣中，新阵营 = 新情侣两人身份组合；
 *   - 目标：在标准预设局中让神眷者尽可能存在并拥有长期生存能力。
 * 本模块只使用 bot 自身信念/公开信息，不读真实身份（除情侣互知规则内）。
 * ========================================================================= */
const shared = require('./shared');
const ctx = shared.ctx;

function wolfProbOf(room, bot, id) {
  let w = 0.5;
  try {
    if (typeof ctx.wolfProb === 'function') w = ctx.wolfProb(room, bot, id) || 0.5;
  } catch (e) { /* 信念缺失回退 0.5 */ }
  // 用预言家/查验声明修正：查杀→更像狼，金水→更像好人（credibility 加权）
  const mem = bot.botMemory || {};
  const seerClaims = mem.seerClaims || {};
  for (const claimerId of Object.keys(seerClaims)) {
    const rec = seerClaims[claimerId];
    if (!rec || !Array.isArray(rec.claims)) continue;
    const cred = Math.max(0, Math.min(1, rec.credibility || 0.5));
    for (const c of rec.claims) {
      if (!c || c.target !== id) continue;
      if (c.result === 'wolf') w = Math.max(w, 0.5 + 0.4 * cred);
      if (c.result === 'good') w = Math.min(w, 0.5 - 0.4 * cred);
    }
  }
  return Math.max(0.05, Math.min(0.95, w));
}

function pickPower(wDiff) {
  // v2 权能槽：人狼恋倾向复仇（殉情宣言反制），同阵营倾向守护（保命）
  return wDiff > 0.1 ? 'vengeance' : 'guard';
}

/**
 * 丘比特选人决策。
 * @returns {{action:'cupid_pick', data:{ids:[string,string], power?}}}|null
 */
function decideCupidPick(room, bot) {
  const nightNum = room.nightNum || 1;
  const aliveOthers = ctx.alivePlayers(room).filter(p => p.id !== bot.id);

  // 首夜：无信息，保持“不连自己”的随机策略（CUPID_ALLOW_SELF=1 可恢复旧行为）
  if (nightNum === 1) {
    const allowSelf = process.env.CUPID_ALLOW_SELF === '1';
    const pool = allowSelf ? ctx.alivePlayers(room) : aliveOthers;
    if (pool.length < 2) return null;
    const a = ctx.pick(pool);
    const b = ctx.pick(pool.filter(q => q.id !== (a && a.id)));
    if (!a || !b) return null;
    const data = { ids: [a.id, b.id] };
    if (room.loverMode === 'v2') data.power = pickPower(Math.abs(wolfProbOf(room, bot, a.id) - wolfProbOf(room, bot, b.id)));
    return { action: 'cupid_pick', data };
  }

  // 重选：只有情侣全灭时才触发（引擎会保证这一点，这里再兜底）
  const lovers = room.lovers || [];
  const loversDead = !lovers.length || lovers.every(id => {
    const q = ctx.byId(room, id);
    return !q || !q.alive;
  });
  if (!loversDead) return { action: 'cupid_pick', data: { ids: null } };

  // 只剩自己和一个可连对象：自连（当前阵营 + 任意 = 神眷者，规则保证）
  if (aliveOthers.length === 1) {
    const p = aliveOthers[0];
    const data = { ids: [bot.id, p.id] };
    if (room.loverMode === 'v2') data.power = pickPower(Math.abs(wolfProbOf(room, bot, bot.id) - wolfProbOf(room, bot, p.id)));
    return { action: 'cupid_pick', data };
  }
  if (aliveOthers.length < 2) return { action: 'cupid_pick', data: { ids: null } };

  // 用信念给存活玩家排序：高 P(wolf)=像狼，低 P(wolf)=像好人。
  // 神眷者训练目标：重造“狼+好”人狼恋，因此选一个最像狼、一个最像好人。
  const scored = aliveOthers
    .map(p => ({ p, w: wolfProbOf(room, bot, p.id) }))
    .sort((a, b) => b.w - a.w);

  // 实验门控：CUPID_REPICK_SELF=1 → 重选时优先自连（当前神眷者自连任何人仍为神眷者，
  // 当前好/狼自连相反阵营也能变神眷者）。自连更稳，但神眷者人数从 3 降为 2。
  if (process.env.CUPID_REPICK_SELF === '1') {
    let partner;
    if (room.cupidCamp === 'third') partner = scored[0].p; // 已神眷者：连最像狼者，保留夜刀能力
    else if (room.cupidCamp === 'wolf') partner = scored[scored.length - 1].p; // 狼阵营：连最像好人者
    else partner = scored[0].p; // 好阵营：连最像狼者
    if (!partner) return { action: 'cupid_pick', data: { ids: null } };
    const data = { ids: [bot.id, partner.id] };
    if (room.loverMode === 'v2') data.power = pickPower(Math.abs(wolfProbOf(room, bot, bot.id) - partner.w));
    return { action: 'cupid_pick', data };
  }

  let wolf = scored[0];
  let good = scored[scored.length - 1];
  if (wolf.p.id === good.p.id) good = scored[scored.length - 2] || null;
  if (!good) return { action: 'cupid_pick', data: { ids: null } };

  const data = { ids: [wolf.p.id, good.p.id] };
  if (room.loverMode === 'v2') data.power = pickPower(Math.abs(wolf.w - good.w));
  return { action: 'cupid_pick', data };
}

module.exports = { decideCupidPick };
