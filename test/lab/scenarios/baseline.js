'use strict';
/* baseline：胜率报告（Wilson CI）+ 首刀分布 + 错误分类统计 */
const { runRoom } = require('../core/room-runner');
const { runPool } = require('../core/pool');
const { summarize } = require('../stats/report');

async function run(cfg) {
  const recs = await runPool(cfg.games, cfg.parallel,
    (i, seed) => runRoom(Object.assign({}, cfg, { seed }), `base-${i}`),
    { seedBase: cfg.seed || 'base', onProgress: (f, t, ms) => process.stderr.write(`\r[lab] ${f}/${t}  (${(ms / 1000).toFixed(0)}s)`) });
  const s = summarize(recs);
  console.log('\n--- 阵营胜率（95% Wilson CI）---');
  for (const [c, v] of Object.entries(s.camps)) {
    console.log(`${c.padEnd(6)} ${(v.pct * 100).toFixed(1)}% (${v.wins}/${v.n})  [${(v.ci[0] * 100).toFixed(1)}%, ${(v.ci[1] * 100).toFixed(1)}%]`);
  }
  console.log(`超时 ${s.timeouts} | 错误 ${JSON.stringify(s.errors)} | 平均局时 ${(s.avgDurMs / 1000).toFixed(1)}s`);
  console.log('--- 首刀分布（第一夜被狼刀者阵营）---');
  const fk = Object.entries(s.firstKill);
  const fkSum = fk.reduce((a, b) => a + b[1], 0) || 1;
  for (const [c, k] of fk) console.log(`  ${c}: ${(k / fkSum * 100).toFixed(1)}%（${k} 次）`);
}
module.exports = { run };
