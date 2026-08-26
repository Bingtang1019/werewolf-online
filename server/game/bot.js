// 自动生成（game.js 拆分——bot 模块，勿手改，重新运行 tools/split-game.js）

const shared = require('./shared');
const ctx = shared.ctx;
const { register } = shared;
const { clock, rooms, createBotDecision, botWolfChat } = shared;

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

/* 房主托管：真人房主在服务端被当作“待代行动玩家”调度，但 isBot 仍为 false（视图仍显示真人/房主） */
function isAutoActing(p) {
  return !!(p && (p.isBot || p.hostAutoplay) && !p.leftGame);
}

/* 当前阶段需要人机行动的玩家列表 */
function pendingBotActors(room) {
  if (room.phase === 'lobby' || room.phase === 'ended') return [];
  switch (room.phase) {
    case 'reveal': {
      const rv = room.reveal;
      if (!rv) return [];
      if (room.settings.thief && rv.stage === 'thiefPick' && rv.thiefId) {
        const t = ctx.byId(room, rv.thiefId);
        return t && isAutoActing(t) && !rv.thiefPicked ? [t] : [];
      }
      if (!rv.dealt && rv.stage === 'hostChoice' && !rv.hostPicked) {
        const h = ctx.byId(room, room.host);
        return h && h.hostAutoplay ? [h] : [];
      }
      if (rv.dealt) return room.players.filter(p => isAutoActing(p) && !p.confirmed && !p.leftGame);
      return [];
    }
    case 'night': {
      if (room.nightStep === 'hunter') {
        const sh = room.shooter ? ctx.byId(room, room.shooter) : null;
        return sh && isAutoActing(sh) && !(room.nightActed['hunter'] || {})[sh.id] ? [sh] : [];
      }
      const actors = ctx.nightActors(room, room.nightStep || '');
      if (!actors.length) return [];
      const acted = room.nightActed[room.nightStep] || {};
      return actors.filter(id => !acted[id]).map(id => ctx.byId(room, id)).filter(p => p && isAutoActing(p));
    }
    case 'lastword':
      return room.lastWorders.filter(id => !room.lastWordDone[id]).map(id => ctx.byId(room, id)).filter(p => p && isAutoActing(p));
    case 'handover': {
      const sh = room.handoverFrom ? ctx.byId(room, room.handoverFrom) : null;
      return sh && isAutoActing(sh) ? [sh] : [];
    }
    case 'sheriff_campaign':
      return room.players.filter(p => isAutoActing(p) && p.alive && !room.campaignDecided[p.id]);
    case 'sheriff_vote':
    case 'vote':
    case 'pk_vote':
      return room.players.filter(p => isAutoActing(p) && p.alive && !room.votes.hasOwnProperty(p.id));
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
        if (!isAutoActing(p) || !p.alive) return false;
        const n = bt ? (bt[p.id] || 0) : 0;
        if (n < quota) return true;
        if (humanRatio > 0.5 && n < quota + 1 && challenged(p)) return true; // 被质疑时允许额外 1 条回应
        return false;
      });
    }
    case 'hunter_shot': {
      const sh = room.shooter ? ctx.byId(room, room.shooter) : null;
      return sh && isAutoActing(sh) ? [sh] : [];
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
        ctx.chatAction(room, b, dec.data);
        markBotTalked(room, b);
        continue;
      }
      // v1.4.4：狼人出刀前先在狼频道沟通（须在 applyAction 前——wolf_set 成功后 setNightStep 会把 phase 推进到非 night，狼频道权限随之失效）
      if (dec.action === 'wolf_set') {
        try {
          const wt = botWolfChat(room, b);
          if (process.env.BOT_DEBUG) console.log('[runBots]', b.name, '狼频道:', wt ? JSON.stringify(wt) : 'null');
          if (wt) ctx.chatAction(room, b, wt.data);
        } catch (e) { if (process.env.BOT_DEBUG) console.log('[runBots] 狼频道异常:', e && e.message); }
      }
      const res = ctx.applyAction(room, b, dec.action, dec.data);
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
  if (!room.players.some(p => p.isBot || p.hostAutoplay)) return;
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

register("autoBotName", autoBotName);
register("botDelay", botDelay);
register("pendingBotActors", pendingBotActors);
register("botDecision", botDecision);
register("markBotTalked", markBotTalked);
register("runBots", runBots);
register("maybeRunBots", maybeRunBots);

module.exports = {};
