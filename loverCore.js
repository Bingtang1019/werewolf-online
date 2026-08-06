'use strict';
/* loverCore.js —— 恋人机制引擎核心（favens v2，M1）
 * loverMode 三态（game.js 建房配置）：
 *   'off'     关闭恋人机制（丘比特连人无效）
 *   'classic' 现行规则（冻结行为，α9/B1 零破坏）
 *   'v2'      权能槽（守护/复仇）+ 解绑 + 恋人刀（背叛权）
 * 状态挂 room.loverV2：{ power, unbind:{used,by}, betrayUsed, guardNight, timeline:{cupidDeadNight,unbindNight,power} }
 * 原则：规则在引擎，策略在 AI（favens）。game.js 仅在 loverMode==='v2' 时调用本模块，classic/off 路径不触达。
 * 事件（由 game.js pushEvent + 系统消息双写）：
 *   lover_unbind（解绑公告）/ lover_guard（挡刀）/ lover_reveal（复仇宣言）/ lover_betray（恋人刀）
 */
function st(room) {
  if (!room.loverV2) room.loverV2 = { power: null, unbind: { used: false, by: null }, betrayUsed: false, guardNight: 0, timeline: { cupidDeadNight: null, unbindNight: null, power: null } };
  return room.loverV2;
}
function byId(room, id) { return room.players.find(q => q.id === id) || null; }
function isWolfRole(q) { return q && (q.role === 'wolf' || q.role === 'wolfBeauty'); }
function v2(room) { return room.loverMode === 'v2'; }
function isLover(room, id) { return !!room.lovers && room.lovers.includes(id); }
function loverOf(room, id) { return room.lovers ? room.lovers.find(x => x !== id) || null : null; }
function cupidDead(room) { const c = room.players.find(q => q.role === 'cupid'); return !c || !c.alive; }
const DAY_PHASES = ['day', 'morning', 'vote', 'speech', 'pk_speech', 'pk_vote', 'sheriff_speech', 'sheriff_vote', 'hunter_shot'];

/* 解绑（修复"殉情投票免疫"——核心一刀）：
 * 条件：v2 && 丘比特已死（唯一硬约束）&& 未用过 && 发起者是恋人成员 && 白天。
 * 效果：不再殉情、不再互认、情侣频道关闭、双方恢复普通身份；系统公告解绑者身份（代价）。
 * 博弈：丘比特存活 = 关系锁生效（免疫期）；丘比特死亡 = 解绑解锁 → 好恋人可反制绑架，狼恋人需防被解绑。 */
function canUnbind(room, playerId) {
  if (!v2(room)) return { ok: false, msg: '仅 v2 模式可解绑' };
  if (room.loverLocked) return { ok: false, msg: '本局解绑已锁定（A/B 注入：unbindLocked，G3 对照）' }; // M3.5：丘比特死但解绑禁用——分离解绑效应
  if (!room.lovers || !isLover(room, playerId)) return { ok: false, msg: '仅恋人成员可发起解绑' };
  const s = st(room);
  if (s.unbind.used) return { ok: false, msg: '本局解绑已使用' };
  if (!cupidDead(room)) return { ok: false, msg: '丘比特尚在，情侣关系锁定中' };
  if (!DAY_PHASES.includes(room.phase)) return { ok: false, msg: '仅白天可发起解绑' };
  return { ok: true };
}
function unbind(room, playerId) {
  const chk = canUnbind(room, playerId);
  if (!chk.ok) return chk;
  const s = st(room);
  s.unbind.used = true; s.unbind.by = playerId;
  s.timeline.unbindNight = room.nightNum;
  const p = byId(room, playerId);
  room.lovers = null; // 关系解除：applyLoverChain 跳过殉情 / isLoverParty 关频道 / view myLover 消失
  return { ok: true, by: p ? p.name : '', byId: playerId };
}
/* 恋人权能槽（修复"丘比特 0 贡献"）：丘比特连人时二选一（v2 必选） */
function grantPower(room, power) {
  if (power !== 'guard' && power !== 'vengeance') return { ok: false, msg: '权能必须是 guard（守护）或 vengeance（复仇）' };
  const s = st(room);
  s.power = power; s.timeline.power = power;
  return { ok: true };
}
/* 守护：v2+guard+狼刀目标是恋人 → 挡刀（不死）。狼队收到"刀被挡"（暴露恋人位置，代价端）。 */
function applyGuard(room, killId) {
  const s = st(room);
  if (!v2(room) || s.power !== 'guard' || !room.lovers || !room.lovers.includes(killId)) return false;
  s.guardNight = room.nightNum + 1;
  return true;
}
/* 复仇宣言：恋人一方因被刀/被票死亡（非自然殉情、非恋人刀）→ 殉情方临死公开身份链 */
function vengeanceDeclare(room, dyingId) {
  const s = st(room);
  if (!v2(room) || s.power !== 'vengeance') return null;
  const partner = loverOf(room, dyingId);
  if (!partner) return null;
  const dq = byId(room, dyingId), pq = byId(room, partner);
  return { declarer: dyingId, declarerName: dq ? dq.name : '', partner, partnerName: pq ? pq.name : '', role: dq ? dq.role : '' };
}
/* 恋人刀（背叛权）：v2 + 狼恋人本人投刀自己的恋人 → 不殉情 + 狼队公告恋人身份（公开=代价） */
function betrayalKill(room, killId) {
  const s = st(room);
  if (!v2(room) || !room.lovers || !room.lovers.includes(killId)) return false;
  const wolfLoverId = room.lovers.find(id => { const q = byId(room, id); return q && q.alive && isWolfRole(q); });
  if (!wolfLoverId) return false;
  const sel = room.night && room.night.wolf && room.night.wolf.sel;
  if (!sel || sel[wolfLoverId] !== killId) return false; // 必须狼恋人本人投的刀
  s.betrayUsed = true;
  return { wolfLoverId, killId, wolfLoverName: byId(room, wolfLoverId) ? byId(room, wolfLoverId).name : '' };
}
/* 丘比特死亡轮次记录（M3 时序敏感性分析数据源） */
function trackCupidDeath(room, deaths) {
  if (!v2(room)) return;
  const s = st(room);
  if (s.timeline.cupidDeadNight != null) return;
  for (const id of deaths) { const q = byId(room, id); if (q && q.role === 'cupid') { s.timeline.cupidDeadNight = room.nightNum; break; } }
}
/* 视图透出（真人 UI：解绑按钮点亮 / 权能展示） */
function viewState(room, pid) {
  const s = st(room);
  return {
    loverMode: room.loverMode,
    inLovers: isLover(room, pid),
    canUnbind: canUnbind(room, pid).ok,
    unbindUsed: s.unbind.used,
    unbindBy: s.unbind.by,
    cupidDead: cupidDead(room),
    power: s.power,
    timeline: room.phase === 'ended' ? s.timeline : null,
  };
}
/* 付费护短标记（v2）：好恋人本票为护短 → 结算时公告“X在保护恋人”（狼队获知身份，代价端） */
function markProtect(room, playerId) { st(room).protectBy = playerId; return true; }
module.exports = { canUnbind, unbind, grantPower, applyGuard, vengeanceDeclare, betrayalKill, trackCupidDeath, markProtect, viewState, isLover, loverOf, cupidDead, v2 };
