'use strict';
/* favens conditionOn 单元测试（v1.7.8 β） */
const assert = require('assert');
const { conditionOn } = require('../favens/condition.js');

function sumWolf(dist, ids) {
  let s = 0;
  for (const id of ids) s += dist[id] || 0;
  return s;
}

/* C1 无约束：已守恒先验原样返回 */
{
  const p = { a: 0.4, b: 0.3, c: 0.3 };
  const d = conditionOn(p, [], 1);
  assert.strictEqual(d.a, 0.4, 'C1a 守恒先验不变');
  assert.ok(Math.abs(sumWolf(d, ['a', 'b', 'c']) - 1) < 1e-9, 'C1b Σ=wolfCount');
}

/* C2 已知一狼：剩余狼数在未知玩家间比例分配 */
{
  const p = { a: 0.5, b: 0.3, c: 0.2 };
  const d = conditionOn(p, [{ id: 'a', camp: 'wolf' }], 2);
  assert.strictEqual(d.a, 1, 'C2a 已知狼锁 1');
  assert.ok(Math.abs(d.b - 0.6) < 1e-9 && Math.abs(d.c - 0.4) < 1e-9, 'C2b 剩余 1 狼按 3:2 缩放');
  assert.ok(Math.abs(sumWolf(d, ['b', 'c']) - 1) < 1e-9, 'C2c 未知 Σ=剩余狼数');
}

/* C3 cap 二次分配：prior 高值玩家被 cap 到 1 后，剩余玩家补足守恒 */
{
  const p = { a: 0.6, b: 0.2, c: 0.1 };
  const d = conditionOn(p, [], 2); // sum=0.9 < rest=2 → f=2.22 → a cap 到 1
  assert.strictEqual(d.a, 1, 'C3a 高先验被 cap 到 1');
  assert.ok(Math.abs(d.b - 2 / 3) < 1e-9 && Math.abs(d.c - 1 / 3) < 1e-9, 'C3b 二次分配 b/c 补足（2:1）');
  assert.ok(Math.abs(sumWolf(d, ['a', 'b', 'c']) - 2) < 1e-9, 'C3c cap 后 Σ 仍守恒');
}

/* C4 约束冲突：已知狼数 > 存活狼数 → throw */
{
  let threw = false;
  try { conditionOn({ a: 0.5, b: 0.5 }, [{ id: 'a', camp: 'wolf' }, { id: 'b', camp: 'wolf' }], 1); }
  catch (e) { threw = e.message.includes('约束冲突'); }
  assert.ok(threw, 'C4 冲突抛错');
}

/* C5 人狼恋·好方：自身锁 0，恋人锁 1，剩余 Σ = wolfCount−1 */
{
  const p = { self: 0.3, lover: 0.3, x: 0.4, y: 0.5 };
  const d = conditionOn(p, [{ id: 'self', camp: 'good' }, { id: 'lover', camp: 'wolf' }], 2);
  assert.strictEqual(d.self, 0, 'C5a 自身锁 0');
  assert.strictEqual(d.lover, 1, 'C5b 恋人（狼）锁 1');
  assert.ok(Math.abs(sumWolf(d, ['x', 'y']) - 1) < 1e-9, 'C5c 未知 Σ = wolfCount−1');
}

/* C6 人狼恋·狼方：自身锁 1，恋人（好）锁 0，剩余 Σ = wolfCount−1 */
{
  const p = { self: 0.9, lover: 0.2, x: 0.4 };
  const d = conditionOn(p, [{ id: 'self', camp: 'wolf' }, { id: 'lover', camp: 'good' }], 2);
  assert.strictEqual(d.self, 1, 'C6a 自身锁 1');
  assert.strictEqual(d.lover, 0, 'C6b 恋人（好）锁 0');
  assert.ok(Math.abs(sumWolf(d, ['x']) - 1) < 1e-9, 'C6c 未知 Σ = wolfCount−1');
}

/* C7 自身入参：constraints 含 self 时，self 不进 unknown 池被缩放 */
{
  const p = { self: 0.9, a: 0.5, b: 0.5 };
  const d = conditionOn(p, [{ id: 'self', camp: 'wolf' }, { id: 'a', camp: 'wolf' }], 2);
  assert.strictEqual(d.self, 1, 'C7a self 未被缩放（锁 1）');
  assert.ok(Math.abs(sumWolf(d, ['a', 'b']) - 1) < 1e-9, 'C7b 剩余 0 狼，unknown 全 0');
  assert.strictEqual(d.b, 0, 'C7c unknown 归零（rest=0）');
}

/* C8 无约束且先验缺失：均匀摊 */
{
  const d = conditionOn({ a: 0, b: 0, c: 0 }, [], 2);
  assert.ok(Math.abs(d.a - 2 / 3) < 1e-9 && Math.abs(d.b - 2 / 3) < 1e-9, 'C8 缺失先验均匀摊（2/3）');
}

console.log('favens conditionOn 单元测试：C1–C8 全部通过');
process.exit(0);
