'use strict';
/* paired：B1-6 验收——同 seed 双策略各跑一遍，逐局比较胜负，McNemar 检验。
 * 注意：交替换边/按阵营配对由调用方（CLI --strategy-a/--strategy-b）决定；胜率按阵营在 baseline 里分别报。 */
const { runOneLabGame } = require('../core/room-runner');
const { mcnemar } = require('../stats/mcnemar');

async function run(cfg) {
  const seedBase = cfg.seed || 'pair';
  const A = cfg.strategyA || cfg['strategy-a'] || 'smart'; // --strategy-a=<level>（config 已转驼峰，兼容旧写法）
  const B = cfg.strategyB || cfg['strategy-b'] || 'simulate';
  let a = 0, b = 0, both = 0; // a = A 好胜 B 狼胜；b = 反过来；both = 两边同胜
  for (let i = 0; i < cfg.games; i++) {
    const seed = `${seedBase}-${i}`;
    const cfgA = Object.assign({}, cfg, { seed, botLine: Array(Math.max(1, cfg.cap - 1)).fill(A) });
    const cfgB = Object.assign({}, cfg, { seed, botLine: Array(Math.max(1, cfg.cap - 1)).fill(B) });
    const [r1, r2] = await Promise.all([runOneLabGame(Object.assign({}, cfgA, { gameId: `pair-${i}-a` })), runOneLabGame(Object.assign({}, cfgB, { gameId: `pair-${i}-b` }))]);
    const w1 = r1.result.winner, w2 = r2.result.winner;
    if (w1 && w2 && w1 !== w2) { if (w1 === 'good') a++; else b++; }
    else if (w1 && w2 && w1 === w2) both++;
    if ((i + 1) % 50 === 0 || i === cfg.games - 1) process.stderr.write(`\r[lab] paired ${i + 1}/${cfg.games}（discordant ${a}:${b}）`);
  }
  const m = mcnemar(a, b);
  console.log(`\n[paired] ${A}(好胜) vs ${B}(好胜): discordant ${a}:${b}（同胜 ${both}），χ²=${m.chi2.toFixed(2)}，p=${m.p.toFixed(4)}${m.p < 0.05 ? ' → 显著（' + (m.better || '?') + ' 更优）' : ' → 不显著'}`);
  if (cfg.games >= 400 && m.p < 0.05) console.log('（N≥400 且显著 → 可作验收结论；N<400 仅冒烟）');
}
module.exports = { run };
