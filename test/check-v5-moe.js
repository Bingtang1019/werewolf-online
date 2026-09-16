'use strict';
/* V5 MoE 冒烟：off / shadow / on 模式、值域、explain 结构 */
const moe = require('../server/ai/moe-value.js');
const rollout = require('../server/ai/rollout.js');

let failures = 0;
function assert(c, m) { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } }
const state = {
  R: 3, S: 2, M: 5, cap: 12, wolf0: 3, god0: 4, vill0: 5,
  info: { checkedWolves: 1, checkedCount: 2, seerAlive: 1, lastExileWasWolf: 1 },
  intent: { attackDensity: 0.4, claimSeerDensity: 0.2, defendDensity: 0.1, votePressure: 0.5, smalltalkRatio: 0.2 },
};
const prev = JSON.parse(JSON.stringify(state));
const next = JSON.parse(JSON.stringify(state)); next.R = 2; next.S = 2; next.M = 5;

process.env.MOE_MODE = 'off';
const off = moe.value(state, '12a');
assert(typeof off === 'number' && off >= 0 && off <= 1, 'MOE_MODE=off 返回 0..1 数值');
process.env.MOE_MODE = 'shadow';
const shadow = moe.value(state, '12a');
assert(typeof shadow === 'number' && shadow >= 0 && shadow <= 1, 'MOE_MODE=shadow 返回 0..1 数值');
process.env.MOE_MODE = 'on';
const on = moe.value(state, '12a');
assert(typeof on === 'number' && on >= 0 && on <= 1, 'MOE_MODE=on 返回 0..1 数值');
const e = moe.explain(state, '12a');
assert(e && typeof e.weights.w3 === 'number' && typeof e.weights.w4 === 'number', 'explain 返回门控权重');
assert(e.weights.w3 + e.weights.w4 + (e.weights.w5 || 0) > 0.999, '门控权重归一化');
assert(typeof moe.payoff(prev, next, '12a') === 'number', 'payoff 返回数值');

// VALUE_MODEL=moe 的 rollout payoff 集成
process.env.VALUE_MODEL = 'moe';
process.env.PAYOFF_MODE = 'value';
const world = { faction: 'good', wolfAlive: 2, godAlive: 3, villAlive: 4, wolfInit: 3, godInit: 4, villInit: 5, configKey: '12a', hasPreset: true, info: state.info, intent: state.intent };
assert(Number.isFinite(rollout.valuePayoff(world, true)), 'rollout valuePayoff(moe, xWolf) 数值有效');
assert(Number.isFinite(rollout.valuePayoff(world, false)), 'rollout valuePayoff(moe, xGood) 数值有效');

// 清理 shadow 文件不必要，不写断言；恢复默认
process.env.MOE_MODE = 'off';
process.env.VALUE_MODEL = '';
if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
console.log('\nV5 MoE 冒烟测试全部通过 ✔');
