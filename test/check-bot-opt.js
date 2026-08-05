'use strict';
/* v1.5.2 优化专项：
 * O1 投票集中：嫌疑前二且已有人投 → 跟票（防分票）
 * O2 卖狼美人：狼美人魅惑高价值目标且狼数充足 → 狼队投狼美人带走目标
 * O3 守卫守神职：自称神职者优先守
 * O4 摄梦人保命：自称神职（认为将被刀）→ 梦狼概率最高者（带走一个）
 * O5 盗贼选神职：无狼时偏向选神职卡
 * O6 职业发言：猎人/摄梦人/守卫/狼美人专属发言句式
 * 运行：node test/check-bot-opt.js
 */
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };
const { createBotDecision } = require('../bot-brain.js');

function mkRoom(msgs, phase, nightStep, role, over) {
  const r = {
    players: [
      { id: 'B', name: 'bot', role: role || 'villager', alive: true, isBot: true, botLevel: 'smart', botMemory: {} },
      { id: 'A', name: '人机·阿蓝', role: 'villager', alive: true, isBot: true, botLevel: 'idle' },
      { id: 'C', name: '人机·阿紫', role: 'villager', alive: true, isBot: true, botLevel: 'idle' },
      { id: 'D', name: '人机·阿青', role: 'villager', alive: true, isBot: true, botLevel: 'idle' },
      { id: 'E', name: '人机·阿黄', role: 'wolf', alive: true, isBot: true, botLevel: 'idle' },
    ],
    settings: { counts: { wolf: 1, seer: 1, villager: 3 }, botMode: 'auto' },
    phase: phase || 'vote', nightStep: nightStep || null, nightNum: 1, dayNum: 1,
    night: { wolf: { kill: null, charm: null, sel: {} } },
    guardLast: null, witchPots: { saveUsed: false, poisonUsed: false },
    seerHistory: [], votes: {}, lastVoteResult: null, pkTied: null, candidates: [],
    lovers: null, wolfPackMemory: {},
    messages: msgs || [],
  };
  if (over) Object.assign(r, over);
  return r;
}

// O1 投票集中：跟票（两个高嫌疑 A/C，有人投 C → 跟票 C；用 easy 档避免对跳存疑干扰）
{
  const room = mkRoom([
    { id: 'm1', ch: 'all', from: 'D', text: '人机·阿蓝是狼，我查杀人机·阿蓝', marker: null, ts: 1 },
    { id: 'm2', ch: 'all', from: 'D', text: '人机·阿紫是狼，我查杀人机·阿紫', marker: null, ts: 2 },
  ], 'vote');
  room.players[0].botLevel = 'easy';
  room.votes = { D: 'C' }; // 有人投 C（两个高嫌疑之一）；A 无人投
  const d = createBotDecision(room, room.players[0]);
  assert(d && d.action === 'vote' && d.data.target === 'C', 'O1 投票集中：跟票高嫌疑中的有票者' + (d ? '（投:' + d.data.target + '）' : '（null）'));
}
// O2 卖狼美人：狼 bot 投狼美人（魅惑自称守卫者，狼数2）
{
  const room = mkRoom([{ id: 'm1', ch: 'all', from: 'T', text: '我是守卫，昨晚守的自己', marker: null, ts: 1 }], 'vote');
  room.players = [
    { id: 'W', name: '狼bot', role: 'wolf', alive: true, isBot: true, botLevel: 'smart', botMemory: {} },
    { id: 'WB', name: '狼美人bot', role: 'wolfBeauty', alive: true, isBot: true, botLevel: 'smart', botMemory: {} },
    { id: 'T', name: '人机·阿紫', role: 'villager', alive: true, isBot: true, botLevel: 'idle' },
    { id: 'X', name: '人机·阿蓝', role: 'villager', alive: true, isBot: true, botLevel: 'idle' },
    { id: 'Y', name: '人机·阿黄', role: 'villager', alive: true, isBot: true, botLevel: 'idle' },
  ];
  room.wolfPackMemory = { charmTarget: 'T' }; // 狼美人魅惑了自称守卫的 T
  const d = createBotDecision(room, room.players[0]);
  assert(d && d.action === 'vote' && d.data.target === 'WB', 'O2 卖狼美人：狼队投狼美人带走魅惑目标' + (d ? '（投:' + d.data.target + '）' : '（null）'));
}
// O3 守卫守神职
{
  const room = mkRoom([{ id: 'm1', ch: 'all', from: 'C', text: '我是守卫，昨晚守的自己', marker: null, ts: 1 }], 'night', 'guard', 'guard');
  const d = createBotDecision(room, room.players[0]);
  assert(d && d.action === 'guard_pick' && d.data.target === 'C', 'O3 守卫优先守自称神职者' + (d ? '（守:' + d.data.target + '）' : '（null）'));
}
// O4 摄梦人保命：自称神职 → 梦狼概率最高者
{
  const room = mkRoom([
    { id: 'm1', ch: 'all', from: 'A', text: '我跳预言家，查杀人机·阿黄', marker: null, ts: 1 },
  ], 'night', 'dreamer', 'dreamer');
  room.players[0].botMemory.roleClaims = { B: '守卫' }; // 模拟自己自称过神职（将被刀风险）
  const d = createBotDecision(room, room.players[0]);
  assert(d && d.action === 'dreamer_pick' && d.data.target === 'E', 'O4 摄梦人保命：梦狼概率最高者（带走）' + (d ? '（梦:' + d.data.target + '）' : '（null）'));
}
// O5 盗贼选神职
{
  const room = mkRoom([], 'reveal', null, 'thief', {
    reveal: { stage: 'thiefPick', thiefId: 'B', thiefPicked: false },
    center: ['villager', 'seer'],
    settings: { thief: true, counts: { wolf: 1, seer: 1, villager: 3 }, botMode: 'auto' },
  });
  const d = createBotDecision(room, room.players[0]);
  assert(d && d.action === 'thief_pick' && d.data.idx === 1, 'O5 盗贼无狼时选神职（seer）' + (d ? '（idx:' + d.data.idx + '）' : '（null）'));
  const room2 = mkRoom([], 'reveal', null, 'thief', {
    reveal: { stage: 'thiefPick', thiefId: 'B', thiefPicked: false },
    center: ['seer', 'villager'],
    settings: { thief: true, counts: { wolf: 1, seer: 1, villager: 3 }, botMode: 'auto' },
  });
  const d2 = createBotDecision(room2, room2.players[0]);
  assert(d2 && d2.action === 'thief_pick' && d2.data.idx === 0, 'O5 盗贼无狼时选神职（seer 在首位）' + (d2 ? '（idx:' + d2.data.idx + '）' : '（null）'));
}
// O6 职业发言句式
{
  const hunter = mkRoom([], 'discuss', null, 'hunter');
  let hit = null;
  for (let i = 0; i < 4; i++) {
    const d = createBotDecision(hunter, hunter.players[0]);
    if (d && d.action === 'chat' && d.data.text.includes('猎人')) { hit = d.data.text; break; }
  }
  assert(!!hit, 'O6 猎人专属发言：' + (hit || '（本次未触发，概率 0.7×4 次）'));
  const guard = mkRoom([], 'discuss', null, 'guard');
  guard.players[0].botMemory.guarded = { A: true };
  const dg = createBotDecision(guard, guard.players[0]);
  assert(dg && dg.action === 'chat' && dg.data.text.includes('守卫'), 'O6 守卫专属发言');
  const wb = mkRoom([], 'discuss', null, 'wolfBeauty');
  wb.players[0].botMemory = {};
  wb.wolfPackMemory = { charmTarget: 'C', talkedClaim: true };
  let wbHit = null;
  for (let i = 0; i < 8; i++) {
    const d = createBotDecision(wb, wb.players[0]);
    if (d && d.action === 'chat' && d.data.text.includes('狼美人')) { wbHit = d.data.text; break; }
  }
  assert(!!wbHit, 'O6 狼美人威胁发言：' + (wbHit || '（未触发）'));
}
if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
console.log('\nv1.5.2 优化专项测试全部通过 ✔');
process.exit(0);