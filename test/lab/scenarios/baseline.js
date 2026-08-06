'use strict';
/* baseline：胜率报告（Wilson CI）+ 首刀分布 + 错误分类统计；--out=<file> 落盘 records（供样本/对比复用） */
const path = require('path');
const { runOneLabGame } = require('../core/room-runner');
const { runPool } = require('../core/pool');
const { createRecorder } = require('../core/recorder');
const { summarize } = require('../stats/report');

async function run(cfg) {
  const ROOT = path.resolve(__dirname, '..', '..', '..');
  const rec = cfg.out ? createRecorder(path.isAbsolute(cfg.out) ? cfg.out : path.join(ROOT, cfg.out)) : null;
  const fn = async (i, seed) => {
    const r = await runOneLabGame(Object.assign({}, cfg, { seed, gameId: `base-${i}` }));
    if (rec && !rec.has(r.gameId)) rec.write(r);
    return r;
  };
  const recs = await runPool(cfg.games, cfg.parallel, fn,
    { seedBase: cfg.seed || 'base', doneSet: rec || null, onProgress: (f, t, ms) => process.stderr.write(`\r[lab] ${f}/${t}  (${(ms / 1000).toFixed(0)}s)`) });
  if (rec) rec.close();
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
  if (rec) console.log(`[lab] 已落盘 → ${cfg.out}`);
}
module.exports = { run };
module.exports = { run };
