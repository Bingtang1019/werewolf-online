'use strict';
/* test/lab/scenarios/human-chat.js —— NLU 端到端：真人预言家每天报查验（有/无 NLU 解析对比）
 * 用法：node test/lab/lab.js human-chat --games=200 --cap=12 --counts="wolf=3,seer=1,witch=1,villager=7" [--nlu=0|1]
 */
const path = require('path');
const Game = require('../../../game.js');
const { runOneLabGame } = require('../core/room-runner');
const { runPool } = require('../core/pool');
const { createRecorder } = require('../core/recorder');
const { summarize } = require('../stats/report');

function injectSeerChat(room, host) {
  const hostP = room.players.find(p => p.id === host);
  if (!hostP || String(hostP.role || '').toLowerCase() !== 'seer') return; // 死后仍可发言（遗言/死后聊天），保证查验信息能注入
  if (!room._nluInjectedClaims) room._nluInjectedClaims = new Set();
  for (const h of room.seerHistory || []) {
    if (h.night >= room.dayNum) continue; // 只报已经过去的夜
    const key = h.night + ':' + h.target;
    if (room._nluInjectedClaims.has(key)) continue;
    const target = room.players.find(p => p.id === h.target);
    if (!target) continue;
    const text = `我是预言家，昨晚查了${target.name}：${h.result === 'wolf' ? '查杀' : '金水'}`;
    try { Game.handleAction(room.id, host, 'chat', { ch: 'all', text }); room._nluInjectedClaims.add(key); } catch (e) { /* 注入失败不影响 */ }
  }
}

function planTasks(cfg) {
  const ROOT = path.resolve(__dirname, '..', '..', '..');
  const out = path.isAbsolute(cfg.out || '') ? cfg.out : path.join(ROOT, cfg.out || 'data/lab-human-chat.jsonl');
  const rec = createRecorder(out);
  const nlu = cfg.nlu !== 0; // --nlu=0 关闭 NLU 注入（对照）
  let i = -1;
  return {
    total: cfg.games, rec, out, nlu,
    next() {
      if (++i >= cfg.games) return null;
      const gameId = `hc-${i}`;
      if (rec.has(gameId)) return { skip: true, gameId };
      return { id: gameId, gameId, seed: `${cfg.seed || 'hc'}-${i}`, full: true };
    },
  };
}
async function run(cfg) {
  const gen = planTasks(cfg);
  const records = [];
  const nlu = gen.nlu;
  await runPool(cfg.games, cfg.parallel, async (i, seed) => {
    const r = await runOneLabGame(Object.assign({}, cfg, { hostRole: 'seer', onDiscuss: nlu ? injectSeerChat : null, seed, gameId: `hc-${i}` }));
    if (!gen.rec.has(r.gameId)) gen.rec.write(r);
    records.push(r);
    return r;
  }, { seedBase: cfg.seed || 'hc', doneSet: gen.rec, onProgress: (f, t, ms) => process.stderr.write(`\r[lab] ${f}/${t}  (${(ms / 1000).toFixed(0)}s)`) });
  gen.rec.close();
  const s = summarize(records);
  console.log('\n--- 阵营胜率（NLU=' + (nlu ? 'on' : 'off') + '）---');
  for (const [c, v] of Object.entries(s.camps)) console.log(`${c.padEnd(6)} ${(v.pct * 100).toFixed(1)}% (${v.wins}/${v.n})  [${(v.ci[0] * 100).toFixed(1)}%, ${(v.ci[1] * 100).toFixed(1)}%]`);
  console.log(`超时 ${s.timeouts} | 错误 ${JSON.stringify(s.errors)} | 平均局时 ${(s.avgDurMs / 1000).toFixed(1)}s`);
}
module.exports = { run, planTasks, report: () => {}, streamable: false };
