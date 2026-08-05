'use strict';
/* 人机狼作为情侣之一（v1.6.3）：恋人互知身份（规则内）——狼恋人不刀/不魅惑/不投恋人，
 * 狼频道引导狼队不刀恋人，白天发言为恋人辩护（减少怀疑）。
 * U1 idle 狼恋人不刀恋人
 * U2 easy 狼恋人不刀/不魅惑恋人
 * U3 smart 狼恋人不刀恋人
 * U4 smart 狼恋人投票不投恋人
 * U5 狼频道发言：狼队已选恋人时劝阻；否则引导目标不含恋人
 * U6 白天发言：恋人有嫌疑时辩护（不施压恋人）
 * 运行：node test/check-bot-lover.js
 */
const { createBotDecision, botWolfChat, loverPartner } = require('../bot-brain.js');
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };

function mkRoom(msgs, phase, nightStep, lovers) {
  return {
    players: [
      { id: 'W', name: '狼恋人', role: 'wolf', alive: true, isBot: true, botLevel: 'smart', botMemory: {} },
      { id: 'P', name: '恋人好', role: 'villager', alive: true, isBot: true, botLevel: 'idle', botMemory: {} },
      { id: 'A', name: '好人A', role: 'villager', alive: true, isBot: true, botLevel: 'idle', botMemory: {} },
      { id: 'B', name: '好人B', role: 'villager', alive: true, isBot: true, botLevel: 'idle', botMemory: {} },
      { id: 'C', name: '好人C', role: 'villager', alive: true, isBot: true, botLevel: 'idle', botMemory: {} },
    ],
    settings: { counts: { wolf: 1, cupid: 1, villager: 3 }, botMode: 'auto' },
    phase: phase || 'night', nightStep: nightStep || 'wolf', nightNum: 1, dayNum: 1,
    night: { wolf: { kill: null, charm: null, sel: {} }, guard: { target: null }, dreamer: { target: null }, seer: { target: null }, witch: { save: false, poison: null, revealed: false }, cupid: { pick: null } },
    guardLast: null, witchPots: { saveUsed: false, poisonUsed: false },
    seerHistory: [], votes: {}, lastVoteResult: null, pkTied: null, candidates: [],
    lovers: lovers || null, wolfPackMemory: {},
    messages: msgs || [],
  };
}
const LOVERS = ['W', 'P']; // 人狼恋：狼恋人 W + 好人恋人 P

// U0 loverPartner 基本行为
{
  const room = mkRoom([], 'night', 'wolf', LOVERS);
  const lp = loverPartner(room, room.players[0]);
  assert(lp && lp.id === 'P' && lp.isWolf === false, 'U0 loverPartner 识别人狼恋（partner=P，非狼）');
  const room2 = mkRoom([], 'night', 'wolf', null);
  assert(loverPartner(room2, room2.players[0]) === null, 'U0 loverPartner 非恋人 → null');
}

// U1 idle 狼恋人不刀恋人
{
  const room = mkRoom([], 'night', 'wolf', LOVERS);
  room.players[0].botLevel = 'idle';
  const d = createBotDecision(room, room.players[0]);
  assert(d && d.action === 'wolf_set' && d.data.kill !== 'P', 'U1 idle 狼恋人不刀恋人' + (d ? '（刀:' + d.data.kill + '）' : '（null）'));
}

// U2 easy 狼恋人不刀/不魅惑恋人
{
  const room = mkRoom([], 'night', 'wolf', LOVERS);
  room.players[0].botLevel = 'easy';
  room.players[2].role = 'wolfBeauty'; // 好人A 当狼美人（狼队友）
  room.players[0].role = 'wolf'; // W 仍是狼
  const d = createBotDecision(room, room.players[0]);
  assert(d && d.action === 'wolf_set' && d.data.kill !== 'P' && d.data.charm !== 'P',
    'U2 easy 狼恋人不刀/不魅惑恋人' + (d ? '（刀:' + d.data.kill + ' 魅惑:' + d.data.charm + '）' : '（null）'));
}

// U3 smart 狼恋人不刀恋人
{
  const room = mkRoom([], 'night', 'wolf', LOVERS);
  const d = createBotDecision(room, room.players[0]);
  assert(d && d.action === 'wolf_set' && d.data.kill !== 'P', 'U3 smart 狼恋人不刀恋人' + (d ? '（刀:' + d.data.kill + '）' : '（null）'));
}

// U4 smart 狼恋人投票不投恋人
{
  const room = mkRoom([], 'vote', null, LOVERS);
  room.players[0].botLevel = 'smart';
  const d = createBotDecision(room, room.players[0]);
  assert(d && d.action === 'vote' && d.data.target !== 'P', 'U4 smart 狼恋人投票不投恋人' + (d ? '（投:' + d.data.target + '）' : '（null）'));
}

// U5 狼频道发言引导
{
  // 5a：狼队已选恋人为刀目标 → 劝阻
  const r5a = mkRoom([], 'night', 'wolf', LOVERS);
  r5a.night.wolf.kill = 'P';
  const c5a = botWolfChat(r5a, r5a.players[0]);
  assert(c5a && c5a.data.ch === 'wolf' && (c5a.data.text.includes('别刀') || c5a.data.text.includes('先别刀')), 'U5a 狼队已选恋人时狼频道劝阻' + (c5a ? '（' + c5a.data.text + '）' : '（null）'));
  // 5b：正常引导（kill 未选恋人）→ 建议目标不含恋人
  const r5b = mkRoom([], 'night', 'wolf', LOVERS);
  r5b.night.wolf.kill = null;
  let bad = false;
  for (let i = 0; i < 20; i++) {
    const c = botWolfChat(r5b, r5b.players[0]);
    if (c && c.data.text.includes('恋人好')) bad = true;
  }
  assert(!bad, 'U5b 狼频道引导刀人建议不指向恋人');
}

// U6 白天发言为恋人辩护（easy 档：恋人嫌疑最高时）
{
  const r6 = mkRoom([], 'discuss', null, LOVERS);
  const bot = r6.players[0];
  bot.botLevel = 'easy';
  const mem = bot.botMemory;
  mem.suspicion = { A: 10, B: 10, C: 10, P: 80 };
  let defended = 0, attacked = 0;
  for (let i = 0; i < 12; i++) {
    const d = createBotDecision(r6, bot);
    if (!d) continue;
    const t = d.data && d.data.text || '';
    if (t.includes('保') || t.includes('别怀疑') || t.includes('不是狼')) defended++;
    if (t.includes('今天先出') || t.includes('出' + '恋人好' + '吧')) attacked++; // 施压句式（辩护文案“出他浪费轮次”是劝阻，不算）
  }
  assert(defended >= 1, 'U6 狼恋人白天为恋人辩护（12 次中至少 1 次，实际 ' + defended + ' 次）');
  assert(attacked === 0, 'U6 狼恋人白天不施压恋人');
}

if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
console.log('\n狼恋人逻辑专项测试全部通过 ✔');
process.exit(0);
