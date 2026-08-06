'use strict';
/* v1.7.2（A-1 方向验证）：统计"被放逐者的投票者身份分布"。
 * 预期：放逐狼 → 投他者中狼比例 << 3/13 先验（狼不投狼）；放逐好人 → 投他者中狼比例 > 先验（狼 argmin 精准投好人）。
 * 若前者接近先验（卖狼/悍跳导致狼也投狼），则 voted_out_good 升嫌疑方向的依据存疑。
 * 运行：node tools/ai/vote-direction-stats.js [games] */
process.env.BOT_DELAY_MS = '100';
process.env.PHASE_TIMEOUT = '30';
process.env.NIGHT_TIMEOUT = '20';
process.env.CHAT_INTERVAL = '0';
process.env.LAB_NO_MODEL = '1'; // 纯 bot 行为统计，排除模型混杂
const Game = require('../../game.js');
const clock = require('../../server/clock');
const { createRng } = require('../../server/ai/rng.js');
const { seedHash } = require('../../test/lab/core/room-runner.js');

const GAMES = parseInt(process.argv[2] || '200', 10);
clock.setMode('virtual');

async function runOne(i) {
  global.rng = createRng(seedHash('vd-' + i));
  const r = Game.createRoom('房主');
  const room = Game.rooms.get(r.roomId);
  const host = r.playerId;
  const exiles = [];
  try {
    for (const [a, d] of [
      ['settings', { sheriff: false, winMode: 'edge', tieRule: 'pk', botMode: 'auto' }],
      ['setCounts', { counts: { wolf: 3, seer: 1, witch: 1, villager: 8 } }],
      ['setCap', { cap: 13 }],
    ]) { if (!(Game.handleAction(room.id, host, a, d) || {}).ok) throw 'cfg'; }
    for (let k = 0; k < 12; k++) Game.handleAction(room.id, host, 'add_bot', { level: 'simulate' });
    Game.handleAction(room.id, host, 'start');
    Game.handleAction(room.id, host, 'hostPick', { role: 'random' });
    let prevPhase = room.phase;
    let guard = 0;
    while (room.phase !== 'ended' && ++guard < 60000) {
      // 1.7.3（F9）：只捕 prevPhase==='vote' 的结算，pk_vote 的放逐会丢失——13 人局 pk 罕见，统计误差可忽略；如需精确可扩展 'pk_vote'
      // vote → 非 vote 的转变 = 本轮投票结算完成（votes 保留到下次 startVote）
      if (prevPhase === 'vote' && room.phase !== 'vote' && room.lastVoteResult && room.lastVoteResult.exiled) {
        const ex = room.players.find(p => p.id === room.lastVoteResult.exiled);
        if (ex) {
          let wolfV = 0, tot = 0;
          for (const vid of Object.keys(room.votes || {})) {
            if (room.votes[vid] !== ex.id) continue;
            const vp = room.players.find(p => p.id === vid);
            if (vp && vp.alive) { tot++; if (vp.role === 'wolf' || vp.role === 'wolfBeauty') wolfV++; }
          }
          if (tot >= 2) exiles.push({ exWolf: ex.role === 'wolf' || ex.role === 'wolfBeauty', wolfV, tot });
        }
      }
      prevPhase = room.phase;
      if (!clock.hasNext()) { const r2 = Game.handleAdvance(room.id, host); if (!(r2 && r2.ok)) { throw 'stall:' + room.phase; } continue; }
      clock.tickNext();
      await new Promise(x => setImmediate(x));
    }
    return exiles;
  } finally { clock.clearAll(); Game.rooms.delete(room.id); }
}

(async () => {
  const agg = { exWolf: { tot: 0, wolfV: 0 }, exGood: { tot: 0, wolfV: 0 }, exWolfN: 0, exGoodN: 0 };
  for (let i = 0; i < GAMES; i++) {
    const exiles = await runOne(i);
    for (const e of exiles) {
      if (e.exWolf) { agg.exWolfN++; agg.exWolf.tot += e.tot; agg.exWolf.wolfV += e.wolfV; }
      else { agg.exGoodN++; agg.exGood.tot += e.tot; agg.exGood.wolfV += e.wolfV; }
    }
    if (i % 50 === 49) process.stderr.write('\r[stats] ' + (i + 1) + '/' + GAMES);
  }
  const rw = agg.exWolf.tot ? agg.exWolf.wolfV / agg.exWolf.tot : 0;
  const rg = agg.exGood.tot ? agg.exGood.wolfV / agg.exGood.tot : 0;
  console.log('\n=== 投票方向统计（' + GAMES + ' 局，13 人局，狼先验 ' + (3 / 13).toFixed(2) + '）===');
  console.log('放逐狼 ' + agg.exWolfN + ' 次：投狼者中狼比例 = ' + (rw * 100).toFixed(1) + '%（' + agg.exWolf.wolfV + '/' + agg.exWolf.tot + '）——预期 <<' + (23).toFixed(0) + '%');
  console.log('放逐好人 ' + agg.exGoodN + ' 次：投好人者中狼比例 = ' + (rg * 100).toFixed(1) + '%（' + agg.exGood.wolfV + '/' + agg.exGood.tot + '）——预期 >' + (23).toFixed(0) + '%');
  console.log('结论：' + (rw < 0.15 ? '投狼者≈全是好人 → voted_out_wolf 降嫌疑方向实锤' : '投狼者中狼比例不低 → 方向需重审'));
  process.exit(0);
})().catch(e => { console.error('异常:', e.message); process.exit(1); });
