'use strict';
/* favens/index.js —— 神眷者主模型：路由 / 概率继承 / 接入
 * 触发：FAVENS=1 且 bot 是恋人成员或丘比特（恋人机制角色）
 * 路由（按 myLover.role 分流——人狼恋边界必须在此兜住，favens 最容易写错的地方）：
 *   丘比特     → cupid.js（三路站队，不投情侣）
 *   狼恋人     → wolfLover.js（夜间刀神底座+红线过滤；白天红线跟票；魅惑保护；继承穿衣服）
 *   好恋人     → goodLover.js（护短+职业策略；conditionOn 概率）
 *   恋人=狼（人狼恋·好方）→ goodLover 不护短（路由不调用护短分支），双方各自为战/混沌（第三方，结局单列）
 * conditionOn try/catch → room.favensInvalid 计数（对局继续，剔除胜率统计，汇总上报）
 * 接入：bot-brain createBotDecision 入口 FAVENS 模式路由（见 bot-brain.js） */
const cupid = require('./cupid.js');
const wolfLover = require('./wolfLover.js');
const goodLover = require('./goodLover.js');

function isWolf(q) { return q && (q.role === 'wolf' || q.role === 'wolfBeauty'); }
function isCupid(bot) { return bot && bot.role === 'cupid'; }
function isLoverMember(room, bot) { return !!(room && room.lovers && bot && room.lovers.includes(bot.id)); }

function partnerOf(room, bot) {
  if (!isLoverMember(room, bot)) return null;
  const pid = room.lovers.find(id => id !== bot.id);
  return room.players.find(q => q.id === pid) || null;
}

/**
 * favensDecide(room, bot) → action 或 null（null=回退普通策略）
 * 按 room.phase 分发（夜间狼恋人刀人 / 白天投票）。
 */
function favensDecide(room, bot) {
  if (!room || !bot || !room.players.some(q => q.id === bot.id)) return null;
  // v2（M1/M2）：恋人机制引擎化——策略适配（规则在 loverCore，策略只做行为选择；v2 要求 FAVENS=1 才进入本模块）
  if (room.loverMode === 'v2') {
    if (isCupid(bot)) return null; // 丘比特投票走普通（v2 无搅局）；权能选择在 cupid_pick 决策（bot-brain 已带）
    if (!isLoverMember(room, bot)) return null;
    if (isWolf(bot)) {
      if (room.phase === 'night' && room.nightStep === 'wolf') return null; // v2 狼恋人：普通狼刀法（删模型继承）
      if (room.phase === 'vote' || room.phase === 'pk_vote' || room.phase === 'sheriff_vote') return wolfLover.decideVoteV2(room, bot); // 保丘比特
      return null;
    }
    // 好恋人 v2：付费护短（保护标记 → 结算公告，狼队获知身份优先刀）
    if (room.phase === 'vote' || room.phase === 'pk_vote' || room.phase === 'sheriff_vote') return goodLover.decideVoteV2(room, bot);
    return null;
  }
  const partner = partnerOf(room, bot);
  const partnerIsWolf = partner && isWolf(partner);
  // 丘比特：v1.7.8 站队复用普通丘比特（对照组同行为——β1 归因：favens 粗糙投法不如普通模型投法精准，+7.5pp 主要来源）
  // favens 丘比特只干预：人狼恋（third）搅局 + 不投情侣红线；好+好/狼+狼站队 → null（走 createBotDecision 普通逻辑）
  // v1.7.9：FAVENS_CUPID_REUSE=1 → 丘比特完全回退普通决策（third 也不搅局）——配对实验证明 third 搅局独占 +3.1pp 偏狼（β 归因）
  if (isCupid(bot)) {
    if (process.env.FAVENS_CUPID_REUSE === '1') return null;
    if (room.cupidCamp === 'third') return process.env.FAVENS_CUPID !== '0' ? cupid.decideVote(room, bot) : null;
    return null;
  }
  // 恋人成员
  if (!isLoverMember(room, bot)) return null;
  if (isWolf(bot)) {
    // 狼恋人：夜间刀人 / 白天投票
    if (process.env.FAVENS_WOLFLOVER === '0') return null; // 子集开关
    if (room.phase === 'night' && room.nightStep === 'wolf') return wolfLover.decideNightKill(room, bot);
    // v1.7.9（c2 实验）：FAVENS_WOLF_DAY=normal → 白天复用普通投票（bot-brain 普通狼决策自带不投恋人红线）→ null
    if (process.env.FAVENS_WOLF_DAY === 'normal') return null;
    if (room.phase === 'vote' || room.phase === 'pk_vote' || room.phase === 'sheriff_vote') return wolfLover.decideVote(room, bot);
    return null;
  }
  if (process.env.FAVENS_GOODLOVER === '0') return null; // 子集开关
  // 好恋人：恋人=狼（人狼恋）→ 不护短，各自为战（第三方）；恋人=好 → 护短
  if (partnerIsWolf) {
    // 人狼恋·好方：第三方混沌策略——不投恋人（红线），其余跟票（不帮任何一边）
    if (room.phase === 'vote' || room.phase === 'pk_vote' || room.phase === 'sheriff_vote') {
      const counts = {};
      for (const k of Object.keys(room.votes || {})) { const t = room.votes[k]; if (t && t !== bot.id && t !== partner.id) counts[t] = (counts[t] || 0) + 1; }
      let best = null, n = 0;
      for (const k of Object.keys(counts)) if (counts[k] > n) { n = counts[k]; best = k; }
      return { action: 'vote', data: { target: best } };
    }
    return null;
  }
  // 恋人=好：护短（soft 默认）
  if (room.phase === 'vote' || room.phase === 'pk_vote' || room.phase === 'sheriff_vote') {
    return goodLover.decideVote(room, bot, { protectLover: process.env.FAVENS_PROTECT_LOVER === 'never' ? 'never' : 'soft' });
  }
  return null;
}
module.exports = { favensDecide, isLoverMember, isCupid };
