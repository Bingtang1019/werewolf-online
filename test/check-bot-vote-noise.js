process.env.LAB_NO_MODEL = '1'; // 1.7.0（B1-4）：单元测试隔离运行时 vote 模型（模型是集成层增强，核心逻辑验证不受其干扰）
'use strict';
/* 投票不确定性表达（v1.6.4，A2-4 + A5-1 confidence.js）：
 * V1 低置信（信息少/嫌疑分散）→ 多次投票出现非最优目标（不再“票得太准”）
 * V2 高置信（嫌疑极度集中）→ 决策稳定（argmax 不变）
 * V3 波动不投恋人（狼恋人保护仍生效）
 * V4 confidenceOf 输出范围与单调性（0.15..0.95）
 * 运行：node test/check-bot-vote-noise.js
 */
const botBrain = require('../bot-brain.js');
const conf = require('../server/ai/confidence.js');
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };

function mkRoom(opts) {
  const o = opts || {};
  return {
    players: [
      { id: 'W', name: '狼', role: 'wolf', alive: true, isBot: true, botLevel: 'smart', botMemory: {}, seat: 1 },
      { id: 'A', name: '甲', role: 'villager', alive: true, isBot: true, botLevel: 'idle', botMemory: {}, seat: 2 },
      { id: 'B', name: '乙', role: 'villager', alive: true, isBot: true, botLevel: 'idle', botMemory: {}, seat: 3 },
      { id: 'C', name: '丙', role: 'villager', alive: true, isBot: true, botLevel: 'idle', botMemory: {}, seat: 4 },
      { id: 'D', name: '丁', role: 'villager', alive: true, isBot: true, botLevel: 'idle', botMemory: {}, seat: 5 },
    ],
    settings: { counts: { wolf: 1, villager: 4 }, botMode: 'auto' },
    phase: 'vote', nightStep: null, nightNum: 2, dayNum: 2,
    night: { wolf: { kill: null, charm: null, sel: {} }, guard: { target: null }, dreamer: { target: null }, seer: { target: null }, witch: { save: false, poison: null, revealed: false }, cupid: { pick: null } },
    guardLast: null, witchPots: { saveUsed: false, poisonUsed: false },
    seerHistory: [], votes: {}, lastVoteResult: { kind: 'vote', totals: {}, max: 0, result: 'none', exiled: null, tied: null }, pkTied: null, candidates: [],
    lovers: o.lovers || null, wolfPackMemory: undefined, botTalked: undefined,
    messages: [],
  };
}
function setBeliefs(bot, map) { // 1.7.0（B1-1②）：阶梯后 easy←现smart——感知体系为 beliefs（buildVoteWorld 优先 beliefs）；suspicion 同步供 confidenceOf 使用
  bot.botMemory.beliefs = {};
  bot.botMemory.suspicion = {};
  for (const k of Object.keys(map)) {
    bot.botMemory.beliefs[k] = { wolf: map[k], good: 1 - map[k] };
    bot.botMemory.suspicion[k] = Math.round(map[k] * 100);
  }
}

// ---- V1：低置信（信念分散）→ 出现非最优 ----
{
  const r = mkRoom();
  const a = r.players[1]; // A：新 easy（现 smart）好人（投票基于 beliefs）
  a.botLevel = 'easy';
  setBeliefs(a, { B: 0.42, C: 0.44, D: 0.43, W: 0.41 }); // 全接近 → 分不清 → 置信低
  let targets = new Set();
  for (let i = 0; i < 40; i++) {
    const d = botBrain.createBotDecision(r, a);
    if (d && d.action === 'vote' && d.data.target) targets.add(d.data.target);
  }
  assert(targets.size >= 2, 'V1 低置信（信念分散）→ 40 次决策出现 ≥2 个不同目标（不再“票得太准”，实际 ' + targets.size + ' 个）');
}

// ---- V2：高置信（信念集中）→ 决策稳定 ----
{
  const r = mkRoom();
  const a = r.players[1];
  a.botLevel = 'easy';
  setBeliefs(a, { B: 0.1, C: 0.9, D: 0.12, W: 0.08 }); // C 极度突出 → 高置信
  let targets = new Set();
  for (let i = 0; i < 40; i++) {
    const d = botBrain.createBotDecision(r, a);
    if (d && d.action === 'vote' && d.data.target) targets.add(d.data.target);
  }
  assert(targets.size === 1 && targets.has('C'), 'V2 高置信（信念集中）→ 决策稳定投 C（实际 ' + [...targets].join(',') + '）');
}

// ---- V3：波动不投恋人（狼恋人保护） ----
{
  const r = mkRoom({ lovers: ['W', 'A'] }); // 狼 W 与好人 A 人狼恋
  const w = r.players[0]; // 新 easy 狼恋人
  w.botLevel = 'easy';
  setBeliefs(w, { A: 0.1, B: 0.5, C: 0.4, D: 0.3 }); // 低置信（分散）
  for (let i = 0; i < 60; i++) {
    const d = botBrain.createBotDecision(r, w);
    if (d && d.action === 'vote' && d.data.target) {
      assert(d.data.target !== 'A', 'V3 狼恋人波动/决策均不投恋人（' + d.data.target + '）');
    }
  }
}

// ---- V4：confidenceOf 范围与单调性 ----
{
  const bot = { botMemory: { suspicion: { A: 10, B: 12, C: 11, D: 9 } } };
  const c1 = conf.confidenceOf(null, bot, 'B'); // 分散 → 低
  const bot2 = { botMemory: { suspicion: { A: 5, B: 95, C: 6, D: 7 } } };
  const c2 = conf.confidenceOf(null, bot2, 'B'); // 集中 → 高
  assert(c1 >= 0.15 && c1 <= 0.95 && c2 >= 0.15 && c2 <= 0.95, 'V4a confidenceOf 输出在 0.15..0.95（' + c1.toFixed(2) + ' / ' + c2.toFixed(2) + '）');
  assert(c2 > c1, 'V4b 最可疑者越突出（方差大）置信越高（' + c1.toFixed(2) + ' < ' + c2.toFixed(2) + '）');
  assert(conf.confidenceOf(null, null, 'x') === 0.15, 'V4c 无记忆 → 最低置信（防御）');
}

if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
console.log('\n投票不确定性表达专项测试全部通过 ✔');
process.exit(0);
