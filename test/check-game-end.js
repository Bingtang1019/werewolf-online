'use strict';
/* 终局幂等兜底（v1.6.4，A2-1——真实反馈“全死了还能继续”）：
 * G1 狼刀最后一个民（屠边）→ 夜晚结算结束，phase=ended、winner=wolf
 * G2 猎人被刀 → 开枪带走最后狼 → 好人胜（结算链中途全灭不挂起）
 * G3 阶段入口兜底：构造“无活人但 phase≠ended” → 推进入口触发结束
 * G4 checkWin 幂等：ended 后重复结算/推进，phase/winner 不变
 * 运行：node test/check-game-end.js
 */
const Game = require('../game.js');
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };

function setupRoom() {
  const c = Game.createRoom('房主');
  const roomId = c.roomId, host = c.playerId;
  const ids = [host];
  for (let i = 1; i < 4; i++) ids.push(Game.joinRoom(roomId, '玩家' + (i + 1)).playerId);
  Game.handleAction(roomId, host, 'settings', { sheriff: false, thief: false });
  Game.handleAction(roomId, host, 'setCounts', { counts: { wolf: 1, seer: 1, villager: 2 } }); // 先 counts 后 cap（cap 变更会校验 counts）
  Game.handleAction(roomId, host, 'setCap', { cap: 4 });
  Game.handleAction(roomId, host, 'start');
  Game.handleAction(roomId, host, 'hostPick', { role: 'random' });
  Game.handleAdvance(roomId, host, 0); // 进夜（hostPick 后 dealt，advance 直接进夜）
  return { roomId, host, ids };
}
function room(roomId) { return Game.rooms.get(roomId); }
function roleOf(roomId, role) { return room(roomId).players.find(p => p.role === role); }
function advanceAll(roomId, host) { for (let i = 0; i < 12; i++) Game.handleAdvance(roomId, host, 0); }
function setAllDeadExcept(roomId, keepIds) {
  for (const p of room(roomId).players) {
    if (!keepIds.includes(p.id)) { p.alive = false; p.deadBy = 'wolf'; }
  }
}

// ---- G1：狼刀最后一个民 → 屠边结束 ----
{
  const { roomId, host } = setupRoom();
  const wolf = roleOf(roomId, 'wolf');
  const civs = room(roomId).players.filter(p => p.role === 'villager');
  // 杀掉除最后一个民之外的所有好人（保留 wolf + 1 民）
  setAllDeadExcept(roomId, [wolf.id, civs[civs.length - 1].id]);
  Game.handleAction(roomId, wolf.id, 'wolf_set', { kill: civs[civs.length - 1].id, confirm: true });
  advanceAll(roomId, host);
  const r = room(roomId);
  assert(r.phase === 'ended', 'G1a 狼刀最后好人民 → phase=ended（实际 ' + r.phase + '）');
  assert(r.winner === 'wolf', 'G1b winner=wolf（屠边）');
}

// ---- G2：猎人被刀 → 开枪带走最后狼 → 好人胜（结算链中途不挂起） ----
{
  // 重建：wolf1 + hunter1（屠边判定需 cfgGods>0 且 gods=0 → 狼胜；这里让猎人开枪带走狼 → 好人胜）
  const c2 = Game.createRoom('房主2');
  const rid2 = c2.roomId, h2 = c2.playerId;
  const ids2 = [h2];
  for (let i = 1; i < 4; i++) ids2.push(Game.joinRoom(rid2, '玩家' + (i + 1)).playerId);
  Game.handleAction(rid2, h2, 'settings', { sheriff: false, thief: false });
  Game.handleAction(rid2, h2, 'setCounts', { counts: { wolf: 1, hunter: 1, villager: 2 } }); // 先 counts 后 cap
  Game.handleAction(rid2, h2, 'setCap', { cap: 4 });
  Game.handleAction(rid2, h2, 'start');
  Game.handleAction(rid2, h2, 'hostPick', { role: 'random' });
  Game.handleAdvance(rid2, h2, 0);
  const wolf2 = roleOf(rid2, 'wolf');
  const hunter2 = roleOf(rid2, 'hunter');
  // 好人只剩猎人：杀光其他好人（除 hunter、wolf）
  setAllDeadExcept(rid2, [wolf2.id, hunter2.id]);
  Game.handleAction(rid2, wolf2.id, 'wolf_set', { kill: hunter2.id, confirm: true }); // 刀猎人
  // wolf_set 后 setNightStep 直接结算 → 猎人分支（nightStep='hunter'），不要 advance（会把 hunter 步弃枪）
  let r2 = room(rid2);
  assert(r2.phase === 'night' && r2.nightStep === 'hunter', 'G2a 猎人被刀 → 先开枪（night/hunter，未直接判狼胜）');
  // 猎人开枪带走狼
  Game.handleAction(rid2, hunter2.id, 'hunter_shoot', { target: wolf2.id });
  r2 = room(rid2);
  assert(r2.phase === 'ended' && r2.winner === 'draw', 'G2b 猎人枪杀最后狼（同归于尽）→ 全灭平局结束（实际 ' + r2.winner + '，结算链中途不挂起）');
  assert(hunter2.alive === false, 'G2c 猎人本身已死（被刀）');
}

// ---- G3：阶段入口兜底——无活人但 phase≠ended → 推进入口触发结束 ----
{
  const { roomId, host } = setupRoom();
  const r = room(roomId);
  // 人为构造：全部死亡但 phase='discuss'（模拟“结算后无人可行动”的挂起残留）
  r.players.forEach(p => { p.alive = false; p.deadBy = 'wolf'; });
  r.phase = 'discuss';
  Game.handleAdvance(roomId, host, 0); // advance(discuss) → startVote 入口兜底
  assert(r.phase === 'ended', 'G3a 无活人 + discuss → 推进入口触发 ended（实际 ' + r.phase + '）');
  // 再构造 phase='morning'（continueMorning 入口）
  r.phase = 'morning';
  r.winner = null; r.endInfo = null;
  Game.handleAdvance(roomId, host, 0);
  assert(r.phase === 'ended', 'G3b 无活人 + morning → continueMorning 入口触发 ended');
}

// ---- G4：checkWin 幂等——ended 后重复推进/操作，phase/winner 不变 ----
{
  const { roomId, host } = setupRoom();
  const wolf = roleOf(roomId, 'wolf');
  const civs = room(roomId).players.filter(p => p.role === 'villager');
  setAllDeadExcept(roomId, [wolf.id, civs[civs.length - 1].id]);
  Game.handleAction(roomId, wolf.id, 'wolf_set', { kill: civs[civs.length - 1].id, confirm: true });
  advanceAll(roomId, host);
  const r = room(roomId);
  const p1 = r.phase, w1 = r.winner;
  advanceAll(roomId, host); // 已 ended 后继续推进
  Game.handleAction(roomId, host, 'mood', { mood: '😀' }); // 任意操作
  assert(r.phase === p1 && r.winner === w1, 'G4 ended 后重复结算/操作 → 幂等（phase/winner 不变）');
  Game.rooms.delete(roomId);
}

if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
console.log('\n终局幂等兜底专项测试全部通过 ✔');
process.exit(0);
