'use strict';
/* check-lover-v2.js —— 恋人机制引擎单测（favens v2，M1）
 * 覆盖：三态开关 / 解绑硬约束与解锁 / 权能槽（守护/复仇）/ 恋人刀 / classic 回归
 * 驱动：debugRoom 摆盘 + nightAction（wolf_set → setNightStep → resolveNight）
 * 注意：debugRoom 的 opts.night 是 nightNum（数字），night 结构需摆盘后手动设置
 */
const assert = require('assert');
const Game = require('../game.js');
const loverCore = require('../loverCore.js');
let failures = 0;
const ok = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };

const NIGHT = { wolf: { kill: null, charm: null, sel: {} }, guard: { target: null }, dreamer: { target: null }, witch: { save: false, poison: null, revealed: false }, cupid: { pick: null } };
function mkRoom(opts = {}) {
  const room = Game.debugRoom(Object.assign({
    phase: 'night', nightStep: 'wolf', night: 0,
    nightActed: {},
    roles: [
      { id: 'L', role: 'wolf', alive: true }, { id: 'W', role: 'wolf', alive: true },
      { id: 'cup', role: 'cupid', alive: true },
      { id: 'a', role: 'villager', alive: true }, { id: 'v', role: 'villager', alive: true },
    ],
    lovers: ['L', 'a'], cupidCamp: 'third', host: 'L',
  }, opts));
  room.night = JSON.parse(JSON.stringify(NIGHT)); // 摆盘 night 结构
  room.night.wolf.sel = {};
  return room;
}
function events(room, type) { return (room.events || []).filter(e => e.type === type); }
function dieOf(room, id) { const q = room.players.find(x => x.id === id); return q ? q.alive : null; }
function sysMsgs(room) { return (room.messages || []).filter(m => m.marker === '系统'); }
/* 驱动狼刀：decoy 狼先投 v + confirm，killer 最后投 kill + confirm（kill 最终生效，触发 resolveNight） */
function driveWolfKill(room, killer, kill) {
  const others = room.players.filter(q => q.alive && (q.role === 'wolf' || q.role === 'wolfBeauty') && q.id !== killer);
  for (const o of others) Game.handleAction(room.id, o.id, 'wolf_set', { kill: 'v', confirm: true });
  Game.handleAction(room.id, killer, 'wolf_set', { kill, confirm: true });
}

/* T1 classic：解绑被拒（三态隔离） */
{
  const room = mkRoom({ phase: 'vote', loverMode: 'classic' });
  const res = Game.handleAction(room.id, 'a', 'lover_unbind', {});
  ok(res.error && res.error.includes('仅 v2'), 'T1 classic 解绑被拒');
  Game.rooms.delete(room.id);
}
/* T2 v2 丘比特存活：解绑被拒（唯一硬约束） */
{
  const room = mkRoom({ phase: 'vote', loverMode: 'v2' });
  const res = Game.handleAction(room.id, 'a', 'lover_unbind', {});
  ok(res.error && res.error.includes('丘比特尚在'), 'T2 丘比特存活时解绑被拒');
  Game.rooms.delete(room.id);
}
/* T3 v2 丘比特死后：解绑成功 → 关系解除（不再殉情/互认/频道） */
{
  const room = mkRoom({ phase: 'vote', loverMode: 'v2' });
  room.players.find(q => q.id === 'cup').alive = false; // 丘比特已死
  const res = Game.handleAction(room.id, 'a', 'lover_unbind', {});
  ok(res.ok && room.lovers === null, 'T3a 解绑成功且情侣关系解除（lovers=null）');
  ok(events(room, 'lover_unbind').length === 1, 'T3b lover_unbind 事件入流');
  ok(sysMsgs(room).some(m => m.text.includes('解除')), 'T3c 系统公告（身份公开代价）');
  // 解绑后一方死亡 → 不殉情（切回 night 阶段驱动狼刀）
  room.phase = 'night'; room.nightStep = 'wolf'; room.nightActed = {};
  room.night.wolf.kill = null; room.night.wolf.sel = {};
  room.players.find(q => q.id === 'a').alive = true;
  driveWolfKill(room, 'L', 'a');
  ok(dieOf(room, 'a') === false && dieOf(room, 'L') === true, 'T3d 解绑后不再殉情（L 存活）');
  Game.rooms.delete(room.id);
}
/* T4 v2 守护：狼刀恋人被挡（免疫 + 狼队“刀被挡”消息） */
{
  const room = mkRoom({ loverMode: 'v2' });
  loverCore.grantPower(room, 'guard');
  driveWolfKill(room, 'L', 'a'); // L 刀恋人 a → 被守护挡下
  ok(dieOf(room, 'a') === true, 'T4a 狼刀恋人被守护挡下（a 存活）');
  ok(events(room, 'lover_guard').length === 1, 'T4b lover_guard 事件');
  ok(room.messages.some(m => m.ch === 'wolf' && m.text.includes('刀被挡')), 'T4c 狼队收到刀被挡消息');
  ok(events(room, 'lover_betray').length === 0, 'T4d 挡刀不触发背叛判定');
  Game.rooms.delete(room.id);
}
/* T5 v2 复仇：恋人被刀（非背叛）→ 殉情方临死宣言 */
{
  const room = mkRoom({ loverMode: 'v2' });
  loverCore.grantPower(room, 'vengeance');
  // W（非恋人狼）最后投刀恋人 a；L（狼恋人）decoy 投 v → sel[L]='v' ≠ kill → 非背叛
  driveWolfKill(room, 'W', 'a');
  ok(dieOf(room, 'a') === false, 'T5a 狼刀恋人 a → a 死');
  ok(dieOf(room, 'L') === false, 'T5b 狼恋人 L 殉情');
  const rv = events(room, 'lover_reveal');
  ok(rv.length === 1 && rv[0].data.declarer === 'L' && rv[0].data.partner === 'a', 'T5c 殉情方 L 临死宣言（恋人=a）');
  Game.rooms.delete(room.id);
}
/* T6 v2 恋人刀（背叛权）：狼恋人投刀恋人 → 不殉情 + 狼队公告身份 */
{
  const room = mkRoom({ loverMode: 'v2' });
  driveWolfKill(room, 'L', 'a'); // L 投刀恋人 a
  ok(dieOf(room, 'a') === false, 'T6a 恋人 a 被刀死');
  ok(dieOf(room, 'L') === true, 'T6b 狼恋人 L 不殉情（背叛存活）');
  ok(events(room, 'lover_betray').length === 1, 'T6c lover_betray 事件');
  ok(events(room, 'lover_reveal').length === 0, 'T6d 恋人刀不触发复仇宣言');
  ok(room.messages.some(m => m.ch === 'wolf' && m.text.includes('背叛')), 'T6e 狼队收到背叛公告');
  Game.rooms.delete(room.id);
}
/* T7 off：关闭恋人机制（丘比特连人无效） */
{
  const room = mkRoom({ phase: 'night', nightStep: 'cupid', loverMode: 'off' });
  const res = Game.handleAction(room.id, 'cup', 'cupid_pick', { ids: ['L', 'a'] });
  ok(res.error && res.error.includes('关闭恋人机制'), 'T7 off 模式丘比特连人被拒');
  Game.rooms.delete(room.id);
}
/* T8 classic 回归：狼刀恋人 → 正常殉情（对照 T6，冻结行为零破坏） */
{
  const room = mkRoom({ loverMode: 'classic' });
  driveWolfKill(room, 'L', 'a');
  ok(dieOf(room, 'a') === false && dieOf(room, 'L') === false, 'T8 classic 狼刀恋人 → a 死 L 殉情（与历史一致）');
  ok(events(room, 'lover_betray').length === 0 && events(room, 'lover_reveal').length === 0, 'T8b classic 无 v2 事件');
  Game.rooms.delete(room.id);
}

/* T9/T10（M3.5）：bot 解绑决策 + 恋人刀反制（favens v2 策略层） */
const goodLover = require('../favens/goodLover.js');
const wolfLover = require('../favens/wolfLover.js');
const room9 = Game.debugRoom({ phase: 'vote', loverMode: 'v2', roles: [{ id: 'L', role: 'wolf' }, { id: 'a', role: 'villager' }, { id: 'cup', role: 'cupid' }, { id: 'v', role: 'villager' }], lovers: ['L', 'a'], cupidCamp: 'third', night: 0 });
room9.loverV2 = { power: 'vengeance', unbind: { used: false, by: null }, timeline: {} };
const botA = room9.players.find(q => q.id === 'a');
const d1 = goodLover.decideVoteV2(room9, botA);
ok(!d1 || d1.action !== 'lover_unbind', 'T9a 丘比特活着 → 好恋人不解绑');
room9.players.find(q => q.id === 'cup').alive = false;
const d2 = goodLover.decideVoteV2(room9, botA);
ok(d2 && d2.action === 'lover_unbind', 'T9b 丘比特死后 → 人狼恋好恋人发起解绑（M3.5 激活点）');
room9.loverV2.unbind.used = true;
const d3 = goodLover.decideVoteV2(room9, botA);
ok(!d3 || d3.action !== 'lover_unbind', 'T9c 解绑仅一次（已用不再发起）');
Game.rooms.delete(room9.id);

const roomA = Game.debugRoom({ phase: 'night', nightStep: 'wolf', loverMode: 'v2', roles: [{ id: 'L', role: 'wolf' }, { id: 'a', role: 'villager' }, { id: 'cup', role: 'cupid' }, { id: 'v', role: 'villager' }], lovers: ['L', 'a'], cupidCamp: 'third', night: 0 });
roomA.loverV2 = { power: 'vengeance', unbind: { used: false, by: null }, timeline: {} };
roomA.rng = { next: () => 0.1 }; // 强制走恋人刀分支
roomA.players.find(q => q.id === 'cup').alive = false; // 丘比特死后（免疫期结束）
const dA = wolfLover.decideNightV2(roomA, roomA.players.find(q => q.id === 'L'));
ok(dA && dA.action === 'wolf_set' && dA.data.kill === 'a', 'T10a 丘比特死后 → 狼恋人 50% 恋人刀反制（不殉情+公告）');
roomA.players.find(q => q.id === 'cup').alive = true;
const dB = wolfLover.decideNightV2(roomA, roomA.players.find(q => q.id === 'L'));
ok(!dB, 'T10b 丘比特活着 → 普通狼刀法（免疫期不反制）');
Game.rooms.delete(roomA.id);

/* T11（M3.5）：A/B 注入 G3——loverLocked 时解绑被拒（丘比特死后解绑仍锁定） */
const roomL = Game.debugRoom({ phase: 'vote', loverMode: 'v2', roles: [{ id: 'L', role: 'wolf' }, { id: 'a', role: 'villager' }, { id: 'cup', role: 'cupid' }, { id: 'v', role: 'villager' }], lovers: ['L', 'a'], cupidCamp: 'third', night: 0 });
roomL.loverV2 = { power: 'vengeance', unbind: { used: false, by: null }, timeline: {} };
roomL.loverLocked = true; // G3 注入
roomL.players.find(q => q.id === 'cup').alive = false; // 丘比特已死
const dL = Game.handleAction(roomL.id, 'a', 'lover_unbind', {});
ok(dL.error && dL.error.includes('锁定'), 'T11 loverLocked → 丘比特死后解绑仍被拒（G3 对照）');
Game.rooms.delete(roomL.id);

if (failures) { console.error(`\n${failures} 个断言失败`); process.exit(1); }
console.log('\ncheck-lover-v2 全部通过 ✓');
process.exit(0); // 摆盘房间的阶段性定时器仍挂着（房间已删），显式退出
