// 自动生成（game.js 拆分——shared 基础设施 + ctx 注册表，勿手改，重新运行 tools/split-game.js）
'use strict';

const ctx = {};
function register(name, fn) { ctx[name] = fn; }
;
/* =========================================================================
 * 狼人杀 游戏引擎（纯内存版，零依赖）
 * 用法：const Game = require('../../game.js')
 *   Game.createRoom(hostName) → { roomId, playerId, view }
 *   Game.handleAction(roomId, playerId, action, data) → { ok, view?, error? }
 *   ...
 * 所有房间状态保存在内存 Map 中，服务器重启即清空。
 * ========================================================================= */

const crypto = require('crypto');
const fs = require('fs'); // 1.7.0（B1-2）：样本采集钩子（lab 平台）
const { createBotDecision, botWolfChat, resetBotPerGame, injectGrudge } = require('../../bot-brain'); // v1.4.0：人机三档决策（idle/easy/smart）
const loverCore = require('../../loverCore.js'); // v2（M1）：恋人机制引擎核心（解绑/权能/恋人刀，仅 loverMode==='v2' 触达）
const { voteFeatures } = require('../../server/ai/features.js'); // 1.7.0（B1-2）：vote 特征（训练/推理共用，只含公开信息）
const { createRng } = require('../../server/ai/rng.js');
const clock = require('../../server/clock'); // v1.7.1：可注入时钟（真实/虚拟），所有定时器与时间戳一律经此模块 // 1.7.0（B1-8）：显式可注入 RNG
const chatRecorder = require('../../chat-recorder'); // 1.8.0：真人聊天记录收集（NLU 语料冷启动数据源；CHAT_RECORD=0 关闭）

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
  if (((process.env.VOTE_MODEL_MODE || 'v3') === 'v3' || ['pi', 'pi-snap', 'pi-pure', 'pi-snap-pure'].includes(process.env.VOTE_STRATEGY || '') || process.env.LAB_AUDIT_VOTE === '1') && room.players && room.players.length) {
    try {
      if (!room._beliefEngine) {
        const { createBeliefEngine } = require('../../server/ai/belief-engine.js');
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
        const { applyEvent } = require('../../server/ai/belief-engine.js');
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
  ctx.maybeRunBots(room); // 计时阶段进入时：若有待行动人机，立即安排执行
}
/* v1.5.6：定时器回调提取为命名函数（供快照恢复 resumeRoom 重挂；行为与原闭包逐字一致） */
function autoBeginNight(room) {
  room._nightTimer = null;
  if (room.phase === 'reveal' && room.reveal.dealt) ctx.beginNight(room); // 5 秒后自动进入夜晚
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
  ctx.tryDeal(room); // ctx.tryDeal 内部已 bump
}
function handoverTimeout(room) {
  room.sheriff = null;
  room.handoverFrom = null;
  ctx.addMessage(room, null, 'all', '警长未及时移交警徽，警徽撕毁', '系统');
  ctx.startDaySteps(room);
}
function lastwordTimeout(room) {
  room.lastWorders.forEach(id => {
    if (!room.lastWordDone[id]) {
      const q = byId(room, id);
      if (q && !q.lastWordUsed) q.lastWordUsed = true;
      room.lastWordDone[id] = true;
    }
  });
  ctx.afterLastWord(room);
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
    if (ctx.thirdFaction(room).includes(id)) return 'third'; // 已是第三方成员（如人狼恋狼恋人）
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
  if (isWolfRole(p)) return ctx.thirdFaction(room).includes(p.id) ? 'good' : 'wolf'; // 狼恋人第三方→好；普通狼→狼
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
  return c === 'good' ? '好人' : c === 'wolf' ? '狼人' : c === 'third' ? '神眷者' : '待定';
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
function createRoom(hostName, deviceId) {
  const id = newRoomCode();
  const room = {
    id, version: 1, host: null,
    phase: 'lobby',
    dayNum: 0, nightNum: 0, nightStep: null,
    playerCap: 6,
    roleCounts: defaultCounts(6),
    settings: { sheriff: true, winMode: 'edge', tieRule: 'pk', thief: false, botMode: 'auto', thirdWinMode: 'majority' }, // botMode: 人机难度 'auto'简单AI | 'passive'挂机；thirdWinMode: 'classic'仅剩神眷者胜 | 'majority'神眷者人数≥非神眷者胜（默认）
    loverMode: 'classic', // v2（恋人权能系统）：'off'关闭恋人机制 | 'classic'现行规则（冻结行为，α9 零破坏）| 'v2'权能+解绑+恋人刀（loverCore 驱动）
    presetKey: null, // v3（分层价值模型）：配置标识（4p/6p/8p/9a/9d/12a/12b/12d/15p）——rollout payoff 的 local/α/payoffScale 路由键
    loverTest: null, // A/B 注入（M3.5）：'cupid-dead-n1'首夜丘比特必死 / 'cupid-immortal'丘比特免疫一切死亡
    loverLocked: false, // A/B 注入（M3.5）：解绑禁用（G3 对照：丘比特死但解绑锁定——分离解绑效应）
    loverV2: null, // v2：恋人机制状态（loverCore 管理：power/unbind/betrayUsed/timeline）
    players: [],
    music: null, // v1.7.25（房间全局播放）：{ list, reviews, idx, playing, mode, prog, ts, who }——房主控制全员同步
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
  const host = addPlayer(room, hostName, deviceId);
  room.host = host.id;
  bump(room);
  return { roomId: id, token: host.sess, playerId: host.id, view: ctx.viewFor(room, host.id) };
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
function addPlayer(room, name, deviceId) {
  const p = { id: uid(), sess: newToken(), deviceId: deviceId || null, name: name || '玩家', seat: nextFreeSeat(room), role: null, alive: true, deadBy: null, deadNote: null, leftGame: false, confirmed: false, lastWordUsed: false };
  room.players.push(p);
  return p;
}
function joinRoom(roomId, name, token, deviceId) {
  const room = rooms.get(roomId);
  if (!room) return { error: '房间不存在或已解散' };
  // v1.7.21（双占位修复）：断线重连——token 匹配房间内玩家则复用（不新建、不占新位）；
  // 场景：清理后台/页面被杀时 leave 来不及发 → 服务端玩家滞留；重进带旧 token → 认领旧位
  // 注意：token 复用不受 phase 限制（游戏中途断线也能重连回自己的位置）
  const old = byToken(room, token);
  if (old) {
    // v1.7.26：token 不续期——一个 token 永久对应一个成员（多标签/刷新/重连永不分身）
    if (old.leftGame) { // 刷新竞态兜底：被误标离场的玩家认领回来时重置状态
      old.leftGame = false;
      if (!old.alive && old.deadBy === 'left') { old.alive = true; old.deadBy = null; }
    }
    bump(room);
    return { playerId: old.id, token, reused: true, view: ctx.viewFor(room, old.id) };
  }
  // v1.7.24（设备校验）：token 已失效（被续期/刷新竞态）时——按设备指纹找同设备旧玩家复用
  // （不新建占位——彻底消灭刷新分身：旧页 leave 删人 + 新页 join 新建 = 两个自己）
  if (deviceId) { // v1.7.26：设备认领无条件（含 lobby——建房/组局中刷新同样防分身）
    const dev = room.players.find(q => q.deviceId === deviceId && !q.isBot);
    if (dev) {
      // v1.7.26：token 不续期——设备兜底也保持原 token（分身机制彻底消除）
      if (dev.leftGame) {
        dev.leftGame = false;
        if (!dev.alive && dev.deadBy === 'left') { dev.alive = true; dev.deadBy = null; }
      }
      bump(room);
      return { playerId: dev.id, token: dev.sess, reused: true, view: ctx.viewFor(room, dev.id) };
    }
  }
  if (room.phase !== 'lobby') return { error: '游戏已开始，无法加入' };
  if (room.players.length >= room.playerCap) return { error: `房间已满（${room.playerCap} 人）` };
  const p = addPlayer(room, name, deviceId);
  bump(room);
  return { playerId: p.id, token: p.sess, view: ctx.viewFor(room, p.id) };
}

/* ---------------------------- 准备阶段（房主配置） ---------------------------- */
function lobbyAction(room, p, action, data) {
  const isHost = p.id === room.host;
  if (action === 'leave') { ctx.removePlayer(room, p.id); return { ok: true, left: true }; }
  if (action === 'kick') {
    if (!isHost) return { error: '只有房主可以踢人' };
    const t = byId(room, data.target);
    if (!t) return { error: '玩家不存在' };
    if (room.players.length <= 1) return { error: '至少需要保留一名玩家' };
    ctx.removePlayer(room, t.id);
    return { ok: true };
  }
  if (!isHost) return { error: '只有房主可以修改设置' };
  if (action === 'settings') {
    const s = room.settings;
    if (typeof data.sheriff === 'boolean') s.sheriff = data.sheriff;
    if (data.winMode === 'city' || data.winMode === 'edge') s.winMode = data.winMode;
    if (data.tieRule === 'none' || data.tieRule === 'pk') s.tieRule = data.tieRule;
    if (data.thirdWinMode === 'classic' || data.thirdWinMode === 'majority') s.thirdWinMode = data.thirdWinMode;
    if (typeof data.thief === 'boolean') s.thief = data.thief;
    if (data.botMode === 'passive' || data.botMode === 'auto') s.botMode = data.botMode;
    bump(room); return { ok: true };
  }
  if (action === 'add_bot') {
    if (room.players.length >= room.playerCap) return { error: '房间已满，请先调大人数上限' };
    const bot = addPlayer(room, (data.name || '').trim() || ctx.autoBotName(room));
    bot.isBot = true;
    // v1.4.0：人机级别（idle 挂机 / easy 简单 / smart 智能）；v1.5.0 增加 simulate（态度模型档）；非法值忽略，走房间 botMode 映射
    if (data.level === 'idle' || data.level === 'easy' || data.level === 'smart' || data.level === 'simulate') bot.botLevel = data.level;
    // 1.7.17（D2 前置）：per-bot 嫌疑分混合权重（多样化 bot 变体——BOT_SUSPICION_W 的 per-bot 版）
    if (data.suspicionW != null) bot.suspicionW = parseFloat(data.suspicionW);
    if (data.followMode === 'strict' || data.followMode === 'loose' || data.followMode === 'none') bot.followMode = data.followMode; // 跟票变体
    // V5.2 策略池：per-bot 投票策略/π 模型路径（覆盖全局 env；生产默认不设）
    if (data.voteStrategy && ['pi', 'pi-snap', 'pi-pure', 'pi-snap-pure', 'dv'].includes(data.voteStrategy)) bot.voteStrategy = data.voteStrategy;
    if (data.piModel) bot.piModel = String(data.piModel);
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
    ctx.removePlayer(room, t.id);
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
    ctx.startGame(room);
    return { ok: true };
  }
  return { error: '未知操作' };
}

register("uid", uid);
register("newToken", newToken);
register("roomRng", roomRng);
register("randInt", randInt);
register("shuffle", shuffle);
register("checkInvariants", checkInvariants);
register("sysMsg", sysMsg);
register("pushEvent", pushEvent);
register("bump", bump);
register("clearPhaseTimer", clearPhaseTimer);
register("schedulePhase", schedulePhase);
register("autoBeginNight", autoBeginNight);
register("autoThiefPick", autoThiefPick);
register("handoverTimeout", handoverTimeout);
register("lastwordTimeout", lastwordTimeout);
register("byId", byId);
register("byToken", byToken);
register("rolePlayer", rolePlayer);
register("expandCounts", expandCounts);
register("effRole", effRole);
register("cupidCamp", cupidCamp);
register("computeCupidCamp", computeCupidCamp);
register("campOf", campOf);
register("typeOf", typeOf);
register("checkCamp", checkCamp);
register("isWolfRole", isWolfRole);
register("roleText", roleText);
register("campText", campText);
register("defaultCounts", defaultCounts);
register("validateConfig", validateConfig);
register("newRoomCode", newRoomCode);
register("createRoom", createRoom);
register("nextFreeSeat", nextFreeSeat);
register("addPlayer", addPlayer);
register("joinRoom", joinRoom);
register("lobbyAction", lobbyAction);

// 导出全部共享变量/模块/setter
module.exports = { ctx, register, loverCore, clock, chatRecorder, ROLE_INFO, WOLF_ROLES, ROOM_CODE_CHARS, rooms, onChange, onBroken, VALID_NIGHT_STEPS, PHASE_TIMEOUT, NIGHT_TIMEOUT, MOODS, createBotDecision, botWolfChat, resetBotPerGame, injectGrudge, loverCore, clock, chatRecorder, voteFeatures, createRng, createBotDecision, botWolfChat, resetBotPerGame, injectGrudge, setOnChange(fn) { onChange = fn; }, setOnBroken(fn) { onBroken = fn; } };
