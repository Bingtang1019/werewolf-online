'use strict';
/* wolfTrain/rollout.js 纯函数单测（完整刀后世界模拟）
 * 运行：node test/check-wolf-rollout.js
 */
const { rolloutNightKillSync, simulateWolfKillLite, simulateWolfKillFull } = require('../wolfTrain/rollout.js');
const { createRng } = require('../server/ai/rng.js');
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };

// R1: rolloutNightKillSync 按 winRate 降序返回
{
  const world = { allVoters: ['a', 'b', 'c', 'd', 'e'], teammates: ['a'], scores: { a: 0.2, b: 0.8, c: 0.3, d: 0.4, e: 0.5 } };
  const ranked = rolloutNightKillSync(world, ['b', 'c', 'd'], simulateWolfKillLite, { n: 10 });
  assert(ranked.length === 3, 'R1 返回全部候选');
  assert(ranked[0].winRate >= ranked[1].winRate && ranked[1].winRate >= ranked[2].winRate, 'R1 按 winRate 降序');
  assert(ranked[0].pid !== 'b' && ranked[2].pid === 'b', 'R1 lite 下 P(wolf) 最高的候选 winRate 最低 → 排末位');
}

// R2: 完整模拟需要注入 rng
{
  const world = { allVoters: ['a', 'b', 'c', 'd'], teammates: ['a'], scores: { a: 0.2, b: 0.8, c: 0.3, d: 0.4 } };
  let threw = false;
  try { simulateWolfKillFull(world, 'b', null); } catch (e) { threw = true; }
  assert(threw, 'R2 未注入 rng 时抛错（确定性纪律）');
}

// R3: 完整模拟在合法世界只返回 'wolf'/'good'，且不修改输入
{
  const world = { allVoters: ['a', 'b', 'c', 'd', 'e'], teammates: ['a'], scores: { a: 0.2, b: 0.8, c: 0.3, d: 0.4, e: 0.5 } };
  const snapshot = JSON.stringify(world);
  const rng = createRng(42);
  let ok = true;
  for (let i = 0; i < 50; i++) {
    const r = simulateWolfKillFull(world, 'b', rng);
    if (r !== 'wolf' && r !== 'good') { ok = false; break; }
  }
  assert(ok, 'R3 50 次完整模拟均返回 wolf/good');
  assert(JSON.stringify(world) === snapshot, 'R3 完整模拟不修改输入 world');
}

// R4: 刀狼队友恒判 good（狼队主动减员不利）
{
  const world = { allVoters: ['a', 'b', 'c', 'd'], teammates: ['a', 'b'], scores: { a: 0.2, b: 0.8, c: 0.3, d: 0.4 } };
  const rng = createRng(7);
  let allGood = true;
  for (let i = 0; i < 20; i++) if (simulateWolfKillFull(world, 'b', rng) !== 'good') allGood = false;
  assert(allGood, 'R4 刀到狼队友恒判 good');
}

if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
console.log('\nwolf rollout 纯函数单测全部通过 ✔');
process.exit(0);
