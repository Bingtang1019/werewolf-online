'use strict';
/* paired：B1-6 验收——同 seed 双策略各跑一遍（a/b 两个独立任务，多进程天然并行；单进程串行安全），逐局配对 McNemar。
 * v1.7.6：planTasks 产出 total = games×2 个任务；跨进程隔离下"同 seed 两遍"不再有串房风险（原 Promise.all 双局并跑已移除）。 */
const { runOneLabGame } = require('../core/room-runner');
const { mcnemar } = require('../stats/mcnemar');

function planTasks(cfg) {
  const seedBase = cfg.seed || 'pair';
  const A = cfg.strategyA || cfg['strategy-a'] || 'smart'; // --strategy-a=<level>（config 已转驼峰，兼容旧写法）
  const B = cfg.strategyB || cfg['strategy-b'] || 'simulate';
  let i = -1, half = 1;
  return {
    total: cfg.games * 2, // a/b 两遍 = 两个独立任务
    next() {
      if (++half >= 2) { half = 0; i++; }
      if (i >= cfg.games) return null;
      const isA = half === 0;
      return {
        id: `pair-${i}-${isA ? 'a' : 'b'}`, gameId: `pair-${i}-${isA ? 'a' : 'b'}`,
        seed: `${seedBase}-${i}`,
        overrides: { botLine: Array(Math.max(1, cfg.cap - 1)).fill(isA ? A : B) },
        full: !!cfg.out,
      };
    },
  };
}
function report(records, cfg) {
  const byIdx = {};
  for (const r of records) {
    const m = String(r.gameId).match(/^pair-(\d+)-([ab])$/);
    if (m) byIdx[Number(m[1]) + (m[2] === 'a' ? 0 : 100000)] = r;
  }
  const A = cfg.strategyA || cfg['strategy-a'] || 'smart';
  const B = cfg.strategyB || cfg['strategy-b'] || 'simulate';
  let a = 0, b = 0, both = 0, n = 0;
  for (const k of Object.keys(byIdx)) {
    const idx = Number(k);
    if (idx >= 100000) continue;
    const r1 = byIdx[idx], r2 = byIdx[idx + 100000];
    if (!r2) continue;
    n++;
    const w1 = r1.result.winner, w2 = r2.result.winner;
    if (w1 && w2 && w1 !== w2) { if (w1 === 'good') a++; else b++; }
    else if (w1 && w2 && w1 === w2) both++;
  }
  const m = mcnemar(a, b);
  console.log(`\n[paired] ${A}(好胜) vs ${B}(好胜): discordant ${a}:${b}（同胜 ${both}/${n} 对），χ²=${m.chi2.toFixed(2)}，p=${m.p.toFixed(4)}${m.p < 0.05 ? ' → 显著（' + (m.better || '?') + ' 更优）' : ' → 不显著'}`);
  if (cfg.games >= 400 && m.p < 0.05) console.log('（N≥400 且显著 → 可作验收结论；N<400 仅冒烟）');
}
async function run(cfg) {
  const gen = planTasks(cfg);
  const records = [];
  for (let t = gen.next(); t; t = gen.next()) {
    if (t.skip) continue;
    const r = await runOneLabGame(Object.assign({}, cfg, t.overrides || {}, { seed: t.seed, gameId: t.gameId }));
    records.push(r);
  }
  report(records, cfg);
}
module.exports = { run, planTasks, report };
