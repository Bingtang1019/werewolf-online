'use strict';
/* 单局执行器：确定性驱动（等 bot 行动/投票/发言达配额再推进，消除调度竞态）
 * + 错误分类（config/engine/stall）+ 事件收集 → GameRecord
 * 依赖方向：scenario → core → game.js（core 不 import stats）
 * lab 是模拟平台：快节奏（botDelay/阶段超时只影响调度时序，不影响决策序列——B1-8 保证）
 * 注意：必须在 require game.js 之前设置 env（game.js 加载时读取）
 */
process.env.BOT_DELAY_MS = '100';
process.env.PHASE_TIMEOUT = '30';
process.env.NIGHT_TIMEOUT = '20';
process.env.SNAPSHOT_SEC = '0'; // 实验室不落盘快照
const Game = require('../../../game.js');
const { createRng } = require('../../../server/ai/rng.js');
const { normalizeEvent } = require('./events');

const ADVANCE_PHASES = ['reveal', 'morning', 'handover', 'lastword', 'sheriff_campaign', 'pk_speech', 'discuss', 'campaign'];
const VOTE_PHASES = ['vote', 'sheriff_vote', 'pk_vote'];

/** 字符串种子 → uint32（确定性验证/配对的关键：同字符串 → 同随机流） */
function seedToInt(s) {
  let h = 2166136261;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h || 1;
}

function safeAction(room, host, type, payload, expectPhase) {
  let res;
  try { res = Game.handleAction(room.id, host, type, payload); }
  catch (e) { throw { kind: 'engine', message: `${type} 抛出: ${e.message}` }; }
  if (res && res.error) throw { kind: 'config', message: `${type}: ${JSON.stringify(res.error)}` };
  if (expectPhase && room.phase !== expectPhase) throw { kind: 'config', message: `${type} 后期望 ${expectPhase} 实际 ${room.phase}` };
}

function clearTimers(room) {
  for (const t of ['_phaseTimer', '_nightTimer', '_nightStepTimer', '_thiefTimer', '_hunterTimer', '_botTimer']) {
    if (room[t]) clearTimeout(room[t]);
  }
}

/** 跑一局，返回 GameRecord。config: {cap,counts,botLine,winMode,seed,scenario}；gameId 全局唯一 */
async function runRoom(config, gameId) {
  if (config.seed) global.rng = createRng(seedToInt(config.seed)); // B1-8：种子注入（配对/确定性模式的核心）
  const r = Game.createRoom('房主');
  const room = Game.rooms.get(r.roomId);
  const host = r.playerId;
  const t0 = Date.now();
  const cfgBlock = { cap: config.cap, counts: config.counts, botLine: config.botLine, winMode: config.winMode, tieRule: 'pk' };
  const base = {
    schema: 'lab.game-record@1', gameId, seed: config.seed || null, scenario: config.scenario,
    startedAt: new Date(t0).toISOString(), config: cfgBlock,
  };
  try {
    safeAction(room, host, 'settings', { sheriff: false, thief: false, winMode: config.winMode, tieRule: 'pk', botMode: 'auto' });
    safeAction(room, host, 'setCounts', { counts: config.counts });
    safeAction(room, host, 'setCap', { cap: config.cap });
    for (const level of config.botLine) safeAction(room, host, 'add_bot', { level });
    safeAction(room, host, 'start');
    if (room.players.length !== config.cap) throw { kind: 'config', message: `start 后人数 ${room.players.length} != ${config.cap}` };
    safeAction(room, host, 'hostPick', { role: 'villager' });

    let guard = 0, stallMs = 0, lastSig = '', discussWait = 0;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    while (guard++ < 12000) { // 硬上限 ~10 分钟
      const phase = room.phase;
      if (phase === 'ended') break;
      const sig = `${phase}|${room.nightNum || 0}|${room.nightStep || ''}`;
      if (sig === lastSig) { stallMs += 20; if (stallMs > 45000) break; } // 阶段 45s 无变化 → stall
      else { stallMs = 0; lastSig = sig; }
      if (phase === 'night') {
        if (room.nightStep === 'hunter') { await sleep(20); continue; } // bot 猎人自动开枪
        const v = Game.viewFor(room, host, 0);
        const pending = (v.night && v.night.actors || []).filter(a => !a.acted)
          .map(a => room.players.find(p => p.id === a.id)).filter(p => p && p.isBot);
        if (pending.length) { await sleep(20); continue; } // 等 bot 行动（host 是平民，无夜晚行动）
        Game.handleAdvance(room.id, host, 0);
      } else if (phase === 'discuss') {
        const bt = room.botTalked && room.botTalked.day === room.dayNum ? room.botTalked.ids : {};
        const done = room.players.filter(p => p.alive && p.isBot).every(b => (bt[b.id] || 0) >= 2); // 全 bot 局人类占比低 → 配额 2
        if (done || (++discussWait) > 400) { discussWait = 0; Game.handleAdvance(room.id, host, 0); } // 8s 上限防卡死
        else await sleep(20);
      } else if (VOTE_PHASES.includes(phase)) {
        const pending = room.players.filter(p => p.alive && p.isBot && !room.votes.hasOwnProperty(p.id));
        if (pending.length) { await sleep(20); continue; } // 等 bot 投完
        if (!room.votes.hasOwnProperty(host)) Game.handleAction(room.id, host, 'vote', { target: null }); // host 弃票 → allAliveVoted 结算
      } else if (phase === 'sheriff_campaign') {
        const pending = room.players.filter(p => p.alive && p.isBot && !room.campaignDecided[p.id]);
        if (pending.length) { await sleep(20); continue; }
        Game.handleAdvance(room.id, host, 0);
      } else if (ADVANCE_PHASES.includes(phase)) {
        Game.handleAdvance(room.id, host, 0);
      } else {
        await sleep(20); // 未知阶段：等待
      }
      await sleep(5);
    }
    const durMs = Date.now() - t0;
    const ended = room.phase === 'ended';
    const err = ended ? null : { kind: 'stall', message: `阶段 ${room.phase} 未结束` };
    const roles = (room.endInfo && room.endInfo.roles) || [];
    const players = roles.map((x, i) => ({ seat: x.seat != null ? x.seat : i, id: x.id, role: x.role, camp: x.camp, isBot: x.isBot != null ? x.isBot : true }));
    let firstKill = null;
    for (const e of (room.events || [])) if (e.type === 'wolf_kill' && e.night === 1 && e.data && e.data.kill) { firstKill = e.data.kill; break; }
    return Object.assign({}, base, {
      endedAt: new Date().toISOString(), durMs,
      result: { winner: room.endInfo ? room.endInfo.winner : null, timeout: !ended, error: err },
      players, events: (room.events || []).map(normalizeEvent),
      firstKill: firstKill ? { id: firstKill, camp: roles.find(x => x.id === firstKill) ? roles.find(x => x.id === firstKill).camp : '?' } : null,
    });
  } catch (e) {
    return Object.assign({}, base, {
      endedAt: new Date().toISOString(), durMs: Date.now() - t0,
      result: { winner: null, timeout: true, error: e.kind ? e : { kind: 'engine', message: e.message } },
      players: [], events: [], firstKill: null,
    });
  } finally {
    clearTimers(room);
    Game.rooms.delete(room.id);
  }
}
module.exports = { runRoom, seedToInt };
