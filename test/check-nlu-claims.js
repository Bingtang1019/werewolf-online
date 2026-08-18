'use strict';
/* NLU 声明证据单测（V5.1c/1.8.0）
 * 运行：node test/check-nlu-claims.js
 */
const { createBeliefEngine, applyEvent, getBeliefs } = require('../server/ai/belief-engine.js');
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };

function makeEngine() {
  const players = [{ id: 'seer', name: 'S' }, { id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
  const counts = { wolf: 1, seer: 1, villager: 2 };
  return createBeliefEngine(players, counts);
}

// N1: 声称预言家后再查杀 → 目标嫌疑升（真预言家查验方向）
{
  const eng = makeEngine();
  applyEvent(eng, { t: 'claim', data: { from: 'seer', type: 'claim_seer', target: null }, night: 1 });
  const before = getBeliefs(eng).posterior.a;
  applyEvent(eng, { t: 'claim', data: { from: 'seer', type: 'check_wolf', target: 'a' }, night: 1 });
  const after = getBeliefs(eng).posterior.a;
  assert(after > before, `N1 真预言家查杀后目标嫌疑升（${before.toFixed(3)}→${after.toFixed(3)}）`);
}

// N2: 未跳预言家的泛用查杀 → 保持原反向（bot 生态狼悍跳方向）
{
  const eng = makeEngine();
  const before = getBeliefs(eng).posterior.a;
  applyEvent(eng, { t: 'claim', data: { from: 'b', type: 'check_wolf', target: 'a' }, night: 1 });
  const after = getBeliefs(eng).posterior.a;
  assert(after < before, `N2 泛用查杀仍按反向处理（${before.toFixed(3)}→${after.toFixed(3)}）`);
}

// N3: 攻击 → 目标嫌疑升；自辩 → 自身嫌疑降
{
  const eng = makeEngine();
  const beforeA = getBeliefs(eng).posterior.a;
  applyEvent(eng, { t: 'claim', data: { from: 'b', type: 'attack', target: 'a' }, night: 1 });
  const afterA = getBeliefs(eng).posterior.a;
  assert(afterA > beforeA, `N3 攻击后目标嫌疑升（${beforeA.toFixed(3)}→${afterA.toFixed(3)}）`);
  const beforeB = getBeliefs(eng).posterior.b;
  applyEvent(eng, { t: 'claim', data: { from: 'b', type: 'defend', target: 'b' }, night: 1 });
  const afterB = getBeliefs(eng).posterior.b;
  assert(afterB < beforeB, `N3 自辩后自身嫌疑降（${beforeB.toFixed(3)}→${afterB.toFixed(3)}）`);
}

if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
console.log('\nNLU 声明证据单测全部通过 ✔');
process.exit(0);
