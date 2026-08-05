'use strict';
/* ============================================================================
 * B1-0 确定性验证（1.7.0，前置 B1-8 RNG 注入已完成）
 * 同种子跑两遍全 bot 对局 → actionLog 逐字节一致（RNG 注入是否彻底的第一关）。
 * 驱动消除调度竞态：夜晚/投票等 bot 行动完成后再推进；discuss 等 bot 发言达配额。
 * 运行：node tools/ai/determinism-check.js --seed=42 --cap=8 --bots=smart [--games=1]
 * 说明：两遍各自重置全局 RNG（SEED）→ 房间 RNG 派生一致 → 决策随机全走房间 RNG；
 *       player id 随机（uid），对比时按座位号归一化（actor 已是 seat，data 内 id → S<seat>）。
 * ============================================================================ */
process.env.BOT_DELAY_MS = '100';
process.env.PHASE_TIMEOUT = '30';
process.env.NIGHT_TIMEOUT = '20';
const Game = require('../../game.js');
const { createRng } = require('../../server/ai/rng.js');

const args = {};
process.argv.slice(2).forEach(a => { const m = a.match(/^--([^=]+)=(.*)$/); if (m) args[m[1]] = m[2]; });
const SEED = parseInt(args.seed || '42', 10);
const CAP = Math.max(4, Math.min(18, parseInt(args.cap || '8', 10)));
const BOTS = args.bots || 'smart';
const GAMES = Math.max(1, parseInt(args.games || '1', 10));
const defaultCounts = cap => { const wolf = cap >= 5 ? 2 : 1; const witch = cap >= 5 ? 1 : 0; return { wolf, seer: 1, witch, hunter: 0, dreamer: 0, guard: 0, wolfBeauty: 0, cupid: 0, villager: cap - wolf - 1 - witch }; };
const COUNTS = defaultCounts(CAP);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function clearRoomTimers(room) {
  if (room._phaseTimer) clearTimeout(room._phaseTimer);
  if (room._nightTimer) clearTimeout(room._nightTimer);
  if (room._nightStepTimer) clearTimeout(room._nightStepTimer);
  if (room._thiefTimer) clearTimeout(room._thiefTimer);
  if (room._hunterTimer) clearTimeout(room._hunterTimer);
  if (room._botTimer) clearTimeout(room._botTimer);
}

/* 对局驱动（确定性版）：bot 行动完成再推进；host（真人，平民）固定弃票/推进 */
async function runOne(seed) {
  global.rng = createRng(seed); // 每遍重置全局 RNG → 房间派生一致
  const r = Game.createRoom('房主');
  const room = Game.rooms.get(r.roomId);
  const host = r.playerId;
  try {
    Game.handleAction(room.id, host, 'settings', { sheriff: true, thief: false, winMode: 'edge', tieRule: 'pk', botMode: 'auto' });
    Game.handleAction(room.id, host, 'setCounts', { counts: COUNTS });
    Game.handleAction(room.id, host, 'setCap', { cap: CAP });
    for (let i = 0; i < CAP - 1; i++) Game.handleAction(room.id, host, 'add_bot', { level: BOTS });
    Game.handleAction(room.id, host, 'start');
    Game.handleAction(room.id, host, 'hostPick', { role: 'villager' });
    let guard = 0, discussWait = 0;
    while (guard++ < 60000) {
      const phase = room.phase;
      if (phase === 'ended') break;
      if (phase === 'reveal') { Game.handleAdvance(room.id, host, 0); }
      else if (phase === 'night') {
        if (room.nightStep === 'hunter') { await sleep(20); continue; } // bot 猎人自动开枪（maybeRunBots）
        const v = Game.viewFor(room, host, 0);
        const pending = (v.night && v.night.actors || []).filter(a => !a.acted).map(a => room.players.find(p => p.id === a.id)).filter(p => p && p.isBot);
        if (pending.length) { await sleep(20); continue; } // 等 bot 行动（host 是平民，无夜晚行动）
        Game.handleAdvance(room.id, host, 0);
      }
      else if (phase === 'discuss') {
        // 等 bot 发言达配额（A4 动态：人类占比 1/CAP ≤0.5 → 配额 2），超 8s 强制推进防卡死
        const bt = room.botTalked && room.botTalked.day === room.dayNum ? room.botTalked.ids : {};
        const quota = 2;
        const done = room.players.filter(p => p.alive && p.isBot).every(b => (bt[b.id] || 0) >= quota);
        if (done || (++discussWait) > 400) { discussWait = 0; Game.handleAdvance(room.id, host, 0); }
        else await sleep(20);
      }
      else if (phase === 'vote' || phase === 'sheriff_vote' || phase === 'pk_vote') {
        const pending = room.players.filter(p => p.alive && p.isBot && !room.votes.hasOwnProperty(p.id));
        if (pending.length) { await sleep(20); continue; } // 等 bot 投完
        if (!room.votes.hasOwnProperty(host)) Game.handleAction(room.id, host, 'vote', { target: null }); // host 弃票 → allAliveVoted 结算
      }
      else if (phase === 'sheriff_campaign') {
        const pending = room.players.filter(p => p.alive && p.isBot && !room.campaignDecided[p.id]);
        if (pending.length) { await sleep(20); continue; }
        Game.handleAdvance(room.id, host, 0);
      }
      else { Game.handleAdvance(room.id, host, 0); }
      await sleep(5);
    }
    return { room, timedOut: room.phase !== 'ended', winner: room.endInfo ? room.endInfo.winner : null };
  } finally {
    clearRoomTimers(room);
    Game.rooms.delete(room.id);
  }
}

/* 玩家 id → 座位号归一化（data 内的 id 字段；数组如 ids 逐元素） */
function normalize(log, room) {
  const seatOf = id => { const p = room.players.find(x => x.id === id); return p ? p.seat : null; };
  return (log || []).map(a => {
    const d = {};
    for (const k of Object.keys(a.data || {})) {
      const v = a.data[k];
      if (typeof v === 'string' && seatOf(v)) d[k] = 'S' + seatOf(v);
      else if (Array.isArray(v)) d[k] = v.map(x => (typeof x === 'string' && seatOf(x)) ? 'S' + seatOf(x) : x);
      else d[k] = v;
    }
    return { n: a.n, phase: a.phase, step: a.step, actor: 'S' + a.actor, action: a.action, data: d };
  });
}

function firstDiff(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (!x || !y || JSON.stringify(x) !== JSON.stringify(y)) return { i, x: x || null, y: y || null };
  }
  return null;
}

async function main() {
  console.log(`[determinism] seed=${SEED} cap=${CAP} bots=${BOTS} games=${GAMES}`);
  let allOk = true;
  for (let g = 0; g < GAMES; g++) {
    const runA = await runOne(SEED);
    const runB = await runOne(SEED);
    const logA = normalize(runA.room.actionLog, runA.room);
    const logB = normalize(runB.room.actionLog, runB.room);
    const sameLen = logA.length === logB.length;
    const diff = sameLen ? firstDiff(logA, logB) : { i: Math.min(logA.length, logB.length), x: null, y: null };
    const winnerSame = runA.winner === runB.winner && runA.timedOut === runB.timedOut;
    const ok = !diff && winnerSame;
    if (ok) {
      console.log(`  game${g + 1}: ✓ 一致（${logA.length} 条动作，winner=${runA.winner || (runA.timedOut ? '超时' : '?')}）`);
    } else {
      allOk = false;
      console.log(`  game${g + 1}: ✗ 不一致！winner A=${runA.winner || (runA.timedOut ? '超时' : '?')} B=${runB.winner || (runB.timedOut ? '超时' : '?')} 长度 ${logA.length}/${logB.length}`);
      if (diff) {
        console.log('    第', diff.i + 1, '条差异:');
        console.log('    A:', JSON.stringify(diff.x));
        console.log('    B:', JSON.stringify(diff.y));
      }
    }
  }
  if (!allOk) { console.error('\nRNG 注入未彻底或存在调度竞态 —— 检查差异点'); process.exit(1); }
  console.log('\n确定性验证通过 ✔（同种子对局决策序列逐字节一致）');
  process.exit(0);
}
main().catch(e => { console.error('异常:', e.message); process.exit(1); });
