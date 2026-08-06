'use strict';
/* 1.7.4 规则补足专项：丘比特判定表/自连/查验口径分离/翻牌口径/警长平票 PK/checkWin 阵营归属
 * 依赖 debugRoom 摆盘（Game.debugRoom 导出） */
const Game = require('../game.js');
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };

function roleOf(room, id) { const p = room.players.find(x => x.id === id); return p ? p.role : null; }

/* R1 判定表：好+好 → good（丘比特计神职） */
function r1() {
  const room = Game.debugRoom({ phase: 'night', nightStep: 'cupid', night: { cupid: { pick: null } }, roles: [
    { id: 'cup', role: 'cupid', alive: true }, { id: 'a', role: 'villager', alive: true }, { id: 'b', role: 'villager', alive: true }, { id: 'c', role: 'wolf', alive: true },
  ], counts: { wolf: 1, cupid: 1, villager: 2 } });
  Game.handleAction(room.id, 'cup', 'cupid_pick', { ids: ['a', 'b'] });
  assert(room.cupidCamp === 'good', 'R1 好+好 → cupidCamp=good（实际 ' + room.cupidCamp + '）');
  Game.rooms.delete(room.id);
}
/* R2 判定表：狼+狼 → wolf（丘比特属狼人阵营） */
function r2() {
  const room = Game.debugRoom({ phase: 'night', nightStep: 'cupid', night: { cupid: { pick: null } }, roles: [
    { id: 'cup', role: 'cupid', alive: true }, { id: 'a', role: 'wolf', alive: true }, { id: 'b', role: 'wolf', alive: true }, { id: 'c', role: 'villager', alive: true },
  ], counts: { wolf: 2, cupid: 1, villager: 1 } });
  Game.handleAction(room.id, 'cup', 'cupid_pick', { ids: ['a', 'b'] });
  assert(room.cupidCamp === 'wolf', 'R2 狼+狼 → cupidCamp=wolf（实际 ' + room.cupidCamp + '）');
  Game.rooms.delete(room.id);
}
/* R3 判定表：好+狼 → third（人狼恋） */
function r3() {
  const room = Game.debugRoom({ phase: 'night', nightStep: 'cupid', night: { cupid: { pick: null } }, roles: [
    { id: 'cup', role: 'cupid', alive: true }, { id: 'a', role: 'villager', alive: true }, { id: 'b', role: 'wolf', alive: true }, { id: 'c', role: 'villager', alive: true },
  ], counts: { wolf: 1, cupid: 1, villager: 2 } });
  Game.handleAction(room.id, 'cup', 'cupid_pick', { ids: ['a', 'b'] });
  assert(room.cupidCamp === 'third', 'R3 好+狼 → cupidCamp=third（实际 ' + room.cupidCamp + '）');
  Game.rooms.delete(room.id);
}
/* R4 自连：丘比特自连好人 → 好+好 → good（旧规则"自连一律第三方"已废除） */
function r4() {
  const room = Game.debugRoom({ phase: 'night', nightStep: 'cupid', night: { cupid: { pick: null } }, roles: [
    { id: 'cup', role: 'cupid', alive: true }, { id: 'a', role: 'villager', alive: true }, { id: 'b', role: 'villager', alive: true }, { id: 'c', role: 'wolf', alive: true },
  ], counts: { wolf: 1, cupid: 1, villager: 2 } });
  Game.handleAction(room.id, 'cup', 'cupid_pick', { ids: ['cup', 'a'] });
  assert(room.cupidCamp === 'good', 'R4 自连好 → good（实际 ' + room.cupidCamp + '）');
  Game.rooms.delete(room.id);
}
/* R5 自连：丘比特自连狼 → 好+狼 → third */
function r5() {
  const room = Game.debugRoom({ phase: 'night', nightStep: 'cupid', night: { cupid: { pick: null } }, roles: [
    { id: 'cup', role: 'cupid', alive: true }, { id: 'a', role: 'wolf', alive: true }, { id: 'b', role: 'villager', alive: true }, { id: 'c', role: 'villager', alive: true },
  ], counts: { wolf: 1, cupid: 1, villager: 2 } });
  Game.handleAction(room.id, 'cup', 'cupid_pick', { ids: ['cup', 'a'] });
  assert(room.cupidCamp === 'third', 'R5 自连狼 → third（实际 ' + room.cupidCamp + '）');
  Game.rooms.delete(room.id);
}
/* R6 查验口径：第三方狼恋人 → 『好』（非狼） */
function r6() {
  const room = Game.debugRoom({ phase: 'night', nightStep: 'seer', night: { seer: { target: null } }, roles: [
    { id: 's', role: 'seer', alive: true }, { id: 'cup', role: 'cupid', alive: true }, { id: 'wb', role: 'wolfBeauty', alive: true }, { id: 'v', role: 'villager', alive: true }, { id: 'w', role: 'wolf', alive: true },
  ], counts: { wolf: 1, wolfBeauty: 1, seer: 1, cupid: 1, villager: 1 }, lovers: ['wb', 'v'], cupidCamp: 'third' });
  Game.handleAction(room.id, 's', 'seer_pick', { target: 'wb' });
  const h = room.seerHistory[0];
  assert(h && h.result === 'good', 'R6 查第三方狼恋人 → good（实际 ' + (h && h.result) + '）');
  Game.rooms.delete(room.id);
}
/* R7 查验口径：普通狼 → 『狼人』 */
function r7() {
  const room = Game.debugRoom({ phase: 'night', nightStep: 'seer', night: { seer: { target: null } }, roles: [
    { id: 's', role: 'seer', alive: true }, { id: 'wb', role: 'wolfBeauty', alive: true }, { id: 'v', role: 'villager', alive: true }, { id: 'w', role: 'wolf', alive: true },
  ], counts: { wolf: 1, wolfBeauty: 1, seer: 1, villager: 1 }, lovers: ['wb', 'v'], cupidCamp: 'third' });
  Game.handleAction(room.id, 's', 'seer_pick', { target: 'w' });
  const h = room.seerHistory[0];
  assert(h && h.result === 'wolf', 'R7 查普通狼 → wolf（实际 ' + (h && h.result) + '）');
  Game.rooms.delete(room.id);
}
/* R8 查验口径：丘比特属狼人阵营（狼狼恋）→ 『狼人』 */
function r8() {
  const room = Game.debugRoom({ phase: 'night', nightStep: 'seer', night: { seer: { target: null } }, roles: [
    { id: 's', role: 'seer', alive: true }, { id: 'cup', role: 'cupid', alive: true }, { id: 'a', role: 'wolf', alive: true }, { id: 'b', role: 'wolf', alive: true },
  ], counts: { wolf: 2, seer: 1, cupid: 1 }, cupidCamp: 'wolf', lovers: ['a', 'b'] });
  Game.handleAction(room.id, 's', 'seer_pick', { target: 'cup' });
  const h = room.seerHistory[0];
  assert(h && h.result === 'wolf', 'R8 查属狼人阵营丘比特 → wolf（实际 ' + (h && h.result) + '）');
  Game.rooms.delete(room.id);
}
/* R9 翻牌口径：狼美人翻牌显示『狼人』（不显示狼美人） */
function r9() {
  const room = Game.debugRoom({ phase: 'ended', roles: [
    { id: 'wb', role: 'wolfBeauty', alive: false }, { id: 'v', role: 'villager', alive: true }, { id: 'w', role: 'wolf', alive: true },
  ] });
  const v = Game.viewFor(room, 'v', 0);
  const wb = v.players.find(p => p.id === 'wb');
  assert(wb && wb.role === '狼人', 'R9 狼美人翻牌显示『狼人』（实际 ' + (wb && wb.role) + '）');
  Game.rooms.delete(room.id);
}
/* R10 警长竞选平票 → PK 再投，得票最多者当选 */
function r10() {
  const room = Game.debugRoom({ phase: 'sheriff_vote', day: 1, roles: [
    { id: 'p1', role: 'villager', alive: true }, { id: 'p2', role: 'villager', alive: true }, { id: 'p3', role: 'villager', alive: true },
    { id: 'p4', role: 'villager', alive: true }, { id: 'p5', role: 'wolf', alive: true },
  ], candidates: ['p1', 'p2'], sheriff: null, settings: { sheriff: true, winMode: 'edge', tieRule: 'pk', thief: false, botMode: 'auto' } });
  // 平票：p1 与 p2 各 2 票（p5 弃票）
  for (const [voter, t] of [['p1', 'p2'], ['p2', 'p1'], ['p3', 'p1'], ['p4', 'p2']]) Game.handleAction(room.id, voter, 'vote', { target: t });
  Game.handleAction(room.id, 'p5', 'vote', { target: null });
  assert(room.phase === 'pk_vote' && room.pkIsSheriff === true, 'R10 警长平票 → 进入 PK（实际 phase=' + room.phase + ' pkIsSheriff=' + room.pkIsSheriff + '）');
  // PK：p2 得 3 票当选
  for (const [voter, t] of [['p1', 'p2'], ['p2', 'p2'], ['p3', 'p2'], ['p4', 'p1'], ['p5', 'p1']]) Game.handleAction(room.id, voter, 'vote', { target: t });
  assert(room.sheriff === 'p2' && room.phase === 'discuss', 'R10 警长 PK 后 p2 当选（实际 sheriff=' + room.sheriff + ' phase=' + room.phase + '）');
  Game.rooms.delete(room.id);
}
/* R11 checkWin：丘比特属狼人阵营（狼狼恋）→ 好人胜需丘比特死亡 */
function r11() {
  const room = Game.debugRoom({ phase: 'vote', roles: [
    { id: 'cup', role: 'cupid', alive: true }, { id: 'w', role: 'wolf', alive: true }, { id: 'v', role: 'villager', alive: true },
  ], cupidCamp: 'wolf', lovers: ['cup', 'w'] });
  // 狼 w 死（非活）→ 剩 cup（属狼人）+ v —— wolfCamp 含 cup → 好人未胜
  room.players.find(x => x.id === 'w').alive = false;
  room.players.find(x => x.id === 'w').deadBy = 'shoot';
  const win = Game.checkWin(room); // 1.7.4：checkWin 已导出
  assert(win === null, 'R11 狼死但属狼人丘比特存活 → 好人未胜（checkWin=' + win + '）');
  // 丘比特死 → 好人胜
  room.players.find(x => x.id === 'cup').alive = false;
  room.players.find(x => x.id === 'cup').deadBy = 'exile';
  const win2 = Game.checkWin(room);
  assert(win2 === 'good', 'R11 属狼人丘比特死亡 → 好人胜（checkWin=' + win2 + '）');
  Game.rooms.delete(room.id);
}
/* R12 cupidCamp 未指定（null）→ thirdFaction 空、typeOf(cupid)=dyn */
function r12() {
  const room = Game.debugRoom({ phase: 'night', nightStep: 'cupid', night: { cupid: { pick: null } }, roles: [
    { id: 'cup', role: 'cupid', alive: true }, { id: 'a', role: 'villager', alive: true }, { id: 'b', role: 'villager', alive: true }, { id: 'w', role: 'wolf', alive: true },
  ], counts: { wolf: 1, cupid: 1, villager: 2 } });
  assert(room.cupidCamp === null, 'R12 未指定情侣 → cupidCamp=null（实际 ' + room.cupidCamp + '）');
  Game.rooms.delete(room.id);
}
/* R13 7b：毒梦游者无效但消耗（梦游者存活、毒药已标记消耗） */
function r13() {
  const room = Game.debugRoom({ phase: 'night', nightStep: 'witch', night: { dreamer: { target: 'v' }, witch: { save: false, poison: 'v', revealed: false } }, witchPots: { saveUsed: false, poisonUsed: true }, roles: [
    { id: 'd', role: 'dreamer', alive: true }, { id: 'w', role: 'wolf', alive: true }, { id: 'v', role: 'villager', alive: true }, { id: 's', role: 'seer', alive: true },
  ] });
  for (let i = 0; i < 10 && room.phase === 'night'; i++) Game.handleAdvance(room.id, room.host);
  const v = room.players.find(x => x.id === 'v');
  assert(v.alive === true, 'R13 毒梦游者无效（梦游者存活，实际 alive=' + v.alive + '）');
  assert(room.witchPots.poisonUsed === true, 'R13 毒药已消耗（poisonUsed=' + room.witchPots.poisonUsed + '）');
  Game.rooms.delete(room.id);
}
/* R14 checkwin：丘比特属好人阵营 → 计神职参与屠边（存活时狼不能屠边，死亡后才触发） */
function r14() {
  const room = Game.debugRoom({ phase: 'vote', roles: [
    { id: 's', role: 'seer', alive: true }, { id: 'cup', role: 'cupid', alive: true }, { id: 'w', role: 'wolf', alive: true },
    { id: 'v', role: 'villager', alive: true }, { id: 'a', role: 'villager', alive: true },
  ], cupidCamp: 'good', lovers: ['v', 'a'] });
  room.players.find(x => x.id === 's').alive = false;
  room.players.find(x => x.id === 's').deadBy = 'wolf';
  const win = Game.checkWin(room);
  assert(win === null, 'R14 丘比特（好人阵营·神职）存活 → 狼未屠边（checkWin=' + win + '）');
  room.players.find(x => x.id === 'cup').alive = false;
  room.players.find(x => x.id === 'cup').deadBy = 'shoot';
  const win2 = Game.checkWin(room);
  assert(win2 === 'wolf', 'R14 丘比特（神职）死亡 → 屠边狼胜（checkWin=' + win2 + '）');
  Game.rooms.delete(room.id);
}

r1(); r2(); r3(); r4(); r5(); r6(); r7(); r8(); r9(); r10(); r11(); r12(); r13(); r14();
if (failures) { console.error('共 ' + failures + ' 处断言失败'); process.exit(1); }
console.log('共 14 项规则断言全部通过');
process.exit(0);
