'use strict';
/* =========================================================================
 * 场景9：丘比特自连好人 → 好人/狼同归于尽，第三方活到最后获胜
 * 规则（补丁5）：第三方胜 = 场上只剩第三方成员（活到最后）。
 * 流程：6人局（狼1/丘1/巫1/猎1/民2），丘比特自连平民X；
 * 夜1：狼刀猎人 → 猎人开枪射平民v1（好狼各损一）；
 * 日1：3:3 平票无人出局；夜2：狼刀女巫 + 女巫毒狼 同归于尽；
 * 场上只剩第三方（丘比特+平民X）→ 第三方获胜。
 * 运行：node test/simulate-third-survive.js
 * ========================================================================= */
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8370;
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

async function scenario9() {
  console.log('\n===== 场景9：丘比特自连好人 → 好狼同灭，第三方活到最后获胜 =====');
  const A = await api('/api/create', { name: 'A' });
  const room = A.roomId;
  const ids = [A.playerId];
  const counts = { wolf: 1, villager: 2, witch: 1, hunter: 1, cupid: 1 };
  await act(room, A.playerId, 'setCap', { cap: 6 });
  await act(room, A.playerId, 'setCounts', { counts });
  await act(room, A.playerId, 'settings', { sheriff: false, winMode: 'city', tieRule: 'none' });
  for (let i = 0; i < 5; i++) {
    const r = await api('/api/join', { roomId: room, name: String.fromCharCode(66 + i) });
    if (r.error) throw new Error('join 失败: ' + r.error);
    ids.push(r.playerId);
  }
  let v = await act(room, A.playerId, 'start');
  await act(room, A.playerId, 'hostPick', { role: 'hunter' });
  for (const id of ids.slice(1)) await act(room, id, 'confirm');
  v = await state(room, A.playerId);
  eq(v.phase, 'night', '进入第一晚');
  const roles = await rolesOf(room, ids);
  const w1 = ids.find(id => roles[id] === '狼人');
  const cupid = ids.find(id => roles[id] === '丘比特');
  const witch = ids.find(id => roles[id] === '女巫');
  const hunter = ids.find(id => roles[id] === '猎人');
  const villagers = ids.filter(id => roles[id] === '平民');
  const v1 = villagers[0], X = villagers[1] || villagers[0];
  assert(!!w1 && !!cupid && !!witch && !!hunter && villagers.length >= 2, '角色在场');

  // 丘比特自连平民 X（第三方 = 丘比特 + X）
  const cv = await state(room, cupid);
  eq(cv.nightStep, 'cupid', '丘比特睁眼');
  await act(room, cupid, 'cupid_pick', { ids: [cupid, X] });
  for (const id of [cupid, X]) {
    const lv = await state(room, id);
    if (lv.nightStep === 'lovers') { eq(lv.night.lovers.partner, id === cupid ? X : cupid, '情侣互相确认'); await act(room, id, 'lovers_ok'); }
  }
  // 夜1：狼刀猎人；女巫不救 → 猎人开枪射平民 v1
  const wv1 = await state(room, w1);
  if (wv1.nightStep === 'wolf') { await act(room, w1, 'wolf_set', { kill: hunter }); await act(room, w1, 'wolf_set', { confirm: true }); }
  v = await state(room, A.playerId);
  if (v.nightStep === 'witch') await act(room, witch, 'witch_act', { save: false });
  v = await state(room, A.playerId);
  eq(v.nightStep, 'hunter', '猎人开枪阶段');
  await act(room, hunter, 'hunter_shoot', { target: v1 });
  v = await state(room, A.playerId);
  eq(v.phase, 'morning', '进入早晨');
  const byIdMap = {};
  v.morningDeaths.forEach(x => byIdMap[x.id] = x);
  eq(byIdMap[hunter] && byIdMap[hunter].deadBy, 'wolf', '猎人死于狼刀');
  eq(byIdMap[v1] && byIdMap[v1].deadBy, 'shoot', '平民 v1 被猎人枪杀');
  // 日1：3:3 平票（无人出局）→ 进入夜2
  await doAdvance(room, A.playerId);
  v = await state(room, A.playerId);
  if (v.phase === 'lastword') { for (const id of v.lastword.entitled) { const dv = await state(room, id.id); if (dv.phase === 'lastword') await act(room, id.id, 'post', { text: '遗言' }); } v = await state(room, A.playerId); }
  eq(v.phase, 'discuss', '进入白天发言');
  await act(room, A.playerId, 'startVote');
  v = await state(room, A.playerId);
  const votes = { [cupid]: w1, [X]: w1, [witch]: cupid, [w1]: cupid }; // 2:2 平票
  for (const p of v.players.filter(x => x.alive)) { const qv = await state(room, p.id); if (qv.phase === 'vote') await act(room, p.id, 'vote', { target: votes[p.id] || null }); }
  v = await state(room, A.playerId);
  eq(v.lastVoteResult && v.lastVoteResult.result, 'tie', '白天投票平票');
  eq(v.phase, 'night', '平票无人出局，进入第二晚');
  // 夜2：狼刀女巫 + 女巫毒狼 同归于尽 → 只剩第三方（丘比特+平民X）
  const wv2 = await state(room, w1);
  if (wv2.nightStep === 'wolf') { await act(room, w1, 'wolf_set', { kill: witch }); await act(room, w1, 'wolf_set', { confirm: true }); }
  v = await state(room, A.playerId);
  if (v.nightStep === 'witch') await act(room, witch, 'witch_act', { poison: w1 });
  v = await state(room, A.playerId);
  eq(v.phase, 'ended', '游戏结束');
  eq(v.winner, 'third', '第三方阵营获胜（活到最后）');
  const end = await state(room, A.playerId);
  const alive = end.players.filter(p => p.alive);
  eq(alive.length, 2, '只剩 2 人存活');
  assert(alive.some(p => p.id === cupid) && alive.some(p => p.id === X), '存活者为丘比特与情侣平民');
  assert(end.endInfo && end.endInfo.text === '第三方阵营获胜（丘比特阵营）', '结算信息正确');
  console.log('  场景9 完成');
}

async function main() {
  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SNAPSHOT_SEC: '0', PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => process.stdout.write('[server] ' + d));
  await sleep(900);
  await scenario9();
  server.kill();
  await sleep(300);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\n场景9 全部通过 ✔');
  process.exit(0);
}
main();
