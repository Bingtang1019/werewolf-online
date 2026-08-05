'use strict';
/* ============================================================================
 * 蒙特卡洛平衡实验室（v1.6.0）
 * 用引擎 + 人机（smart/simulate）批量自动对局，量化阵营/角色胜率、首刀分布、平均局时。
 * 运行：node test/check-balance-lab.js --games=10 --cap=8 --bots=smart --winMode=edge
 *       --counts=wolf2,seer1,witch1,villager4 （可选，默认按 cap 自动配）
 * 说明：纯工具，不进全量回归（批量对局耗时）；结果给规则平衡提供数据依据。
 * ============================================================================ */
process.env.BOT_DELAY_MS = '100';
process.env.PHASE_TIMEOUT = '30';
process.env.NIGHT_TIMEOUT = '20';
const Game = require('../game.js');

const args = {};
process.argv.slice(2).forEach(a => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) args[m[1]] = m[2];
});
const GAMES = Math.max(1, parseInt(args.games || '10', 10));
const CAP = Math.max(4, Math.min(18, parseInt(args.cap || '8', 10)));
const BOTS = args.bots || 'smart';
const WINMODE = args.winMode || 'edge';
const parseCounts = s => {
  const c = {};
  String(s || '').split(',').forEach(x => { const m = x.match(/^(\w+)(\d+)$/); if (m) c[m[1]] = parseInt(m[2], 10); });
  return c;
};const defaultCounts = cap => {
  const wolf = cap >= 5 ? 2 : 1;
  const witch = cap >= 5 ? 1 : 0;
  return { wolf, seer: 1, witch, hunter: 0, dreamer: 0, guard: 0, wolfBeauty: 0, cupid: 0, villager: cap - wolf - 1 - witch };
};
const _parsedCounts = parseCounts(args.counts);
const COUNTS = Object.keys(_parsedCounts).length ? _parsedCounts : defaultCounts(CAP);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function clearRoomTimers(room) {
  if (room._phaseTimer) clearTimeout(room._phaseTimer);
  if (room._nightTimer) clearTimeout(room._nightTimer);
  if (room._nightStepTimer) clearTimeout(room._nightStepTimer);
  if (room._thiefTimer) clearTimeout(room._thiefTimer);
  if (room._hunterTimer) clearTimeout(room._hunterTimer);
  if (room._botTimer) clearTimeout(room._botTimer);
}

async function runOne() {
  const r = Game.createRoom('房主');
  const room = Game.rooms.get(r.roomId);
  const host = r.playerId;
  const t0 = Date.now();
  try {
    Game.handleAction(room.id, host, 'settings', { sheriff: false, thief: false, winMode: WINMODE, tieRule: 'pk', botMode: 'auto' });
    Game.handleAction(room.id, host, 'setCounts', { counts: COUNTS });
    Game.handleAction(room.id, host, 'setCap', { cap: CAP });
    for (let i = 0; i < CAP - 1; i++) Game.handleAction(room.id, host, 'add_bot', { level: BOTS });
    Game.handleAction(room.id, host, 'start');
    Game.handleAction(room.id, host, 'hostPick', { role: 'villager' });
    let guard = 0;
    while (guard++ < 60000) { // 上限 ~5 分钟/局
      const phase = room.phase;
      if (phase === 'ended') break;
      if (phase === 'reveal') {
        // 发牌后房主强推进夜（跳过 5s 定时器与 bot 确认仪式）
        Game.handleAdvance(room.id, host, 0);
      } else if (phase === 'morning' || phase === 'discuss' || phase === 'handover' || phase === 'lastword' || phase === 'sheriff_campaign' || phase === 'pk_speech') {
        Game.handleAdvance(room.id, host, 0);
      } else if (phase === 'vote' || phase === 'sheriff_vote' || phase === 'pk_vote') {
        if (!room.votes.hasOwnProperty(host)) Game.handleAction(room.id, host, 'vote', { target: null }); // 房主弃票
      }
      await sleep(50);
    }
    const dur = Date.now() - t0;
    const timedOut = room.phase !== 'ended';
    // 首刀：事件流里第一夜狼刀目标（无论是否被救）
    let firstKill = null;
    for (const e of (room.events || [])) { if (e.type === 'wolf_kill' && e.night === 1 && e.data.kill) { firstKill = e.data.kill; break; } }
    const result = { dur, timedOut, winner: room.endInfo ? room.endInfo.winner : null, firstKill };
    // 首刀者阵营（通过 endInfo.roles 的 camp）
    if (firstKill && room.endInfo) {
      const fr = room.endInfo.roles.find(x => x.id === firstKill);
      result.firstKillCamp = fr ? fr.camp : '?';
    }
    return result;
  } finally {
    clearRoomTimers(room);
    Game.rooms.delete(room.id);
  }
}

async function main() {
  console.log(`[balance-lab] games=${GAMES} cap=${CAP} bots=${BOTS} winMode=${WINMODE} counts=${JSON.stringify(COUNTS)}`);
  const stats = { wolf: 0, good: 0, third: 0, timeouts: 0, totalMs: 0, firstKill: {} };
  for (let i = 0; i < GAMES; i++) {
    const res = await runOne();
    if (res.timedOut || !res.winner) { stats.timeouts++; continue; }
    if (res.winner === 'wolf') stats.wolf++; else if (res.winner === 'good') stats.good++; else stats.third++;
    stats.totalMs += res.dur;
    if (res.firstKillCamp) stats.firstKill[res.firstKillCamp] = (stats.firstKill[res.firstKillCamp] || 0) + 1;
  }
  const n = GAMES - stats.timeouts;
  console.log('--- 阵营胜率 ---');
  console.log(`狼人  ${(stats.wolf / n * 100).toFixed(1)}%  (${stats.wolf}/${n})`);
  console.log(`好人  ${(stats.good / n * 100).toFixed(1)}%  (${stats.good}/${n})`);
  console.log(`第三方 ${(stats.third / n * 100).toFixed(1)}%  (${stats.third}/${n})`);
  console.log(`超时/无效 ${stats.timeouts}/${GAMES} | 平均局时 ${(stats.totalMs / Math.max(1, n) / 1000).toFixed(1)}s`);
  console.log('--- 首刀分布（第一夜被狼刀者的阵营）---');
  const firstSum = Object.values(stats.firstKill).reduce((a, b) => a + b, 0) || 1;
  for (const [camp, c] of Object.entries(stats.firstKill)) console.log(`  ${camp}: ${(c / firstSum * 100).toFixed(1)}%（${c} 次）`);
  process.exit(0);
}
main().catch(e => { console.error('异常:', e.message); process.exit(1); });
