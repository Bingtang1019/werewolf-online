'use strict';
/* baseline：胜率报告（Wilson CI）+ 首刀分布 + 错误分类统计；--out=<file> 落盘 records（供样本/对比复用）
 * v1.7.6：拆 planTasks/report —— 单进程（runPool）与多进程（mpool）共用同一任务源。 */
const path = require('path');
const { runOneLabGame } = require('../core/room-runner');
const { runPool } = require('../core/pool');
const { createRecorder } = require('../core/recorder');
const { summarize } = require('../stats/report');

function planTasks(cfg) {
  const seedBase = cfg.seed || 'base';
  const ROOT = path.resolve(__dirname, '..', '..', '..');
  const rec = cfg.out ? createRecorder(path.isAbsolute(cfg.out) ? cfg.out : path.join(ROOT, cfg.out)) : null;
  let i = -1;
  return {
    total: cfg.games, rec,
    next() {
      if (++i >= cfg.games) return null;
      const gameId = `base-${i}`;
      if (rec && rec.has(gameId)) return { skip: true, gameId }; // checkpoint 续跑
      return { id: gameId, gameId, seed: `${seedBase}-${i}`, full: !!cfg.out }; // --out 落盘需完整 events
    },
  };
}
function report(records, cfg) {
  const s = summarize(records);
  console.log('\n--- 阵营胜率（95% Wilson CI）---');
  for (const [c, v] of Object.entries(s.camps)) {
    console.log(`${c.padEnd(6)} ${(v.pct * 100).toFixed(1)}% (${v.wins}/${v.n})  [${(v.ci[0] * 100).toFixed(1)}%, ${(v.ci[1] * 100).toFixed(1)}%]`);
  }
  console.log(`超时 ${s.timeouts} | 错误 ${JSON.stringify(s.errors)} | 平均局时 ${(s.avgDurMs / 1000).toFixed(1)}s`);
  console.log('--- 首刀分布（第一夜被狼刀者阵营）---');
  const fk = Object.entries(s.firstKill);
  const fkSum = fk.reduce((a, b) => a + b[1], 0) || 1;
  for (const [c, k] of fk) console.log(`  ${c}: ${(k / fkSum * 100).toFixed(1)}%（${k} 次）`);
  if (cfg.out) console.log(`[lab] 已落盘 → ${cfg.out}`);
}
async function run(cfg) {
  const gen = planTasks(cfg);
  const records = [];
  await runPool(cfg.games, cfg.parallel, async (i, seed) => {
    const r = await runOneLabGame(Object.assign({}, cfg, { seed, gameId: `base-${i}` }));
    if (gen.rec && !gen.rec.has(r.gameId)) gen.rec.write(r);
    records.push(r);
    return r;
  }, { seedBase: cfg.seed || 'base', doneSet: gen.rec || null, onProgress: (f, t, ms) => process.stderr.write(`\r[lab] ${f}/${t}  (${(ms / 1000).toFixed(0)}s)`) });
  if (gen.rec) gen.rec.close();
  report(records, cfg);
}
module.exports = { run, planTasks, report };
