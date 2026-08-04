'use strict';
/* =========================================================================
 * 狼人杀 游戏引擎（纯内存版，零依赖）
 * 用法：const Game = require('./game.js')
 *   Game.createRoom(hostName) → { roomId, playerId, view }
 *   Game.handleAction(roomId, playerId, action, data) → { ok, view?, error? }
 *   ...
 * 所有房间状态保存在内存 Map 中，服务器重启即清空。
 * ========================================================================= */

const crypto = require('crypto');

/* ---------------------------- 角色定义 ---------------------------- */
const ROLE_INFO = {
  villager:   { name: '平民',   camp: 'good', type: 'civil', desc: '无特殊技能，一觉睡到天亮。' },
  seer:       { name: '预言家', camp: 'good', type: 'god',   desc: '每晚可查验一名玩家的身份是好人还是狼人。' },
  witch:      { name: '女巫',   camp: 'good', type: 'god',   desc: '解药救当晚被狼人杀害者（可自救），毒药毒杀一人；每晚最多使用一瓶药。' },
  hunter:     { name: '猎人',   camp: 'good', type: 'god',   desc: '被狼人杀害或被投票放逐时可开枪；被毒杀/魅惑带死/殉情时不能开枪。' },
  dreamer:    { name: '摄梦人', camp: 'good', type: 'god',   desc: '每晚必须梦游一名玩家（不能梦自己）；梦游者免疫夜间伤害；摄梦人夜间出局则梦游者一并出局。' },
  guard:      { name: '守卫',   camp: 'good', type: 'god',   desc: '每晚守护一名玩家（可守自己），不能连续两晚守同一人；被守者免疫狼刀；被守且被解药救=同守同救出局。' },
  wolf:       { name: '狼人',   camp: 'wolf', type: 'wolf',  desc: '夜里集体睁眼，共同杀死一人；可自刀、可空刀。' },
  wolfBeauty: { name: '狼美人', camp: 'wolf', type: 'wolf',  desc: '夜里可魅惑一名玩家；仅在被放逐出局时，被魅惑者跟随出局（被狼刀/毒杀/被猎人枪杀均不触发）。' },
  thief:      { name: '盗贼',   camp: 'dyn',  type: 'dyn',   desc: '第一晚最先睁眼，从两张身份牌中选择一张作为自己的身份，另一张作废；若其中有狼人牌则必须选狼人。' },
  cupid:      { name: '丘比特', camp: 'dyn',  type: 'dyn',   desc: '第一晚指定两名玩家为情侣（可包括自己）；情侣一死一殉情；情侣均为好人则属好人阵营，均为狼人则属狼人阵营，否则为第三方阵营。' },
};

const WOLF_ROLES = ['wolf', 'wolfBeauty'];
const ROOM_CODE_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DEATH_TEXT = {
  wolf:   '被狼人杀害',
  poison: '被女巫毒杀',
  exile:  '被投票放逐',
  shoot:  '被猎人枪杀',
  charm:  '被狼美人魅惑带走',
  lover:  '殉情',
  dream:  '随摄梦人出局',
  left:   '离开游戏',
};

/* ---------------------------- 工具函数 ---------------------------- */
const rooms = new Map();
function uid() { return crypto.randomBytes(8).toString('hex'); }
function randInt(n) { return Math.floor(Math.random() * n); }
function shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = randInt(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }
function bump(room) { room.version = (room.version || 0) + 1; }

/* 白天发言/投票阶段超时（秒），可用环境变量 PHASE_TIMEOUT 覆盖（便于测试） */
const PHASE_TIMEOUT = Math.max(2, parseInt(process.env.PHASE_TIMEOUT || '30', 10));

function clearPhaseTimer(room) {
  if (room._phaseTimer) { clearTimeout(room._phaseTimer); room._phaseTimer = null; }
  room.phaseDeadline = null;
}
function schedulePhase(room, expectedPhase, fn) {
  clearPhaseTimer(room);
  room.phaseDeadline = Date.now() + PHASE_TIMEOUT * 1000;
  room._phaseTimer = setTimeout(() => {
    room._phaseTimer = null;
    room.phaseDeadline = null;
    if (!rooms.has(room.id)) return;
    if (room.phase !== expectedPhase) return; // 阶段已变化（玩家/房主提前推进）则不再触发
    fn(room);
  }, PHASE_TIMEOUT * 1000);
  maybeRunBots(room); // 计时阶段进入时：若有待行动人机，立即安排执行
}
function byId(room, id) { return room.players.find(p => p.id === id) || null; }
function rolePlayer(room, key) { return room.players.find(p => effRole(p) === key) || null; }
function expandCounts(c) { const arr = []; for (const k in c) { for (let i = 0; i < (c[k] || 0); i++) arr.push(k); } return arr; }
function effRole(p) { return (p.role === 'thief' && p.pickedRole) ? p.pickedRole : p.role; }
// 丘比特阵营：开局默认为第三方；情侣指定/重选时按情侣整体阵营计算并记忆；
// 情侣死亡后、重新指认前保持当前阵营不变。
function cupidCamp(room, cupidId) {
  return room.cupidCamp || 'third';
}
// 根据当前情侣计算丘比特阵营（情侣=双好→good，双狼→wolf，一好一狼→third）
function computeCupidCamp(room) {
  const L = room.lovers;
  if (!L || !L[0]) return room.cupidCamp || 'third';
  const [a, b] = L;
  const cupid = rolePlayer(room, 'cupid');
  const cupidId = cupid ? cupid.id : null;
  const pa = byId(room, a), pb = byId(room, b);
  if (a === cupidId || b === cupidId) return 'third'; // 自连一律第三方（丘比特本质为第三方）
  const ca = campOf(room, pa), cb = campOf(room, pb);
  if (ca === 'wolf' && cb === 'wolf') return 'wolf';
  if (ca !== cb) return 'third';
  return 'good';
}
function campOf(room, p) {
  if (!p || !p.role) return 'dyn';
  const r = effRole(p);
  if (r === 'cupid') return cupidCamp(room, p.id);
  return ROLE_INFO[r].camp;
}
function typeOf(room, p) {
  if (!p || !p.role) return 'dyn';
  const r = effRole(p);
  if (r === 'cupid') { const c = cupidCamp(room, p.id); return c === 'good' ? 'god' : (c === 'wolf' ? 'wolf' : 'third'); }
  return ROLE_INFO[r].type;
}
function isWolfRole(p) { return effRole(p) === 'wolf' || effRole(p) === 'wolfBeauty'; }
function roleText(room, p) {
  if (!p.role) return null;
  // 盗贼选定新角色后即丧失盗贼身份，翻牌/展示显示所选角色
  return ROLE_INFO[effRole(p)].name;
}
function campText(room, p) {
  const c = campOf(room, p);
  return c === 'good' ? '好人' : c === 'wolf' ? '狼人' : c === 'third' ? '第三方' : '待定';
}
function defaultCounts(n) {
  const wolf = n >= 5 ? 2 : 1;
  const witch = n >= 5 ? 1 : 0;
  const seer = 1;
  return { wolf, seer, witch, hunter: 0, dreamer: 0, guard: 0, wolfBeauty: 0, cupid: 0, villager: n - wolf - seer - witch };
}
function validateConfig(room) {
  const c = room.roleCounts;
  const n = room.playerCap;
  if (n < 4 || n > 18) return '人数需在 4~18 之间';
  if (!(c.wolf >= 1)) return '狼人数量必须 ≥ 1';
  if (!(c.villager >= 1)) return '平民数量必须 ≥ 1';
  for (const k of ['seer', 'witch', 'hunter', 'dreamer', 'guard', 'wolfBeauty', 'cupid']) {
    if ((c[k] || 0) > 1) return '神职/特殊职业最多 1 人';
  }
  const sum = Object.values(c).reduce((a, b) => a + (b || 0), 0);
  // 盗贼玩法开启时，身份牌总数比玩家人数多 1（额外两张供盗贼择一，另一张作废）
  const need = n + (room.settings.thief ? 1 : 0);
  if (sum !== need) return `身份牌总数(${sum})必须${room.settings.thief ? '比玩家人数多 1' : '等于玩家人数'}（${need}）`;
  return null;
}
function newRoomCode() {
  for (;;) { let s = ''; for (let i = 0; i < 6; i++) s += ROOM_CODE_CHARS[randInt(36)]; if (!rooms.has(s)) return s; }
}

/* ---------------------------- 房间创建 / 加入 ---------------------------- */
function createRoom(hostName) {
  const id = newRoomCode();
  const room = {
    id, version: 1, host: null,
    phase: 'lobby',
    dayNum: 0, nightNum: 0, nightStep: null,
    playerCap: 6,
    roleCounts: defaultCounts(6),
    settings: { sheriff: true, winMode: 'edge', tieRule: 'pk', thief: false, botMode: 'auto' }, // botMode: 人机难度 'auto'简单AI | 'passive'挂机
    players: [],
    messages: [],
    winner: null, endInfo: null,
    // 游戏运行时字段
    center: null, lovers: null, sheriff: null,
    cupidCamp: 'third', // 丘比特阵营：开局默认第三方
    loversConfirm: false,
    seerHistory: [], guardLast: null,
    witchPots: { saveUsed: false, poisonUsed: false },
    charmTarget: null,
    night: null, nightActed: null,
    reveal: null,
    morningDeaths: [], dayDeaths: [], exileDeaths: [],
    votes: {}, lastVoteResult: null,
    pkTied: null, candidates: [], campaignDecided: {},
    lastWorders: [], lastWordDone: {}, lastWordContext: null,
    handoverFrom: null, shooter: null, shotContext: null,
    dealt: false,
    phaseDeadline: null,
    lastActive: Date.now(), // 最近一次被轮询的时间（供服务端 TTL 清理无活动房间）
  };
  rooms.set(id, room);
  const host = addPlayer(room, hostName);
  room.host = host.id;
  bump(room);
  return { roomId: id, playerId: host.id, view: viewFor(room, host.id) };
}
function addPlayer(room, name) {
  const p = { id: uid(), name: name || '玩家', seat: room.players.length + 1, role: null, pickedRole: null, alive: true, deadBy: null, deadNote: null, leftGame: false, confirmed: false, lastWordUsed: false };
  room.players.push(p);
  return p;
}
function joinRoom(roomId, name) {
  const room = rooms.get(roomId);
  if (!room) return { error: '房间不存在或已解散' };
  if (room.phase !== 'lobby') return { error: '游戏已开始，无法加入' };
  if (room.players.length >= room.playerCap) return { error: `房间已满（${room.playerCap} 人）` };
  const p = addPlayer(room, name);
  bump(room);
  return { playerId: p.id, view: viewFor(room, p.id) };
}

/* ---------------------------- 准备阶段（房主配置） ---------------------------- */
function lobbyAction(room, p, action, data) {
  const isHost = p.id === room.host;
  if (action === 'leave') { removePlayer(room, p.id, false); return { ok: true, left: true }; }
  if (action === 'kick') {
    if (!isHost) return { error: '只有房主可以踢人' };
    const t = byId(room, data.target);
    if (!t) return { error: '玩家不存在' };
    if (room.players.length <= 1) return { error: '至少需要保留一名玩家' };
    removePlayer(room, t.id, true);
    return { ok: true };
  }
  if (!isHost) return { error: '只有房主可以修改设置' };
  if (action === 'settings') {
    const s = room.settings;
    if (typeof data.sheriff === 'boolean') s.sheriff = data.sheriff;
    if (data.winMode === 'city' || data.winMode === 'edge') s.winMode = data.winMode;
    if (data.tieRule === 'none' || data.tieRule === 'pk') s.tieRule = data.tieRule;
    if (typeof data.thief === 'boolean') s.thief = data.thief;
    if (data.botMode === 'passive' || data.botMode === 'auto') s.botMode = data.botMode;
    bump(room); return { ok: true };
  }
  if (action === 'add_bot') {
    if (room.players.length >= room.playerCap) return { error: '房间已满，请先调大人数上限' };
    const bot = addPlayer(room, (data.name || '').trim() || autoBotName(room));
    bot.isBot = true;
    bump(room);
    return { ok: true };
  }
  if (action === 'remove_bot') {
    const bots = room.players.filter(q => q.isBot);
    if (!bots.length) return { error: '当前没有可移除的人机' };
    if (room.players.length <= 1) return { error: '至少需要保留一名玩家' };
    const t = data.target ? byId(room, data.target) : bots[bots.length - 1];
    if (!t || !t.isBot) return { error: '玩家不存在或不是人机' };
    removePlayer(room, t.id, false);
    bump(room);
    return { ok: true };
  }
  if (action === 'setCounts') {
    const c = data.counts;
    if (!c || typeof c !== 'object') return { error: '参数错误' };
    const nc = {};
    for (const k of Object.keys(ROLE_INFO)) nc[k] = Math.max(0, Math.min(Infinity, Math.floor(c[k] || 0)));
    nc.thief = 0; // 盗贼是设置开关（settings.thief），不占用身份牌
    nc.wolf = Math.max(1, nc.wolf);
    nc.villager = Math.max(1, nc.villager);
    room.roleCounts = nc;
    const err = validateConfig(room);
    if (err) { bump(room); return { ok: true, warning: err }; } // 允许先保存再调整
    bump(room); return { ok: true };
  }
  if (action === 'setCap') {
    const n = Math.floor(data.cap);
    if (n < 4 || n > 18) return { error: '人数需在 4~18 之间' };
    if (n < room.players.length) return { error: `当前已有 ${room.players.length} 人，无法减少，请先踢人` };
    const c = room.roleCounts;
    const others = Object.keys(c).filter(k => k !== 'villager').reduce((a, k) => a + (c[k] || 0), 0);
    // 盗贼玩法开启时身份牌总数比玩家人数多 1
    const need = n + (room.settings.thief ? 1 : 0);
    const villager = need - others;
    if (villager < 1) return { error: '此人数下平民数量将不足 1，请先调整职业配置' };
    room.playerCap = n;
    room.roleCounts = { ...c, villager };
    bump(room); return { ok: true };
  }
  if (action === 'start') {
    const err = validateConfig(room);
    if (err) return { error: err };
    if (room.players.length !== room.playerCap) return { error: `人数未满：当前 ${room.players.length}/${room.playerCap} 人，无法开局` };
    startGame(room);
    return { ok: true };
  }
  return { error: '未知操作' };
}

function startGame(room) {
  const err = validateConfig(room);
  if (err) return { error: err };
  clearPhaseTimer(room);
  // 清空上一局状态
  room.dayNum = 0; room.nightNum = 0; room.nightStep = null;
  room.winner = null; room.endInfo = null;
  room.center = null; room.lovers = null; room.sheriff = null;
  room.cupidCamp = 'third'; // 丘比特阵营：开局默认第三方
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
  room.players.forEach(p => { p.role = null; p.pickedRole = null; p.alive = true; p.deadBy = null; p.deadNote = null; p.leftGame = false; p.confirmed = false; p.lastWordUsed = false; });
  // 身份牌堆（盗贼玩法开启时总数 = 玩家人数 + 1）；center 两张在房主确定身份后再抽取
  const deck = shuffle(expandCounts(room.roleCounts));
  room.center = null;
  room.reveal = { stage: 'hostChoice', hostPicked: false, thiefId: null, thiefPicked: false, dealt: false, deck };
  room.phase = 'reveal';
  if (room._nightTimer) { clearTimeout(room._nightTimer); room._nightTimer = null; }
  bump(room);
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
        rv.thiefId = candidates[randInt(candidates.length)].id;
      }
      if (!rv.thiefPicked) { rv.stage = 'thiefPick'; bump(room); return { ok: true }; }
    }
    tryDeal(room);
    bump(room);
    return { ok: true };
  }
  // 盗贼从两张身份牌中选择一张（若其中有狼人牌则必须选狼人）
  if (action === 'thief_pick') {
    if (rv.stage !== 'thiefPick' || p.id !== rv.thiefId) return { error: '操作不合法' };
    const idx = data.idx;
    if (idx !== 0 && idx !== 1) return { error: '参数错误' };
    const card = room.center[idx];
    if ((WOLF_ROLES.includes(room.center[0]) || WOLF_ROLES.includes(room.center[1])) && !WOLF_ROLES.includes(card)) {
      return { error: '两张牌中有狼人牌，盗贼必须选择狼人' };
    }
    p.role = card; // 选定后即丧失盗贼身份
    rv.thiefPicked = true;
    tryDeal(room);
    bump(room);
    return { ok: true };
  }
  // 确认身份（全员确认可提前开始，否则发牌后等待 5 秒自动开始）
  if (action === 'confirm') {
    if (!rv.dealt) return { error: '身份还未发放' };
    p.confirmed = true;
    bump(room);
    if (room.players.every(q => q.confirmed || q.leftGame)) {
      if (room._nightTimer) { clearTimeout(room._nightTimer); room._nightTimer = null; }
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
  if (rv.dealt) return;
  if (!rv.hostPicked) return; // 等房主确定期望身份
  if (room.settings.thief && (!rv.thiefId || !rv.thiefPicked)) return; // 等盗贼选择
  // 房主未取牌（未选择具体职业）→ 从剩余牌中随机分配
  const host = byId(room, room.host);
  if (!host.role) { if (rv.deck.length) host.role = rv.deck.pop(); }
  host.confirmed = true; // 房主确定身份即视为已确认
  // 其余未分配玩家随机取牌
  for (const q of room.players) {
    if (!q.role && !q.leftGame) { if (rv.deck.length) q.role = rv.deck.pop(); }
  }
  rv.dealt = true;
  rv.stage = 'dealt';
  if (room._nightTimer) clearTimeout(room._nightTimer);
  room._nightTimer = setTimeout(() => {
    room._nightTimer = null;
    if (room.phase === 'reveal' && room.reveal.dealt) beginNight(room); // 5 秒后自动进入夜晚
  }, 5000);
  bump(room);
}

/* ---------------------------- 夜晚 ---------------------------- */
function beginNight(room) {
  clearPhaseTimer(room); // 夜晚无倒计时（各角色行动由房主强制推进）
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
  maybeRunBots(room); // 夜晚开始/换步：安排人机行动
  bump(room);
}
/* 夜晚行动顺序：
 * 首夜：丘比特(指定情侣) → 情侣确认 → 守卫 → 摄梦人 → 狼人 → 预言家 → 女巫
 * 盗贼已在身份展示阶段选牌（若开启盗贼玩法），不再于夜晚睁眼。
 * 后续夜：若情侣全灭且丘比特存活，则丘比特可重新指定情侣（可放弃）；新情侣需互相确认 */
function nightSteps(room) {
  const steps = [];
  const cupid = rolePlayer(room, 'cupid');
  const loversDead = room.lovers && room.lovers.length === 2 && room.lovers.every(id => { const q = byId(room, id); return !q || !q.alive; });
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
    case 'thief': return allWithRole('thief');
    case 'cupid': return allWithRole('cupid');
    case 'lovers': return room.lovers ? room.lovers.filter(id => { const q = byId(room, id); return q && q.alive; }) : [];
    case 'guard': return allWithRole('guard');
    case 'dreamer': return allWithRole('dreamer');
    case 'wolf': return room.players.filter(p => alive(p) && isWolfRole(p)).map(p => p.id);
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
  const steps = nightSteps(room);
  for (const s of steps) {
    if (s === 'lovers' && stepDone(room, s)) room.loversConfirm = false; // 情侣确认完毕
    if (!stepDone(room, s)) {
      room.nightStep = s;
      if (s === 'witch') room.night.witch.revealed = true;
      bump(room);
      return;
    }
  }
  room.nightStep = null;
  // 狼步完成（含房主 advance 跳过）→ 统一锁定本晚魅惑目标
  if (room.night && stepDone(room, 'wolf')) room.charmTarget = room.night.wolf.charm;
  resolveNight(room);
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
      for (const id of ids) { const q = byId(room, id); if (!q || !q.alive) return { error: '玩家不存在或已出局' }; }
      room.lovers = [ids[0], ids[1]].sort();
      n.cupid.pick = [ids[0], ids[1]];
      room.cupidCamp = computeCupidCamp(room); // 按新情侣整体阵营更新丘比特阵营
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
      const t = byId(room, data.target);
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
      const t = byId(room, data.target);
      if (!t || !t.alive) return { error: '玩家不存在或已出局' };
      if (t.id === p.id) return { error: '不能梦自己' };
      n.dreamer.target = t.id;
      markActed(room, step, p.id);
      setNightStep(room);
      return { ok: true };
    }
    case 'wolf_set': {
      if (step !== 'wolf' || !isWolfRole(p)) return { error: '操作不合法' };
      if (data.hasOwnProperty('kill')) {
        if (data.kill === null || data.kill === '') { n.wolf.kill = null; n.wolf.sel[p.id] = null; }
        else { const t = byId(room, data.kill); if (!t || !t.alive) return { error: '玩家不存在或已出局' }; n.wolf.kill = t.id; n.wolf.sel[p.id] = t.id; }
      }
      if (data.hasOwnProperty('charm')) {
        const beauty = room.players.find(q => q.alive && effRole(q) === 'wolfBeauty');
        if (data.charm === null || data.charm === '') { if (beauty) n.wolf.charm = null; }
        else { const t = byId(room, data.charm); if (!t || !t.alive) return { error: '玩家不存在或已出局' }; if (t.id === p.id) return { error: '不能魅惑自己' }; if (!beauty) return { error: '本局没有狼美人' }; n.wolf.charm = t.id; }
      }
      if (data.confirm) {
        markActed(room, 'wolf', p.id);
      }
      bump(room);
      if (nightActors(room, 'wolf').every(id => (room.nightActed['wolf'] || {})[id])) {
        setNightStep(room); // 魅惑目标由 setNightStep 统一锁定
      }
      return { ok: true };
    }
    case 'seer_pick': {
      if (step !== 'seer' || p.role !== 'seer') return { error: '操作不合法' };
      const t = byId(room, data.target);
      if (!t || !t.alive) return { error: '玩家不存在或已出局' };
      if (t.id === p.id) return { error: '不能查验自己' };
      const c = campOf(room, t);
      const result = c === 'wolf' ? 'wolf' : 'good';
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
        const t = byId(room, poison);
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
        const t = byId(room, target);
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
    const q = byId(room, pid);
    if (q && q.alive && !deaths.includes(pid)) { q.alive = false; q.deadBy = by; deaths.push(pid); }
  };
  const n = room.night;
  const guardT = n.guard.target;
  const dreamT = n.dreamer.target;
  const kill = n.wolf.kill;
  const wSave = n.witch.save;
  const wPoison = n.witch.poison;
  const dreamer = rolePlayer(room, 'dreamer');
  if (kill) {
    const guarded = kill === guardT, dreamed = kill === dreamT, saved = wSave;
    if (!dreamed) {
      if (guarded && saved) { const q = byId(room, kill); q.deadNote = '同守同救（狼刀+守护+解药）'; die(kill, 'wolf'); }
      else if (!guarded && !saved) { die(kill, 'wolf'); }
    }
  }
  if (wPoison && wPoison !== dreamT) die(wPoison, 'poison');
  if (dreamT && dreamer && !dreamer.alive && dreamer.deadBy !== 'left') die(dreamT, 'dream'); // 摄梦人离开≠死亡，不带走梦游者
  applyLoverChain(room, deaths, die);
  room.nightDeaths = deaths;
  if (checkWin(room)) { bump(room); return; }
  // 猎人被狼刀杀死 → 夜间开枪
  const hunter = deaths.find(id => { const q = byId(room, id); return effRole(q) === 'hunter' && q.deadBy === 'wolf'; });
  if (hunter) {
    room.nightStep = 'hunter';
    room.shooter = hunter;
    room.shotContext = 'night';
    bump(room);
    maybeRunBots(room); // 被刀猎人若是人机 →自动决定是否开枪
    return;
  }
  finishNight(room);
}
function finishNight(room) {
  room.nightStep = null;
  if (checkWin(room)) { bump(room); return; }
  beginMorning(room);
}
function resolveShot(room, target) {
  const deaths = [];
  const die = (pid, by) => {
    const q = byId(room, pid);
    if (q && q.alive && !deaths.includes(pid)) { q.alive = false; q.deadBy = by; deaths.push(pid); }
  };
  if (target) {
    die(target, 'shoot');
    applyLoverChain(room, deaths, die);
    // 狼美人被猎人枪杀不能带走被魅惑者（仅被放逐时才触发魅惑）
  }
  room.shooter = null;
  if (room.shotContext === 'night') {
    room.nightDeaths = (room.nightDeaths || []).concat(deaths);
    if (checkWin(room)) { bump(room); return; }
    finishNight(room);
  } else {
    room.dayDeaths = (room.dayDeaths || []).concat(deaths);
    if (checkWin(room)) { bump(room); return; }
    beginNight(room);
  }
}
function applyLoverChain(room, deaths, die) {
  if (!room.lovers || !room.lovers[0]) return;
  const [a, b] = room.lovers;
  // 情侣二人中一方死亡 → 另一方殉情（链只涉及两人，一次判定即可；die 内部已判活/去重）
  if (deaths.includes(a)) die(b, 'lover');
  if (deaths.includes(b)) die(a, 'lover');
}
function dieAndApplyLoverChain(room, deaths, pid, by) {
  const q = byId(room, pid);
  if (!q || !q.alive || deaths.includes(pid)) return;
  q.alive = false; q.deadBy = by; deaths.push(pid);
  applyLoverChain(room, deaths, (p2, b2) => { const q2 = byId(room, p2); if (q2 && q2.alive && !deaths.includes(p2)) { q2.alive = false; q2.deadBy = b2; deaths.push(p2); } });
}

/* ---------------------------- 早晨 / 白天 ---------------------------- */
function beginMorning(room) {
  room.dayNum++;
  room.phase = 'morning';
  room.morningDeaths = room.nightDeaths || [];
  room.nightDeaths = null;
  if (checkWin(room)) { bump(room); return; }
  bump(room);
  // 停留在此，由房主点击“继续”或30秒超时后进入遗言/警徽/白天流程（continueMorning）
  schedulePhase(room, 'morning', () => continueMorning(room));
}
function continueMorning(room) {
  // 夜晚死亡：仅第一晚有遗言
  if (room.nightNum === 1 && room.morningDeaths.length) {
    const entitled = room.morningDeaths.filter(id => !byId(room, id).lastWordUsed);
    if (entitled.length) { startLastWord(room, entitled, 'night'); return; }
  }
  // 警徽移交（仅狼刀致死）
  const sheriff = room.sheriff;
  if (sheriff) {
    const sq = byId(room, sheriff);
    if (sq && !sq.alive && sq.deadBy === 'wolf') { startHandover(room); return; }
  }
  startDaySteps(room);
}
function startDaySteps(room) {
  if (room.dayNum === 1 && room.settings.sheriff && !room.sheriff) {
    room.phase = 'sheriff_campaign';
    room.candidates = [];
    room.campaignDecided = {};
    bump(room);
    schedulePhase(room, 'sheriff_campaign', () => beginSheriffVote(room)); // 超时未表态视为弃权
    return;
  }
  startDiscuss(room);
}
function startDiscuss(room) {
  room.phase = 'discuss';
  bump(room);
  schedulePhase(room, 'discuss', () => startVote(room)); // 超时自动进入投票
}
function startHandover(room) {
  room.phase = 'handover';
  room.handoverFrom = room.sheriff;
  bump(room);
  schedulePhase(room, 'handover', () => { // 超时默认撕毁警徽
    room.sheriff = null;
    room.handoverFrom = null;
    addMessage(room, null, 'all', '警长未及时移交警徽，警徽撕毁', '系统');
    startDaySteps(room);
  });
}
function startLastWord(room, ids, context) {
  room.phase = 'lastword';
  room.lastWorders = ids;
  room.lastWordContext = context;
  room.lastWordDone = {};
  ids.forEach(id => { if (byId(room, id).lastWordUsed) room.lastWordDone[id] = true; });
  bump(room);
  schedulePhase(room, 'lastword', () => { // 超时视为跳过遗言
    room.lastWorders.forEach(id => {
      if (!room.lastWordDone[id]) {
        const q = byId(room, id);
        if (q && !q.lastWordUsed) q.lastWordUsed = true;
        room.lastWordDone[id] = true;
      }
    });
    afterLastWord(room);
  });
}
function afterLastWord(room) {
  room.lastWorders = [];
  if (room.lastWordContext === 'exile') {
    room.lastWordContext = null;
    afterExile(room);
  } else {
    room.lastWordContext = null;
    continueMorning(room);
  }
}

/* 白天投票 */
function startVote(room) {
  room.phase = 'vote';
  room.votes = {};
  bump(room);
  schedulePhase(room, 'vote', () => resolveExileVote(room)); // 超时未投视为弃票
}
function computeVotes(room, useSheriffWeight) {
  const totals = {};
  for (const p of room.players) {
    if (!p.alive) continue;
    if (!room.votes.hasOwnProperty(p.id)) continue;
    const v = room.votes[p.id];
    if (!v) continue;
    const w = (useSheriffWeight && p.id === room.sheriff) ? 1.5 : 1;
    totals[v] = (totals[v] || 0) + w;
  }
  const entries = Object.entries(totals);
  if (!entries.length) return { tie: false, winner: null, totals: {}, max: 0 };
  const max = Math.max(...entries.map(e => e[1]));
  const top = entries.filter(e => Math.abs(e[1] - max) < 1e-9).map(e => e[0]);
  if (top.length > 1) return { tie: true, tied: top, totals, max };
  return { tie: false, winner: top[0], totals, max };
}
function allAliveVoted(room) { return room.players.filter(p => p.alive).every(p => room.votes.hasOwnProperty(p.id)); }

function resolveExileVote(room) {
  const res = computeVotes(room, true);
  room.lastVoteResult = {
    kind: 'vote', totals: res.totals, max: res.max,
    result: res.tie ? 'tie' : (res.winner ? 'exile' : 'none'),
    exiled: res.winner, tied: res.tied || null,
  };
  if (res.tie) {
    if (room.settings.tieRule === 'pk') {
      room.pkTied = res.tied.filter(id => byId(room, id).alive);
      room.phase = 'pk_speech';
      bump(room);
      schedulePhase(room, 'pk_speech', () => beginPkVote(room)); // 超时自动进入 PK 投票
      return;
    }
    // 平票无人出局
    beginNight(room);
    return;
  }
  if (!res.winner) { beginNight(room); return; }
  exilePlayer(room, res.winner);
}
function exilePlayer(room, id) {
  const q = byId(room, id);
  q.alive = false; q.deadBy = 'exile';
  room.dayDeaths = [id];
  room.exileDeaths = [id];
  startLastWord(room, [id], 'exile');
}
function afterExile(room) {
  const deaths = [];
  const die = (pid, by) => { const q = byId(room, pid); if (q && q.alive && !deaths.includes(pid)) { q.alive = false; q.deadBy = by; deaths.push(pid); } };
  // 被放逐者本身也计入死亡列表，用于触发情侣殉情
  const exileAndCharm = room.exileDeaths.slice();
  for (const id of room.exileDeaths) {
    const q = byId(room, id);
    if (effRole(q) === 'wolfBeauty' && room.charmTarget && room.charmTarget !== id) {
      die(room.charmTarget, 'charm');
      exileAndCharm.push(room.charmTarget);
    }
  }
  applyLoverChain(room, exileAndCharm, die);
  room.dayDeaths = room.dayDeaths.concat(deaths);
  if (checkWin(room)) { bump(room); return; }
  // 猎人被放逐 → 开枪
  const hunter = room.exileDeaths.find(id => { const q = byId(room, id); return effRole(q) === 'hunter'; });
  if (hunter) {
    room.phase = 'hunter_shot';
    room.shooter = hunter;
    room.shotContext = 'exile';
    bump(room);
    maybeRunBots(room); // 被放逐猎人若是人机 →自动决定是否开枪
    return;
  }
  beginNight(room);
}

/* 警长竞选 */
function resolveSheriffVote(room) {
  const res = computeVotes(room, false);
  room.lastVoteResult = {
    kind: 'sheriff', totals: res.totals, max: res.max,
    result: res.tie ? 'tie' : (res.winner ? 'elected' : 'none'),
    exiled: res.winner, tied: res.tied || null,
  };
  if (res.winner && !res.tie) room.sheriff = res.winner;
  startDiscuss(room);
}

/* ---------------------------- 胜负判定 ---------------------------- */
function thirdFaction(room) {
  const ids = [];
  const cupid = rolePlayer(room, 'cupid');
  // 第三方阵营 = 情侣两人 + 丘比特（若丘比特不在情侣中）
  // 情侣 = [丘比特, 狼] 时，丘比特阵营为第三方，成员即情侣两人
  if (cupid && cupidCamp(room, cupid.id) === 'third') {
    if (room.lovers && room.lovers[0]) ids.push(room.lovers[0], room.lovers[1]);
    if (!room.lovers || !room.lovers.includes(cupid.id)) ids.push(cupid.id);
  }
  return ids;
}
function checkWin(room) {
  const alive = room.players.filter(p => p.alive && !p.leftGame);
  if (!alive.length) return null;
  // 第三方：场上仅剩第三方成员（丘比特/情侣已死仍计入名单）→ 第三方胜
  const third = thirdFaction(room);
  if (third.length && alive.every(p => third.includes(p.id))) {
    room.winner = 'third';
    room.endInfo = { winner: 'third', text: '第三方阵营获胜（丘比特阵营）', roles: room.players.map(p => ({ id: p.id, name: p.name, role: roleText(room, p), camp: campText(room, p), alive: p.alive })) };
    room.phase = 'ended';
    bump(room);
    return room.winner;
  }
  const isThird = id => third.includes(id);
  // 狼人阵营 / 好人阵营（均剔除第三方成员；第三方默认输，除非活到最后）
  const goodCamp = alive.filter(p => campOf(room, p) === 'good' && !isThird(p.id));
  const wolfCamp = alive.filter(p => campOf(room, p) === 'wolf' && !isThird(p.id));
  // 狼人胜
  if (room.settings.winMode === 'city') {
    if (goodCamp.length === 0) { // 屠城：好人阵营全灭即胜，无需消灭第三方
      room.winner = 'wolf';
      room.endInfo = { winner: 'wolf', text: '狼人阵营获胜（屠城）', roles: room.players.map(p => ({ id: p.id, name: p.name, role: roleText(room, p), camp: campText(room, p), alive: p.alive })) };
      room.phase = 'ended';
      bump(room);
      return room.winner;
    }
  } else {
    // 屠边：好人阵营的神职或平民全灭（第三方不计）
    // 注意：若本局配置中本就没有某类职业（如 4 人局狼1+民3 无神职），
    // 该类别恒为 0 不应触发“全灭”——只按配置中存在的类别判定，否则狼人首刀即误判狼胜。
    const GOD_KEYS = ['seer', 'witch', 'hunter', 'dreamer', 'guard'];
    // 本局是否“配置了”神职/平民：按实际发出去的牌判定（盗贼玩法中可能被作废的身份卡不计入），
    // 否则无神职/无民（或神职卡被作废）的局会因该类别恒为 0 而首刀即误判狼胜。
    const hasRole = p => !!(p.role && (p.role !== 'thief' || p.pickedRole));
    const cfgGods = room.players.some(p => hasRole(p) && GOD_KEYS.includes(effRole(p)));
    const cfgCivs = room.players.some(p => hasRole(p) && effRole(p) === 'villager');
    const gods = goodCamp.filter(p => typeOf(room, p) === 'god');
    const civs = goodCamp.filter(p => typeOf(room, p) === 'civil');
    if ((gods.length === 0 && cfgGods > 0) || (civs.length === 0 && cfgCivs > 0)) {
      room.winner = 'wolf';
      room.endInfo = { winner: 'wolf', text: '狼人阵营获胜（屠边）', roles: room.players.map(p => ({ id: p.id, name: p.name, role: roleText(room, p), camp: campText(room, p), alive: p.alive })) };
      room.phase = 'ended';
      bump(room);
      return room.winner;
    }
  }
  // 好人胜：狼人阵营（剔除第三方）全灭即胜
  if (wolfCamp.length === 0) {
    room.winner = 'good';
    room.endInfo = { winner: 'good', text: '好人阵营获胜', roles: room.players.map(p => ({ id: p.id, name: p.name, role: roleText(room, p), camp: campText(room, p), alive: p.alive })) };
    room.phase = 'ended';
    bump(room);
    return room.winner;
  }
  return null;
}

/* ---------------------------- 白天动作 ---------------------------- */
function dayAction(room, p, action, data) {
  switch (room.phase) {
    case 'morning':
      return { error: '等待房主继续' };
    case 'lastword': {
      if (!room.lastWorders.includes(p.id) || room.lastWordDone[p.id]) return { error: '现在不需要你发言' };
      if (action === 'post') {
        const text = (data.text || '').trim();
        if (!text) return { error: '请输入遗言内容' };
        addMessage(room, p, 'all', text, '遗言');
        p.lastWordUsed = true;
        room.lastWordDone[p.id] = true;
        bump(room);
        if (room.lastWorders.every(id => room.lastWordDone[id])) afterLastWord(room);
        return { ok: true };
      }
      if (action === 'skip') { p.lastWordUsed = true; room.lastWordDone[p.id] = true; bump(room); if (room.lastWorders.every(id => room.lastWordDone[id])) afterLastWord(room); return { ok: true }; }
      return { error: '未知操作' };
    }
    case 'handover': {
      if (action !== 'handover') return { error: '未知操作' };
      if (room.handoverFrom !== p.id) return { error: '只有警长本人可以移交警徽' };
      const target = data.target || null;
      if (target) {
        const t = byId(room, target);
        if (!t || !t.alive) return { error: '玩家不存在或已出局' };
        room.sheriff = t.id;
        addMessage(room, p, 'all', `警徽移交给了 ${t.name}`, '系统');
      } else {
        room.sheriff = null;
        addMessage(room, p, 'all', '警长撕毁了警徽', '系统');
      }
      room.handoverFrom = null;
      bump(room);
      startDaySteps(room);
      return { ok: true };
    }
    case 'sheriff_campaign': {
      if (action !== 'campaign') return { error: '未知操作' };
      if (room.campaignDecided[p.id]) return { error: '你已做出选择' };
      room.campaignDecided[p.id] = true;
      if (data.run) room.candidates.push(p.id);
      bump(room);
      if (room.players.filter(q => q.alive).every(q => room.campaignDecided[q.id])) beginSheriffVote(room);
      return { ok: true };
    }
    case 'sheriff_vote': {
      if (action !== 'vote') return { error: '未知操作' };
      if (room.votes.hasOwnProperty(p.id)) return { error: '你已投票' };
      const target = data.target || null;
      if (target && !room.candidates.includes(target)) return { error: '只能投给竞选者' };
      room.votes[p.id] = target;
      bump(room);
      if (allAliveVoted(room)) resolveSheriffVote(room);
      return { ok: true };
    }
    case 'discuss': {
      if (action !== 'startVote') return { error: '未知操作' };
      if (p.id !== room.host) return { error: '只有房主可以结束发言进入投票' };
      startVote(room);
      return { ok: true };
    }
    case 'vote': {
      if (action !== 'vote') return { error: '未知操作' };
      if (room.votes.hasOwnProperty(p.id)) return { error: '你已投票（平票前不能改票）' };
      const target = data.target || null;
      if (target) { const t = byId(room, target); if (!t || !t.alive) return { error: '玩家不存在或已出局' }; }
      room.votes[p.id] = target;
      bump(room);
      if (allAliveVoted(room)) resolveExileVote(room);
      return { ok: true };
    }
    case 'pk_speech': {
      if (action !== 'startVote') return { error: '未知操作' };
      if (p.id !== room.host) return { error: '只有房主可以开始 PK 投票' };
      beginPkVote(room);
      return { ok: true };
    }
    case 'pk_vote': {
      if (action !== 'vote') return { error: '未知操作' };
      if (room.votes.hasOwnProperty(p.id)) return { error: '你已投票' };
      const target = data.target || null;
      if (target && !room.pkTied.includes(target)) return { error: '只能投给 PK 玩家' };
      room.votes[p.id] = target;
      bump(room);
      if (allAliveVoted(room)) resolvePkVote(room);
      return { ok: true };
    }
    case 'hunter_shot': {
      if (action !== 'hunter_shoot') return { error: '未知操作' };
      if (room.shooter !== p.id) return { error: '现在不需要你操作' };
      const target = data.target || null;
      if (target) {
        const t = byId(room, target);
        if (!t || !t.alive) return { error: '玩家不存在或已出局' };
        if (t.id === p.id) return { error: '不能枪杀自己' };
      }
      room.shooter = null;
      resolveShot(room, target);
      return { ok: true };
    }
    case 'ended': {
      if (action === 'rematch' && p.id === room.host) { rematch(room); return { ok: true }; }
      return { error: '未知操作' };
    }
  }
  return { error: '未知操作' };
}
function beginSheriffVote(room) {
  if (!room.candidates.length) {
    room.lastVoteResult = { kind: 'sheriff', totals: {}, max: 0, result: 'none', exiled: null, tied: null };
    startDiscuss(room);
    return;
  }
  room.phase = 'sheriff_vote';
  room.votes = {};
  bump(room);
  schedulePhase(room, 'sheriff_vote', () => resolveSheriffVote(room)); // 超时未投视为弃票
}
function beginPkVote(room) {
  room.phase = 'pk_vote';
  room.votes = {};
  bump(room);
  schedulePhase(room, 'pk_vote', () => resolvePkVote(room));
}
function resolvePkVote(room) {
  const res = computeVotes(room, true);
  room.lastVoteResult = {
    kind: 'pk', totals: res.totals, max: res.max,
    result: res.tie ? 'tie' : (res.winner ? 'exile' : 'none'),
    exiled: res.winner, tied: res.tied || null,
  };
  if (res.winner && !res.tie) exilePlayer(room, res.winner);
  else beginNight(room);
}

/* ---------------------------- 消息 ---------------------------- */
function addMessage(room, p, ch, text, marker) {
  const prev = room.messages[room.messages.length - 1];
  // ts 严格递增：作为聊天增量传输的锚点（同一毫秒内的多条消息也不会丢失）
  const ts = Math.max(Date.now(), (prev ? prev.ts : 0) + 1);
  room.messages.push({ id: uid(), ch, from: p ? p.id : null, name: p ? p.name : '系统', text, marker: marker || null, ts, day: room.dayNum, night: room.nightNum });
  if (room.messages.length > 500) room.messages.splice(0, room.messages.length - 500);
}
function chatAccess(room, p, ch) {
  if (ch === 'all') return room.phase !== 'night'; // 全体频道夜间关闭
  if (ch === 'wolf') return p && isWolfRole(p) && room.phase === 'night'; // 狼人频道仅夜晚开放
  if (ch === 'lover') return p && room.lovers && room.lovers.includes(p.id); // 情侣频道全天开放
  return false;
}
// 查看历史消息的权限：全体消息始终可见，私密频道仅成员可见；狼人频道仅夜晚开放（白天连历史也不可见）
function chatView(room, p, ch) {
  if (ch === 'all') return true;
  if (ch === 'wolf') return !!p && isWolfRole(p) && room.phase === 'night';
  if (ch === 'lover') return !!p && room.lovers && room.lovers.includes(p.id);
  return false;
}
function chatAction(room, p, data) {
  const ch = data.ch === 'lover' ? 'lover' : data.ch === 'wolf' ? 'wolf' : 'all';
  if (!chatAccess(room, p, ch)) return { error: '你没有该频道的发言权限' };
  const text = (data.text || '').trim();
  if (!text) return { error: '消息不能为空' };
  if (text.length > 200) return { error: '消息过长（≤200字）' };
  addMessage(room, p, ch, text, null);
  bump(room);
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
              room.reveal.thiefId = candidates[randInt(candidates.length)].id;
            }
          }
        }
        if (room.settings.thief && room.reveal.thiefId && !room.reveal.thiefPicked) {
          const thief = byId(room, room.reveal.thiefId);
          const card = (WOLF_ROLES.includes(room.center[0]) || WOLF_ROLES.includes(room.center[1]))
            ? room.center.find(k => WOLF_ROLES.includes(k))
            : room.center[0];
          thief.role = card;
          room.reveal.thiefPicked = true;
        }
        tryDeal(room);
        bump(room);
        return { ok: true };
      }
      room.players.forEach(q => { q.confirmed = true; });
      if (room._nightTimer) { clearTimeout(room._nightTimer); room._nightTimer = null; }
      bump(room);
      beginNight(room);
      return { ok: true };
    }
    case 'night': {
      if (room.nightStep === 'hunter') { resolveShot(room, null); return { ok: true }; } // 猎人弃枪
      const actors = nightActors(room, room.nightStep);
      actors.forEach(id => { markActed(room, room.nightStep, id); });
      bump(room);
      setNightStep(room);
      return { ok: true };
    }
    case 'morning': continueMorning(room); return { ok: true };
    case 'lastword':
      room.lastWorders.forEach(id => { if (!room.lastWordDone[id]) { byId(room, id).lastWordUsed = true; room.lastWordDone[id] = true; } });
      afterLastWord(room);
      return { ok: true };
    case 'handover':
      room.sheriff = null;
      room.handoverFrom = null;
      bump(room);
      startDaySteps(room);
      return { ok: true };
    case 'sheriff_campaign':
      room.players.filter(q => q.alive).forEach(q => { room.campaignDecided[q.id] = true; });
      beginSheriffVote(room);
      return { ok: true };
    case 'sheriff_vote':
      room.players.filter(q => q.alive).forEach(q => { if (!room.votes.hasOwnProperty(q.id)) room.votes[q.id] = null; });
      resolveSheriffVote(room);
      return { ok: true };
    case 'discuss': startVote(room); return { ok: true };
    case 'vote':
      room.players.filter(q => q.alive).forEach(q => { if (!room.votes.hasOwnProperty(q.id)) room.votes[q.id] = null; });
      resolveExileVote(room);
      return { ok: true };
    case 'pk_speech': beginPkVote(room); return { ok: true };
    case 'pk_vote':
      room.players.filter(q => q.alive).forEach(q => { if (!room.votes.hasOwnProperty(q.id)) room.votes[q.id] = null; });
      resolvePkVote(room);
      return { ok: true };
    case 'hunter_shot':
      room.shooter = null;
      resolveShot(room, null);
      return { ok: true };
    case 'ended': return { ok: true };
  }
  return { error: '当前阶段无需操作' };
}
function removePlayer(room, pid, isKick) {
  const p = byId(room, pid);
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
      if (candidates.length) room.reveal.thiefId = candidates[randInt(candidates.length)].id;
    }
    if (room.players.length === 0) { rooms.delete(room.id); return; }
    bump(room);
    return;
  } else {
    if (p.alive) {
      p.alive = false;
      p.deadBy = 'left';
      p.leftGame = true;
      if (room.sheriff === pid) room.sheriff = null;
      if (room.phase === 'vote' || room.phase === 'pk_vote' || room.phase === 'sheriff_vote') { if (!room.votes.hasOwnProperty(pid)) room.votes[pid] = null; }
      if (room.phase === 'night' && room.nightStep) { markActed(room, room.nightStep, pid); }
      if (room.phase === 'sheriff_campaign') room.campaignDecided[pid] = true;
      if (room.phase === 'lastword' && room.lastWorders.includes(pid)) { p.lastWordUsed = true; room.lastWordDone[pid] = true; }
      if (room.phase === 'handover' && room.handoverFrom === pid) { room.handoverFrom = null; room.sheriff = null; }
      if (room.phase === 'hunter_shot' && room.shooter === pid) { room.shooter = null; }
      checkWin(room);
    }
  }
  if (room.host === pid) {
    // 房主离开：新房主仅从真人中产生；无真人则解散房间
    const rest = room.players.filter(q => q.id !== pid && !q.leftGame && !q.isBot);
    if (rest.length) room.host = rest[0].id;
    else { rooms.delete(room.id); return; }
  }
  bump(room);
  if (room.phase === 'night' && room.nightStep && room.nightStep !== 'hunter') { if (nightActors(room, room.nightStep).length && nightActors(room, room.nightStep).every(id => (room.nightActed[room.nightStep] || {})[id])) setNightStep(room); }
  if (room.players.length === 0) { rooms.delete(room.id); return; }
  // 尝试自动推进
  autoAdvance(room);
}
function rematch(room) {
  clearPhaseTimer(room);
  room.phase = 'lobby';
  room.dayNum = 0; room.nightNum = 0; room.nightStep = null;
  room.winner = null; room.endInfo = null;
  room.center = null; room.lovers = null; room.sheriff = null;
  room.cupidCamp = 'third'; // 丘比特阵营：开局默认第三方
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
  room.reveal = null;
  if (room._nightTimer) { clearTimeout(room._nightTimer); room._nightTimer = null; }
  room.players.forEach(p => { p.role = null; p.pickedRole = null; p.alive = true; p.deadBy = null; p.deadNote = null; p.leftGame = false; p.confirmed = false; p.lastWordUsed = false; });
  bump(room);
}

/* 自动推进（动作完成后链式推进阶段） */
function autoAdvanceInner(room) {
  let guard = 0;
  while (guard++ < 60) {
    if (room.phase === 'ended') return;
    if (room.phase === 'reveal') {
      if (room.reveal.dealt && room.players.every(q => q.confirmed || q.leftGame)) { beginNight(room); continue; }
      return;
    }
    if (room.phase === 'night') {
      if (room.nightStep === 'hunter') return; // 等待猎人开枪，不可自动跳过
      if (room.nightStep) {
        if (stepDone(room, room.nightStep)) { setNightStep(room); continue; }
        return;
      }
      return;
    }
    if (room.phase === 'lastword') {
      if (room.lastWorders.every(id => room.lastWordDone[id])) { afterLastWord(room); continue; }
      return;
    }
    if (room.phase === 'sheriff_campaign') {
      if (room.players.filter(q => q.alive).every(q => room.campaignDecided[q.id])) { beginSheriffVote(room); continue; }
      return;
    }
    if (room.phase === 'sheriff_vote') {
      if (allAliveVoted(room)) { resolveSheriffVote(room); continue; }
      return;
    }
    if (room.phase === 'vote') {
      if (allAliveVoted(room)) { resolveExileVote(room); continue; }
      return;
    }
    if (room.phase === 'pk_vote') {
      if (allAliveVoted(room)) { resolvePkVote(room); continue; }
      return;
    }
    return;
  }
}
function autoAdvance(room) {
  try { autoAdvanceInner(room); }
  finally { maybeRunBots(room); } // 阶段推进后：若有待行动人机，安排执行
}

/* ---------------------------- 统一入口 ---------------------------- */
function applyAction(room, p, action, data) {
  let res;
  switch (room.phase) {
    case 'lobby': res = lobbyAction(room, p, action, data); break;
    case 'reveal': res = revealAction(room, p, action, data); break;
    case 'night': res = nightAction(room, p, action, data); break;
    default: res = dayAction(room, p, action, data); break;
  }
  if (res && res.ok) autoAdvance(room);
  return res;
}
function handleAction(roomId, pid, action, data, chatSince) {
  const room = rooms.get(roomId);
  if (!room) return { error: '房间不存在或已解散' };
  const p = byId(room, pid);
  if (!p) return { error: '玩家不存在' };
  const res = applyAction(room, p, action, data);
  if (res && res.ok) return { ok: true, view: viewFor(room, pid, chatSince || 0), left: !!res.left };
  return { error: res.error || '操作失败' };
}
function handleChat(roomId, pid, data, chatSince) {
  const room = rooms.get(roomId);
  if (!room) return { error: '房间不存在或已解散' };
  const p = byId(room, pid);
  if (!p) return { error: '玩家不存在' };
  const res = chatAction(room, p, data);
  if (res.ok) return { ok: true, view: viewFor(room, pid, chatSince || 0) };
  return { error: res.error };
}
function handleAdvance(roomId, pid, chatSince) {
  const room = rooms.get(roomId);
  if (!room) return { error: '房间不存在或已解散' };
  const res = advance(room, pid);
  if (res.ok) {
    autoAdvance(room);
    return { ok: true, view: viewFor(room, pid, chatSince || 0) };
  }
  return { error: res.error };
}
function handleLeave(roomId, pid) {
  const room = rooms.get(roomId);
  if (!room) return { ok: true };
  removePlayer(room, pid, false);
  return { ok: true };
}
function handleKick(roomId, pid, target, chatSince) {
  const room = rooms.get(roomId);
  if (!room) return { error: '房间不存在或已解散' };
  if (pid !== room.host) return { error: '只有房主可以踢人' };
  removePlayer(room, target, true);
  return { ok: true, view: viewFor(room, pid, chatSince || 0) };
}

/* ============================ 人机玩家（房主调试功能） ============================
 * 人机 = 服务端自动行动的正常玩家（p.isBot = true），所有决策复用与真人相同的
 * action 入口（applyAction），保证校验与结算一致。
 * settings.botMode 控制难度：
 *   'auto'   简单AI：夜晚按职业启发式决策（狼优先刀好人/女巫常规用药等），白天随机投票；
 *   'passive'挂机：只补必要动作（被刀自救/全员人机时补狼刀），白天一律弃票。
 * 队内有人类时，人机只补 confirm、绝不覆盖人类的共享选择（狼刀/魅惑）。
 */
const BOT_NAMES = ['豆豆', '阿蓝', '阿紫', '阿青', '阿黄', '阿绿', '阿橙', '阿粉', '阿灰', '阿白', '阿棕', '小雾'];
function autoBotName(room) {
  const used = new Set(room.players.map(p => p.name));
  let i = 0, name;
  do { name = '人机·' + BOT_NAMES[(room.players.length + i++) % BOT_NAMES.length]; } while (used.has(name));
  return name;
}
function botDelay() { return 400 + Math.floor(Math.random() * 300); } // 400~700ms，模拟真人节奏

/* 当前阶段需要人机行动的玩家列表 */
function pendingBotActors(room) {
  if (room.phase === 'lobby' || room.phase === 'ended') return [];
  switch (room.phase) {
    case 'reveal': {
      const rv = room.reveal;
      if (!rv) return [];
      if (room.settings.thief && rv.stage === 'thiefPick' && rv.thiefId) {
        const t = byId(room, rv.thiefId);
        return t && t.isBot && !rv.thiefPicked ? [t] : [];
      }
      if (rv.dealt) return room.players.filter(p => p.isBot && !p.confirmed && !p.leftGame);
      return [];
    }
    case 'night': {
      if (room.nightStep === 'hunter') {
        const sh = room.shooter ? byId(room, room.shooter) : null;
        return sh && sh.isBot && !(room.nightActed['hunter'] || {})[sh.id] ? [sh] : [];
      }
      const actors = nightActors(room, room.nightStep || '');
      if (!actors.length) return [];
      const acted = room.nightActed[room.nightStep] || {};
      return actors.filter(id => !acted[id]).map(id => byId(room, id)).filter(p => p && p.isBot);
    }
    case 'lastword':
      return room.lastWorders.filter(id => !room.lastWordDone[id]).map(id => byId(room, id)).filter(p => p && p.isBot);
    case 'handover': {
      const sh = room.handoverFrom ? byId(room, room.handoverFrom) : null;
      return sh && sh.isBot ? [sh] : [];
    }
    case 'sheriff_campaign':
      return room.players.filter(p => p.isBot && p.alive && !room.campaignDecided[p.id]);
    case 'sheriff_vote':
    case 'vote':
    case 'pk_vote':
      return room.players.filter(p => p.isBot && p.alive && !room.votes.hasOwnProperty(p.id));
    case 'hunter_shot': {
      const sh = room.shooter ? byId(room, room.shooter) : null;
      return sh && sh.isBot ? [sh] : [];
    }
    default: return [];
  }
}

/* 人机决策：返回 { action, data }；null = 无需动作 */
function botDecision(room, p) {
  const auto = room.settings.botMode === 'auto';
  const alive = () => room.players.filter(q => q.alive);
  const aliveOthers = () => alive().filter(q => q.id !== p.id);
  const pick = arr => (arr.length ? arr[randInt(arr.length)] : null);
  const pickId = arr => { const q = pick(arr); return q ? q.id : null; };
  const goodOthers = () => aliveOthers().filter(q => campOf(room, q) !== 'wolf');
  if (room.phase === 'reveal') {
    const rv = room.reveal;
    if (room.settings.thief && rv.stage === 'thiefPick' && rv.thiefId === p.id && !rv.thiefPicked) {
      const wolfIdx = room.center.findIndex(k => WOLF_ROLES.includes(k)); // 有狼必选狼
      return { action: 'thief_pick', data: { idx: wolfIdx >= 0 ? wolfIdx : randInt(2) } };
    }
    return { action: 'confirm', data: {} };
  }
  if (room.phase === 'night') {
    switch (room.nightStep) {
      case 'cupid': {
        if (room.nightNum === 1 || auto) {
          const a = pick(alive());
          const b = pick(alive().filter(q => q.id !== a.id));
          return b ? { action: 'cupid_pick', data: { ids: [a.id, b.id] } } : null;
        }
        return { action: 'cupid_pick', data: { ids: null } }; // 挂机：放弃重选
      }
      case 'lovers': return { action: 'lovers_ok', data: {} };
      case 'guard': {
        const valid = alive().filter(q => q.id !== room.guardLast); // 服务端禁止连守同一人
        const target = auto ? pickId(valid) : (room.guardLast === p.id ? pickId(valid) : p.id); // 挂机守自己
        return target ? { action: 'guard_pick', data: { target } } : null;
      }
      case 'dreamer': {
        const t = pickId(aliveOthers());
        return t ? { action: 'dreamer_pick', data: { target: t } } : null;
      }
      case 'wolf': {
        const humans = room.players.some(q => q.alive && isWolfRole(q) && !q.isBot);
        if (humans) return { action: 'wolf_set', data: { confirm: true } }; // 有人类狼：只确认，不覆盖
        const data = { confirm: true };
        if (!room.night.wolf.kill) { // 首个狼人机出刀（含魅惑）
          const targets = goodOthers();
          data.kill = pickId(targets.length ? targets : aliveOthers());
          const beauty = alive().find(q => effRole(q) === 'wolfBeauty');
          if (auto && beauty) data.charm = pickId(aliveOthers().filter(q => !isWolfRole(q) && q.id !== beauty.id));
        }
        return { action: 'wolf_set', data };
      }
      case 'seer': {
        const t = pickId(aliveOthers());
        return t ? { action: 'seer_pick', data: { target: t } } : null;
      }
      case 'witch': {
        const attacked = room.night.wolf.kill;
        const save = !room.witchPots.saveUsed && !!attacked && (auto || attacked === p.id); // 挂机仅被刀自救
        let poison = null;
        if (auto && !save && !room.witchPots.poisonUsed && room.nightNum >= 2) {
          const t = pick(aliveOthers());
          if (t) poison = t.id;
        }
        return { action: 'witch_act', data: { save, poison } };
      }
      case 'hunter': {
        const t = auto ? pick(aliveOthers()) : null;
        return { action: 'hunter_shoot', data: { target: t ? t.id : null } };
      }
      default: return null;
    }
  }
  if (room.phase === 'lastword') return { action: 'skip', data: {} };
  if (room.phase === 'handover') return { action: 'handover', data: { target: null } }; // 人机警长默认撕毁警徽
  if (room.phase === 'sheriff_campaign') return { action: 'campaign', data: { run: auto ? Math.random() < 0.5 : false } };
  if (room.phase === 'sheriff_vote') {
    const target = auto && room.candidates.length ? room.candidates[randInt(room.candidates.length)] : null;
    return { action: 'vote', data: { target } };
  }
  if (room.phase === 'vote') return { action: 'vote', data: { target: auto ? pickId(aliveOthers()) : null } };
  if (room.phase === 'pk_vote') {
    const target = auto && room.pkTied && room.pkTied.length ? room.pkTied[randInt(room.pkTied.length)] : null;
    return { action: 'vote', data: { target } };
  }
  if (room.phase === 'hunter_shot') {
    const t = auto ? pick(aliveOthers()) : null;
    return { action: 'hunter_shoot', data: { target: t ? t.id : null } };
  }
  return null;
}

/* 执行一批待行动的人机（每步都走与真人相同的 action 入口） */
function runBots(room) {
  const bots = pendingBotActors(room);
  for (const b of bots) {
    const dec = botDecision(room, b);
    if (!dec) continue;
    const res = applyAction(room, b, dec.action, dec.data);
    if (!(res && res.ok)) break; // 动作异常或阶段已变：停止本轮
  }
}

/* 检查当前是否需要人机行动；需要则安排一次延迟执行（单定时器，防重入） */
function maybeRunBots(room) {
  if (room.phase === 'lobby' || room.phase === 'ended') return;
  if (!room.players.some(p => p.isBot)) return;
  if (room._botTimer) return;
  if (!pendingBotActors(room).length) return;
  room._botTimer = setTimeout(() => {
    room._botTimer = null;
    if (!rooms.has(room.id)) return;
    if (room.phase === 'lobby' || room.phase === 'ended') return;
    runBots(room);
  }, botDelay());
}

/* ---------------------------- 玩家视图（个性化） ---------------------------- */
function viewFor(room, pid, chatSince) {
  const me = byId(room, pid);
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
    sheriff: room.sheriff,
    winner: room.winner,
    endInfo: room.endInfo,
    dealt: !!(room.reveal && room.reveal.dealt),
    players: room.players.map(q => ({
      id: q.id, name: q.name, seat: q.seat, alive: q.alive, deadBy: q.deadBy, deadNote: q.deadNote,
      role: (!q.alive || q.id === pid || room.phase === 'ended' || room.phase === 'lobby') ? roleText(room, q) : null,
      isBot: !!q.isBot, isMe: q.id === pid, sheriff: q.id === room.sheriff, confirmed: q.confirmed,
    })),
    my: { id: pid, name: me ? me.name : '', alive: me ? me.alive : false, isHost: room.host === pid, role: me ? roleText(room, me) : null, roleKey: me ? effRole(me) : null, camp: me ? ((effRole(me) === 'cupid' || (me.role === 'thief' && !me.pickedRole)) ? null : campText(room, me)) : null },
    myChannels: me ? (['all'].filter(() => room.phase !== 'night').concat(isWolfRole(me) && room.phase === 'night' ? ['wolf'] : []).concat(room.lovers && room.lovers.includes(me.id) ? ['lover'] : [])) : ['all'],
    phaseTimed: !!room.phaseDeadline,
    phaseDeadline: room.phaseDeadline,
    // 情侣成员：被指认的瞬间醒来彼此确认身份，之后随时可见对方身份与丘比特
    myLover: (me && room.lovers && room.lovers.includes(me.id)) ? (() => {
      const partnerId = room.lovers.find(id => id !== me.id);
      const partner = byId(room, partnerId);
      const cupid = rolePlayer(room, 'cupid');
      return { id: partnerId, name: partner ? partner.name : '', role: partner ? roleText(room, partner) : '', cupidName: cupid ? cupid.name : '' };
    })() : null,
    // 预言家：查验记录任何阶段可见（白天也能翻看）
    seerHistory: (me && effRole(me) === 'seer') ? room.seerHistory.map(h => {
      const q = byId(room, h.target);
      return { name: q ? q.name : '', result: h.result, night: h.night };
    }) : null,
    chat: (chatSince > 0 ? room.messages.filter(m => m.ts > chatSince && chatView(room, me, m.ch)) : room.messages.filter(m => chatView(room, me, m.ch))),
    chatFull: !(chatSince > 0),
    lastVoteResult: room.lastVoteResult,
    morningDeaths: room.morningDeaths.map(id => { const q = byId(room, id); return q ? { id, name: q.name, role: roleText(room, q), deadBy: q.deadBy, deadNote: q.deadNote } : null; }).filter(Boolean),
    dayDeaths: room.dayDeaths.map(id => { const q = byId(room, id); return q ? { id, name: q.name, role: roleText(room, q), deadBy: q.deadBy, deadNote: q.deadNote } : null; }).filter(Boolean),
  };
  // ---- 身份展示阶段 ----
  if (room.phase === 'reveal') {
    const rv = room.reveal || { stage: 'hostChoice', hostPicked: false, thiefId: null, thiefPicked: false, dealt: false, deck: [] };
    view.reveal = {
      stage: rv.stage,
      hostPicked: rv.hostPicked,
      thiefPicked: rv.thiefPicked,
      dealt: rv.dealt,
      canPick: room.host === pid && !rv.hostPicked && !rv.dealt,
      available: (room.host === pid && !rv.hostPicked && !rv.dealt) ? Array.from(new Set(rv.deck)).map(k => ({ key: k, name: ROLE_INFO[k].name, desc: ROLE_INFO[k].desc })) : [],
      isThief: rv.stage === 'thiefPick' && rv.thiefId === pid,
      thiefCards: (rv.stage === 'thiefPick' && rv.thiefId === pid && room.center) ? room.center.map(k => ({ key: k, name: ROLE_INFO[k].name, desc: ROLE_INFO[k].desc })) : null,
      myRole: (rv.dealt || me.role) ? roleText(room, me) : null,
      myDesc: me && me.role ? ROLE_INFO[effRole(me)].desc : null,
      confirmed: room.players.filter(q => !q.leftGame).map(q => ({ id: q.id, name: q.name, ok: q.confirmed })),
    };
  }
  // ---- 夜晚 ----
  if (room.phase === 'night') {
    const actors = room.nightStep ? nightActors(room, room.nightStep) : [];
    const night = {
      step: room.nightStep,
      actors: actors.map(id => { const q = byId(room, id); return { id, name: q ? q.name : '', acted: !!(room.nightActed[room.nightStep] || {})[id] }; }),
    };
    if (me) {
      const n = room.night;
      if (room.nightStep === 'thief' && me.role === 'thief') night.thief = { cards: room.center.map(k => ({ key: k, name: ROLE_INFO[k].name })) };
      if (room.nightStep === 'cupid' && effRole(me) === 'cupid') night.cupid = { pick: n.cupid.pick };
      if (room.nightStep === 'lovers' && room.lovers && room.lovers.includes(me.id)) {
        // 情侣在被指认的瞬间醒来：彼此确认身份，并知道丘比特是谁
        const partnerId = room.lovers.find(id => id !== me.id);
        const partner = byId(room, partnerId);
        const cupid = rolePlayer(room, 'cupid');
        night.lovers = {
          partner: partnerId,
          partnerName: partner ? partner.name : '',
          partnerRole: partner ? roleText(room, partner) : '',
          cupidName: cupid ? cupid.name : '',
        };
      }
      if (isWolfRole(me)) {
        night.wolf = {
          kill: n.wolf.kill,
          charm: n.wolf.charm,
          teammates: room.players.filter(q => q.alive && isWolfRole(q)).map(q => ({ id: q.id, name: q.name, role: roleText(room, q) })),
          // 各狼选定受刀对象（undefined=未选，null=空刀）
          selections: room.players.filter(q => q.alive && isWolfRole(q)).map(q => ({
            id: q.id, name: q.name,
            kill: Object.prototype.hasOwnProperty.call(n.wolf.sel, q.id) ? n.wolf.sel[q.id] : undefined,
          })),
        };
      }
      if (effRole(me) === 'seer') night.seer = { history: room.seerHistory.map(h => { const q = byId(room, h.target); return { target: h.target, name: q ? q.name : '', result: h.result, night: h.night }; }) };
      if (effRole(me) === 'guard') night.guard = { last: room.guardLast, target: n.guard.target };
      if (effRole(me) === 'dreamer') night.dreamer = { target: n.dreamer.target };
      if (effRole(me) === 'witch') {
        const victimKnown = room.night.witch.revealed || room.phase !== 'night';
        night.witch = {
          victim: victimKnown ? (room.night.wolf.kill || null) : null,
          saveUsed: room.witchPots.saveUsed,
          poisonUsed: room.witchPots.poisonUsed,
        };
      }
      if (effRole(me) === 'cupid' && room.lovers) night.couple = room.lovers;
      if (room.lovers && room.lovers.includes(me.id)) night.myLover = room.lovers.find(id => id !== me.id);
    }
    if (room.nightStep === 'hunter') night.hunter = { shooter: room.shooter, shooterName: room.shooter ? (byId(room, room.shooter) || {}).name : '' };
    view.night = night;
  }
  // ---- 白天各阶段 ----
  if (room.phase === 'morning') {
    view.morning = { canContinue: room.host === pid };
  }
  if (room.phase === 'lastword') {
    view.lastword = {
      entitled: room.lastWorders.map(id => { const q = byId(room, id); return { id, name: q ? q.name : '', posted: !!room.lastWordDone[id], isMe: id === pid, me: q ? q.name : '' }; }),
      context: room.lastWordContext,
      canAdvance: room.host === pid,
    };
  }
  if (room.phase === 'handover') {
    view.handover = { from: room.handoverFrom, fromName: room.handoverFrom ? (byId(room, room.handoverFrom) || {}).name : '', canAdvance: room.host === pid };
  }
  if (room.phase === 'sheriff_campaign') {
    view.campaign = {
      candidates: room.candidates.map(id => { const q = byId(room, id); return { id, name: q ? q.name : '' }; }),
      myDecided: !!room.campaignDecided[pid],
      progress: room.players.filter(q => q.alive).filter(q => room.campaignDecided[q.id]).length,
      need: room.players.filter(q => q.alive).length,
      canAdvance: room.host === pid,
    };
  }
  if (room.phase === 'sheriff_vote') {
    view.sheriffVote = {
      candidates: room.candidates.map(id => { const q = byId(room, id); return { id, name: q ? q.name : '' }; }),
      myVote: room.votes[pid] || null,
      myVoted: room.votes.hasOwnProperty(pid),
      voted: room.players.filter(q => q.alive && room.votes.hasOwnProperty(q.id)).length,
      need: room.players.filter(q => q.alive).length,
    };
  }
  if (room.phase === 'discuss') view.discuss = { canStartVote: room.host === pid };
  if (room.phase === 'vote' || room.phase === 'pk_vote') {
    view.vote = {
      myVote: room.votes[pid] || null,
      myVoted: room.votes.hasOwnProperty(pid),
      voted: room.players.filter(q => q.alive && room.votes.hasOwnProperty(q.id)).length,
      need: room.players.filter(q => q.alive).length,
      pkTied: room.phase === 'pk_vote' ? room.pkTied.map(id => { const q = byId(room, id); return { id, name: q ? q.name : '' }; }) : null,
    };
  }
  if (room.phase === 'pk_speech') view.pkSpeech = { tied: room.pkTied.map(id => { const q = byId(room, id); return { id, name: q ? q.name : '' }; }), canStartVote: room.host === pid };
  if (room.phase === 'hunter_shot') view.hunterShot = { shooter: room.shooter, shooterName: room.shooter ? (byId(room, room.shooter) || {}).name : '' };
  if (room.phase === 'ended') view.canRematch = room.host === pid;
  return view;
}

module.exports = {
  ROLE_INFO, rooms, createRoom, joinRoom, handleAction, handleChat, handleAdvance, handleLeave, handleKick, viewFor,
};
