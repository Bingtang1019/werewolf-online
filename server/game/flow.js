// 自动生成（game.js 拆分——flow 模块，勿手改，重新运行 tools/split-game.js）

const shared = require('./shared');
const ctx = shared.ctx;
const { register } = shared;
const { loverCore, clock, WOLF_ROLES, rooms, NIGHT_TIMEOUT, resetBotPerGame } = shared;


function startGame(room) {
  const err = ctx.validateConfig(room);
  if (err) return { error: err };
  ctx.clearPhaseTimer(room);
  // 清空上一局状态
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
  room.players.forEach(p => { p.role = null; p.alive = true; p.deadBy = null; p.deadNote = null; p.leftGame = false; p.confirmed = false; p.lastWordUsed = false; if (p.isBot || p.hostAutoplay) resetBotPerGame(p); }); // v1.5.6：新局重置 bot/托管房主本局事实记忆（保留 suspicion）
  room.wolfPackMemory = undefined; room.botTalked = undefined; // v1.5.6：跨局共享战术/发言标记重置
  // 身份牌堆（盗贼玩法开启时总数 = 玩家人数 + 1）；center 两张在房主确定身份后再抽取
  const deck = ctx.shuffle(room, ctx.expandCounts(room.roleCounts));
  room.center = null;
  room.reveal = { stage: 'hostChoice', hostPicked: false, thiefId: null, thiefPicked: false, dealt: false, deck };
  room.phase = 'reveal';
  if (room._nightTimer) { clock.clearTimeout(room._nightTimer); room._nightTimer = null; }
  ctx.bump(room);
  return { ok: true };
}

/* ---------------------------- 身份展示阶段 ---------------------------- */
function revealAction(room, p, action, data) {
  const rv = room.reveal;
  // 房主选择期望身份（或选择随机分配）→ 之后随机指定盗贼（若开启）
  if (action === 'hostPick') {
    if (p.id !== room.host) return { error: '只有房主可以选择职业' };
    if (rv.dealt) return { error: '职业已发放' };
    if (rv.hostPicked) return { error: '你已完成选择' };
    const want = data.role || null;
    if (want && want !== 'random') {
      const i = rv.deck.indexOf(want);
      if (i < 0) return { error: '该职业不在本局牌堆中' };
      rv.deck.splice(i, 1);
      p.role = want;
    }
    rv.hostPicked = true;
    // 盗贼玩法：房主身份确定后，从剩余身份牌中随机抽两张展示给盗贼，并随机指定一名玩家为盗贼
    // （房主若已取牌则不可能成为盗贼；未取牌则可能被指定为盗贼）
    if (room.settings.thief) {
      if (!room.center) room.center = [rv.deck.pop(), rv.deck.pop()];
      if (!rv.thiefId) {
        const candidates = room.players.filter(q => !q.role);
        rv.thiefId = candidates[ctx.randInt(room, candidates.length)].id;
      }
      // 盗贼选牌 30 秒倒计时：超时自动选牌（有狼必选狼，否则随机）
      // v1.6.2：hostPick 受 hostPicked 守卫仅执行一次，此处 thiefPicked 恒为 false，去除恒真分支并修正缩进
      rv.stage = 'thiefPick';
      if (room._thiefTimer) clock.clearTimeout(room._thiefTimer);
      room.revealDeadline = clock.now() + NIGHT_TIMEOUT * 1000;
      room._thiefTimer = clock.setTimeout(() => ctx.autoThiefPick(room), NIGHT_TIMEOUT * 1000); // 有狼必选狼
      ctx.bump(room);
      return { ok: true };
    }
    tryDeal(room); // tryDeal 内部已 ctx.bump
    return { ok: true };
  }
  // 盗贼从两张身份牌中选择一张（若其中有狼人牌则必须选狼人）
  if (action === 'thief_pick') {
    if (rv.stage !== 'thiefPick' || p.id !== rv.thiefId) return { error: '操作不合法' };
    if (room._thiefTimer) { clock.clearTimeout(room._thiefTimer); room._thiefTimer = null; }
    room.revealDeadline = null;
    const idx = data.idx;
    if (idx !== 0 && idx !== 1) return { error: '参数错误' };
    const card = room.center[idx];
    if ((WOLF_ROLES.includes(room.center[0]) || WOLF_ROLES.includes(room.center[1])) && !WOLF_ROLES.includes(card)) {
      return { error: '两张牌中有狼人牌，盗贼必须选择狼人' };
    }
    p.role = card; // 选定后即丧失盗贼身份
    rv.thiefPicked = true;
    tryDeal(room); // tryDeal 内部已 ctx.bump
    return { ok: true };
  }
  // 确认身份（全员确认可提前开始；盗贼局强制等待 5 秒展示盗贼结果，否则发牌后等待 5 秒自动开始）
  if (action === 'confirm') {
    if (!rv.dealt) return { error: '身份还未发放' };
    p.confirmed = true;
    ctx.bump(room);
    if (room.players.every(q => q.confirmed || q.leftGame) && !room.reveal.thiefPicked) {
      if (room._nightTimer) { clock.clearTimeout(room._nightTimer); room._nightTimer = null; }
      beginNight(room);
    }
    return { ok: true };
  }
  return { error: '未知操作' };
}

/* 发牌：房主已处理且盗贼（若有）已选择后，将剩余身份牌随机分配给其他玩家，
 * 发放完毕后等待 5 秒自动进入夜晚（全员确认可提前） */
function tryDeal(room) {
  const rv = room.reveal;
  // 盗贼选牌倒计时已结束/已选牌 → 清理定时器与倒计时展示
  if (room._thiefTimer) { clock.clearTimeout(room._thiefTimer); room._thiefTimer = null; }
  room.revealDeadline = null;
  if (rv.dealt) return;
  if (!rv.hostPicked) return; // 等房主确定期望身份
  if (room.settings.thief && (!rv.thiefId || !rv.thiefPicked)) return; // 等盗贼选择
  // 房主未取牌（未选择具体职业）→ 从剩余牌中随机分配
  const host = ctx.byId(room, room.host);
  if (!host.role) { if (rv.deck.length) host.role = rv.deck.pop(); }
  host.confirmed = true; // 房主确定身份即视为已确认
  // 其余未分配玩家随机取牌
  for (const q of room.players) {
    if (!q.role && !q.leftGame) { if (rv.deck.length) q.role = rv.deck.pop(); }
  }
  rv.dealt = true;
  rv.stage = 'dealt';
  if (room._nightTimer) clock.clearTimeout(room._nightTimer);
  room._nightTimer = clock.setTimeout(() => ctx.autoBeginNight(room), 5000); // 5 秒后自动进入夜晚
  ctx.bump(room);
}

/* ---------------------------- 夜晚 ---------------------------- */
function beginNight(room) {
  if (ctx.checkGameEnd(room)) return; // v1.6.4（A2-1）：阶段推进入口兜底——防“结算后无人可行动”挂起
  // v4.2：发言量信息特征——speech 摘要事件（每天结算一次，粗粒度，不撑 200 条事件缓冲）
  if (room.speechToday && Object.keys(room.speechToday).length) {
    ctx.pushEvent(room, 'speech', { day: room.dayNum, counts: Object.assign({}, room.speechToday) });
    room.speechToday = {};
  }
  ctx.pushEvent(room, 'night_start', { night: room.nightNum + 1 }); // v1.6.0
  ctx.clearPhaseTimer(room); // 白天阶段倒计时清掉（夜晚步骤有自己的 30 秒倒计时）
  if (room._thiefTimer) { clock.clearTimeout(room._thiefTimer); room._thiefTimer = null; }
  room.revealDeadline = null;
  clearNightTimer(room);
  clock.clearTimeout(room._hunterTimer); room._hunterTimer = null; room.hunterDeadline = null;
  room.nightNum++;
  room.phase = 'night';
  room.nightStep = null;
  room.nightActed = {};
  room.loversConfirm = false;
  room.night = {
    wolf: { kill: null, charm: null, locked: false, sel: {} },
    guard: { target: null },
    dreamer: { target: null },
    seer: { target: null },
    witch: { save: false, poison: null, revealed: false },
    cupid: { pick: null },
  };
  room.shooter = null; room.shotContext = null;
  setNightStep(room);
  ctx.maybeRunBots(room); // 夜晚开始/换步：安排人机行动
  ctx.bump(room);
}
/* 夜晚行动顺序：
 * 首夜：丘比特(指定情侣) → 情侣确认 → 守卫 → 摄梦人 → 狼人 → 预言家 → 女巫
 * 盗贼已在身份展示阶段选牌（若开启盗贼玩法），不再于夜晚睁眼。
 * 后续夜：若情侣全灭且丘比特存活，则丘比特可重新指定情侣（可放弃）；新情侣需互相确认 */
function nightSteps(room) {
  const steps = [];
  const cupid = ctx.rolePlayer(room, 'cupid');
  const loversDead = room.lovers && room.lovers.length === 2 && room.lovers.every(id => { const q = ctx.byId(room, id); return !q || !q.alive; });
  const needCupid = !!(cupid && cupid.alive && (room.nightNum === 1 || loversDead));
  if (needCupid) {
    steps.push('cupid');
    room.loversConfirm = true; // 本晚情侣需确认（首夜或重选后）
  }
  if (room.loversConfirm) steps.push('lovers');
  steps.push('guard', 'dreamer', 'wolf', 'seer', 'witch');
  return steps;
}
function nightActors(room, step) {
  const alive = p => p.alive;
  const allWithRole = key => room.players.filter(p => alive(p) && p.role === key).map(p => p.id);
  switch (step) {
    case 'cupid': return allWithRole('cupid');
    case 'lovers': return room.lovers ? room.lovers.filter(id => { const q = ctx.byId(room, id); return q && q.alive; }) : [];
    case 'guard': return allWithRole('guard');
    case 'dreamer': return allWithRole('dreamer');
    case 'wolf': return room.players.filter(p => alive(p) && ctx.isWolfRole(p)).map(p => p.id);
    case 'seer': return allWithRole('seer');
    case 'witch': {
      const witches = allWithRole('witch');
      if (!witches.length) return [];
      if (room.witchPots.saveUsed && room.witchPots.poisonUsed) return [];
      return witches;
    }
    default: return [];
  }
}
function stepDone(room, step) {
  const actors = nightActors(room, step);
  if (!actors.length) return true;
  const acted = room.nightActed[step] || {};
  return actors.every(id => acted[id] === true);
}
function markActed(room, step, pid) {
  room.nightActed[step] = room.nightActed[step] || {};
  room.nightActed[step][pid] = true;
}
function setNightStep(room) {
  clearNightTimer(room); // 旧步骤的 30 秒倒计时作废，重新按新步骤安排
  const steps = nightSteps(room);
  for (const s of steps) {
    if (s === 'lovers' && stepDone(room, s)) room.loversConfirm = false; // 情侣确认完毕
    if (!stepDone(room, s)) {
      room.nightStep = s;
      ctx.pushEvent(room, 'night_step', { step: s }); // v1.6.0
      if (s === 'witch') room.night.witch.revealed = true;
      scheduleNightStepTimer(room); // 本步骤 30 秒倒计时：超时全员视为跳过
      ctx.bump(room);
      return;
    }
  }
  room.nightStep = null;
  // 狼步完成（含房主 advance 跳过）→ 统一锁定本晚魅惑目标
  if (room.night && stepDone(room, 'wolf')) room.charmTarget = room.night.wolf.charm;
  resolveNight(room);
}
/* 夜晚步骤 30 秒倒计时：超时未完成则跳过本步骤（与房主强制继续同语义） */
function clearNightTimer(room) {
  if (room._nightStepTimer) { clock.clearTimeout(room._nightStepTimer); room._nightStepTimer = null; }
  room.nightDeadline = null;
}
/*猎人开枪 30 秒超时弃枪（夜晚被刀 / 白天被放逐两条路径共用；N1 修复） */
function scheduleHunterShotTimer(room, delayMs) {
  clock.clearTimeout(room._hunterTimer);
  room.hunterDeadline = null;
  const active = (room.phase === 'night' && room.nightStep === 'hunter') || room.phase === 'hunter_shot';
  if (!active || !room.shooter) return;
  const t = Math.max(0, delayMs === undefined ? NIGHT_TIMEOUT * 1000 : delayMs); // v1.5.6：C1
  room.hunterDeadline = clock.now() + t;
  const shooter = room.shooter;
  room._hunterTimer = clock.setTimeout(() => {
    room._hunterTimer = null;
    room.hunterDeadline = null;
    if (!rooms.has(room.id)) return;
    const ok = (room.phase === 'night' && room.nightStep === 'hunter') || room.phase === 'hunter_shot';
    if (!ok || room.shooter !== shooter) return; // 已开枪/已处理
    resolveShot(room, null); // 超时弃枪
    ctx.autoAdvance(room);
  }, t);
}

function scheduleNightStepTimer(room, delayMs) {
  clearNightTimer(room);
  if (room.phase !== 'night' || !room.nightStep) return;
  const actors = nightActors(room, room.nightStep);
  if (!actors.length) return;
  const t = Math.max(0, delayMs === undefined ? NIGHT_TIMEOUT * 1000 : delayMs); // v1.5.6：C1
  room.nightDeadline = clock.now() + t;
  const step = room.nightStep;
  room._nightStepTimer = clock.setTimeout(() => {
    room._nightStepTimer = null;
    room.nightDeadline = null;
    if (!rooms.has(room.id) || room.phase !== 'night' || room.nightStep !== step) return; // 已推进/已结束
    const as = nightActors(room, step);
    as.forEach(id => markActed(room, step, id)); // 未操作者视为弃权
    setNightStep(room);
    ctx.autoAdvance(room);
  }, t);
}

function nightAction(room, p, action, data) {
  const step = room.nightStep;
  const actors = step === 'hunter' ? (room.shooter ? [room.shooter] : []) : nightActors(room, step);
  if (!actors.includes(p.id)) return { error: '现在不需要你操作' };
  if ((room.nightActed[step] || {})[p.id]) return { error: '你已完成本阶段操作' };
  const n = room.night;
  switch (action) {
    case 'cupid_pick': {
      if (step !== 'cupid' || p.role !== 'cupid') return { error: '操作不合法' };
      if (room.loverMode === 'off') return { error: '本局已关闭恋人机制' }; // v2（M1）：off 三态
      const ids = data.ids;
      // 情侣殉情后丘比特可重新指定情侣，也可放弃重选（首夜必须指定）
      if (ids === null || ids === undefined) {
        if (room.nightNum === 1) return { error: '第一晚必须指定情侣' };
        room.lovers = null;
        n.cupid.pick = null;
        markActed(room, step, p.id);
        setNightStep(room);
        return { ok: true };
      }
      if (!Array.isArray(ids) || ids.length !== 2 || ids[0] === ids[1]) return { error: '请选择两名不同的玩家' };
      for (const id of ids) { const q = ctx.byId(room, id); if (!q || !q.alive) return { error: '玩家不存在或已出局' }; }
      if (room.loverMode === 'v2') {
        const rp = loverCore.grantPower(room, data.power); // v2：权能槽二选一（守护/复仇），真人/bot 必选
        if (!rp.ok) return { error: rp.msg };
      }
      room.lovers = [ids[0], ids[1]].sort();
      n.cupid.pick = [ids[0], ids[1]];
      room.cupidCamp = ctx.computeCupidCamp(room); // 按新情侣整体阵营更新丘比特阵营
      markActed(room, step, p.id);
      setNightStep(room);
      return { ok: true };
    }
    case 'lovers_ok': {
      if (step !== 'lovers' || !room.lovers.includes(p.id)) return { error: '操作不合法' };
      markActed(room, step, p.id);
      setNightStep(room);
      return { ok: true };
    }
    case 'guard_pick': {
      if (step !== 'guard' || p.role !== 'guard') return { error: '操作不合法' };
      const t = ctx.byId(room, data.target);
      if (!t || !t.alive) return { error: '玩家不存在或已出局' };
      if (t.id === room.guardLast) return { error: '不能连续两晚守护同一名玩家' };
      n.guard.target = t.id;
      room.guardLast = t.id;
      markActed(room, step, p.id);
      setNightStep(room);
      return { ok: true };
    }
    case 'dreamer_pick': {
      if (step !== 'dreamer' || p.role !== 'dreamer') return { error: '操作不合法' };
      const t = ctx.byId(room, data.target);
      if (!t || !t.alive) return { error: '玩家不存在或已出局' };
      if (t.id === p.id) return { error: '不能梦自己' };
      n.dreamer.target = t.id;
      markActed(room, step, p.id);
      setNightStep(room);
      return { ok: true };
    }
    case 'wolf_set': {
      if (step !== 'wolf' || !ctx.isWolfRole(p)) return { error: '操作不合法' };
      // v1.6.2：用 !== undefined 替代 hasOwnProperty——直接传 undefined（如测试 harness）不再误入校验分支报“玩家不存在”
      if (data.kill !== undefined) {
        if (data.kill === null || data.kill === '') { n.wolf.kill = null; n.wolf.sel[p.id] = null; }
        else { const t = ctx.byId(room, data.kill); if (!t || !t.alive) return { error: '玩家不存在或已出局' }; n.wolf.kill = t.id; n.wolf.sel[p.id] = t.id; }
      }
      if (data.charm !== undefined) {
        const beauty = room.players.find(q => q.alive && ctx.effRole(q) === 'wolfBeauty');
        if (data.charm === null || data.charm === '') { if (beauty) n.wolf.charm = null; }
        else { const t = ctx.byId(room, data.charm); if (!t || !t.alive) return { error: '玩家不存在或已出局' }; if (t.id === p.id) return { error: '不能魅惑自己' }; if (!beauty) return { error: '本局没有狼美人' }; n.wolf.charm = t.id; }
      }
      if (data.confirm) {
        markActed(room, 'wolf', p.id);
      }
      ctx.bump(room);
      if (nightActors(room, 'wolf').every(id => (room.nightActed['wolf'] || {})[id])) {
        setNightStep(room); // 魅惑目标由 setNightStep 统一锁定
      }
      return { ok: true };
    }
    case 'seer_pick': {
      if (step !== 'seer' || p.role !== 'seer') return { error: '操作不合法' };
      const t = ctx.byId(room, data.target);
      if (!t || !t.alive) return { error: '玩家不存在或已出局' };
      if (t.id === p.id) return { error: '不能查验自己' };
      const result = ctx.checkCamp(room, t); // 1.7.4：查验按阵营口径（第三方→好）
      n.seer.target = t.id;
      room.seerHistory.push({ target: t.id, result, night: room.nightNum });
      markActed(room, step, p.id);
      setNightStep(room);
      return { ok: true };
    }
    case 'witch_act': {
      if (step !== 'witch' || p.role !== 'witch') return { error: '操作不合法' };
      const w = n.witch;
      const save = !!data.save;
      const poison = data.poison === null || data.poison === undefined ? null : data.poison;
      if (save && poison) return { error: '每晚最多使用一瓶药' };
      if (save) {
        if (room.witchPots.saveUsed) return { error: '解药已使用' };
        if (!room.night.wolf.kill) return { error: '今晚无人被狼人袭击，无法使用解药' };
        w.save = true;
        room.witchPots.saveUsed = true;
      }
      if (poison) {
        if (room.witchPots.poisonUsed) return { error: '毒药已使用' };
        const t = ctx.byId(room, poison);
        if (!t || !t.alive) return { error: '玩家不存在或已出局' };
        if (t.id === p.id) return { error: '不能毒自己' };
        w.poison = t.id;
        room.witchPots.poisonUsed = true;
      }
      markActed(room, step, p.id);
      setNightStep(room);
      return { ok: true };
    }
    case 'hunter_shoot': {
      if (step !== 'hunter' || room.shooter !== p.id) return { error: '操作不合法' };
      const target = data.target || null;
      if (target) {
        const t = ctx.byId(room, target);
        if (!t || !t.alive) return { error: '玩家不存在或已出局' };
        if (t.id === p.id) return { error: '不能枪杀自己' };
      }
      markActed(room, step, p.id);
      resolveShot(room, target);
      return { ok: true };
    }
  }
  return { error: '未知操作' };
}

/* 夜晚结算 */
function resolveNight(room) {
  const deaths = [];
  const die = (pid, by) => {
    const q = ctx.byId(room, pid);
    if (q && q.alive && !deaths.includes(pid)) { if (room.loverTest && room.loverTest.includes('immortal') && q.role === 'cupid') return; q.alive = false; q.deadBy = by; deaths.push(pid); }
  };
  const n = room.night;
  const guardT = n.guard.target;
  const dreamT = n.dreamer.target;
  const kill = n.wolf.kill;
  const wSave = n.witch.save;
  const wPoison = n.witch.poison;
  const dreamer = ctx.rolePlayer(room, 'dreamer');
  if (kill) {
    const guarded = kill === guardT, dreamed = kill === dreamT, saved = wSave;
    const loverGuard = loverCore.applyGuard(room, kill); // v2 守护：恋人被狼刀 → 挡刀（狼队收到“刀被挡”，暴露恋人位置）
    if (loverGuard) {
      ctx.pushEvent(room, 'lover_guard', { target: kill, name: ctx.byId(room, kill) ? ctx.byId(room, kill).name : '' });
      ctx.sysMsg(room, 'wolf', '刀被挡了——你的目标被恋人守护');
      ctx.sysMsg(room, 'all', '昨夜有人挡下了狼刀');
    } else if (!dreamed) {
      if (guarded && saved) { const q = ctx.byId(room, kill); q.deadNote = '同守同救（狼刀+守护+解药）'; die(kill, 'wolf'); }
      else if (!guarded && !saved) { die(kill, 'wolf'); }
    }
  }
  if (wPoison && wPoison !== dreamT) die(wPoison, 'poison');
  if (dreamT && dreamer && !dreamer.alive && dreamer.deadBy !== 'left') die(dreamT, 'dream'); // 摄梦人离开≠死亡，不带走梦游者
  const betray = deaths.includes(kill) && loverCore.betrayalKill(room, kill); // v2 恋人刀：狼恋人投刀自己的恋人且致死 → 不殉情 + 狼队公告身份（被挡/未死不触发）
  if (betray) {
    ctx.pushEvent(room, 'lover_betray', betray);
    ctx.sysMsg(room, 'wolf', betray.wolfLoverName + ' 刀了恋人 ' + (ctx.byId(room, betray.killId) ? ctx.byId(room, betray.killId).name : '') + '（背叛，不殉情）');
    ctx.sysMsg(room, 'all', '狼队发生了背叛：' + betray.wolfLoverName + ' 刀了自己的恋人');
  }
  applyLoverChain(room, deaths, die, betray);
  room.nightDeaths = deaths;
  if (room.loverTest && room.loverTest.includes('dead-n1') && room.nightNum === 1) { const cp = ctx.rolePlayer(room, 'cupid'); if (cp && cp.alive) { die(cp.id, 'lover_test'); room.nightDeaths = deaths; } } // A/B 注入（M3.5）：首夜丘比特必死 → 解绑全程解锁
  loverCore.trackCupidDeath(room, deaths); // v2 时序记录（丘比特死亡轮次，M3 敏感性分析）
  // v1.6.2：wolf_kill/deaths 事件提前到猎人判断之前推送（猎人开枪分支提前 return 曾导致这两条事件丢失）
  if (room.night && room.night.wolf && room.night.wolf.kill) ctx.pushEvent(room, 'wolf_kill', { kill: room.night.wolf.kill, saved: !deaths.includes(room.night.wolf.kill) });
  ctx.pushEvent(room, 'deaths', { deaths: deaths.map(id => { const q = ctx.byId(room, id); return { id, name: q ? q.name : '', by: q ? q.deadBy : '', role: q ? q.role : '' }; }) });
  // 猎人被狼刀杀死 → 先结算猎人开枪，再判胜负（否则最后的神职猎人被刀会直接判狼胜而无法开枪；枪杀可能改变战局）
  const hunter = deaths.find(id => { const q = ctx.byId(room, id); return ctx.effRole(q) === 'hunter' && q.deadBy === 'wolf'; });
  if (hunter) {
    room.nightStep = 'hunter';
    room.shooter = hunter;
    room.shotContext = 'night';
    scheduleHunterShotTimer(room); // 猎人 30 秒未开枪 → 弃枪
    ctx.bump(room);
    ctx.maybeRunBots(room); // 被刀猎人若是人机 →自动决定是否开枪
    return;
  }
  if (ctx.checkWin(room)) { ctx.bump(room); return; }
  finishNight(room);
}
function finishNight(room) {
  room.nightStep = null;
  if (ctx.checkWin(room)) { ctx.bump(room); return; }
  beginMorning(room);
}
function resolveShot(room, target) {
  ctx.pushEvent(room, 'shot', { shooter: room.shooter, target: target || null }); // v1.6.0
  clock.clearTimeout(room._hunterTimer); room._hunterTimer = null; room.hunterDeadline = null;
  const deaths = [];
  const die = (pid, by) => {
    const q = ctx.byId(room, pid);
    if (q && q.alive && !deaths.includes(pid)) { if (room.loverTest && room.loverTest.includes('immortal') && q.role === 'cupid') return; q.alive = false; q.deadBy = by; deaths.push(pid); }
  };
  if (target) {
    die(target, 'shoot');
    applyLoverChain(room, deaths, die);
    loverCore.trackCupidDeath(room, deaths); // v2 时序记录（丘比特被枪杀）
    // 狼美人被猎人枪杀不能带走被魅惑者（仅被放逐时才触发魅惑）
  }
  // v1.6.2：枪杀/殉情死亡批次入事件流（night 分支与此前 deaths 事件分两批；day 分支与放逐批次分离）
  if (deaths.length) ctx.pushEvent(room, 'deaths', { deaths: deaths.map(id => { const q = ctx.byId(room, id); return { id, name: q ? q.name : '', by: q ? q.deadBy : '', role: q ? q.role : '' }; }) });
  room.shooter = null;
  if (room.shotContext === 'night') {
    room.nightDeaths = (room.nightDeaths || []).concat(deaths);
    if (ctx.checkWin(room)) { ctx.bump(room); return; }
    finishNight(room);
  } else {
    room.dayDeaths = (room.dayDeaths || []).concat(deaths);
    if (ctx.checkWin(room)) { ctx.bump(room); return; }
    beginNight(room);
  }
}
function applyLoverChain(room, deaths, die, betray) {
  if (!room.lovers || !room.lovers[0]) return;
  const [a, b] = room.lovers;
  const initial = deaths.slice(); // 初始死亡快照（被刀/被票/被枪杀）；殉情追加的死亡不再二次触发宣言/链
  if (initial.includes(a)) {
    if (betray && a === betray.killId && b === betray.wolfLoverId) return; // v2 恋人刀：不殉情（背叛方存活）
    const decl = loverCore.vengeanceDeclare(room, b); // v2 复仇：殉情方临死真相宣言
    if (decl) {
      ctx.pushEvent(room, 'lover_reveal', decl);
      ctx.sysMsg(room, 'all', decl.declarerName + '（恋人）临死宣言：我的恋人是 ' + decl.partnerName + '');
    }
    die(b, 'lover');
  }
  if (initial.includes(b)) {
    if (betray && b === betray.killId && a === betray.wolfLoverId) return;
    const decl = loverCore.vengeanceDeclare(room, a);
    if (decl) {
      ctx.pushEvent(room, 'lover_reveal', decl);
      ctx.sysMsg(room, 'all', decl.declarerName + '（恋人）临死宣言：我的恋人是 ' + decl.partnerName + '');
    }
    die(a, 'lover');
  }
}
/* ---------------------------- 早晨 / 白天 ---------------------------- */
function beginMorning(room) {
  room.dayNum++;
  room.dayDeaths = []; // 前一天的放逐公告在次日天亮时清空（过夜期间保留供回看，N3）
  room.phase = 'morning';
  room.morningDeaths = room.nightDeaths || [];
  room.nightDeaths = null;
  if (ctx.checkWin(room)) { ctx.bump(room); return; }
  ctx.bump(room);
  // 停留在此，由房主点击“继续”或30秒超时后进入遗言/警徽/白天流程（continueMorning）
  ctx.schedulePhase(room, 'morning', () => continueMorning(room));
}
function continueMorning(room) {
  if (ctx.checkGameEnd(room)) return; // v1.6.4（A2-1）
  // 夜晚死亡：仅第一晚有遗言
  if (room.nightNum === 1 && room.morningDeaths.length) {
    const entitled = room.morningDeaths.filter(id => !ctx.byId(room, id).lastWordUsed);
    if (entitled.length) { startLastWord(room, entitled, 'night'); return; }
  }
  // 警徽移交：只要不是被魅惑带走、被摄梦人带走、被毒杀，其余死因（狼刀/枪杀/放逐/殉情等）均可移交
  const sheriff = room.sheriff;
  if (sheriff) {
    const sq = ctx.byId(room, sheriff);
    if (sq && !sq.alive && sq.deadBy !== 'charm' && sq.deadBy !== 'dream' && sq.deadBy !== 'poison') { startHandover(room); return; }
  }
  startDaySteps(room);
}
function startDaySteps(room) {
  if (ctx.checkGameEnd(room)) return; // v1.6.4（A2-1）
  if (room.dayNum === 1 && room.settings.sheriff && !room.sheriff) {
    room.phase = 'sheriff_campaign';
    room.candidates = [];
    room.campaignDecided = {};
    ctx.bump(room);
    ctx.schedulePhase(room, 'sheriff_campaign', () => ctx.beginSheriffVote(room)); // 超时未表态视为弃权
    return;
  }
  startDiscuss(room);
}
function startDiscuss(room) {
  if (ctx.checkGameEnd(room)) return; // v1.6.4（A2-1）
  room.phase = 'discuss';
  ctx.bump(room);
  ctx.schedulePhase(room, 'discuss', () => ctx.startVote(room)); // 超时自动进入投票
}
function startHandover(room) {
  if (ctx.checkGameEnd(room)) return; // v1.6.4（A2-1）
  room.phase = 'handover';
  room.handoverFrom = room.sheriff;
  ctx.bump(room);
  ctx.schedulePhase(room, 'handover', ctx.handoverTimeout); // 超时默认撕毁警徽
}
function startLastWord(room, ids, context) {
  // v1.6.4（A2-1）：防“结算后无人可行动”挂起——但放逐链中（exileDeaths 非空）不提前判胜负：
  // 放逐后的魅惑/殉情链尚未结算（afterExile 才是递归出口），此刻检查会“早判”（人狼恋狼恋人属第三方被排除 → 误判好人胜）
  if (!(room.exileDeaths && room.exileDeaths.length) && ctx.checkGameEnd(room)) return;
  room.phase = 'lastword';
  room.lastWorders = ids;
  room.lastWordContext = context;
  room.lastWordDone = {};
  ids.forEach(id => { if (ctx.byId(room, id).lastWordUsed) room.lastWordDone[id] = true; });
  ctx.bump(room);
  ctx.schedulePhase(room, 'lastword', ctx.lastwordTimeout); // 超时视为跳过遗言
}
function afterLastWord(room) {
  room.lastWorders = [];
  if (room.lastWordContext === 'exile') {
    room.lastWordContext = null;
    ctx.afterExile(room);
  } else {
    room.lastWordContext = null;
    continueMorning(room);
  }
}

/* 白天投票 */

register("startGame", startGame);
register("revealAction", revealAction);
register("tryDeal", tryDeal);
register("beginNight", beginNight);
register("nightSteps", nightSteps);
register("nightActors", nightActors);
register("stepDone", stepDone);
register("markActed", markActed);
register("setNightStep", setNightStep);
register("clearNightTimer", clearNightTimer);
register("scheduleHunterShotTimer", scheduleHunterShotTimer);
register("scheduleNightStepTimer", scheduleNightStepTimer);
register("nightAction", nightAction);
register("resolveNight", resolveNight);
register("finishNight", finishNight);
register("resolveShot", resolveShot);
register("applyLoverChain", applyLoverChain);
register("beginMorning", beginMorning);
register("continueMorning", continueMorning);
register("startDaySteps", startDaySteps);
register("startDiscuss", startDiscuss);
register("startHandover", startHandover);
register("startLastWord", startLastWord);
register("afterLastWord", afterLastWord);

module.exports = {};
