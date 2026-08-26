// 自动生成（game.js 拆分——actions 模块，勿手改，重新运行 tools/split-game.js）

const fs = require('fs');
const shared = require('./shared');
const ctx = shared.ctx;
const { register } = shared;
const { loverCore, rooms, MOODS, createRng, voteFeatures } = shared;

function debugRoom(opts = {}) {
  const r = ctx.createRoom('调试房主');
  const room = rooms.get(r.roomId);
  if (opts.seed != null) room.rng = createRng(opts.seed);          // 摆盘也可确定性
  const cap = opts.cap || (opts.roles ? opts.roles.length : 6);
  room.playerCap = cap;
  room.roleCounts = opts.counts || ctx.defaultCounts(cap);
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
    for (const s of ctx.nightSteps(room)) {
      if (s === room.nightStep) break;
      ctx.nightActors(room, s).forEach(id => ctx.markActed(room, s, id));
    }
  }
  ctx.bump(room);
  return room;
}

function autoAdvanceInner(room) {
  let guard = 0;
  while (guard++ < 60) {
    if (room.phase === 'ended') return;
    if (room.phase === 'reveal') {
      if (room.reveal.dealt && room.players.every(q => q.confirmed || q.leftGame) && !room.reveal.thiefPicked) { ctx.beginNight(room); continue; }
      return;
    }
    if (room.phase === 'night') {
      if (room.nightStep === 'hunter') return; // 等待猎人开枪，不可自动跳过
      if (room.nightStep) {
        if (ctx.stepDone(room, room.nightStep)) { ctx.setNightStep(room); continue; }
        return;
      }
      return;
    }
    if (room.phase === 'lastword') {
      if (room.lastWorders.every(id => room.lastWordDone[id])) { ctx.afterLastWord(room); continue; }
      return;
    }
    if (room.phase === 'sheriff_campaign') {
      if (room.players.filter(q => q.alive).every(q => room.campaignDecided[q.id])) { ctx.beginSheriffVote(room); continue; }
      return;
    }
    if (room.phase === 'sheriff_vote') {
      if (ctx.allAliveVoted(room)) { ctx.resolveSheriffVote(room); continue; }
      return;
    }
    if (room.phase === 'vote') {
      if (ctx.allAliveVoted(room)) { ctx.resolveExileVote(room); continue; }
      return;
    }
    if (room.phase === 'pk_vote') {
      if (ctx.allAliveVoted(room)) { ctx.resolvePkVote(room); continue; }
      return;
    }
    return;
  }
}
function autoAdvance(room) {
  try { autoAdvanceInner(room); }
  finally { ctx.maybeRunBots(room); } // 阶段推进后：若有待行动人机，安排执行
}

/* ---------------------------- 统一入口 ---------------------------- */
function applyAction(room, p, action, data) {
  let res;
  switch (room.phase) {
    case 'lobby': res = ctx.lobbyAction(room, p, action, data); break;
    case 'reveal': res = ctx.revealAction(room, p, action, data); break;
    case 'night': res = ctx.nightAction(room, p, action, data); break;
    default: res = ctx.dayAction(room, p, action, data); break;
  }
  if (res && res.ok) {
    // 1.7.0（B1-2）vote 样本采集钩子（lab 平台）——只采好人 bot 在正式投票阶段（phase==='vote'）的决策时刻特征；
    // v1.7.2（A-2b）：采集移到 actionLog.push 之前——保证 bot_prev_same 读到的是"上轮投票"（推理时 buildVoteWorld 在决策前，actionLog 同样不含本次）；
    // v1.7.2（B-4）：仅 phase==='vote' 采集，排除竞选/平票投票（day1 无信息时刻的噪声样本）；
    // label 用真实身份（训练侧）；特征只含公开信息（features.js）；批量落盘防单条 append 开销；采集失败绝不影响对局
    if (action === 'vote' && room.phase === 'vote' && room.labSampleFile && p.isBot && !ctx.isWolfRole(p) && data && data.target) {
      const useV5 = process.env.V5_SAMPLES === '1'; // V5 A2：意图特征采集开关
      const featFn = useV5 ? require('../ai/intent-features.js').voteFeaturesV5 : voteFeatures;
      const f = featFn(room, p.id, data.target);
      if (f) {
        const by = ctx.byId(room, data.target);
        room.labSampleBuf = room.labSampleBuf || [];
        room.labSampleBuf.push(JSON.stringify({ gameId: room.labGameId || 'x', day: room.dayNum || 0, botId: p.id, candId: data.target, features: f, label: by ? (ctx.isWolfRole(by) ? 1 : 0) : 0, v5: useV5 ? true : false }));
        if (room.labSampleBuf.length >= 500) flushLabSamples(room);
      }
    }
    // v1.7.7（α3）：夜刀样本采集（wolf_set 成功且 bot 狼出刀）——狼侧刀神分类器训练数据；
    // 与 vote 钩子同模式：特征只含公开信息（wolfTrain/features 复用 voteFeatures 13 维），label 用真实身份（是否神职）
    if (action === 'wolf_set' && room.labSampleFile && p.isBot && ctx.isWolfRole(p) && data && data.kill) {
      try {
        // v1.7.7（α3）：采集“被杀者 + 随机对照”（去选择偏置）——每夜每狼 bot 决策时采 1+upTo 个样本
        const smps = require('../../wolfTrain/collector.js').collectKillSamples(room, p.id, data.kill, 3);
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
function handleMusic(roomId, pid, action, data) {
  // v1.7.30（全局播放）：任何人可控制播放（play/pause/next/prev/seek/mode/playAt）——歌曲增减（apply/approve/reject）仍限房主
  // 时间戳同步：每次播放动作记录 { ts: 服务端时间戳, pos: 起点进度 }——跟随端按服务端时钟对齐（方案 B，精度≈网络延迟）
  const room = rooms.get(roomId);
  if (!room) return { error: '房间不存在' };
  const p = ctx.byId(room, pid);
  if (!p) return { error: '玩家不存在' };
  if (!room.music) room.music = { list: [], reviews: [], idx: -1, cur: null, playing: false, mode: 0, prog: 0, ts: 0, pos: 0, who: '', lastNextAt: 0 };
  const m = room.music;
  const hostOnly = action === 'apply' || action === 'approve' || action === 'reject';
  if (hostOnly && room.host !== pid) return { error: '只有房主可以管理歌单' };
  const now = Date.now();
  if (action === 'play' || action === 'pause') {
    if (action === 'play' && m.playing) return { ok: true, music: m }; // 已在播放——幂等
    if (action === 'pause' && !m.playing) return { ok: true, music: m }; // 已暂停——幂等
    if (action === 'play') { m.playing = true; m.pos = m.prog; m.ts = now; }
    else { m.prog = m.pos + (now - m.ts) / 1000; m.playing = false; m.ts = now; m.pos = m.prog; }
    m.who = p.name;
    ctx.bump(room);
    return { ok: true, music: m };
  }
  if (action === 'next' || action === 'prev') {
    // v1.7.30：next 去重——全员 ended 会同时广播 next（同曲同位置），2s 窗口内重复 next 忽略
    if (now - m.lastNextAt < 2000) return { ok: true, music: m };
    if (!m.list.length) return { error: '歌单为空' };
    const n = m.list.length;
    m.idx = action === 'next' ? (m.idx + 1) % n : (m.idx - 1 + n) % n;
    m.playing = true; m.pos = 0; m.ts = now; m.prog = 0; m.who = p.name; m.lastNextAt = now;
    ctx.bump(room);
    return { ok: true, music: m };
  }
  if (action === 'seek') {
    m.pos = Math.max(0, Number(data && data.prog) || 0);
    m.ts = now; m.prog = m.pos; m.who = p.name;
    ctx.bump(room);
    return { ok: true, music: m };
  }
  if (action === 'mode') {
    m.mode = (Number(data && data.mode) || 0) % 3;
    m.who = p.name;
    ctx.bump(room);
    return { ok: true, music: m };
  }
  if (action === 'playAt') {
    if (!data || !data.url) return { error: '参数错误' };
    const u = String(data.url);
    if (!/^https?:\/\//i.test(u) && !u.startsWith('music/') && !u.startsWith('/music/')) return { error: '仅支持 http/https 或站内 music/ 路径' };
    m.cur = { url: u.slice(0, 300), name: String(data.name || '未知歌曲').slice(0, 40), src: String(data.src || 'official').slice(0, 12) };
    m.playing = true; m.pos = 0; m.ts = now; m.prog = 0; m.who = p.name;
    ctx.bump(room);
    return { ok: true, music: m };
  }
  if (action === 'apply') {
    if (!data || !data.url || !data.name) return { error: '参数错误' };
    m.reviews.push({ id: ctx.uid().slice(0, 6), url: String(data.url).slice(0, 300), name: String(data.name).slice(0, 40), from: p.name });
    ctx.bump(room);
    return { ok: true, music: m };
  }
  if (action === 'approve' || action === 'reject') {
    const id = data && data.id;
    const ri = m.reviews.findIndex(r => r.id === id);
    if (ri === -1) return { error: '申请不存在' };
    const [r] = m.reviews.splice(ri, 1);
    if (action === 'approve') m.list.push({ url: r.url, name: r.name, src: 'member' });
    ctx.bump(room);
    return { ok: true, music: m };
  }
  return { error: '未知操作' };
}

function handleAction(roomId, pid, action, data, chatSince) {
  const room = rooms.get(roomId);
  if (!room) return { error: '房间不存在或已解散' };
  const p = ctx.byId(room, pid);
  if (!p) return { error: '玩家不存在' };
  if (p.leftGame) return { error: '你已离开房间' }; // 防已离开玩家刷操作（刷版本号）
  // 心情表情：任意阶段可切换（点击自己的表情按钮循环，null=关闭）
  if (action === 'mood') { // 心情表情（MOODS 在模块级定义，经视图下发保证前后端一致 N6）
    const mood = data.mood == null ? null : String(data.mood).slice(0, 8);
    if (mood && !MOODS.includes(mood)) return { error: '无效的表情' };
    p.mood = mood;
    ctx.bump(room);
    return { ok: true, view: ctx.viewFor(room, pid, chatSince || 0) };
  }
  const res = applyAction(room, p, action, data);
  if (res && res.ok) return { ok: true, view: ctx.viewFor(room, pid, chatSince || 0), left: !!res.left };
  return { error: res.error || '操作失败' };
}
function handleChat(roomId, pid, data, chatSince) {
  const room = rooms.get(roomId);
  if (!room) return { error: '房间不存在或已解散' };
  const p = ctx.byId(room, pid);
  if (!p) return { error: '玩家不存在' };
  if (p.leftGame) return { error: '你已离开房间' };
  const res = ctx.chatAction(room, p, data);
  if (res.ok) return { ok: true, view: ctx.viewFor(room, pid, chatSince || 0) };
  return { error: res.error };
}
function handleAdvance(roomId, pid, chatSince) {
  const room = rooms.get(roomId);
  if (!room) return { error: '房间不存在或已解散' };
  const res = ctx.advance(room, pid);
  if (res.ok) {
    autoAdvance(room);
    return { ok: true, view: ctx.viewFor(room, pid, chatSince || 0) };
  }
  return { error: res.error };
}
function handleLeave(roomId, pid) {
  const room = rooms.get(roomId);
  if (!room) return { ok: true };
  ctx.removePlayer(room, pid);
  return { ok: true };
}
function handleKick(roomId, pid, target, chatSince) {
  const room = rooms.get(roomId);
  if (!room) return { error: '房间不存在或已解散' };
  if (pid !== room.host) return { error: '只有房主可以踢人' };
  ctx.removePlayer(room, target);
  return { ok: true, view: ctx.viewFor(room, pid, chatSince || 0) };
}

/* ============================ 人机玩家（房主调试功能） ============================
 * 人机 = 服务端自动行动的正常玩家（p.isBot = true），所有决策复用与真人相同的
 * action 入口（applyAction），保证校验与结算一致。
 * settings.botMode 控制难度：
 *   'auto'   简单AI：夜晚按职业启发式决策（狼优先刀好人/女巫常规用药等），白天随机投票；
 *   'passive'挂机：只补必要动作（被刀自救/全员人机时补狼刀），白天一律弃票。
 * 队内有人类时，人机只补 confirm、绝不覆盖人类的共享选择（狼刀/魅惑）。
 */

register("debugRoom", debugRoom);
register("autoAdvanceInner", autoAdvanceInner);
register("autoAdvance", autoAdvance);
register("applyAction", applyAction);
register("flushLabSamples", flushLabSamples);
register("handleMusic", handleMusic);
register("handleAction", handleAction);
register("handleChat", handleChat);
register("handleAdvance", handleAdvance);
register("handleLeave", handleLeave);
register("handleKick", handleKick);

module.exports = {};
