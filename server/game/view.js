// 自动生成（game.js 拆分——view 模块，勿手改，重新运行 tools/split-game.js）

const shared = require('./shared');
const ctx = shared.ctx;
const { register } = shared;
const { loverCore, clock, ROLE_INFO, rooms, PHASE_TIMEOUT, NIGHT_TIMEOUT, MOODS } = shared;

function viewFor(room, pid, chatSince) {
  const me = ctx.byId(room, pid);
  const view = {
    v: room.version,
    roomId: room.id,
    phase: room.phase,
    nightStep: room.nightStep,
    dayNum: room.dayNum,
    nightNum: room.nightNum,
    host: room.host,
    settings: room.settings,
    roleCounts: room.roleCounts,
    playerCap: room.playerCap,
    phaseTimeout: PHASE_TIMEOUT,
    nightDeadline: room.nightDeadline || null,
    revealDeadline: room.revealDeadline || null,
    nightTimeout: NIGHT_TIMEOUT,
    sheriff: room.sheriff,
    winner: room.winner,
    endInfo: room.endInfo,
    dealt: !!(room.reveal && room.reveal.dealt),
    players: room.players.map(q => ({
      id: q.id, name: q.name, seat: q.seat, alive: q.alive, deadBy: q.deadBy, deadNote: q.deadNote,
      role: (!q.alive || q.id === pid || room.phase === 'ended' || room.phase === 'lobby') ? ctx.roleText(room, q) : null,
      isBot: !!q.isBot, isMe: q.id === pid, sheriff: q.id === room.sheriff, confirmed: q.confirmed,
      mood: q.mood || null,
    })),
    my: { id: pid, name: me ? me.name : '', alive: me ? me.alive : false, isHost: room.host === pid, role: me ? ctx.roleText(room, me) : null, roleKey: me ? ctx.effRole(me) : null, camp: me ? ((me.role === 'thief') ? null : ctx.campText(room, me)) : null, // v1.7.6：丘比特可得知自己当前阵营（ctx.cupidCamp）
      mood: me ? (me.mood || null) : null }, // 安全加固：token 永不进视图（前端从 create/join 响应获取）
    music: room.music, // v1.7.25（房间全局播放）：低频状态随 view 同步（list/reviews/idx/playing/mode）——prog 由 state 轮询携带
    myChannels: me ? (['all'].filter(() => room.phase !== 'night').concat(ctx.isWolfRole(me) && room.phase === 'night' ? ['wolf'] : []).concat(ctx.isLoverParty(room, me.id) ? ['lover'] : [])) : ['all'],
    phaseTimed: !!room.phaseDeadline,
    phaseDeadline: room.phaseDeadline,
    hunterDeadline: room.hunterDeadline || null, // 猎人开枪 30 秒超时（夜晚/白天共用）
    moods: MOODS, // 表情白名单（服务端唯一来源，客户端据此循环展示 N6）
    // 情侣成员：被指认的瞬间醒来彼此确认身份，之后随时可见对方身份与丘比特
    myLover: (me && room.lovers && room.lovers.includes(me.id)) ? (() => {
      const partnerId = room.lovers.find(id => id !== me.id);
      const partner = ctx.byId(room, partnerId);
      const cupid = ctx.rolePlayer(room, 'cupid');
      return { id: partnerId, name: partner ? partner.name : '', role: partner ? ctx.roleText(room, partner) : '', cupidName: cupid ? cupid.name : '' };
    })() : null,
    // v1.7.6（丘比特规则补足）：丘比特知道情侣身份（两人）——白天也可查看
    myCouple: (me && (() => { const c = ctx.rolePlayer(room, 'cupid'); return c && c.id === me.id; })() && room.lovers) ? room.lovers.map(id => { const q = ctx.byId(room, id); return { id, name: q ? q.name : '', role: q ? ctx.roleText(room, q) : '' }; }) : null,
    // v2（M1）：恋人机制视图（解绑按钮点亮 / 权能展示；classic 返回 loverMode 标记）
    lover: loverCore.viewState(room, pid),
    // 预言家：查验记录任何阶段可见（白天也能翻看）
    seerHistory: (me && ctx.effRole(me) === 'seer') ? room.seerHistory.map(h => {
      const q = ctx.byId(room, h.target);
      return { name: q ? q.name : '', result: h.result, night: h.night };
    }) : null,
    chat: (chatSince > 0 ? room.messages.filter(m => m.ts > chatSince && ctx.chatView(room, me, m.ch)) : room.messages.filter(m => ctx.chatView(room, me, m.ch))),
    chatFull: !(chatSince > 0),
    lastVoteResult: room.lastVoteResult,
    morningDeaths: room.morningDeaths.map(id => { const q = ctx.byId(room, id); return q ? { id, name: q.name, role: ctx.roleText(room, q), deadBy: q.deadBy, deadNote: q.deadNote } : null; }).filter(Boolean),
    dayDeaths: room.dayDeaths.map(id => { const q = ctx.byId(room, id); return q ? { id, name: q.name, role: ctx.roleText(room, q), deadBy: q.deadBy, deadNote: q.deadNote } : null; }).filter(Boolean),
  };
  // ---- 身份展示阶段 ----
  if (room.phase === 'reveal') {
    const rv = room.reveal || { stage: 'hostChoice', hostPicked: false, thiefId: null, thiefPicked: false, dealt: false, deck: [] };
    view.reveal = {
      dealt: rv.dealt,
      canPick: room.host === pid && !rv.hostPicked && !rv.dealt,
      // 非房主不暴露“房主正在选职业”的阶段细节（stage/hostPicked 仅房主与已发牌时可见）
      stage: (room.host === pid || rv.dealt) ? rv.stage : null,
      hostPicked: room.host === pid ? rv.hostPicked : null,
      thiefPicked: (rv.stage === 'thiefPick' && rv.thiefId === pid) ? rv.thiefPicked : null,
      // 盗贼窃取：选牌阶段对所有人可见（不泄漏房主选择）；发牌后公开盗贼所得角色
      thiefPicking: room.settings.thief && rv.stage === 'thiefPick' && !rv.dealt,
      thiefTook: (room.settings.thief && rv.dealt && rv.thiefId && ctx.byId(room, rv.thiefId)) ? ctx.effRole(ctx.byId(room, rv.thiefId)) : null,
      available: (room.host === pid && !rv.hostPicked && !rv.dealt) ? Array.from(new Set(rv.deck)).map(k => ({ key: k, name: ROLE_INFO[k].name, desc: ROLE_INFO[k].desc })) : [],
      isThief: rv.stage === 'thiefPick' && rv.thiefId === pid,
      thiefCards: (rv.stage === 'thiefPick' && rv.thiefId === pid && room.center) ? room.center.map(k => ({ key: k, name: ROLE_INFO[k].name, desc: ROLE_INFO[k].desc })) : null,
      myRole: (rv.dealt || me.role) ? ctx.roleText(room, me) : null,
      myDesc: me && me.role ? ROLE_INFO[ctx.effRole(me)].desc : null,
      confirmed: room.players.filter(q => !q.leftGame).map(q => ({ id: q.id, name: q.name, ok: q.confirmed })),
    };
  }
  // ---- 夜晚 ----
  if (room.phase === 'night') {
    const actors = room.nightStep ? ctx.nightActors(room, room.nightStep) : [];
    const night = {
      step: room.nightStep,
      actors: actors.map(id => { const q = ctx.byId(room, id); return { id, name: q ? q.name : '', acted: !!(room.nightActed[room.nightStep] || {})[id] }; }),
    };
    if (me) {
      const n = room.night;
      if (room.nightStep === 'thief' && me.role === 'thief') night.thief = { cards: room.center.map(k => ({ key: k, name: ROLE_INFO[k].name })) };
      if (room.nightStep === 'cupid' && ctx.effRole(me) === 'cupid') night.cupid = { pick: n.cupid.pick };
      if (room.nightStep === 'lovers' && room.lovers && room.lovers.includes(me.id)) {
        // 情侣在被指认的瞬间醒来：彼此确认身份，并知道丘比特是谁
        const partnerId = room.lovers.find(id => id !== me.id);
        const partner = ctx.byId(room, partnerId);
        const cupid = ctx.rolePlayer(room, 'cupid');
        night.lovers = {
          partner: partnerId,
          partnerName: partner ? partner.name : '',
          partnerRole: partner ? ctx.roleText(room, partner) : '',
          cupidName: cupid ? cupid.name : '',
        };
      }
      if (ctx.isWolfRole(me)) {
        night.wolf = {
          kill: n.wolf.kill,
          charm: n.wolf.charm,
          teammates: room.players.filter(q => q.alive && ctx.isWolfRole(q)).map(q => ({ id: q.id, name: q.name, role: ctx.roleText(room, q) })),
          // 各狼选定受刀对象（undefined=未选，null=空刀）
          selections: room.players.filter(q => q.alive && ctx.isWolfRole(q)).map(q => ({
            id: q.id, name: q.name,
            kill: Object.prototype.hasOwnProperty.call(n.wolf.sel, q.id) ? n.wolf.sel[q.id] : undefined,
          })),
        };
      }
      if (ctx.effRole(me) === 'seer') night.seer = { history: room.seerHistory.map(h => { const q = ctx.byId(room, h.target); return { target: h.target, name: q ? q.name : '', result: h.result, night: h.night }; }) };
      if (ctx.effRole(me) === 'guard') night.guard = { last: room.guardLast, target: n.guard.target };
      if (ctx.effRole(me) === 'dreamer') night.dreamer = { target: n.dreamer.target };
      if (ctx.effRole(me) === 'witch') {
        const victimKnown = room.night.witch.revealed || room.phase !== 'night';
        night.witch = {
          victim: victimKnown ? (room.night.wolf.kill || null) : null,
          saveUsed: room.witchPots.saveUsed,
          poisonUsed: room.witchPots.poisonUsed,
        };
      }
      if (ctx.effRole(me) === 'cupid' && room.lovers) night.couple = room.lovers;
      if (room.lovers && room.lovers.includes(me.id)) night.myLover = room.lovers.find(id => id !== me.id);
    }
    if (room.nightStep === 'hunter') night.hunter = { shooter: room.shooter, shooterName: room.shooter ? (ctx.byId(room, room.shooter) || {}).name : '', context: room.shotContext };
    view.night = night;
  }
  // ---- 白天各阶段 ----
  if (room.phase === 'morning') {
    view.morning = { canContinue: room.host === pid };
  }
  if (room.phase === 'lastword') {
    view.lastword = {
      entitled: room.lastWorders.map(id => { const q = ctx.byId(room, id); return { id, name: q ? q.name : '', posted: !!room.lastWordDone[id], isMe: id === pid, me: q ? q.name : '' }; }),
      context: room.lastWordContext,
      canAdvance: room.host === pid,
    };
  }
  if (room.phase === 'handover') {
    view.handover = { from: room.handoverFrom, fromName: room.handoverFrom ? (ctx.byId(room, room.handoverFrom) || {}).name : '', canAdvance: room.host === pid };
  }
  if (room.phase === 'sheriff_campaign') {
    view.campaign = {
      candidates: room.candidates.map(id => { const q = ctx.byId(room, id); return { id, name: q ? q.name : '' }; }),
      myDecided: !!room.campaignDecided[pid],
      progress: room.players.filter(q => q.alive).filter(q => room.campaignDecided[q.id]).length,
      need: room.players.filter(q => q.alive).length,
      canAdvance: room.host === pid,
    };
  }
  if (room.phase === 'sheriff_vote') {
    view.sheriffVote = {
      candidates: room.candidates.map(id => { const q = ctx.byId(room, id); return { id, name: q ? q.name : '' }; }),
      myVote: room.votes[pid] || null,
      myVoted: room.votes.hasOwnProperty(pid),
      voted: room.players.filter(q => q.alive && room.votes.hasOwnProperty(q.id)).length,
      need: room.players.filter(q => q.alive).length,
      // 房主可见的“谁已投/投给谁”明细（v1.3.0）；非房主不下发，避免多余信息泄露
      votedBy: room.host === pid ? room.players.filter(q => q.alive && room.votes.hasOwnProperty(q.id)).map(q => ({ id: q.id, name: q.name, vote: room.votes[q.id] })) : undefined,
    };
  }
  if (room.phase === 'discuss') view.discuss = { canStartVote: room.host === pid };
  if (room.phase === 'vote' || room.phase === 'pk_vote') {
    view.vote = {
      myVote: room.votes[pid] || null,
      myVoted: room.votes.hasOwnProperty(pid),
      voted: room.players.filter(q => q.alive && room.votes.hasOwnProperty(q.id)).length,
      need: room.players.filter(q => q.alive).length,
      pkTied: room.phase === 'pk_vote' ? room.pkTied.map(id => { const q = ctx.byId(room, id); return { id, name: q ? q.name : '' }; }) : null,
      // 房主可见的“谁已投/投给谁”明细（v1.3.0）；非房主不下发
      votedBy: room.host === pid ? room.players.filter(q => q.alive && room.votes.hasOwnProperty(q.id)).map(q => ({ id: q.id, name: q.name, vote: room.votes[q.id] })) : undefined,
    };
  }
  if (room.phase === 'pk_speech') view.pkSpeech = { tied: room.pkTied.map(id => { const q = ctx.byId(room, id); return { id, name: q ? q.name : '' }; }), canStartVote: room.host === pid };
  if (room.phase === 'hunter_shot') view.hunterShot = { shooter: room.shooter, shooterName: room.shooter ? (ctx.byId(room, room.shooter) || {}).name : '', context: room.shotContext };
  if (room.phase === 'ended') view.canRematch = room.host === pid;
  return view;
}

/* v1.5.6：快照恢复——按房间当前状态重挂定时器并唤醒 bot 调度（超时重新计时，玩家恢复后不会被秒杀） */
const PHASE_TIMEOUT_FN = {
  morning: ctx.continueMorning,
  sheriff_campaign: ctx.beginSheriffVote,
  discuss: ctx.startVote,
  handover: ctx.handoverTimeout,
  lastword: ctx.lastwordTimeout,
  vote: ctx.resolveExileVote,
  pk_speech: ctx.beginPkVote,
  sheriff_vote: ctx.resolveSheriffVote,
  pk_vote: ctx.resolvePkVote,
};
function resumeRoom(room) {
  if (!room || !rooms.has(room.id)) return;
  room._phaseTimer = null; room._nightTimer = null; room._nightStepTimer = null;
  room._thiefTimer = null; room._hunterTimer = null; room._botTimer = null;
  room.phaseDeadline = null; room.nightDeadline = null; room.revealDeadline = null; room.hunterDeadline = null;
  room.lastActive = clock.now(); // 防 TTL 秒杀
  const now = clock.now();
  const remain = (d) => (d ? Math.max(0, d - now) : undefined); // C1：按剩余时间重挂（已过期 → 0 → 立即触发）
  if (room.phase === 'reveal' && room.reveal) {
    if (room.reveal.stage === 'thiefPick' && !room.reveal.thiefPicked && !room.reveal.dealt) {
      const t = remain(room.revealDeadline) === undefined ? NIGHT_TIMEOUT * 1000 : remain(room.revealDeadline);
      room.revealDeadline = now + t;
      room._thiefTimer = clock.setTimeout(() => ctx.autoThiefPick(room), t); // v1.5.7：补闭包传参
    } else if (room.reveal.dealt) {
      room._nightTimer = clock.setTimeout(() => ctx.autoBeginNight(room), 5000); // v1.5.7：补闭包传参
    }
  } else if (room.phase === 'night') {
    ctx.scheduleNightStepTimer(room, remain(room.nightDeadline));
    ctx.scheduleHunterShotTimer(room, remain(room.hunterDeadline));
  } else if (room.phase === 'hunter_shot') {
    ctx.scheduleHunterShotTimer(room, remain(room.hunterDeadline)); // v1.5.7：P1 白天被放逐的猎人弃枪定时器（此前漏挂会永久卡死）
  } else if (room.phase !== 'lobby' && room.phase !== 'ended') {
    const fn = PHASE_TIMEOUT_FN[room.phase];
    if (fn) ctx.schedulePhase(room, room.phase, fn, remain(room.phaseDeadline));
  }
  ctx.maybeRunBots(room); // 唤醒 bot 调度
}


register("viewFor", viewFor);
register("resumeRoom", resumeRoom);

module.exports = {};
