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
const fs = require('fs'); // 1.7.0（B1-2）：样本采集钩子（lab 平台）
const { createBotDecision, botWolfChat, resetBotPerGame, injectGrudge } = require('./bot-brain'); // v1.4.0：人机三档决策（idle/easy/smart）
const loverCore = require('./loverCore.js'); // v2（M1）：恋人机制引擎核心（解绑/权能/恋人刀，仅 loverMode==='v2' 触达）
const { voteFeatures } = require('./server/ai/features.js'); // 1.7.0（B1-2）：vote 特征（训练/推理共用，只含公开信息）
const { createRng } = require('./server/ai/rng.js');
const clock = require('./server/clock'); // v1.7.1：可注入时钟（真实/虚拟），所有定时器与时间戳一律经此模块 // 1.7.0（B1-8）：显式可注入 RNG
const chatRecorder = require('./chat-recorder'); // 1.8.0：真人聊天记录收集（NLU 语料冷启动数据源；CHAT_RECORD=0 关闭）

/* 1.7.0（B1-8）：全局 RNG——server.js 启动时用 SEED env 注入；独立 require（如测试直接调引擎）时回退默认种子 */
if (!global.rng) global.rng = createRng(parseInt(process.env.SEED || '0', 10) || 12345);

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

/* ---------------------------- 工具函数 ---------------------------- */
const rooms = new Map();
function uid() { return crypto.randomBytes(8).toString('hex'); }
function newToken() { return crypto.randomBytes(16).toString('hex'); } // 安全加固（C1/C2/C3）：会话 token 128bit 熵，永不进视图
/* 1.7.0（B1-8）：随机统一走显式 RNG——房间级 rng（从全局派生），保证同种子对局确定性 */
function roomRng(room) { return (room && room.rng) || global.rng; }
function randInt(room, n) { return roomRng(room).int(n); }
function shuffle(room, arr) { for (let i = arr.length - 1; i > 0; i--) { const j = randInt(room, i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }
let onChange = null; // v1.5.6：状态变更钩子（server.js 注册 → 快照防抖落盘；覆盖 timer/bot 等非 API 路径变更）
let onBroken = null; // v1.6.1：房间不变式校验失败回调（server.js 注册 → 快照回滚）
/* v1.6.1：引擎不变式自检（O(房间) 轻量，bump 时运行；失败 → 标记 broken → 快照回滚该房间，不污染全局） */
const VALID_NIGHT_STEPS = ['wolf', 'seer', 'witch', 'guard', 'dreamer', 'hunter', 'cupid', 'lovers'];
function checkInvariants(room) {
  if (!room || typeof room.id !== 'string' || room.id.length !== 6) return 'room-id';
  if (!Array.isArray(room.players) || room.players.length < 1 || room.players.length > 18) return 'players';
  for (const p of room.players) {
    if (!p || typeof p.id !== 'string') return 'player-id';
    if (typeof p.alive !== 'boolean') return 'player-alive';
    if (p.role !== null && p.role !== undefined && typeof p.role !== 'string') return 'player-role';
  }
  if (room.phase === 'night' && room.nightStep && !VALID_NIGHT_STEPS.includes(room.nightStep)) return 'night-step';
  if (room.phase === 'reveal' && (!room.reveal || typeof room.reveal !== 'object')) return 'reveal';
  if (room.lastVoteResult !== null && room.lastVoteResult !== undefined && typeof room.lastVoteResult !== 'object') return 'vote-result';
  return null;
}
/* v2（M1）：系统公告消息入消息流（marker='系统'，全频道或狼频道可见；事件流 lover_* 双写） */
function sysMsg(room, ch, text) {
  room.messages.push({ id: uid(), ch, from: null, name: '系统', text, marker: '系统', ts: clock.now(), day: room.dayNum });
}
/* v1.6.0：游戏事件流（环形缓冲 200 条）——运维勘查 + 上帝视角回放的数据源 */
function pushEvent(room, type, data) {
  if (!room || !room.id) return;
  if (!room.events) room.events = [];
  room.events.push({ t: clock.now(), night: room.nightNum || 0, phase: room.phase || '', type, data });
  if (room.events.length > 200) room.events.splice(0, room.events.length - 200);
  // 1.7.17（D1）：信念引擎增量（仅 VOTE_STRATEGY=pi 的信念版 π 需要——生产默认零开销）
  // 事件驱动：与训练侧 belief-engine 消费同一事件流（A-2 同源）；首次投票前挂载
  // 1.7.18+：挂载条件含默认回退（生产默认 v3——未设 env 时同样挂载；VOTE_MODEL_MODE=v2 回退时零开销）
  if (((process.env.VOTE_MODEL_MODE || 'v3') === 'v3' || process.env.VOTE_STRATEGY === 'pi' || process.env.VOTE_STRATEGY === 'pi-snap' || process.env.LAB_AUDIT_VOTE === '1') && room.players && room.players.length) {
    try {
      if (!room._beliefEngine) {
        const { createBeliefEngine } = require('./server/ai/belief-engine.js');
        const counts = { wolf: 0, villager: 0, seer: 0, witch: 0, guard: 0, hunter: 0, wolfBeauty: 0, cupid: 0 };
        for (const p of room.players) {
          const rk = String(p.role || '').toLowerCase();
          if (rk.includes('wolf')) { if (rk.includes('beauty')) counts.wolfBeauty++; else counts.wolf++; }
          else if (rk.includes('seer')) counts.seer++;
          else if (rk.includes('witch')) counts.witch++;
          else if (rk.includes('guard')) counts.guard++;
          else if (rk.includes('hunter')) counts.hunter++;
          else if (rk.includes('cupid')) counts.cupid++;
          else counts.villager++;
        }
        room._beliefEngine = createBeliefEngine(room.players, counts);
      }
      if (type === 'deaths' || type === 'exile' || type === 'vote_cast' || type === 'claim' || type === 'wolf_kill') { // 1.7.18：补 wolf_kill——death_infer 特征源（此前漏喂 → eng.kills 恒空 → death_infer 恒 0）
        const { applyEvent } = require('./server/ai/belief-engine.js');
        // 事件字段归一：pushEvent 存 {type, data}，belief-engine 消费 {t, night, data}
        applyEvent(room._beliefEngine, { t: type, night: room.nightNum || 0, data });
      }
    } catch (e) { /* 信念引擎异常绝不影响对局（fail-open） */ }
  }
}
function bump(room) {
  room.version = (room.version || 0) + 1;
  if (onChange) { try { onChange(room); } catch (e) {} }
  // v1.6.1：不变式自检（轻量 O(房间)）；失败 → 通知 server 快照回滚该房间
  const inv = checkInvariants(room);
  if (inv && onBroken) { try { onBroken(room.id, inv); } catch (e) {} }
}

/* 白天发言/投票阶段超时（秒），可用环境变量 PHASE_TIMEOUT 覆盖（便于测试）；默认 60s */
const PHASE_TIMEOUT = Math.max(2, parseInt(process.env.PHASE_TIMEOUT || '60', 10));
/* 夜晚每个行动步骤/盗贼选牌的超时（秒），超时未完成视为跳过/随机（房主仍可强制继续）；默认 45s */
const NIGHT_TIMEOUT = Math.max(2, parseInt(process.env.NIGHT_TIMEOUT || '45', 10));
/* 表情白名单：唯一来源，经视图下发（view.moods），客户端据此循环展示（N6） */
const MOODS = ['😀', '😨', '😤', '😭', '😏', '🤔', '😇', '🤡', '😴', '😱', '🥳', '🕶️'];

function clearPhaseTimer(room) {
  if (room._phaseTimer) { clock.clearTimeout(room._phaseTimer); room._phaseTimer = null; }
  room.phaseDeadline = null;
}
function schedulePhase(room, expectedPhase, fn, delayMs) {
  clearPhaseTimer(room);
  const t = Math.max(0, delayMs === undefined ? PHASE_TIMEOUT * 1000 : delayMs); // v1.5.6：C1 支持剩余时间重挂
  room.phaseDeadline = clock.now() + t;
  room._phaseTimer = clock.setTimeout(() => {
    room._phaseTimer = null;
    room.phaseDeadline = null;
    if (!rooms.has(room.id)) return;
    if (room.phase !== expectedPhase) return; // 阶段已变化（玩家/房主提前推进）则不再触发
    fn(room);
  }, t);
  maybeRunBots(room); // 计时阶段进入时：若有待行动人机，立即安排执行
}
/* v1.5.6：定时器回调提取为命名函数（供快照恢复 resumeRoom 重挂；行为与原闭包逐字一致） */
function autoBeginNight(room) {
  room._nightTimer = null;
  if (room.phase === 'reveal' && room.reveal.dealt) beginNight(room); // 5 秒后自动进入夜晚
}
function autoThiefPick(room) {
  room._thiefTimer = null;
  room.revealDeadline = null;
  if (!rooms.has(room.id) || room.phase !== 'reveal' || room.reveal.dealt || room.reveal.thiefPicked || room.reveal.stage !== 'thiefPick') return;
  const t = room.reveal.thiefId ? byId(room, room.reveal.thiefId) : null;
  if (!t) return;
  const wolfIdx = room.center.findIndex(k => WOLF_ROLES.includes(k)); // 有狼必选狼
  t.role = room.center[wolfIdx >= 0 ? wolfIdx : randInt(room, 2)];
  room.reveal.thiefPicked = true;
  tryDeal(room); // tryDeal 内部已 bump
}
function handoverTimeout(room) {
  room.sheriff = null;
  room.handoverFrom = null;
  addMessage(room, null, 'all', '警长未及时移交警徽，警徽撕毁', '系统');
  startDaySteps(room);
}
function lastwordTimeout(room) {
  room.lastWorders.forEach(id => {
    if (!room.lastWordDone[id]) {
      const q = byId(room, id);
      if (q && !q.lastWordUsed) q.lastWordUsed = true;
      room.lastWordDone[id] = true;
    }
  });
  afterLastWord(room);
}
function byId(room, id) { return room.players.find(p => p.id === id) || null; }
function byToken(room, tok) { if (!tok) return null; return room.players.find(q => q.sess === tok) || null; } // 安全加固：token 定位玩家（凭证不落视图）
function rolePlayer(room, key) { return room.players.find(p => effRole(p) === key) || null; }
function expandCounts(c) { const arr = []; for (const k in c) { for (let i = 0; i < (c[k] || 0); i++) arr.push(k); } return arr; }
function effRole(p) { return p.role; } // v1.6.2：pickedRole 从未被赋值（盗贼选牌即替换 role），简化
// 丘比特阵营：开局 null（未指定，按无阵营处理，rules.md 三·新增）；情侣指定/重选时按判定表计算并记忆；
// 情侣死亡后、重新指认前保持当前阵营不变；放弃重选后按原阵营继续。
function cupidCamp(room) {
  return room.cupidCamp || null;
}
/* 判定表（rules.md 三·新增）：丘比特身份（首轮=好人；重选=当前阵营）+ 情侣身份组合
 * 好+好→good（丘比特计神职）；狼+狼→wolf（丘比特属狼人阵营）；好+狼→third；第三方+任意→third */
function computeCupidCamp(room) {
  const L = room.lovers;
  if (!L || !L[0]) return room.cupidCamp || null; // 无情侣：保持当前（未指定=null，指认前死亡按无阵营）
  const cupid = rolePlayer(room, 'cupid');
  const cupidId = cupid ? cupid.id : null;
  // 参与判定的两人：丘比特在情侣中（自连）=丘比特+被连者；否则=情侣两人
  const pair = (L[0] === cupidId || L[1] === cupidId) ? [cupidId, L.find(id => id !== cupidId)] : L;
  const campOfId = id => {
    if (id === cupidId) return room.cupidCamp || 'good'; // 丘比特：首轮=好人，重选=当前阵营
    const q = byId(room, id);
    if (!q || !q.role) return 'dyn';
    if (thirdFaction(room).includes(id)) return 'third'; // 已是第三方成员（如人狼恋狼恋人）
    return campOf(room, q);
  };
  const c1 = campOfId(pair[0]), c2 = campOfId(pair[1]);
  if (c1 === 'third' || c2 === 'third') return 'third'; // 第三方+任意→第三方
  if (c1 === 'wolf' && c2 === 'wolf') return 'wolf';
  if (c1 === 'good' && c2 === 'good') return 'good';
  return 'third'; // 好+狼（或 dyn 参与）→ 第三方
}
function campOf(room, p) {
  if (!p || !p.role) return 'dyn';
  const r = effRole(p);
  if (r === 'cupid') return cupidCamp(room);
  return ROLE_INFO[r].camp;
}
function typeOf(room, p) {
  if (!p || !p.role) return 'dyn';
  const r = effRole(p);
  if (r === 'cupid') { if (room.loverTest && room.loverTest.includes('dyn')) return 'dyn'; const c = cupidCamp(room); return c === 'good' ? 'god' : (c === 'wolf' ? 'wolf' : 'dyn'); } // A/B 注入：dyn 化（不计屠边） // 1.7.4：第三方/未指定丘比特不计神（不进屠边）
  return ROLE_INFO[r].type;
}
/* 1.7.4：查验按阵营口径（rules.md 三.13）——狼人阵营成员→'wolf'；好人阵营/第三方→'good'
 * 第三方成员（人狼恋狼恋人、第三方丘比特）显示『好（非狼）』；丘比特属狼人阵营显示『狼人』 */
function checkCamp(room, p) {
  if (!p || !p.role) return 'dyn';
  if (effRole(p) === 'cupid') return cupidCamp(room) === 'wolf' ? 'wolf' : 'good';
  if (isWolfRole(p)) return thirdFaction(room).includes(p.id) ? 'good' : 'wolf'; // 狼恋人第三方→好；普通狼→狼
  return 'good';
}
function isWolfRole(p) { return effRole(p) === 'wolf' || effRole(p) === 'wolfBeauty'; }
function roleText(room, p) {
  if (!p.role) return null;
  const r = effRole(p);
  if (r === 'wolfBeauty') return '狼人'; // 1.7.4：翻牌口径（rules.md 三.13）——狼恋人翻牌『狼人』（职业牌不显示狼美人）
  return ROLE_INFO[r].name;
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
  for (;;) { let s = ''; for (let i = 0; i < 6; i++) s += ROOM_CODE_CHARS[global.rng.int(36)]; if (!rooms.has(s)) return s; } // 房间号不参与对局确定性 → 全局 RNG
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
    loverMode: 'classic', // v2（恋人权能系统）：'off'关闭恋人机制 | 'classic'现行规则（冻结行为，α9 零破坏）| 'v2'权能+解绑+恋人刀（loverCore 驱动）
    presetKey: null, // v3（分层价值模型）：配置标识（4p/6p/8p/9a/9d/12a/12b/12d/15p）——rollout payoff 的 local/α/payoffScale 路由键
    loverTest: null, // A/B 注入（M3.5）：'cupid-dead-n1'首夜丘比特必死 / 'cupid-immortal'丘比特免疫一切死亡
    loverLocked: false, // A/B 注入（M3.5）：解绑禁用（G3 对照：丘比特死但解绑锁定——分离解绑效应）
    loverV2: null, // v2：恋人机制状态（loverCore 管理：power/unbind/betrayUsed/timeline）
    players: [],
    messages: [],
    winner: null, endInfo: null,
    // 游戏运行时字段
    center: null, lovers: null, sheriff: null,
    cupidCamp: null, // 丘比特阵营：开局 null（1.7.4 判定表：未指定按无阵营处理）
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
    rng: createRng(global.rng.int(0x7fffffff)), // 1.7.0（B1-8）：房间级显式 RNG（从全局派生；快照记录 state 可续流）
    actionLog: [], // 1.7.0（B1-8）：决策动作日志（L2-lite 基础，确定性验证/回放数据源；不进 view）
    lastActive: clock.now(), // 最近一次被轮询的时间（供服务端 TTL 清理无活动房间）
  };
  rooms.set(id, room);
  const host = addPlayer(room, hostName);
  room.host = host.id;
  bump(room);
  return { roomId: id, token: host.sess, playerId: host.id, view: viewFor(room, host.id) };
}
/* 1.7.18 修复：座位号分配改"最小空缺"——玩家退出（splice）后 length+1 会与剩余
 * 玩家座位冲突（3号退出后新加入者 seat=length+1=6，与现有6号重复——"全是6号"bug
 * 的根因）；最小空缺保证：座位号稳定（退出者不自动进位）+ 新加入者补最小空位，
 * 永不重复 */
function nextFreeSeat(room) {
  const used = new Set();
  for (const q of room.players) if (q && q.seat != null) used.add(q.seat);
  let s = 1;
  while (used.has(s)) s++;
  return s;
}
function addPlayer(room, name) {
  const p = { id: uid(), sess: newToken(), name: name || '玩家', seat: nextFreeSeat(room), role: null, alive: true, deadBy: null, deadNote: null, leftGame: false, confirmed: false, lastWordUsed: false };
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
  return { playerId: p.id, token: p.sess, view: viewFor(room, p.id) };
}

/* ---------------------------- 准备阶段（房主配置） ---------------------------- */
function lobbyAction(room, p, action, data) {
  const isHost = p.id === room.host;
  if (action === 'leave') { removePlayer(room, p.id); return { ok: true, left: true }; }
  if (action === 'kick') {
    if (!isHost) return { error: '只有房主可以踢人' };
    const t = byId(room, data.target);
    if (!t) return { error: '玩家不存在' };
    if (room.players.length <= 1) return { error: '至少需要保留一名玩家' };
    removePlayer(room, t.id);
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
    // v1.4.0：人机级别（idle 挂机 / easy 简单 / smart 智能）；v1.5.0 增加 simulate（态度模型档）；非法值忽略，走房间 botMode 映射
    if (data.level === 'idle' || data.level === 'easy' || data.level === 'smart' || data.level === 'simulate') bot.botLevel = data.level;
    // 1.7.17（D2 前置）：per-bot 嫌疑分混合权重（多样化 bot 变体——BOT_SUSPICION_W 的 per-bot 版）
    if (data.suspicionW != null) bot.suspicionW = parseFloat(data.suspicionW);
    if (data.followMode === 'strict' || data.followMode === 'loose' || data.followMode === 'none') bot.followMode = data.followMode; // 跟票变体
    // v1.5.0：态度模型风格参数（aggressive/balanced/conservative + 狼侧 charge/shark/normal）
    if (data.style === 'aggressive' || data.style === 'conservative' || data.style === 'balanced') bot.botStyle = data.style;
    if (data.wolfStyle === 'charge' || data.wolfStyle === 'shark' || data.wolfStyle === 'normal') bot.wolfStyle = data.wolfStyle;
    bump(room);
    return { ok: true };
  }
  if (action === 'remove_bot') {
    const bots = room.players.filter(q => q.isBot);
    if (!bots.length) return { error: '当前没有可移除的人机' };
    if (room.players.length <= 1) return { error: '至少需要保留一名玩家' };
    const t = data.target ? byId(room, data.target) : bots[bots.length - 1];
    if (!t || !t.isBot) return { error: '玩家不存在或不是人机' };
    removePlayer(room, t.id);
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
  room.players.forEach(p => { p.role = null; p.alive = true; p.deadBy = null; p.deadNote = null; p.leftGame = false; p.confirmed = false; p.lastWordUsed = false; if (p.isBot) resetBotPerGame(p); }); // v1.5.6：新局重置 bot 本局事实记忆（保留 suspicion）
  room.wolfPackMemory = undefined; room.botTalked = undefined; // v1.5.6：跨局共享战术/发言标记重置
  // 身份牌堆（盗贼玩法开启时总数 = 玩家人数 + 1）；center 两张在房主确定身份后再抽取
  const deck = shuffle(room, expandCounts(room.roleCounts));
  room.center = null;
  room.reveal = { stage: 'hostChoice', hostPicked: false, thiefId: null, thiefPicked: false, dealt: false, deck };
  room.phase = 'reveal';
  if (room._nightTimer) { clock.clearTimeout(room._nightTimer); room._nightTimer = null; }
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
        rv.thiefId = candidates[randInt(room, candidates.length)].id;
      }
      // 盗贼选牌 30 秒倒计时：超时自动选牌（有狼必选狼，否则随机）
      // v1.6.2：hostPick 受 hostPicked 守卫仅执行一次，此处 thiefPicked 恒为 false，去除恒真分支并修正缩进
      rv.stage = 'thiefPick';
      if (room._thiefTimer) clock.clearTimeout(room._thiefTimer);
      room.revealDeadline = clock.now() + NIGHT_TIMEOUT * 1000;
      room._thiefTimer = clock.setTimeout(() => autoThiefPick(room), NIGHT_TIMEOUT * 1000); // 有狼必选狼
      bump(room);
      return { ok: true };
    }
    tryDeal(room); // tryDeal 内部已 bump
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
    tryDeal(room); // tryDeal 内部已 bump
    return { ok: true };
  }
  // 确认身份（全员确认可提前开始；盗贼局强制等待 5 秒展示盗贼结果，否则发牌后等待 5 秒自动开始）
  if (action === 'confirm') {
    if (!rv.dealt) return { error: '身份还未发放' };
    p.confirmed = true;
    bump(room);
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
  const host = byId(room, room.host);
  if (!host.role) { if (rv.deck.length) host.role = rv.deck.pop(); }
  host.confirmed = true; // 房主确定身份即视为已确认
  // 其余未分配玩家随机取牌
  for (const q of room.players) {
    if (!q.role && !q.leftGame) { if (rv.deck.length) q.role = rv.deck.pop(); }
  }
  rv.dealt = true;
  rv.stage = 'dealt';
  if (room._nightTimer) clock.clearTimeout(room._nightTimer);
  room._nightTimer = clock.setTimeout(() => autoBeginNight(room), 5000); // 5 秒后自动进入夜晚
  bump(room);
}

/* ---------------------------- 夜晚 ---------------------------- */
function beginNight(room) {
  if (checkGameEnd(room)) return; // v1.6.4（A2-1）：阶段推进入口兜底——防“结算后无人可行动”挂起
  // v4.2：发言量信息特征——speech 摘要事件（每天结算一次，粗粒度，不撑 200 条事件缓冲）
  if (room.speechToday && Object.keys(room.speechToday).length) {
    pushEvent(room, 'speech', { day: room.dayNum, counts: Object.assign({}, room.speechToday) });
    room.speechToday = {};
  }
  pushEvent(room, 'night_start', { night: room.nightNum + 1 }); // v1.6.0
  clearPhaseTimer(room); // 白天阶段倒计时清掉（夜晚步骤有自己的 30 秒倒计时）
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
  clearNightTimer(room); // 旧步骤的 30 秒倒计时作废，重新按新步骤安排
  const steps = nightSteps(room);
  for (const s of steps) {
    if (s === 'lovers' && stepDone(room, s)) room.loversConfirm = false; // 情侣确认完毕
    if (!stepDone(room, s)) {
      room.nightStep = s;
      pushEvent(room, 'night_step', { step: s }); // v1.6.0
      if (s === 'witch') room.night.witch.revealed = true;
      scheduleNightStepTimer(room); // 本步骤 30 秒倒计时：超时全员视为跳过
      bump(room);
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
    autoAdvance(room);
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
    autoAdvance(room);
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
      for (const id of ids) { const q = byId(room, id); if (!q || !q.alive) return { error: '玩家不存在或已出局' }; }
      if (room.loverMode === 'v2') {
        const rp = loverCore.grantPower(room, data.power); // v2：权能槽二选一（守护/复仇），真人/bot 必选
        if (!rp.ok) return { error: rp.msg };
      }
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
      // v1.6.2：用 !== undefined 替代 hasOwnProperty——直接传 undefined（如测试 harness）不再误入校验分支报“玩家不存在”
      if (data.kill !== undefined) {
        if (data.kill === null || data.kill === '') { n.wolf.kill = null; n.wolf.sel[p.id] = null; }
        else { const t = byId(room, data.kill); if (!t || !t.alive) return { error: '玩家不存在或已出局' }; n.wolf.kill = t.id; n.wolf.sel[p.id] = t.id; }
      }
      if (data.charm !== undefined) {
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
      const result = checkCamp(room, t); // 1.7.4：查验按阵营口径（第三方→好）
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
    if (q && q.alive && !deaths.includes(pid)) { if (room.loverTest && room.loverTest.includes('immortal') && q.role === 'cupid') return; q.alive = false; q.deadBy = by; deaths.push(pid); }
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
    const loverGuard = loverCore.applyGuard(room, kill); // v2 守护：恋人被狼刀 → 挡刀（狼队收到“刀被挡”，暴露恋人位置）
    if (loverGuard) {
      pushEvent(room, 'lover_guard', { target: kill, name: byId(room, kill) ? byId(room, kill).name : '' });
      sysMsg(room, 'wolf', '刀被挡了——你的目标被恋人守护');
      sysMsg(room, 'all', '昨夜有人挡下了狼刀');
    } else if (!dreamed) {
      if (guarded && saved) { const q = byId(room, kill); q.deadNote = '同守同救（狼刀+守护+解药）'; die(kill, 'wolf'); }
      else if (!guarded && !saved) { die(kill, 'wolf'); }
    }
  }
  if (wPoison && wPoison !== dreamT) die(wPoison, 'poison');
  if (dreamT && dreamer && !dreamer.alive && dreamer.deadBy !== 'left') die(dreamT, 'dream'); // 摄梦人离开≠死亡，不带走梦游者
  const betray = deaths.includes(kill) && loverCore.betrayalKill(room, kill); // v2 恋人刀：狼恋人投刀自己的恋人且致死 → 不殉情 + 狼队公告身份（被挡/未死不触发）
  if (betray) {
    pushEvent(room, 'lover_betray', betray);
    sysMsg(room, 'wolf', betray.wolfLoverName + ' 刀了恋人 ' + (byId(room, betray.killId) ? byId(room, betray.killId).name : '') + '（背叛，不殉情）');
    sysMsg(room, 'all', '狼队发生了背叛：' + betray.wolfLoverName + ' 刀了自己的恋人');
  }
  applyLoverChain(room, deaths, die, betray);
  room.nightDeaths = deaths;
  if (room.loverTest && room.loverTest.includes('dead-n1') && room.nightNum === 1) { const cp = rolePlayer(room, 'cupid'); if (cp && cp.alive) { die(cp.id, 'lover_test'); room.nightDeaths = deaths; } } // A/B 注入（M3.5）：首夜丘比特必死 → 解绑全程解锁
  loverCore.trackCupidDeath(room, deaths); // v2 时序记录（丘比特死亡轮次，M3 敏感性分析）
  // v1.6.2：wolf_kill/deaths 事件提前到猎人判断之前推送（猎人开枪分支提前 return 曾导致这两条事件丢失）
  if (room.night && room.night.wolf && room.night.wolf.kill) pushEvent(room, 'wolf_kill', { kill: room.night.wolf.kill, saved: !deaths.includes(room.night.wolf.kill) });
  pushEvent(room, 'deaths', { deaths: deaths.map(id => { const q = byId(room, id); return { id, name: q ? q.name : '', by: q ? q.deadBy : '', role: q ? q.role : '' }; }) });
  // 猎人被狼刀杀死 → 先结算猎人开枪，再判胜负（否则最后的神职猎人被刀会直接判狼胜而无法开枪；枪杀可能改变战局）
  const hunter = deaths.find(id => { const q = byId(room, id); return effRole(q) === 'hunter' && q.deadBy === 'wolf'; });
  if (hunter) {
    room.nightStep = 'hunter';
    room.shooter = hunter;
    room.shotContext = 'night';
    scheduleHunterShotTimer(room); // 猎人 30 秒未开枪 → 弃枪
    bump(room);
    maybeRunBots(room); // 被刀猎人若是人机 →自动决定是否开枪
    return;
  }
  if (checkWin(room)) { bump(room); return; }
  finishNight(room);
}
function finishNight(room) {
  room.nightStep = null;
  if (checkWin(room)) { bump(room); return; }
  beginMorning(room);
}
function resolveShot(room, target) {
  pushEvent(room, 'shot', { shooter: room.shooter, target: target || null }); // v1.6.0
  clock.clearTimeout(room._hunterTimer); room._hunterTimer = null; room.hunterDeadline = null;
  const deaths = [];
  const die = (pid, by) => {
    const q = byId(room, pid);
    if (q && q.alive && !deaths.includes(pid)) { if (room.loverTest && room.loverTest.includes('immortal') && q.role === 'cupid') return; q.alive = false; q.deadBy = by; deaths.push(pid); }
  };
  if (target) {
    die(target, 'shoot');
    applyLoverChain(room, deaths, die);
    loverCore.trackCupidDeath(room, deaths); // v2 时序记录（丘比特被枪杀）
    // 狼美人被猎人枪杀不能带走被魅惑者（仅被放逐时才触发魅惑）
  }
  // v1.6.2：枪杀/殉情死亡批次入事件流（night 分支与此前 deaths 事件分两批；day 分支与放逐批次分离）
  if (deaths.length) pushEvent(room, 'deaths', { deaths: deaths.map(id => { const q = byId(room, id); return { id, name: q ? q.name : '', by: q ? q.deadBy : '', role: q ? q.role : '' }; }) });
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
function applyLoverChain(room, deaths, die, betray) {
  if (!room.lovers || !room.lovers[0]) return;
  const [a, b] = room.lovers;
  const initial = deaths.slice(); // 初始死亡快照（被刀/被票/被枪杀）；殉情追加的死亡不再二次触发宣言/链
  if (initial.includes(a)) {
    if (betray && a === betray.killId && b === betray.wolfLoverId) return; // v2 恋人刀：不殉情（背叛方存活）
    const decl = loverCore.vengeanceDeclare(room, b); // v2 复仇：殉情方临死真相宣言
    if (decl) {
      pushEvent(room, 'lover_reveal', decl);
      sysMsg(room, 'all', decl.declarerName + '（恋人）临死宣言：我的恋人是 ' + decl.partnerName + '');
    }
    die(b, 'lover');
  }
  if (initial.includes(b)) {
    if (betray && b === betray.killId && a === betray.wolfLoverId) return;
    const decl = loverCore.vengeanceDeclare(room, a);
    if (decl) {
      pushEvent(room, 'lover_reveal', decl);
      sysMsg(room, 'all', decl.declarerName + '（恋人）临死宣言：我的恋人是 ' + decl.partnerName + '');
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
  if (checkWin(room)) { bump(room); return; }
  bump(room);
  // 停留在此，由房主点击“继续”或30秒超时后进入遗言/警徽/白天流程（continueMorning）
  schedulePhase(room, 'morning', () => continueMorning(room));
}
function continueMorning(room) {
  if (checkGameEnd(room)) return; // v1.6.4（A2-1）
  // 夜晚死亡：仅第一晚有遗言
  if (room.nightNum === 1 && room.morningDeaths.length) {
    const entitled = room.morningDeaths.filter(id => !byId(room, id).lastWordUsed);
    if (entitled.length) { startLastWord(room, entitled, 'night'); return; }
  }
  // 警徽移交：只要不是被魅惑带走、被摄梦人带走、被毒杀，其余死因（狼刀/枪杀/放逐/殉情等）均可移交
  const sheriff = room.sheriff;
  if (sheriff) {
    const sq = byId(room, sheriff);
    if (sq && !sq.alive && sq.deadBy !== 'charm' && sq.deadBy !== 'dream' && sq.deadBy !== 'poison') { startHandover(room); return; }
  }
  startDaySteps(room);
}
function startDaySteps(room) {
  if (checkGameEnd(room)) return; // v1.6.4（A2-1）
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
  if (checkGameEnd(room)) return; // v1.6.4（A2-1）
  room.phase = 'discuss';
  bump(room);
  schedulePhase(room, 'discuss', () => startVote(room)); // 超时自动进入投票
}
function startHandover(room) {
  if (checkGameEnd(room)) return; // v1.6.4（A2-1）
  room.phase = 'handover';
  room.handoverFrom = room.sheriff;
  bump(room);
  schedulePhase(room, 'handover', handoverTimeout); // 超时默认撕毁警徽
}
function startLastWord(room, ids, context) {
  // v1.6.4（A2-1）：防“结算后无人可行动”挂起——但放逐链中（exileDeaths 非空）不提前判胜负：
  // 放逐后的魅惑/殉情链尚未结算（afterExile 才是递归出口），此刻检查会“早判”（人狼恋狼恋人属第三方被排除 → 误判好人胜）
  if (!(room.exileDeaths && room.exileDeaths.length) && checkGameEnd(room)) return;
  room.phase = 'lastword';
  room.lastWorders = ids;
  room.lastWordContext = context;
  room.lastWordDone = {};
  ids.forEach(id => { if (byId(room, id).lastWordUsed) room.lastWordDone[id] = true; });
  bump(room);
  schedulePhase(room, 'lastword', lastwordTimeout); // 超时视为跳过遗言
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
  if (checkGameEnd(room)) return; // v1.6.4（A2-1）
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
  if (room.loverMode === 'v2' && room.loverV2 && room.loverV2.protectBy) { // v2 付费护短：结算公告“X在保护恋人”（狼队获知身份，优先刀）
    const pb = byId(room, room.loverV2.protectBy);
    pushEvent(room, 'lover_protect', { by: pb ? pb.id : null, name: pb ? pb.name : '' });
    sysMsg(room, 'all', (pb ? pb.name : '某人') + ' 在保护恋人（护短公开）');
    room.loverV2.protectBy = null;
  }
  const res = computeVotes(room, true);
  // 1.7.17（D1 数据源）：vote 明细事件——每票 voter→target（投票结算处发射，块 2 lastExiledId 的同源数据；
  // 投票预测器训练数据源：P(vote_i = j | 投票者视角)；records-v5 重采后含本事件）
  const voteDetail = [];
  for (const p of room.players) {
    if (!p.alive || !room.votes.hasOwnProperty(p.id)) continue;
    const v = room.votes[p.id];
    if (!v) continue;
    voteDetail.push({ voter: p.id, target: v });
  }
  if (voteDetail.length) pushEvent(room, 'vote', { votes: voteDetail, totals: res.totals });
  room.lastVoteResult = {
    kind: 'vote', totals: res.totals, max: res.max,
    result: res.tie ? 'tie' : (res.winner ? 'exile' : 'none'),
    exiled: res.winner, tied: res.tied || null,
  };
  pushEvent(room, 'exile', { exiled: res.winner, result: res.tie ? 'tie' : (res.winner ? 'exile' : 'none'), tied: res.tied || null, role: res.winner ? (byId(room, res.winner) || {}).role || '' : '' }); // v1.6.0（V5.1：放逐身份公开）
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
  if (room.loverTest && room.loverTest.includes('immortal') && q.role === 'cupid') {
    q.deadBy = null;
    // 修复（M3.5）：豁免 = 放逐无效，视为无人出局直接入夜。
    // 此前直接 return → 无新定时器 + phase 停驻 'vote' → lab 虚拟时钟卡死兜底 → stall 数分钟/局
    pushEvent(room, 'exile_immune', { id: id, name: q.name }); // 对冲 resolveExileVote 已推送的 exile 事件
    sysMsg(room, 'all', q.name + ' 被投票放逐但豁免（测试注入）');
    room.votes = {};
    if (checkWin(room)) { bump(room); return; }
    beginNight(room);
    return;
  }
  q.alive = false; q.deadBy = 'exile';
  room.lastExiledId = id; // v4.2：票型信息特征（lastExileWasWolf——推理端与训练端 exile 事件同源）
  room.dayDeaths = [id];
  room.exileDeaths = [id];
  startLastWord(room, [id], 'exile');
}
function afterExile(room) {
  const deaths = [];
  const die = (pid, by) => { const q = byId(room, pid); if (q && q.alive && !deaths.includes(pid)) { if (room.loverTest && room.loverTest.includes('immortal') && q.role === 'cupid') return; q.alive = false; q.deadBy = by; deaths.push(pid); } };
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
  loverCore.trackCupidDeath(room, exileAndCharm); // v2 时序记录（丘比特被票死）
  room.dayDeaths = room.dayDeaths.concat(deaths);
  // v1.6.2：放逐死亡批次入事件流（放逐者 + 魅惑带走 + 殉情；猎人枪杀批次由 resolveShot 推送）
  const exileDead = [...new Set(exileAndCharm.concat(deaths))];
  if (exileDead.length) pushEvent(room, 'deaths', { deaths: exileDead.map(id => { const q = byId(room, id); return { id, name: q ? q.name : '', by: q ? q.deadBy : '', role: q ? q.role : '' }; }) });
  // 猎人被放逐 → 先结算开枪，再判胜负（枪杀可能改变战局，与夜晚猎人同规则）
  const hunter = room.exileDeaths.find(id => { const q = byId(room, id); return effRole(q) === 'hunter'; });
  if (hunter) {
    room.phase = 'hunter_shot';
    room.shooter = hunter;
    room.shotContext = 'exile';
    scheduleHunterShotTimer(room); // 被放逐猎人 30 秒未开枪 → 弃枪（N1 修复）
    bump(room);
    maybeRunBots(room); // 被放逐猎人若是人机 →自动决定是否开枪
    return;
  }
  if (checkWin(room)) { bump(room); return; }
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
  // 1.7.4：警长竞选平票同样适用 PK 规则（rules.md 三.3）——平票者 PK 再投，得票最多者当选；再平票无人当选
  if (res.tie && res.tied && res.tied.length) { room.pkTied = res.tied; beginSheriffPkVote(room); return; }
  if (res.winner && !res.tie) room.sheriff = res.winner;
  startDiscuss(room);
}
function beginSheriffPkVote(room) {
  if (checkGameEnd(room)) return; // v1.6.4（A2-1）
  room.phase = 'pk_vote';
  room.pkIsSheriff = true; // 1.7.4：警长 PK——当选而非放逐
  room.votes = {};
  bump(room);
  schedulePhase(room, 'pk_vote', () => resolvePkVote(room)); // 超时未投视为弃票
}

/* ---------------------------- 胜负判定 ---------------------------- */
/* v1.6.4（A2-1）：终局幂等兜底——checkWin 幂等（ended 直接返回）；阶段推进入口统一调用，
 * 覆盖“结算后无人可行动”的挂起场景（死亡链为同步递归，兜底点放入口/递归出口均安全）。 */
function checkGameEnd(room) {
  if (room.phase === 'ended') return true;
  return !!checkWin(room);
}
function thirdFaction(room) {
  const ids = [];
  const cupid = rolePlayer(room, 'cupid');
  // 第三方阵营 = 情侣两人 + 丘比特（若丘比特不在情侣中）
  // 情侣 = [丘比特, 狼] 时，丘比特阵营为第三方，成员即情侣两人
  if (cupid && cupidCamp(room) === 'third') {
    if (room.lovers && room.lovers[0]) ids.push(room.lovers[0], room.lovers[1]);
    if (!room.lovers || !room.lovers.includes(cupid.id)) ids.push(cupid.id);
  }
  return ids;
}
function checkWin(room) {
  if (room.phase === 'ended') return room.winner || null; // v1.6.4（A2-1）：幂等——终局后重复调用直接返回
  const alive = room.players.filter(p => p.alive && !p.leftGame);
  const endRoles = () => room.players.map(p => ({ id: p.id, name: p.name, role: roleText(room, p), camp: campText(room, p), alive: p.alive, seat: p.seat }));
  // v1.6.4（A2-1）：全员阵亡（无活人）→ 平局结束——此前 return null 导致“全死了还能继续”（真实反馈）
  if (!alive.length) {
    room.winner = 'draw';
    room.endInfo = { winner: 'draw', text: '全员阵亡（平局）', roles: endRoles() };
    room.phase = 'ended';
    bump(room);
    return room.winner;
  }
  // 第三方：场上仅剩第三方成员（丘比特/情侣已死仍计入名单）→ 第三方胜
  const third = thirdFaction(room);
  if (third.length && alive.every(p => third.includes(p.id))) {
    room.winner = 'third';
    room.endInfo = { winner: 'third', text: '第三方阵营获胜（丘比特阵营）', roles: endRoles() };
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
      room.endInfo = { winner: 'wolf', text: '狼人阵营获胜（屠城）', roles: endRoles() };
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
    const hasRole = p => !!p.role; // 新模型下无人持有“盗贼”牌（盗贼选定后即转换身份），无需特判（死逻辑清理）
    const cfgGods = room.players.some(p => hasRole(p) && GOD_KEYS.includes(effRole(p)));
    const cfgCivs = room.players.some(p => hasRole(p) && effRole(p) === 'villager');
    const gods = goodCamp.filter(p => typeOf(room, p) === 'god');
    const civs = goodCamp.filter(p => typeOf(room, p) === 'civil');
    if ((gods.length === 0 && cfgGods > 0) || (civs.length === 0 && cfgCivs > 0)) {
      room.winner = 'wolf';
      room.endInfo = { winner: 'wolf', text: '狼人阵营获胜（屠边）', roles: endRoles() };
      room.phase = 'ended';
      bump(room);
      return room.winner;
    }
  }
  // 好人胜：狼人阵营（剔除第三方）全灭即胜
  if (wolfCamp.length === 0) {
    room.winner = 'good';
    room.endInfo = { winner: 'good', text: '好人阵营获胜', roles: endRoles() };
    room.phase = 'ended';
    bump(room);
    return room.winner;
  }
  return null;
}

/* ---------------------------- 白天动作 ---------------------------- */
function dayAction(room, p, action, data) {
  if (action === 'lover_unbind') { // v2（M1）：白天任一恋人宣言解绑（丘比特死后解锁，一次性；公告=身份公开代价）
    const r2 = loverCore.unbind(room, p.id);
    if (!r2.ok) return { error: r2.msg };
    pushEvent(room, 'lover_unbind', { by: r2.by, byId: r2.byId });
    sysMsg(room, 'all', r2.by + ' 解除了情侣关系（恋人身份公开）');
    return { ok: true };
  }
  switch (room.phase) {
    case 'morning':
      return { error: '等待房主继续' };
    case 'lastword': {
      if (!room.lastWorders.includes(p.id) || room.lastWordDone[p.id]) return { error: '现在不需要你发言' };
      if (action === 'post') {
        const text = (data.text || '').trim();
        if (!text) return { error: '请输入遗言内容' };
        addMessage(room, p, 'all', text, '遗言', data.claim || null); // D1：结构化声明透传
        if (data.claim) pushEvent(room, 'claim', { from: p.id, type: data.claim.type, target: data.claim.target || null, night: data.claim.night != null ? data.claim.night : room.nightNum }); // V5.1：声明事件
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
      if (!p.alive) return { error: '你已出局，无法投票' }; // 规则（rules.md 三.10）：已出局玩家不得投票
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
      if (!p.alive) return { error: '你已出局，无法投票' }; // 规则（rules.md 三.10）：已出局玩家不得投票
      if (room.votes.hasOwnProperty(p.id)) return { error: '你已投票（平票前不能改票）' };
      if (room.loverMode === 'v2' && data && data.protectPartner) loverCore.markProtect(room, p.id); // v2：护短标记（结算公告）
      const target = data.target || null;
      if (target) { const t = byId(room, target); if (!t || !t.alive) return { error: '玩家不存在或已出局' }; }
      room.votes[p.id] = target;
      // 1.7.17（D1 数据源）：逐票事件——每票落定时刻快照（排除本次票——决策时刻语义，训练/推理特征对齐；结算快照会泄漏后续票）
      if (room.phase === 'vote') {
        const snap = [];
        for (const q of room.players) {
          if (!q.alive || !room.votes.hasOwnProperty(q.id)) continue;
          if (q.id === p.id) continue; // 1.7.17：排除本次票（voteFeatures A-2 排除自己，两边一致）
          const v = room.votes[q.id];
          if (!v) continue;
          snap.push({ voter: q.id, target: v });
        }
        pushEvent(room, 'vote_cast', { voter: p.id, target, votes: snap });
      }
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
      if (!p.alive) return { error: '你已出局，无法投票' }; // 规则（rules.md 三.10）：已出局玩家不得投票
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
  if (checkGameEnd(room)) return; // v1.6.4（A2-1）
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
  if (checkGameEnd(room)) return; // v1.6.4（A2-1）
  room.phase = 'pk_vote';
  room.votes = {};
  bump(room);
  schedulePhase(room, 'pk_vote', () => resolvePkVote(room));
}
function resolvePkVote(room) {
  const res = computeVotes(room, true);
  if (room.pkIsSheriff) { // 1.7.4：警长 PK——得票最多当选，再平票无人当选
    room.pkIsSheriff = null;
    room.lastVoteResult = {
      kind: 'sheriff_pk', totals: res.totals, max: res.max,
      result: res.tie ? 'tie' : (res.winner ? 'elected' : 'none'),
      exiled: res.winner, tied: res.tied || null,
    };
    if (res.winner && !res.tie) room.sheriff = res.winner;
    startDiscuss(room);
    return;
  }
  room.lastVoteResult = {
    kind: 'pk', totals: res.totals, max: res.max,
    result: res.tie ? 'tie' : (res.winner ? 'exile' : 'none'),
    exiled: res.winner, tied: res.tied || null,
  };
  if (res.winner && !res.tie) exilePlayer(room, res.winner);
  else beginNight(room);
}

/* ---------------------------- 消息 ---------------------------- */
function addMessage(room, p, ch, text, marker, claim) {
  const prev = room.messages[room.messages.length - 1];
  // ts 严格递增：作为聊天增量传输的锚点（同一毫秒内的多条消息也不会丢失）
  const ts = Math.max(clock.now(), (prev ? prev.ts : 0) + 1);
  room.messages.push({ id: uid(), ch, from: p ? p.id : null, name: p ? p.name : '系统', text, marker: marker || null, ts, day: room.dayNum, night: room.nightNum, claim: claim || null }); // V5.1：结构化声明随消息
  if (room.messages.length > 500) room.messages.splice(0, room.messages.length - 500);
}
/* v1.7.6（丘比特规则补足）：情侣频道成员 = 情侣两人 + 丘比特（丘比特知情侣，可在情侣频道发言） */
function isLoverParty(room, id) {
  if (!id || !room) return false;
  if (room.lovers && room.lovers.includes(id)) return true;
  const cupid = rolePlayer(room, 'cupid');
  return cupid && cupid.id === id;
}
function chatAccess(room, p, ch) {
  if (ch === 'all') return room.phase !== 'night'; // 全体频道夜间关闭
  if (ch === 'wolf') return p && isWolfRole(p) && room.phase === 'night'; // 狼人频道仅夜晚开放
  if (ch === 'lover') return p && isLoverParty(room, p.id); // 情侣频道全天开放（含丘比特）
  return false;
}
// 查看历史消息的权限：全体消息始终可见，私密频道仅成员可见；狼人频道仅夜晚开放（白天连历史也不可见）
function chatView(room, p, ch) {
  if (ch === 'all') return true;
  if (ch === 'wolf') return !!p && isWolfRole(p) && room.phase === 'night';
  if (ch === 'lover') return !!p && isLoverParty(room, p.id);
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
  if (data.claim) pushEvent(room, 'claim', { from: p.id, type: data.claim.type, target: data.claim.target || null, night: data.claim.night != null ? data.claim.night : room.nightNum }); // V5.1：声明事件（belief-engine 证据源）
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
              room.reveal.thiefId = candidates[randInt(room, candidates.length)].id;
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
        tryDeal(room); // tryDeal 内部已 bump
        return { ok: true };
      }
      room.players.forEach(q => { q.confirmed = true; });
      if (room._nightTimer) { clock.clearTimeout(room._nightTimer); room._nightTimer = null; }
      if (room._thiefTimer) { clock.clearTimeout(room._thiefTimer); room._thiefTimer = null; } // 清理盗贼选牌倒计时
      room.revealDeadline = null;
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
function removePlayer(room, pid) {
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
      if (candidates.length) room.reveal.thiefId = candidates[randInt(room, candidates.length)].id;
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
  if (room._nightTimer) { clock.clearTimeout(room._nightTimer); room._nightTimer = null; }
  clearNightTimer(room);
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
  room.players.forEach(p => { p.role = null; p.alive = true; p.deadBy = null; p.deadNote = null; p.leftGame = false; p.confirmed = false; p.lastWordUsed = false; p.mood = null; if (p.isBot) resetBotPerGame(p); }); // v1.5.6：同 startGame（reset 保留 suspicion）
  room.wolfPackMemory = undefined; room.botTalked = undefined; // v1.5.6
  // v1.5.6：先 reset 再注入——上一局狼名单写成轻量"恩怨"（跨局印象，显式建模而非概率泄漏）
  if (grudgeWolfIds.length) for (const p of room.players) { if (p.isBot) injectGrudge(p, grudgeWolfIds); }
  bump(room);
}

/* 自动推进（动作完成后链式推进阶段） */

/* =========================================================================
 * 测试构造器（debug-only）：跳过建房/发牌，直接摆出指定阶段状态。
 * 仅供测试/实验室使用。opts.roles 用固定 id（'p1'..）便于断言。
 * 自动补齐：night 阶段会按 nightSteps 顺序把 nightStep 之前的步骤标记为已完成。
 * ========================================================================= */
function debugRoom(opts = {}) {
  const r = createRoom('调试房主');
  const room = rooms.get(r.roomId);
  if (opts.seed != null) room.rng = createRng(opts.seed);          // 摆盘也可确定性
  const cap = opts.cap || (opts.roles ? opts.roles.length : 6);
  room.playerCap = cap;
  room.roleCounts = opts.counts || defaultCounts(cap);
  room.players = (opts.roles || []).map((x, i) => ({
    id: x.id || ('p' + (i + 1)), name: x.name || ('玩家' + (i + 1)), seat: x.seat || (i + 1),
    role: x.role || null, alive: x.alive !== false, deadBy: x.deadBy || null, deadNote: x.deadNote || null,
    leftGame: !!x.leftGame, confirmed: true, lastWordUsed: !!x.lastWordUsed,
    isBot: !!x.isBot, botLevel: x.botLevel, lastChatAt: 0,
  }));
  room.host = opts.host || (room.players[0] ? room.players[0].id : room.host);
  room.phase = opts.phase || 'night';
  room.nightNum = opts.night || 0;
  room.dayNum = opts.day || 0;
  room.nightStep = opts.nightStep || null;
  room.votes = opts.votes || {};
  room.lovers = opts.lovers || null;
  room.loverMode = opts.loverMode || 'classic'; // v2（M1）：恋人权能模式三态
  room.loverV2 = opts.loverV2 || null; // v2：loverCore 状态（测试/恢复可预置）
  room.cupidCamp = opts.cupidCamp || null; // 1.7.4：摆盘可指定丘比特阵营（默认 null）
  room.sheriff = opts.sheriff || null;
  room.witchPots = Object.assign({ saveUsed: false, poisonUsed: false }, opts.witchPots);
  room.guardLast = opts.guardLast || null;
  room.charmTarget = opts.charmTarget || null;
  room.night = Object.assign({
    wolf: { kill: null, charm: null, locked: false, sel: {} },
    guard: { target: null }, dreamer: { target: null }, seer: { target: null },
    witch: { save: false, poison: null, revealed: false }, cupid: { pick: null },
  }, opts.night || {});
  room.nightActed = opts.nightActed || {};
  room.candidates = opts.candidates || [];
  room.pkTied = opts.pkTied || null;
  room.campaignDecided = opts.campaignDecided || {};
  room.lastWorders = opts.lastWorders || [];
  room.lastWordDone = opts.lastWordDone || {};
  room.lastWordContext = opts.lastWordContext || null;
  room.handoverFrom = opts.handoverFrom || null;
  room.shooter = opts.shooter || null;
  room.shotContext = opts.shotContext || null;
  room.morningDeaths = opts.morningDeaths || [];
  room.dayDeaths = opts.dayDeaths || [];
  room.exileDeaths = opts.exileDeaths || [];
  room.seerHistory = opts.seerHistory || [];
  room.messages = []; room.actionLog = [];
  room.reveal = { stage: 'dealt', hostPicked: true, thiefId: null, thiefPicked: true, dealt: true, deck: [] };
  // night 摆盘：自动把 nightStep 之前的步骤标记完成（guard 未行动时 wolf 步不会被 setNightStep 接受）
  if (room.phase === 'night' && room.nightStep) {
    for (const s of nightSteps(room)) {
      if (s === room.nightStep) break;
      nightActors(room, s).forEach(id => markActed(room, s, id));
    }
  }
  bump(room);
  return room;
}

function autoAdvanceInner(room) {
  let guard = 0;
  while (guard++ < 60) {
    if (room.phase === 'ended') return;
    if (room.phase === 'reveal') {
      if (room.reveal.dealt && room.players.every(q => q.confirmed || q.leftGame) && !room.reveal.thiefPicked) { beginNight(room); continue; }
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
  if (res && res.ok) {
    // 1.7.0（B1-2）vote 样本采集钩子（lab 平台）——只采好人 bot 在正式投票阶段（phase==='vote'）的决策时刻特征；
    // v1.7.2（A-2b）：采集移到 actionLog.push 之前——保证 bot_prev_same 读到的是"上轮投票"（推理时 buildVoteWorld 在决策前，actionLog 同样不含本次）；
    // v1.7.2（B-4）：仅 phase==='vote' 采集，排除竞选/平票投票（day1 无信息时刻的噪声样本）；
    // label 用真实身份（训练侧）；特征只含公开信息（features.js）；批量落盘防单条 append 开销；采集失败绝不影响对局
    if (action === 'vote' && room.phase === 'vote' && room.labSampleFile && p.isBot && !isWolfRole(p) && data && data.target) {
      const f = voteFeatures(room, p.id, data.target);
      if (f) {
        const by = byId(room, data.target);
        room.labSampleBuf = room.labSampleBuf || [];
        room.labSampleBuf.push(JSON.stringify({ gameId: room.labGameId || 'x', day: room.dayNum || 0, botId: p.id, candId: data.target, features: f, label: by ? (isWolfRole(by) ? 1 : 0) : 0 }));
        if (room.labSampleBuf.length >= 500) flushLabSamples(room);
      }
    }
    // v1.7.7（α3）：夜刀样本采集（wolf_set 成功且 bot 狼出刀）——狼侧刀神分类器训练数据；
    // 与 vote 钩子同模式：特征只含公开信息（wolfTrain/features 复用 voteFeatures 13 维），label 用真实身份（是否神职）
    if (action === 'wolf_set' && room.labSampleFile && p.isBot && isWolfRole(p) && data && data.kill) {
      try {
        // v1.7.7（α3）：采集“被杀者 + 随机对照”（去选择偏置）——每夜每狼 bot 决策时采 1+upTo 个样本
        const smps = require('./wolfTrain/collector.js').collectKillSamples(room, p.id, data.kill, 3);
        if (smps.length) {
          room.labSampleBuf = room.labSampleBuf || [];
          for (const wf of smps) {
            room.labSampleBuf.push(JSON.stringify({ gameId: room.labGameId || 'x', night: room.nightNum || 0, wolfId: p.id, kill: wf.victimId, isKill: wf.isKill, features: wf.X, label: wf.y }));
          }
          if (room.labSampleBuf.length >= 500) flushLabSamples(room);
        }
      } catch (e) { /* 采集失败绝不影响对局 */ }
    }
    // 1.7.0（B1-8）：决策动作日志（L2-lite）——确定性验证/回放数据源；mood 等纯展示动作不记
    if (action !== 'mood') {
      if (!room.actionLog) room.actionLog = [];
      room.actionLog.push({ n: room.actionLog.length + 1, phase: room.phase, step: room.nightStep || null, actor: p.seat, action, data: data === undefined ? null : data }); // actor 记座位号（玩家 id 随机，确定性对比需要）
      if (room.actionLog.length > 5000) room.actionLog.splice(0, room.actionLog.length - 5000);
    }
    autoAdvance(room);
  }
  return res;
}
/* 1.7.0（B1-2）：批量落盘 vote 样本（房间结束时由 lab 平台 flush 剩余） */
function flushLabSamples(room) {
  if (room.labSampleBuf && room.labSampleBuf.length) {
    try { fs.appendFileSync(room.labSampleFile, room.labSampleBuf.join('\n') + '\n'); } catch (e) { /* 忽略采集错误，不影响对局 */ }
    room.labSampleBuf = [];
  }
}
function handleAction(roomId, pid, action, data, chatSince) {
  const room = rooms.get(roomId);
  if (!room) return { error: '房间不存在或已解散' };
  const p = byId(room, pid);
  if (!p) return { error: '玩家不存在' };
  if (p.leftGame) return { error: '你已离开房间' }; // 防已离开玩家刷操作（刷版本号）
  // 心情表情：任意阶段可切换（点击自己的表情按钮循环，null=关闭）
  if (action === 'mood') { // 心情表情（MOODS 在模块级定义，经视图下发保证前后端一致 N6）
    const mood = data.mood == null ? null : String(data.mood).slice(0, 8);
    if (mood && !MOODS.includes(mood)) return { error: '无效的表情' };
    p.mood = mood;
    bump(room);
    return { ok: true, view: viewFor(room, pid, chatSince || 0) };
  }
  const res = applyAction(room, p, action, data);
  if (res && res.ok) return { ok: true, view: viewFor(room, pid, chatSince || 0), left: !!res.left };
  return { error: res.error || '操作失败' };
}
function handleChat(roomId, pid, data, chatSince) {
  const room = rooms.get(roomId);
  if (!room) return { error: '房间不存在或已解散' };
  const p = byId(room, pid);
  if (!p) return { error: '玩家不存在' };
  if (p.leftGame) return { error: '你已离开房间' };
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
  removePlayer(room, pid);
  return { ok: true };
}
function handleKick(roomId, pid, target, chatSince) {
  const room = rooms.get(roomId);
  if (!room) return { error: '房间不存在或已解散' };
  if (pid !== room.host) return { error: '只有房主可以踢人' };
  removePlayer(room, target);
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
const BOT_NAMES = ['豆豆', '阿蓝', '阿紫', '阿青', '阿黄', '阿绿', '阿橙', '阿粉', '阿灰', '阿白', '阿棕', '小雾', '小明', '小刚', '小红', '小花', '小丽', '小芳', '小军', '小兰'];
function autoBotName(room) {
  const used = new Set(room.players.map(p => p.name));
  let i = 0, name;
  // 1.7.6：BOT_NAMES 扩容 + 序号兑底——此前 12 个名字在 ≥13 bot 局（15 人局 14 bot）do-while 死循环
  do { name = '人机·' + BOT_NAMES[(room.players.length + i++) % BOT_NAMES.length]; } while (used.has(name) && i <= BOT_NAMES.length);
  if (used.has(name)) name = '人机·' + BOT_NAMES[room.players.length % BOT_NAMES.length] + (room.players.length); // 极端兑底：名字+序号
  return name;
}
/* 人机行动前等待：默认 10s±25%（7500~12500ms）模拟真人思考节奏（可 BOT_DELAY_MS 覆盖，测试用）
 * 注意：抖动必须是相对值——绝对 ±2500 在 BOT_DELAY_MS 调小时会出现负延时（setTimeout 立即执行 → bot 行动风暴/竞态） */
const BOT_DELAY_BASE = Math.max(100, parseInt(process.env.BOT_DELAY_MS || '10000', 10));
function botDelay() { return Math.max(100, Math.round(BOT_DELAY_BASE * (0.75 + global.rng.next() * 0.5))); } // ±25%（调度时序不参与对局确定性 → 全局 RNG）

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
    case 'discuss': { // v1.4.4：发言模拟；v1.6.4（A4-1）：发言次数动态化——人类越多人机越不倾向发言
      const bt = room.botTalked && room.botTalked.day === room.dayNum ? room.botTalked.ids : null;
      // 人类占比：>50% → 配额 1 条；>80% → 配额 1 条且仅“被质疑时开口”（被投/被查杀时允许额外 1 条回应）；否则 2 条
      const humans = room.players.filter(q => !q.isBot && !q.leftGame && q.alive).length;
      const aliveCount = room.players.filter(q => q.alive).length || 1;
      const humanRatio = humans / aliveCount;
      const quota = humanRatio > 0.5 ? 1 : 2;
      const challenged = p => {
        const lv = room.lastVoteResult;
        if (lv && lv.totals && lv.totals[p.id]) return true; // 上一轮被投
        return room.messages.some(m => m.ch === 'all' && m.from && m.from !== p.id && m.text && m.text.includes('查杀') && m.text.includes(p.name)); // 被查杀
      };
      return room.players.filter(p => {
        if (!p.isBot || !p.alive) return false;
        const n = bt ? (bt[p.id] || 0) : 0;
        if (n < quota) return true;
        if (humanRatio > 0.5 && n < quota + 1 && challenged(p)) return true; // 被质疑时允许额外 1 条回应
        return false;
      });
    }
    case 'hunter_shot': {
      const sh = room.shooter ? byId(room, room.shooter) : null;
      return sh && sh.isBot ? [sh] : [];
    }
    default: return [];
  }
}

/* 人机决策（v1.4.0）：统一走 bot-brain 三档入口（idle/easy/smart），公共层+智力层分离 */
function botDecision(room, p) {
  return createBotDecision(room, p);
}

/* 标记 bot 已发言一次（v1.4.4：计数，每人每天至多 2 条） */
function markBotTalked(room, p) {
  if (!room.botTalked || room.botTalked.day !== room.dayNum) room.botTalked = { day: room.dayNum, ids: {} };
  room.botTalked.ids[p.id] = (room.botTalked.ids[p.id] || 0) + 1;
}

/* 执行一批待行动的人机（每步都走与真人相同的 action 入口） */
function runBots(room) {
  room._botBusy = true;
  try {
    const bots = pendingBotActors(room);
    for (const b of bots) {
      const dec = botDecision(room, b);
      if (process.env.BOT_DEBUG) console.log('[runBots]', b.name, room.phase + '/' + room.nightStep, '→', JSON.stringify(dec));
      if (!dec) { markBotTalked(room, b); continue; }
      if (dec.action === 'chat') { // v1.4.3：发言走 chat 通道（真人同款限流），失败不中断
        chatAction(room, b, dec.data);
        markBotTalked(room, b);
        continue;
      }
      // v1.4.4：狼人出刀前先在狼频道沟通（须在 applyAction 前——wolf_set 成功后 setNightStep 会把 phase 推进到非 night，狼频道权限随之失效）
      if (dec.action === 'wolf_set') {
        try {
          const wt = botWolfChat(room, b);
          if (process.env.BOT_DEBUG) console.log('[runBots]', b.name, '狼频道:', wt ? JSON.stringify(wt) : 'null');
          if (wt) chatAction(room, b, wt.data);
        } catch (e) { if (process.env.BOT_DEBUG) console.log('[runBots] 狼频道异常:', e && e.message); }
      }
      const res = applyAction(room, b, dec.action, dec.data);
      if (!(res && res.ok)) break; // 动作异常或阶段已变：停止本轮
    }
  } finally {
    room._botBusy = false;
  }
  maybeRunBots(room); // 收尾统一调度下一波（执行期间不重复调度，避免空跑定时器）
}

/* 检查当前是否需要人机行动；需要则安排一次延迟执行（单定时器，防重入） */
function maybeRunBots(room) {
  if (room.phase === 'lobby' || room.phase === 'ended') return;
  if (room._botBusy) return; // runBots 执行期间不重复调度（N4）
  if (!room.players.some(p => p.isBot)) return;
  if (room._botTimer) return;
  if (!pendingBotActors(room).length) return;
  if (process.env.BOT_DEBUG) console.log('[sched]', room.phase + '/' + room.nightStep, '→', pendingBotActors(room).map(p => p.name).join(','));
  room._botTimer = clock.setTimeout(() => {
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
      role: (!q.alive || q.id === pid || room.phase === 'ended' || room.phase === 'lobby') ? roleText(room, q) : null,
      isBot: !!q.isBot, isMe: q.id === pid, sheriff: q.id === room.sheriff, confirmed: q.confirmed,
      mood: q.mood || null,
    })),
    my: { id: pid, name: me ? me.name : '', alive: me ? me.alive : false, isHost: room.host === pid, role: me ? roleText(room, me) : null, roleKey: me ? effRole(me) : null, camp: me ? ((me.role === 'thief') ? null : campText(room, me)) : null, // v1.7.6：丘比特可得知自己当前阵营（cupidCamp）
      mood: me ? (me.mood || null) : null }, // 安全加固：token 永不进视图（前端从 create/join 响应获取）
    myChannels: me ? (['all'].filter(() => room.phase !== 'night').concat(isWolfRole(me) && room.phase === 'night' ? ['wolf'] : []).concat(isLoverParty(room, me.id) ? ['lover'] : [])) : ['all'],
    phaseTimed: !!room.phaseDeadline,
    phaseDeadline: room.phaseDeadline,
    hunterDeadline: room.hunterDeadline || null, // 猎人开枪 30 秒超时（夜晚/白天共用）
    moods: MOODS, // 表情白名单（服务端唯一来源，客户端据此循环展示 N6）
    // 情侣成员：被指认的瞬间醒来彼此确认身份，之后随时可见对方身份与丘比特
    myLover: (me && room.lovers && room.lovers.includes(me.id)) ? (() => {
      const partnerId = room.lovers.find(id => id !== me.id);
      const partner = byId(room, partnerId);
      const cupid = rolePlayer(room, 'cupid');
      return { id: partnerId, name: partner ? partner.name : '', role: partner ? roleText(room, partner) : '', cupidName: cupid ? cupid.name : '' };
    })() : null,
    // v1.7.6（丘比特规则补足）：丘比特知道情侣身份（两人）——白天也可查看
    myCouple: (me && (() => { const c = rolePlayer(room, 'cupid'); return c && c.id === me.id; })() && room.lovers) ? room.lovers.map(id => { const q = byId(room, id); return { id, name: q ? q.name : '', role: q ? roleText(room, q) : '' }; }) : null,
    // v2（M1）：恋人机制视图（解绑按钮点亮 / 权能展示；classic 返回 loverMode 标记）
    lover: loverCore.viewState(room, pid),
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
      dealt: rv.dealt,
      canPick: room.host === pid && !rv.hostPicked && !rv.dealt,
      // 非房主不暴露“房主正在选职业”的阶段细节（stage/hostPicked 仅房主与已发牌时可见）
      stage: (room.host === pid || rv.dealt) ? rv.stage : null,
      hostPicked: room.host === pid ? rv.hostPicked : null,
      thiefPicked: (rv.stage === 'thiefPick' && rv.thiefId === pid) ? rv.thiefPicked : null,
      // 盗贼窃取：选牌阶段对所有人可见（不泄漏房主选择）；发牌后公开盗贼所得角色
      thiefPicking: room.settings.thief && rv.stage === 'thiefPick' && !rv.dealt,
      thiefTook: (room.settings.thief && rv.dealt && rv.thiefId && byId(room, rv.thiefId)) ? effRole(byId(room, rv.thiefId)) : null,
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
    if (room.nightStep === 'hunter') night.hunter = { shooter: room.shooter, shooterName: room.shooter ? (byId(room, room.shooter) || {}).name : '', context: room.shotContext };
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
      pkTied: room.phase === 'pk_vote' ? room.pkTied.map(id => { const q = byId(room, id); return { id, name: q ? q.name : '' }; }) : null,
      // 房主可见的“谁已投/投给谁”明细（v1.3.0）；非房主不下发
      votedBy: room.host === pid ? room.players.filter(q => q.alive && room.votes.hasOwnProperty(q.id)).map(q => ({ id: q.id, name: q.name, vote: room.votes[q.id] })) : undefined,
    };
  }
  if (room.phase === 'pk_speech') view.pkSpeech = { tied: room.pkTied.map(id => { const q = byId(room, id); return { id, name: q ? q.name : '' }; }), canStartVote: room.host === pid };
  if (room.phase === 'hunter_shot') view.hunterShot = { shooter: room.shooter, shooterName: room.shooter ? (byId(room, room.shooter) || {}).name : '', context: room.shotContext };
  if (room.phase === 'ended') view.canRematch = room.host === pid;
  return view;
}

/* v1.5.6：快照恢复——按房间当前状态重挂定时器并唤醒 bot 调度（超时重新计时，玩家恢复后不会被秒杀） */
const PHASE_TIMEOUT_FN = {
  morning: continueMorning,
  sheriff_campaign: beginSheriffVote,
  discuss: startVote,
  handover: handoverTimeout,
  lastword: lastwordTimeout,
  vote: resolveExileVote,
  pk_speech: beginPkVote,
  sheriff_vote: resolveSheriffVote,
  pk_vote: resolvePkVote,
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
      room._thiefTimer = clock.setTimeout(() => autoThiefPick(room), t); // v1.5.7：补闭包传参
    } else if (room.reveal.dealt) {
      room._nightTimer = clock.setTimeout(() => autoBeginNight(room), 5000); // v1.5.7：补闭包传参
    }
  } else if (room.phase === 'night') {
    scheduleNightStepTimer(room, remain(room.nightDeadline));
    scheduleHunterShotTimer(room, remain(room.hunterDeadline));
  } else if (room.phase === 'hunter_shot') {
    scheduleHunterShotTimer(room, remain(room.hunterDeadline)); // v1.5.7：P1 白天被放逐的猎人弃枪定时器（此前漏挂会永久卡死）
  } else if (room.phase !== 'lobby' && room.phase !== 'ended') {
    const fn = PHASE_TIMEOUT_FN[room.phase];
    if (fn) schedulePhase(room, room.phase, fn, remain(room.phaseDeadline));
  }
  maybeRunBots(room); // 唤醒 bot 调度
}

module.exports = {
  debugRoom,
  ROLE_INFO, rooms, createRoom, joinRoom, handleAction, handleChat, handleAdvance, handleLeave, handleKick, viewFor, resumeRoom, byToken, // 安全加固（C1/C2/C3）：token 定位玩家
  checkWin, // 1.7.4：导出供规则测试/实验室直接判定
  // v1.6.1：钩子用 setter 导出（CommonJS 值导出会让外部赋值不生效）
  setOnChange(fn) { onChange = fn; },
  setOnBroken(fn) { onBroken = fn; },
  addMessage,
  // 1.7.0（B1-2）：lab 平台——批量落盘 vote 样本（房间结束时 flush 剩余）
  flushLabSamples,
};
