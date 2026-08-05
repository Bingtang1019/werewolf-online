'use strict';
/* =========================================================================
 * 场景7：丘比特自连人狼情侣
 * 规则（补丁5）：好人/狼阵营均剔除第三方成员计数 —— 好人狼人互杀决胜负，
 * 第三方默认输，除非场上只剩第三方成员（活到最后）。
 * 本场景验证：放逐非第三方狼后，好人立即获胜（第三方成员仍存活但游戏已结束）。
 * 运行：node test/simulate-cupid-self.js
 * ========================================================================= */
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8367;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const assert = (cond, msg) => { if (cond) console.log('  ✓ ' + msg); else { failures++; console.error('  ✗ FAIL: ' + msg); } };
const eq = (a, b, msg) => assert(a === b, `${msg} (期望 ${JSON.stringify(b)},实际 ${JSON.stringify(a)})`);
async function api(p, body) { const res = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return res.json(); }
async function act(room, me, action, data) { const r = await api('/api/action', { room, me, action, data: data || {} }); if (r.error) throw new Error(`action ${action} 失败: ${r.error}`); return r.view; }
async function state(room, me) { return (await (await fetch(`${BASE}/api/state?room=${room}&me=${me}`)).json()); }
async function rolesOf(room, ids) { const m = {}; for (const id of ids) { const v = await state(room, id); m[id] = v.my.role; } return m; }
async function doAdvance(room, me) { const r = await api('/api/advance', { room, me }); if (r.error) throw new Error('advance 失败: ' + r.error); return r.view; }

async function scenario7() {
  console.log('\n===== 场景7：丘比特自连人狼情侣 → 好人早胜（第三方默认输） =====');
  const A = await api('/api/create', { name: 'A' });
  const room = A.roomId;
  const ids = [A.playerId];
  const counts = { wolf: 2, villager: 3, seer: 1, witch: 1, cupid: 1 };
  await act(room, A.playerId, 'setCap', { cap: 8 });
  await act(room, A.playerId, 'setCounts', { counts });
  await act(room, A.playerId, 'settings', { sheriff: false, winMode: 'city' });
  for (let i = 0; i < 7; i++) {
    const r = await api('/api/join', { roomId: room, name: String.fromCharCode(66 + i) });
    if (r.error) throw new Error('join 失败: ' + r.error);
    ids.push(r.playerId);
  }
  let v = await act(room, A.playerId, 'start');
  await act(room, A.playerId, 'hostPick', { role: 'seer' });
  for (const id of ids.slice(1)) await act(room, id, 'confirm');
  v = await state(room, A.playerId);
  eq(v.phase, 'night', '进入第一晚');
  const roles = await rolesOf(room, ids);
  const wolves = ids.filter(id => roles[id] === '狼人');
  const cupid = ids.find(id => roles[id] === '丘比特');
  const witch = ids.find(id => roles[id] === '女巫');
  assert(wolves.length === 2 && !!cupid && !!witch, '角色在场');
  const w1 = wolves[0], w2 = wolves[1];
  const villagers = ids.filter(id => roles[id] === '平民');
  const v1 = villagers[0];
  // 丘比特自连 w1（人狼情侣，第三方 = 丘比特 + w1）
  const cv = await state(room, cupid);
  eq(cv.nightStep, 'cupid', '丘比特睁眼');
  await act(room, cupid, 'cupid_pick', { ids: [cupid, w1] });
  // 情侣（丘比特+狼）互认
  for (const id of [cupid, w1]) {
    const lv = await state(room, id);
    if (lv.nightStep === 'lovers') {
      eq(lv.night.lovers.partner, id === cupid ? w1 : cupid, '情侣互相确认');
      if (id === w1) eq(lv.night.lovers.partnerRole, '丘比特', '狼看到情侣身份是丘比特');
      await act(room, id, 'lovers_ok');
    }
  }
  // 狼刀 v1（非第三方）
  for (const w of wolves) { const wv = await state(room, w); if (wv.nightStep === 'wolf') { await act(room, w, 'wolf_set', { kill: v1 }); await act(room, w, 'wolf_set', { confirm: true }); } }
  v = await state(room, A.playerId);
  if (v.nightStep === 'seer') await act(room, A.playerId, 'seer_pick', { target: w1 });
  v = await state(room, A.playerId);
  if (v.nightStep === 'witch') await act(room, witch, 'witch_act', { save: false });
  v = await state(room, A.playerId);
  eq(v.phase, 'morning', '进入早晨');
  eq(v.morningDeaths.length, 1, 'v1 死于狼刀');
  await doAdvance(room, A.playerId);
  v = await state(room, A.playerId);
  if (v.phase === 'lastword') { const lw = await state(room, v.lastword.entitled[0].id); if (lw.phase === 'lastword') await act(room, lw.my.id, 'post', { text: '遗言' }); v = await state(room, A.playerId); }
  eq(v.phase, 'discuss', '进入白天发言');
  // 放逐非第三方狼 w2 → 好人早胜（第三方成员仍存活）
  await act(room, A.playerId, 'startVote');
  v = await state(room, A.playerId);
  for (const p of v.players.filter(x => x.alive)) { const qv = await state(room, p.id); if (qv.phase === 'vote') await act(room, p.id, 'vote', { target: w2 }); }
  v = await state(room, A.playerId);
  if (v.phase === 'lastword') { const lw = await state(room, w2); if (lw.phase === 'lastword') await act(room, w2, 'post', { text: '遗言' }); v = await state(room, A.playerId); }
  eq(v.phase, 'ended', '游戏结束');
  eq(v.winner, 'good', '好人阵营获胜（第三方默认输）');
  const end = await state(room, A.playerId);
  const cupidAlive = (end.players.find(p => p.id === cupid) || {}).alive;
  const w1Alive = (end.players.find(p => p.id === w1) || {}).alive;
  assert(cupidAlive && w1Alive, '第三方成员（丘比特+狼）仍存活，但好人已获胜（无需消灭第三方）');
  assert(end.endInfo && end.endInfo.text === '好人阵营获胜', '结算信息正确');
  console.log('  场景7 完成');
}

async function main() {
  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SNAPSHOT_SEC: '0', PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => process.stdout.write('[server] ' + d));
  await sleep(900);
  await scenario7();
  server.kill();
  await sleep(300);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\n场景7 全部通过 ✔');
  process.exit(0);
}
main();
