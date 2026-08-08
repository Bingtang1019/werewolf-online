'use strict';
/* v1.8.0（vote-v4 蒸馏前置）：投票轮级决策状态——房间级特征快照（架构革命 ①）。
 *
 * 问题：buildVoteWorld 每票每 bot 全量重算——11 候选 × [voteFeatures(13 维，内部
 *       全扫 messages/票型) + beliefFeatures25(12 维信念查表) + modelProb(stump)]
 *       × 每轮 ~7 bot——房间级数据重复构造 N 次（O(候选×bot×证据)）。
 * 颠覆：房间级特征在"投票轮开始"构造一次（room._vs），决策时 O(1) 查表拼接。
 *       bot 级项（排除自己的票/消息、botPrevSame）单独小算。
 *       票型字段（votesAgainst/voteLead/prevVotes）实时读 room.votes——快照失效键
 *       只用 day+phase（messages 在 day 内不变；PK/警长票 phase 变化覆盖）。
 *
 * A-2 纪律：缓存/预计算不改变特征值——配对验证（同 seed 双跑 0 不一致）是硬门槛。
 */

// 房间级快照：每候选一行（messages 派生字段——慢的部分，构建一次）
function buildRoomVoteState(room) {
  const players = room.players;
  const total = players.length || 1;
  const alive = players.filter(p => p.alive);
  const n = alive.length || 1;
  const msgs = room.messages || [];
  const rows = new Map();
  // 房间级聚合（messages 一次全扫）
  const talkCount = new Map(), checkedWolf = new Map(), checkedGood = new Map(), claimsSeer = new Map(), claimsGod = new Map(), accusedAll = new Map();
  const seerClaimers = new Set();
  for (const m of msgs) if (m.ch === 'all' && m.from) talkCount.set(m.from, (talkCount.get(m.from) || 0) + 1); // 独立循环：无 text 过滤（与原版 talkCount 一致——主循环有 m.text 过滤会漏数）
  for (const m of msgs) {
    if (m.ch !== 'all' || !m.text) continue;
    if (m.from) {
      if (m.text.includes('预言家') || m.text.includes('跳预')) claimsSeer.set(m.from, (claimsSeer.get(m.from) || 0) + 1);
      if (/我是(守卫|女巫|猎人|摄梦人)/.test(m.text)) claimsGod.set(m.from, (claimsGod.get(m.from) || 0) + 1);
      if (m.text.includes('我是预言家') || m.text.includes('我跳预言家') || m.text.includes('跳预')) seerClaimers.add(m.from);
    }
    for (const p of players) {
      if (!p.name) continue;
      if (m.text.includes(p.name)) {
        if (m.from !== p.id) { // 1.8.0：cw/cg 只统计"第三方"（原实现 m.from===candId 走 claims 分支不计数查杀/金水；bot 的由差值减）
          if (m.text.includes('查杀')) checkedWolf.set(p.id, (checkedWolf.get(p.id) || 0) + 1);
          if (m.text.includes('金水')) checkedGood.set(p.id, (checkedGood.get(p.id) || 0) + 1);
        }
        if (/(怀疑|别信|投|出)/.test(m.text)) accusedAll.set(p.id, (accusedAll.get(p.id) || 0) + 1);
      }
    }
  }
  for (const p of players) {
    if (!p.alive) continue;
    const seatNorm = (p.seat - 1) / Math.max(1, total - 1);
    const cs = claimsSeer.get(p.id) || 0;
    const counterSeer = (cs > 0 && seerClaimers.size > 1) ? 1 : 0;
    rows.set(p.id, {
      seatNorm,
      ringBase: p.seat,
      talk: Math.min(talkCount.get(p.id) || 0, 5) / 5,
      cw: Math.min(checkedWolf.get(p.id) || 0, 3) / 3,
      cg: Math.min(checkedGood.get(p.id) || 0, 3) / 3,
      cs: Math.min(cs, 2) / 2,
      cg2: Math.min(claimsGod.get(p.id) || 0, 2) / 2,
      accAll: accusedAll.get(p.id) || 0,
      cSeer: counterSeer,
    });
  }
  // bot 级差值表（botId -> { acc/cw/cg/va 差值, prevTarget }）
  const botDiffs = new Map();
  for (const m of msgs) {
    if (m.ch !== 'all' || !m.text || !m.from) continue;
    for (const p of players) {
      if (!p.name || !m.text.includes(p.name)) continue;
      let d = botDiffs.get(m.from);
      if (!d) { d = { acc: new Map(), va: new Map(), cw: new Map(), cg: new Map(), prevTarget: null }; botDiffs.set(m.from, d); }
      if (/(怀疑|别信|投|出)/.test(m.text)) d.acc.set(p.id, (d.acc.get(p.id) || 0) + 1);
      if (m.text.includes('查杀')) d.cw.set(p.id, (d.cw.get(p.id) || 0) + 1);
      if (m.text.includes('金水')) d.cg.set(p.id, (d.cg.get(p.id) || 0) + 1);
    }
  }
  // bot 级差值：投票（bot 投给 cand 的票——vAAll 减它）
  for (const k of Object.keys(room.votes || {})) {
    const t = room.votes[k];
    if (!t) continue;
    let d = botDiffs.get(k);
    if (!d) { d = { acc: new Map(), va: new Map(), cw: new Map(), cg: new Map(), prevTarget: null }; botDiffs.set(k, d); }
    d.va.set(t, (d.va.get(t) || 0) + 1);
  }
  for (const a of room.actionLog || []) {
    if (a.action !== 'vote') continue;
    const bp = players[Number(a.actor) - 1];
    const d = bp ? botDiffs.get(bp.id) : null;
    if (d) d.prevTarget = (a.data || {}).target;
  }
  const playersById = new Map(players.map(p => [p.id, p]));
  return { rows, botDiffs, n, total, playersById, votesRef: room.votes, lvRef: room.lastVoteResult };
}

// 决策时：O(1) 拼接 13 维（与 voteFeatures 逐位同值——配对验证硬门槛）
function voteFeatures13(vs, botId, candId) {
  const row = vs.rows.get(candId);
  if (!row) return null;
  const bot = vs.playersById ? vs.playersById.get(botId) : null;
  const cand = vs.playersById ? vs.playersById.get(candId) : null;
  if (!bot || !cand) return null;
  const total = vs.total;
  const rawDist = Math.abs(bot.seat - cand.seat);
  const ringDist = Math.min(rawDist, total - rawDist) / Math.max(1, total / 2);
  const bd = vs.botDiffs.get(botId);
  const accByBot = bd && bd.acc.get(candId) ? bd.acc.get(candId) : 0;
  const vAByBot = bd && bd.va.get(candId) ? bd.va.get(candId) : 0;
  const cwByBot = bd && bd.cw.get(candId) ? bd.cw.get(candId) : 0;
  const cgByBot = bd && bd.cg.get(candId) ? bd.cg.get(candId) : 0;
  // 票型实时（votesRef 是 room.votes 引用——每次决策反映当前票型；与 voteFeatures 一致：排除 bot 自己的票）
  const votes = vs.votesRef || {};
  let vAAll = 0, maxVotes = 0;
  const vCounts = {};
  for (const k of Object.keys(votes)) { if (k === botId) continue; const t = votes[k]; if (!t) continue; vCounts[t] = (vCounts[t] || 0) + 1; if (t === candId) vAAll++; }
  for (const k of Object.keys(vCounts)) if (vCounts[k] > maxVotes) maxVotes = vCounts[k];
  const lv = vs.lvRef;
  const pV = lv && lv.totals ? Math.min(lv.totals[candId] || 0, 5) / 5 : 0;
  const votesAgainst = vAAll; // 已排除 bot
  const accused = Math.max(0, row.accAll - accByBot);
  const vL = (votesAgainst > 0 && votesAgainst >= maxVotes) ? 1 : 0;
  const botPrevSame = bd && bd.prevTarget === candId ? 1 : 0;
  return [
    row.seatNorm,
    ringDist,
    row.talk,
    Math.max(0, row.cw - cwByBot),
    Math.max(0, row.cg - cgByBot),
    votesAgainst / vs.n,
    pV,
    row.cs,
    row.cg2,
    Math.min(accused, 3) / 3,
    row.cSeer,
    vL,
    botPrevSame,
  ];
}

module.exports = { buildRoomVoteState, voteFeatures13 };
