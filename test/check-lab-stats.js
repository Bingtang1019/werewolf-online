'use strict';
/* 实验室 stats 纯函数单测（Wilson/McNemar/report）
 * 运行：node test/check-lab-stats.js
 */
const { wilsonCI } = require('./lab/stats/wilson');
const { mcnemar } = require('./lab/stats/mcnemar');
const { summarize } = require('./lab/stats/report');
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };

// W1: Wilson 95% CI 已知值（k=50,n=100 → 约 [0.402, 0.598]）
{
  const [lo, hi] = wilsonCI(50, 100);
  assert(Math.abs(lo - 0.402) < 0.01 && Math.abs(hi - 0.598) < 0.01, `W1 Wilson(50,100) ≈ [0.402,0.598] 实际 [${lo.toFixed(3)},${hi.toFixed(3)}]`);
}
// W2: 边界——n=0 → [0,0]；k=0 → lo=0；k=n → hi=1
{
  const z = wilsonCI(0, 0);
  assert(z[0] === 0 && z[1] === 0, 'W2 Wilson(0,0) = [0,0]');
  const l = wilsonCI(0, 50);
  assert(l[0] === 0, 'W2 k=0 下界为 0');
  const h = wilsonCI(50, 50);
  assert(h[1] === 1, 'W2 k=n 上界为 1');
}

// M1: McNemar 显著（a=30,b=10 → χ²≈9.03, p≈0.0026）
{
  const m = mcnemar(30, 10);
  assert(Math.abs(m.chi2 - 9.025) < 0.1, `M1 McNemar(30,10) χ²≈9.03 实际 ${m.chi2.toFixed(2)}`);
  assert(m.p < 0.05 && m.better === 'A', `M1 p=${m.p.toFixed(4)}<0.05 且 better=A`);
}
// M2: 不显著（a=10,b=10 → 无更优方，p≈0.87）
{
  const m = mcnemar(10, 10);
  assert(m.p > 0.5 && m.better === null, `M2 McNemar(10,10) p≈0.87 且 better=null（实际 p=${m.p.toFixed(3)}）`);
}
// M3: 全同 → null
{
  const m = mcnemar(0, 0);
  assert(m.chi2 === 0 && m.p === 1 && m.better === null, 'M3 McNemar(0,0) 无 discordant');
}

// R1: report 错误分类（config/engine/stall 分开计）
{
  const recs = [
    mk('g1', 'good', null),
    mk('g2', 'wolf', null),
    mk('g3', null, { kind: 'stall', message: 'x' }),
    mk('g4', null, { kind: 'config', message: 'x' }),
    mk('g5', null, { kind: 'engine', message: 'x' }),
  ];
  const s = summarize(recs);
  assert(s.valid === 2, 'R1 valid=2');
  assert(s.errors.stall === 1 && s.errors.config === 1 && s.errors.engine === 1, 'R1 错误分类分别计数');
  assert(s.camps.good.wins === 1 && s.camps.wolf.wins === 1, 'R1 阵营胜场');
}
function mk(gameId, winner, error) {
  return {
    schema: 'lab.game-record@1', gameId, seed: null, scenario: 't', startedAt: '', endedAt: '', durMs: 1000,
    config: { cap: 5, counts: {}, botLine: [], winMode: 'edge', tieRule: 'pk' },
    result: { winner, timeout: !!error, error },
    players: [], events: [],
    firstKill: winner === 'good' ? { id: 'x', camp: 'good' } : null,
  };
}

if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
console.log('\n实验室 stats 单测全部通过 ✔');
process.exit(0);
