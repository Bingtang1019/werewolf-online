'use strict';
/* =========================================================================
 * vote 特征提取（1.7.0，B1-2/B1-4）——训练与推理共用同一套特征函数（B1-7④，消灭特征漂移）
 * 纪律：只读公开信息（发言/投票/查验声明/位置），绝不读真实身份（B1-7②）；
 *       位置类特征（座位/环距离）——狼人杀信息量最高的公开特征之一（B1-2）
 * voteFeatures(room, botId, candId) → 特征数组（归一化 0..1）；label 由调用方用真实身份打标
 * ========================================================================= */
const FEATURE_NAMES = [
  'seat_norm',    // 候选座位归一化（0..1）
  'ring_dist',    // 候选与 bot 的座位环距离（归一化 0..0.5）
  'talk_count',   // 候选白天发言次数（0..1 归一）
  'checked_wolf', // 候选被公开"查杀"声明次数
  'checked_good', // 候选被公开"金水"声明次数
  'votes_against',// 候选当前被投票数（相对存活人数）
  'prev_votes',   // 候选历史被投票数（上一轮）
  'claims_seer',  // 候选自称预言家次数
  'claims_god',   // 候选自称神职（守卫/女巫/猎人/摄梦人）次数
  // 1.7.0（B1-3 加强）：高信息量特征
  'accused_count',  // 候选被公开质疑次数（怀疑/别信/投/出 + 名字）
  'counter_seer',   // 候选自称预言家且白天有人对跳（预言家对跳是最强狼信号之一）
  'vote_lead',      // 候选当前是否最高票（跟随公众压力信号）
  'bot_prev_same',  // bot 上一轮是否投过候选（行为一致性——狼更易被重复针对）
];

function voteFeatures(room, botId, candId) {
  const bot = room.players.find(p => p.id === botId);
  const cand = room.players.find(p => p.id === candId);
  if (!bot || !cand) return null;
  const total = room.players.length || 1;
  const alive = room.players.filter(p => p.alive);
  const n = alive.length || 1;
  // 位置
  const seatNorm = (cand.seat - 1) / Math.max(1, total - 1);
  const rawDist = Math.abs(bot.seat - cand.seat);
  const ringDist = Math.min(rawDist, total - rawDist) / Math.max(1, total);
  // 发言（白天频道）
  const msgs = room.messages || [];
  let talkCount = 0;
  for (const m of msgs) if (m.ch === 'all' && m.from === candId) talkCount++;
  // 公开查验声明（非本人、白天频道）
  let checkedWolf = 0, checkedGood = 0, claimsSeer = 0, claimsGod = 0;
  for (const m of msgs) {
    if (m.ch !== 'all' || !m.text) continue;
    if (m.from === candId) {
      if (m.text.includes('预言家') || m.text.includes('跳预')) claimsSeer++;
      if (/我是(守卫|女巫|猎人|摄梦人)/.test(m.text)) claimsGod++;
    } else if (m.from !== botId) {
      if (m.text.includes('查杀') && m.text.includes(cand.name)) checkedWolf++;
      if (m.text.includes('金水') && m.text.includes(cand.name)) checkedGood++;
    }
  }
  // 投票
  const votes = room.votes || {};
  let votesAgainst = 0;
  for (const k of Object.keys(votes)) if (votes[k] === candId) votesAgainst++;
  const lv = room.lastVoteResult;
  const prevVotes = lv && lv.totals ? (lv.totals[candId] || 0) : 0;
  // 1.7.0（B1-3 加强）：
  // 被质疑次数（怀疑/别信/投/出 + 候选名）
  let accused = 0;
  for (const m of msgs) {
    if (m.ch === 'all' && m.from !== botId && m.text && m.text.includes(cand.name) && /(怀疑|别信|投|出)/.test(m.text)) accused++;
  }
  // 对跳预言家：候选自称过预言家，且白天另有他人也声称预言家
  const seerClaimers = new Set();
  for (const m of msgs) if (m.ch === 'all' && m.text && m.text.includes('预言家')) seerClaimers.add(m.from);
  const counterSeer = (claimsSeer > 0 && seerClaimers.size > 1) ? 1 : 0;
  // 当前最高票（相对票数）
  let maxVotes = 0;
  for (const k of Object.keys(votes)) { let c = 0; for (const k2 of Object.keys(votes)) if (votes[k2] === votes[k]) c++; if (c > maxVotes) maxVotes = c; }
  const voteLead = votesAgainst > 0 && votesAgainst >= maxVotes ? 1 : 0;
  // bot 上一轮是否投过候选（actionLog：L2-lite 公开日志）
  const lastVoteLog = (room.actionLog || []).filter(a => a.action === 'vote' && a.actor === bot.seat);
  const prevTarget = lastVoteLog.length ? (lastVoteLog[lastVoteLog.length - 1].data || {}).target : null;
  const botPrevSame = prevTarget === candId ? 1 : 0;
  return [
    seatNorm,
    ringDist,
    Math.min(talkCount, 5) / 5,
    Math.min(checkedWolf, 3) / 3,
    Math.min(checkedGood, 3) / 3,
    votesAgainst / n,
    Math.min(prevVotes, 5) / 5,
    Math.min(claimsSeer, 2) / 2,
    Math.min(claimsGod, 2) / 2,
    Math.min(accused, 3) / 3,
    counterSeer,
    voteLead,
    botPrevSame,
  ];
}

module.exports = { voteFeatures, FEATURE_NAMES };
