'use strict';
/* =========================================================================
 * 场景8：狼美人被猎人枪杀 → 不能带走被魅惑者
 * 流程：6人局（狼2/狼美1/预1/猎1/民1），狼刀猎人 → 猎人开枪射狼美人，
 * 验证被魅惑者 v1 在狼美人被枪杀后仍然存活。
 * 运行：node test/simulate-wolfbeauty-gun.js
 * ========================================================================= */
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8368;
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

async function scenario8() {
  console.log('\n===== 场景8：狼美人被枪杀不能带走被魅惑者 =====');
  const A = await api('/api/create', { name: 'A' });
  const room = A.roomId;
  const ids = [A.playerId];
  const counts = { wolf: 2, wolfBeauty: 1, villager: 2, seer: 1, hunter: 1 };
  await act(room, A.playerId, 'setCap', { cap: 7 });
  await act(room, A.playerId, 'setCounts', { counts });
  await act(room, A.playerId, 'settings', { sheriff: false });
  for (let i = 0; i < 6; i++) {
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
  const beauty = ids.find(id => roles[id] === '狼美人');
  const hunter = ids.find(id => roles[id] === '猎人');
  const w1 = wolves[0], w2 = wolves[1];
  const villagers = ids.filter(id => roles[id] === '平民');
  const v1 = villagers[0], v2 = villagers[1];
  assert(!!beauty && !!hunter && wolves.length === 2, '角色在场');

  // 狼刀猎人、魅惑 v1（狼美人也是狼，需全员确认）；预言家查验
  for (const w of [w1, w2, beauty]) {
    const wv = await state(room, w);
    if (wv.nightStep === 'wolf') { await act(room, w, 'wolf_set', { kill: hunter, charm: v1 }); await act(room, w, 'wolf_set', { confirm: true }); }
  }
  v = await state(room, A.playerId);
  if (v.nightStep === 'seer') await act(room, A.playerId, 'seer_pick', { target: w1 });
  // 猎人被狼刀 → 开枪射狼美人
  v = await state(room, A.playerId);
  eq(v.nightStep, 'hunter', '猎人开枪阶段');
  await act(room, hunter, 'hunter_shoot', { target: beauty });
  v = await state(room, A.playerId);
  eq(v.phase, 'morning', '进入早晨');
  const byIdMap = {};
  v.morningDeaths.forEach(x => byIdMap[x.id] = x);
  eq(byIdMap[hunter] && byIdMap[hunter].deadBy, 'wolf', '猎人死于狼刀');
  eq(byIdMap[beauty] && byIdMap[beauty].deadBy, 'shoot', '狼美人被枪杀');
  // 核心断言：被魅惑者 v1 未被带走
  assert(!byIdMap[v1], '被魅惑者 v1 未被狼美人枪杀带走');
  const aliveNow = await state(room, A.playerId);
  assert((aliveNow.players.find(p => p.id === v1) || {}).alive, 'v1 仍存活');

  // 继续：白天放逐 w1 → 夜晚 w2 刀预言家 → 白天放逐 w2 → 好人胜
  await doAdvance(room, A.playerId);
  v = await state(room, A.playerId);
  if (v.phase === 'lastword') { for (const id of v.lastword.entitled) { const dv = await state(room, id.id); if (dv.phase === 'lastword') await act(room, id.id, 'post', { text: '遗言' }); } v = await state(room, A.playerId); }
  eq(v.phase, 'discuss', '进入白天发言');
  await act(room, A.playerId, 'startVote');
  v = await state(room, A.playerId);
  for (const p of v.players.filter(x => x.alive)) { const qv = await state(room, p.id); if (qv.phase === 'vote') await act(room, p.id, 'vote', { target: w1 }); }
  v = await state(room, A.playerId);
  if (v.phase === 'lastword') { const lw = await state(room, w1); if (lw.phase === 'lastword') await act(room, w1, 'post', { text: '遗言' }); v = await state(room, A.playerId); }
  eq(v.phase, 'night', '进入第二晚');
  // 夜2：w2 刀另一平民 v2（避免触发屠边）
  const w2v = await state(room, w2);
  if (w2v.nightStep === 'wolf') { await act(room, w2, 'wolf_set', { kill: v2 }); await act(room, w2, 'wolf_set', { confirm: true }); }
  v = await state(room, A.playerId);
  if (v.nightStep === 'seer') await act(room, A.playerId, 'seer_pick', { target: w2 });
  v = await state(room, A.playerId);
  eq(v.phase, 'morning', '第二晚结束');
  await doAdvance(room, A.playerId);
  v = await state(room, A.playerId);
  if (v.phase === 'discuss') {
    await act(room, A.playerId, 'startVote');
    v = await state(room, A.playerId);
    for (const p of v.players.filter(x => x.alive)) { const qv = await state(room, p.id); if (qv.phase === 'vote') await act(room, p.id, 'vote', { target: w2 }); }
    v = await state(room, A.playerId);
    if (v.phase === 'lastword') { const lw = await state(room, w2); if (lw.phase === 'lastword') await act(room, w2, 'post', { text: '遗言' }); v = await state(room, A.playerId); }
  }
  eq(v.phase, 'ended', '游戏结束');
  eq(v.winner, 'good', '好人阵营获胜');
  // v1 全程存活
  const end = await state(room, A.playerId);
  assert((end.players.find(p => p.id === v1) || {}).alive, 'v1 整局存活（未被魅惑带走）');
  console.log('  场景8 完成');
}

async function main() {
  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SNAPSHOT_SEC: '0', PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => process.stdout.write('[server] ' + d));
  await sleep(900);
  await scenario8();
  server.kill();
  await sleep(300);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\n场景8 全部通过 ✔');
  process.exit(0);
}
main();
