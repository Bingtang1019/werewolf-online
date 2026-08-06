'use strict';
/* favens/goodLover.js —— 好恋人（β）
 * 已知阵营（恋人互认：myLover.role，v1.7.6 消息）：
 *   恋人=好 → 护短（protectLover: soft/never）+ 职业策略（职业技能正常）
 *   恋人=狼（人狼恋）→ 路由层分流到第三方/混沌策略（不护短、不刀恋人、各自为战）——本模块不处理
 * conditionOn：信念 = 普通策略先验 × conditionOn(情侣约束)（狼数守恒，硬覆盖恋人身份）
 * invalid：conditionOn 抛错 → 返回未条件化先验（路由层标记 invalid，对局继续剔除统计） */
const { conditionOn } = require('./condition.js');

function isWolf(q) { return q && (q.role === 'wolf' || q.role === 'wolfBeauty'); }
function wolfCountOf(room) {
  const rc = room.roleCounts || {};
  const wolfInit = (rc.wolf || 0) + (rc.wolfBeauty || 0);
  const deadWolf = room.players.filter(q => !q.alive && (q.role === 'wolf' || q.role === 'wolfBeauty')).length;
  return Math.max(0, wolfInit - deadWolf);
}
function loverIdOf(room, bot) {
  return room.lovers && room.lovers.includes(bot.id) ? room.lovers.find(id => id !== bot.id) : null;
}

/* 概率继承：普通策略先验 × conditionOn(自身=好 + 恋人身份) */
function getBeliefs(room, bot, prior) {
  const loverId = loverIdOf(room, bot);
  const lover = loverId ? room.players.find(q => q.id === loverId) : null;
  if (!lover) return prior;
  const constraints = [
    { id: bot.id, camp: 'good' },
    { id: lover.id, camp: isWolf(lover) ? 'wolf' : 'good' },
  ];
  try { return conditionOn(prior, constraints, wolfCountOf(room)); }
  catch (e) { return prior; } // invalid：路由层计数
}

/* 护短投票：恋人被集火时 soft→投次优 / never→弃票；否则正常投（好人视角，票型/自称神职代理） */
function decideVote(room, bot, { protectLover = 'soft' } = {}) {
  const loverId = loverIdOf(room, bot);
  const pool = room.players.filter(q => q.alive && q.id !== bot.id && q.id !== loverId);
  const counts = {};
  for (const k of Object.keys(room.votes || {})) {
    const t = room.votes[k];
    if (t && pool.some(q => q.id === t)) counts[t] = (counts[t] || 0) + 1;
  }
  let lead = null, n = 0;
  for (const k of Object.keys(counts)) if (counts[k] > n) { n = counts[k]; lead = k; }
  if (lead === loverId) {
    if (protectLover === 'never') return { action: 'vote', data: { target: null } }; // 绝不投恋人 → 弃票
    // soft：投次优（票型次高或自称神职者）
    let t = null, bestV = -1;
    const claims = (room.messages || []).filter(m => m.ch === 'all' && m.text && m.from !== bot.id && m.from !== loverId);
    const claimMap = {};
    for (const m of claims) { const mm = m.text.match(/我是(女巫|预言家|猎人|守卫|摄梦人)/); if (mm && !claimMap[m.from]) claimMap[m.from] = mm[1]; }
    const val = { '女巫': 5, '预言家': 4, '猎人': 3, '守卫': 2, '摄梦人': 1 };
    for (const q of pool) { const r = claimMap[q.id]; if (r && (val[r] || 0) > bestV) { bestV = val[r] || 0; t = q.id; } }
    return { action: 'vote', data: { target: t || lead } }; // 恋人被集火但无次优 → 保恋人（soft 不下票到恋人）
  }
  return { action: 'vote', data: { target: lead || null } };
}
module.exports = { decideVote, getBeliefs };
