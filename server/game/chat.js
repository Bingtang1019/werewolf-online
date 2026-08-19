// 自动生成（game.js 拆分——chat 模块，勿手改，重新运行 tools/split-game.js）

const shared = require('./shared');
const ctx = shared.ctx;
const { register } = shared;
const { clock, chatRecorder, WOLF_ROLES, rooms, resetBotPerGame, injectGrudge } = shared;
const { extractClaims } = require('../ai/nlu-claims.js'); // 1.8.0：真人聊天 NLU 声明抽取（belief-engine 证据源）

function addMessage(room, p, ch, text, marker, claim) {
  const prev = room.messages[room.messages.length - 1];
  // ts 严格递增：作为聊天增量传输的锚点（同一毫秒内的多条消息也不会丢失）
  const ts = Math.max(clock.now(), (prev ? prev.ts : 0) + 1);
  room.messages.push({ id: ctx.uid(), ch, from: p ? p.id : null, name: p ? p.name : '系统', text, marker: marker || null, ts, day: room.dayNum, night: room.nightNum, claim: claim || null }); // V5.1：结构化声明随消息
  if (room.messages.length > 500) room.messages.splice(0, room.messages.length - 500);
}
/* 1.8.x（丘比特削弱）：情侣频道仅情侣两人可见；丘比特知情侣身份但不能看/进情侣频道 */
function isLoverParty(room, id) {
  if (!id || !room) return false;
  return !!(room.lovers && room.lovers.includes(id));
}
function chatAccess(room, p, ch) {
  if (ch === 'all') return room.phase !== 'night'; // 全体频道夜间关闭
  if (ch === 'wolf') return p && ctx.isWolfRole(p) && room.phase === 'night'; // 狼人频道仅夜晚开放
  if (ch === 'lover') return p && isLoverParty(room, p.id); // 情侣频道全天开放（仅情侣两人）
  return false;
}
// 查看历史消息的权限：全体消息始终可见，私密频道仅成员可见；狼人频道仅夜晚开放（白天连历史也不可见）
function chatView(room, p, ch) {
  if (ch === 'all') return true;
  if (ch === 'wolf') return !!p && ctx.isWolfRole(p) && room.phase === 'night';
  if (ch === 'lover') return !!p && isLoverParty(room, p.id); // 仅情侣两人可见
  return false;
}
/* 聊天发送间隔（毫秒），防刷屏：同一玩家两条消息至少间隔该时长；可用 CHAT_INTERVAL 覆盖（0=关闭） */
const CHAT_INTERVAL = Math.max(0, parseInt(process.env.CHAT_INTERVAL || '800', 10));

function chatAction(room, p, data) {
  const ch = data.ch === 'lover' ? 'lover' : data.ch === 'wolf' ? 'wolf' : 'all';
  if (!chatAccess(room, p, ch)) return { error: '你没有该频道的发言权限' };
  const text = (data.text || '').trim();
  if (!text) return { error: '消息不能为空' };
  if (text.length > 200) return { error: '消息过长（≤200字）' };
  if (CHAT_INTERVAL > 0) { // 防刷屏限流
    const now = clock.now();
    if (p.lastChatAt && now - p.lastChatAt < CHAT_INTERVAL) return { error: '发言太快了，请稍候再试' };
    p.lastChatAt = now;
  }
  if (!room.speechToday) room.speechToday = {};
  room.speechToday[p.id] = (room.speechToday[p.id] || 0) + 1; // v4.2：发言量信息特征（speech 摘要事件数据源）
  if (!p.isBot) chatRecorder.record(room, p, ch, text); // 1.8.0：真人聊天收集（NLU 语料冷启动；失败静默不阻塞）
  addMessage(room, p, ch, text, null, data.claim || null); // D1：结构化声明透传（bot 声明：查杀/金水）
  if (data.claim) ctx.pushEvent(room, 'claim', { from: p.id, type: data.claim.type, target: data.claim.target || null, night: data.claim.night != null ? data.claim.night : room.nightNum }); // V5.1：声明事件（belief-engine 证据源）
  // 1.8.0：真人聊天 NLU 声明抽取——把“查杀/金水/攻击/自辩/跳身份”变成 belief-engine 可消费的结构化声明
  // LAB_NLU_PARSE_BOTS=1 时也解析 bot 消息（但跳过带结构化 claim 的消息，避免重复计数）
  if (!p.isBot || (process.env.LAB_NLU_PARSE_BOTS === '1' && !data.claim)) {
    for (const c of extractClaims(room, p.id, text)) {
      ctx.pushEvent(room, 'claim', { from: p.id, type: c.type, target: c.target, night: room.nightNum });
    }
  }
  ctx.bump(room);
  return { ok: true };
}

/* ---------------------------- 房主强制继续 / 离开 / 踢人 ---------------------------- */
function advance(room, pid) {
  if (pid !== room.host) return { error: '只有房主可以操作' };
  switch (room.phase) {
    case 'reveal': {
      // 强制推进：房主未选择→随机；盗贼未选择→按规则代选；已发牌→立即进入夜晚
      if (!room.reveal.dealt) {
        if (!room.reveal.hostPicked) {
          room.reveal.hostPicked = true;
          if (room.settings.thief) {
            if (!room.center) room.center = [room.reveal.deck.pop(), room.reveal.deck.pop()];
            if (!room.reveal.thiefId) {
              const candidates = room.players.filter(q => !q.role);
              room.reveal.thiefId = candidates[ctx.randInt(room, candidates.length)].id;
            }
          }
        }
        if (room.settings.thief && room.reveal.thiefId && !room.reveal.thiefPicked) {
          const thief = ctx.byId(room, room.reveal.thiefId);
          const card = (WOLF_ROLES.includes(room.center[0]) || WOLF_ROLES.includes(room.center[1]))
            ? room.center.find(k => WOLF_ROLES.includes(k))
            : room.center[0];
          thief.role = card;
          room.reveal.thiefPicked = true;
        }
        ctx.tryDeal(room); // ctx.tryDeal 内部已 ctx.bump
        return { ok: true };
      }
      room.players.forEach(q => { q.confirmed = true; });
      if (room._nightTimer) { clock.clearTimeout(room._nightTimer); room._nightTimer = null; }
      if (room._thiefTimer) { clock.clearTimeout(room._thiefTimer); room._thiefTimer = null; } // 清理盗贼选牌倒计时
      room.revealDeadline = null;
      ctx.bump(room);
      ctx.beginNight(room);
      return { ok: true };
    }
    case 'night': {
      if (room.nightStep === 'hunter') { ctx.resolveShot(room, null); return { ok: true }; } // 猎人弃枪
      const actors = ctx.nightActors(room, room.nightStep);
      actors.forEach(id => { ctx.markActed(room, room.nightStep, id); });
      ctx.bump(room);
      ctx.setNightStep(room);
      return { ok: true };
    }
    case 'morning': ctx.continueMorning(room); return { ok: true };
    case 'lastword':
      room.lastWorders.forEach(id => { if (!room.lastWordDone[id]) { ctx.byId(room, id).lastWordUsed = true; room.lastWordDone[id] = true; } });
      ctx.afterLastWord(room);
      return { ok: true };
    case 'handover':
      room.sheriff = null;
      room.handoverFrom = null;
      ctx.bump(room);
      ctx.startDaySteps(room);
      return { ok: true };
    case 'sheriff_campaign':
      room.players.filter(q => q.alive).forEach(q => { room.campaignDecided[q.id] = true; });
      ctx.beginSheriffVote(room);
      return { ok: true };
    case 'sheriff_vote':
      room.players.filter(q => q.alive).forEach(q => { if (!room.votes.hasOwnProperty(q.id)) room.votes[q.id] = null; });
      ctx.resolveSheriffVote(room);
      return { ok: true };
    case 'discuss': ctx.startVote(room); return { ok: true };
    case 'vote':
      room.players.filter(q => q.alive).forEach(q => { if (!room.votes.hasOwnProperty(q.id)) room.votes[q.id] = null; });
      ctx.resolveExileVote(room);
      return { ok: true };
    case 'pk_speech': ctx.beginPkVote(room); return { ok: true };
    case 'pk_vote':
      room.players.filter(q => q.alive).forEach(q => { if (!room.votes.hasOwnProperty(q.id)) room.votes[q.id] = null; });
      ctx.resolvePkVote(room);
      return { ok: true };
    case 'hunter_shot':
      room.shooter = null;
      ctx.resolveShot(room, null);
      return { ok: true };
    case 'ended': return { ok: true };
  }
  return { error: '当前阶段无需操作' };
}
function removePlayer(room, pid) {
  const p = ctx.byId(room, pid);
  if (!p) return;
  if (room.phase === 'lobby') {
    room.players = room.players.filter(q => q.id !== pid);
  } else if (room.phase === 'reveal' && room.reveal && !room.reveal.dealt) {
    // 身份发放前离开：直接移除（类似大厅）
    room.players = room.players.filter(q => q.id !== pid);
    // 离开的是盗贼 → 重新随机指定一名盗贼
    if (room.settings.thief && room.reveal.thiefId === pid) {
      room.reveal.thiefId = null;
      const candidates = room.players.filter(q => !q.role && !q.leftGame);
      if (candidates.length) room.reveal.thiefId = candidates[ctx.randInt(room, candidates.length)].id;
    }
    if (room.players.length === 0) { rooms.delete(room.id); return; }
    ctx.bump(room);
    return;
  } else {
    if (p.alive) {
      p.alive = false;
      p.deadBy = 'left';
      p.leftGame = true;
      if (room.sheriff === pid) room.sheriff = null;
      if (room.phase === 'vote' || room.phase === 'pk_vote' || room.phase === 'sheriff_vote') { if (!room.votes.hasOwnProperty(pid)) room.votes[pid] = null; }
      if (room.phase === 'night' && room.nightStep) { ctx.markActed(room, room.nightStep, pid); }
      if (room.phase === 'sheriff_campaign') room.campaignDecided[pid] = true;
      if (room.phase === 'lastword' && room.lastWorders.includes(pid)) { p.lastWordUsed = true; room.lastWordDone[pid] = true; }
      if (room.phase === 'handover' && room.handoverFrom === pid) { room.handoverFrom = null; room.sheriff = null; }
      if (room.phase === 'hunter_shot' && room.shooter === pid) { room.shooter = null; }
      ctx.checkWin(room);
    }
  }
  if (room.host === pid) {
    // 房主离开：新房主仅从真人中产生；无真人则解散房间
    const rest = room.players.filter(q => q.id !== pid && !q.leftGame && !q.isBot);
    if (rest.length) room.host = rest[0].id;
    else { rooms.delete(room.id); return; }
  }
  ctx.bump(room);
  if (room.phase === 'night' && room.nightStep && room.nightStep !== 'hunter') { if (ctx.nightActors(room, room.nightStep).length && ctx.nightActors(room, room.nightStep).every(id => (room.nightActed[room.nightStep] || {})[id])) ctx.setNightStep(room); }
  if (room.players.length === 0) { rooms.delete(room.id); return; }
  // 尝试自动推进
  ctx.autoAdvance(room);
}
function rematch(room) {
  ctx.clearPhaseTimer(room);
  if (room._nightTimer) { clock.clearTimeout(room._nightTimer); room._nightTimer = null; }
  ctx.clearNightTimer(room);
  if (room._thiefTimer) { clock.clearTimeout(room._thiefTimer); room._thiefTimer = null; }
  room.revealDeadline = null;
  clock.clearTimeout(room._hunterTimer); room._hunterTimer = null; room.hunterDeadline = null;
  // v1.5.6：先把上一局狼名单取出（endInfo 即将清空，跨局"恩怨"用局部变量保留）
  const grudgeWolfIds = (room.endInfo && room.endInfo.roles)
    ? room.endInfo.roles.filter(r => r && r.camp === '狼人').map(r => r.id) : [];
  room.phase = 'lobby';
  room.dayNum = 0; room.nightNum = 0; room.nightStep = null;
  room.winner = null; room.endInfo = null;
  room.center = null; room.lovers = null; room.sheriff = null;
  room.cupidCamp = null; // 丘比特阵营：开局 null（1.7.4 判定表）
  room.loversConfirm = false;
  room.seerHistory = []; room.guardLast = null;
  room.witchPots = { saveUsed: false, poisonUsed: false };
  room.charmTarget = null;
  room.night = null; room.nightActed = null;
  room.morningDeaths = []; room.dayDeaths = []; room.exileDeaths = [];
  room.votes = {}; room.lastVoteResult = null;
  room.pkTied = null; room.candidates = []; room.campaignDecided = {};
  room.lastWorders = []; room.lastWordDone = {}; room.lastWordContext = null;
  room.handoverFrom = null; room.shooter = null; room.shotContext = null;
  room.messages = [];
  room.actionLog = []; // 1.7.0（B1-8）：新局清空动作日志
  room.reveal = null;
  if (room._nightTimer) { clock.clearTimeout(room._nightTimer); room._nightTimer = null; }
  room.players.forEach(p => { p.role = null; p.alive = true; p.deadBy = null; p.deadNote = null; p.leftGame = false; p.confirmed = false; p.lastWordUsed = false; p.mood = null; if (p.isBot) resetBotPerGame(p); }); // v1.5.6：同 ctx.startGame（reset 保留 suspicion）
  room.wolfPackMemory = undefined; room.botTalked = undefined; // v1.5.6
  // v1.5.6：先 reset 再注入——上一局狼名单写成轻量"恩怨"（跨局印象，显式建模而非概率泄漏）
  if (grudgeWolfIds.length) for (const p of room.players) { if (p.isBot) injectGrudge(p, grudgeWolfIds); }
  ctx.bump(room);
}

/* 自动推进（动作完成后链式推进阶段） */

/* =========================================================================
 * 测试构造器（debug-only）：跳过建房/发牌，直接摆出指定阶段状态。
 * 仅供测试/实验室使用。opts.roles 用固定 id（'p1'..）便于断言。
 * 自动补齐：night 阶段会按 nightSteps 顺序把 nightStep 之前的步骤标记为已完成。
 * ========================================================================= */

register("addMessage", addMessage);
register("isLoverParty", isLoverParty);
register("chatAccess", chatAccess);
register("chatView", chatView);
register("chatAction", chatAction);
register("advance", advance);
register("removePlayer", removePlayer);
register("rematch", rematch);

module.exports = {};
