'use strict';
/* favens/cupid.js —— 丘比特三路站队（β）
 * 丘比特知道自己的阵营（cupidCamp）：好+好→帮好；狼+狼→帮狼；人狼恋→搅局（kingmaker 继承）
 * 红线：永不投情侣（丘比特知情侣身份，v1.7.6 规则）
 * 目标选择用公开信号（票型集中/自称神职），不依赖隐藏信息——丘比特不知道玩家身份（除情侣）。 */
const fs = require('fs');
const path = require('path');
const { voteFeatures } = require('../server/ai/features.js');

function isWolf(q) { return q && (q.role === 'wolf' || q.role === 'wolfBeauty'); }
function claimsMap(room) {
  const m = new Map();
  for (const msg of room.messages || []) {
    if (msg.ch === 'all' && msg.from && msg.text) {
      const mm = msg.text.match(/我是(女巫|预言家|猎人|守卫|摄梦人)/);
      if (mm && !m.has(msg.from)) m.set(msg.from, mm[1]);
    }
  }
  return m;
}
function voteCounts(room, pool) {
  const c = {};
  for (const k of Object.keys(room.votes || {})) {
    const t = room.votes[k];
    if (t && pool.some(q => q.id === t)) c[t] = (c[t] || 0) + 1;
  }
  return c;
}
function leadOf(counts) {
  let lead = null, n = 0;
  for (const k of Object.keys(counts)) if (counts[k] > n) { n = counts[k]; lead = k; }
  return lead;
}

function decideVote(room, bot) {
  const c = room.cupidCamp || 'good'; // 未指定情侣前丘比特身份=好人（首轮）
  const lovers = room.lovers || [];
  const pool = room.players.filter(q => q.alive && q.id !== bot.id && !lovers.includes(q.id));
  if (!pool.length) return { action: 'vote', data: { target: null } };
  const counts = voteCounts(room, pool);
  const lead = leadOf(counts);
  const claims = claimsMap(room);
  if (c === 'good') {
    // 帮好：投自称神职者（嫌疑代理）或票型最高者（好人视角）
    let t = null;
    for (const q of pool) if (claims.has(q.id)) { t = q.id; break; }
    return { action: 'vote', data: { target: t || lead } };
  }
  if (c === 'wolf') {
    // 帮狼：投票型最高的好人（搅浑 / 帮狼节奏）——v1.7.8 参数化：FAVENS_CUPID_WOLF=0 时弃票（控 favens 狼侧偏移，β1 归因：丘比特帮狼贡献 +7.5pp）
    if (process.env.FAVENS_CUPID_WOLF === '0') return { action: 'vote', data: { target: null } };
    return { action: 'vote', data: { target: lead || null } };
  }
  // 人狼恋（third）：搅局——公开计数近似优势方（狼数 vs 好人存活数），削优势方
  const wolfAlive = room.players.filter(q => q.alive && isWolf(q)).length;
  const goodAlive = room.players.filter(q => q.alive && !isWolf(q)).length;
  if (goodAlive > wolfAlive) {
    let t = null;
    for (const q of pool) if (claims.has(q.id)) { t = q.id; break; }
    return { action: 'vote', data: { target: t || lead } };
  }
  return { action: 'vote', data: { target: lead || null } };
}
module.exports = { decideVote };
