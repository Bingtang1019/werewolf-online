process.env.LAB_NO_MODEL = '1'; // 1.7.0（B1-4）：单元测试隔离运行时 vote 模型（模型是集成层增强，核心逻辑验证不受其干扰）
'use strict';
/* 好人 bot 白天发言与组合式生成（v1.6.4，A2-3/A2-5）：
 * E1 easy 预言家主发言报查验（不再“p 都不放一个”）
 * E2 被投票 → 次发言开口辩解（defend_self）
 * E3 平民表态：smart/easy 平民主发言不再必然沉默（多次调用至少一次输出）
 * E4 组合式生成：lexicon.json 可加载、输出不超长、无残留占位符
 * 运行：node test/check-bot-expression.js
 */
const botBrain = require('../bot-brain.js');
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };

function mkRoom(msgs, opts) {
  const o = opts || {};
  return {
    players: [
      { id: 'S', name: '预言家', role: 'seer', alive: true, isBot: true, botLevel: 'easy', botMemory: {}, seat: 1 },
      { id: 'P', name: '平民A', role: 'villager', alive: true, isBot: true, botLevel: 'easy', botMemory: {}, seat: 2 },
      { id: 'Q', name: '平民B', role: 'villager', alive: true, isBot: true, botLevel: 'smart', botMemory: {}, seat: 3 },
      { id: 'H', name: '房主', role: 'villager', alive: true, isBot: false, botMemory: {}, seat: 4 },
    ],
    settings: { counts: { wolf: 1, seer: 1, villager: 3 }, botMode: 'auto' },
    phase: o.phase || 'discuss', nightStep: null, nightNum: 1, dayNum: 1,
    night: { wolf: { kill: null, charm: null, sel: {} }, guard: { target: null }, dreamer: { target: null }, seer: { target: null }, witch: { save: false, poison: null, revealed: false }, cupid: { pick: null } },
    guardLast: null, witchPots: { saveUsed: false, poisonUsed: false },
    seerHistory: o.seerHistory || [], votes: {}, lastVoteResult: o.lastVoteResult || null, pkTied: null, candidates: [],
    lovers: null, wolfPackMemory: undefined, botTalked: o.botTalked || undefined,
    messages: msgs || [],
  };
}

// ---- E1：easy 预言家报查验 ----
{
  const r = mkRoom([], { seerHistory: [{ target: 'P', result: 'wolf', night: 1 }] });
  const d = botBrain.createBotDecision(r, r.players[0]); // S 是 easy 预言家
  assert(d && d.action === 'chat' && d.data.text.includes('预言家') && d.data.text.includes('查杀'), 'E1 easy 预言家主发言报查验（' + (d ? d.data.text : 'null') + '）');
}

// ---- E2：被投票 → 次发言辩解（80% 概率，多次调用容忍随机） ----
{
  let defended = false;
  for (let i = 0; i < 12 && !defended; i++) {
    const r = mkRoom([], { lastVoteResult: { kind: 'vote', totals: { S: 2, P: 1 }, max: 2, result: 'none', exiled: null, tied: null }, botTalked: { day: 1, ids: { S: 1 } } }); // S 已发过主发言（count=1）
    const d = botBrain.createBotDecision(r, r.players[0]);
    if (d && d.action === 'chat' && (d.data.text.includes('别投') || d.data.text.includes('好人'))) { defended = true; break; }
  }
  assert(defended, 'E2 被投票 → 次发言辩解（80% 概率，12 次内出现）');
}

// ---- E3：平民表态（easy 与 smart） ----
{
  let easyTalked = 0, smartTalked = 0;
  for (let i = 0; i < 40; i++) {
    const re = mkRoom([]);
    const de = botBrain.createBotDecision(re, re.players[1]); // P：easy 平民
    if (de && de.action === 'chat') easyTalked++;
    const rs = mkRoom([]);
    const ds = botBrain.createBotDecision(rs, rs.players[2]); // Q：smart 平民
    if (ds && ds.action === 'chat') smartTalked++;
  }
  assert(easyTalked >= 3, 'E3a easy 平民主发言不再必然沉默（40 次中 ' + easyTalked + ' 次开口）');
  assert(smartTalked >= 10, 'E3b smart 平民主发言更活跃（40 次中 ' + smartTalked + ' 次开口）');
}

// ---- E4：组合式生成文本质量 ----
{
  let allOk = true, longOk = true, phOk = true;
  for (let i = 0; i < 60; i++) {
    const r = mkRoom([]);
    const d = botBrain.createBotDecision(r, r.players[1]);
    if (d && d.action === 'chat') {
      const t = d.data.text;
      if (t.length > 120) longOk = false;
      if (/\{[a-zA-Z]+\}/.test(t)) phOk = false;
      if (t.length > 200) allOk = false;
    }
  }
  assert(allOk && longOk && phOk, 'E4 组合式生成：无残留占位符、长度受控（≤120 字）');
}

if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
console.log('\n人机发言表达专项测试全部通过 ✔');
process.exit(0);
