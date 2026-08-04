/* 白天阶段倒计时测试：PHASE_TIMEOUT=2 时各环节应自动推进
 * 验证点：morning 超时自动继续 / discuss 超时自动进投票 / vote 超时自动结算（未投弃票）
 *         lastword 超时自动跳过 / 提前操作后旧定时器不误触发
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = 8396;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function eq(a, b, msg) {
  if (a === b) console.log(' ✓ ' + msg + (a === b ? '' : `（期望 ${JSON.stringify(b)},实际 ${JSON.stringify(a)}）`));
  else { failures++; console.error(' ✗ FAIL: ' + msg + `（期望 ${JSON.stringify(b)},实际 ${JSON.stringify(a)}）`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(p, body) {
  const res = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return res.json();
}
async function act(room, me, action, data) {
  const r = await api('/api/action', { room, me, action, data: data || {} });
  if (r.error) throw new Error(`action ${action}失败: ${r.error}`);
  return r.view;
}
async function state(room, me) { return (await fetch(`${BASE}/api/state?room=${room}&me=${me}`)).json(); }

async function scenario() {
  console.log('\n=====场景10：白天倒计时自动推进 =====');
  const A = await api('/api/create', { name: 'A' });
  const room = A.roomId;
  const ids = [A.playerId];
  for (const n of ['B', 'C', 'D', 'E', 'F']) {
    const r = await api('/api/join', { roomId: room, name: n });
    if (r.error) throw new Error('join失败: ' + r.error);
    ids.push(r.playerId);
  }
  await act(room, A.playerId, 'setCap', { cap: 6 });
  await act(room, A.playerId, 'settings', { sheriff: false });
  let v = await act(room, A.playerId, 'start');
  eq(v.phase, 'reveal', '进入身份展示');
  await act(room, A.playerId, 'hostPick', { role: 'seer' });
  for (const id of ids.slice(1)) await act(room, id, 'confirm');
  v = await state(room, A.playerId);
  eq(v.phase, 'night', '进入第一晚');
  const roles = {};
  for (const id of ids) { const sv = await state(room, id); roles[id] = sv.my.role; }
  const wolves = ids.filter(id => roles[id] === '狼人');
  const witch = ids.find(id => roles[id] === '女巫');
  const villager = ids.find(id => roles[id] === '平民');
  // 夜晚：狼刀平民，女巫救 → 平安夜
  for (const w of wolves) {
    const wv = await state(room, w);
    if (wv.nightStep === 'wolf') { await act(room, w, 'wolf_set', { kill: villager }); await act(room, w, 'wolf_set', { confirm: true }); }
  }
  v = await state(room, A.playerId);
  if (v.nightStep === 'seer') await act(room, A.playerId, 'seer_pick', { target: wolves[0] });
  v = await state(room, A.playerId);
  if (v.nightStep === 'witch') await act(room, witch, 'witch_act', { save: true });
  v = await state(room, A.playerId);
  eq(v.phase, 'morning', '进入早晨');
  eq(v.phaseTimed, true, '早晨有倒计时');
  // 1) morning 超时 → 自动进入白天发言
  await sleep(2600);
  v = await state(room, A.playerId);
  eq(v.phase, 'discuss', '早晨超时自动进入发言');
  // 2) discuss 超时 → 自动进入投票
  await sleep(2600);
  v = await state(room, A.playerId);
  eq(v.phase, 'vote', '发言超时自动进入投票');
  // 3) 只投一票，其余弃票 → 超时自动结算（放逐得票最高者）
  const aliveV = v.players.filter(p => p.alive);
  await act(room, A.playerId, 'vote', { target: wolves[0] });
  await sleep(2600);
  v = await state(room, A.playerId);
  eq(v.phase, 'lastword', '投票超时自动结算进入遗言');
  eq(v.lastVoteResult && v.lastVoteResult.exiled, wolves[0], '未投票者视为弃票，得票最高者被放逐');
  // 4) lastword 超时 → 自动跳过进入夜晚
  await sleep(2600);
  v = await state(room, A.playerId);
  eq(v.phase, 'night', '遗言超时自动跳过进入夜晚');
  eq(v.nightNum, 2, '进入第二晚');
  // 5) 提前操作时旧定时器不误触发：夜晚行动后早晨→房主立即继续→发言→立即投票全部投完
  const w2 = wolves[0] === wolves[0] ? wolves.filter(id => id !== wolves[0])[0] : null;
  for (const w of wolves.filter(id => id !== wolves[0])) {
    const wv = await state(room, w);
    if (wv.nightStep === 'wolf') { await act(room, w, 'wolf_set', { kill: witch }); await act(room, w, 'wolf_set', { confirm: true }); }
  }
  v = await state(room, A.playerId);
  if (v.nightStep === 'seer') await act(room, A.playerId, 'seer_pick', { target: w2 || wolves[0] });
  v = await state(room, A.playerId);
  if (v.nightStep === 'witch') await act(room, witch, 'witch_act', { save: false });
  v = await state(room, A.playerId);
  if (v.phase === 'morning') {
    await api('/api/advance', { room, me: A.playerId });
    v = await state(room, A.playerId);
  }
  eq(v.phase, 'discuss', '第二日进入发言');
  await act(room, A.playerId, 'startVote'); // 房主提前结束发言
  v = await state(room, A.playerId);
  eq(v.phase, 'vote', '提前进入投票');
  const alive2 = v.players.filter(p => p.alive);
  const target2 = alive2.find(p => p.id !== A.playerId) || alive2[0];
  for (const p of alive2) {
    const qv = await state(room, p.id);
    if (qv.phase === 'vote') await act(room, p.id, 'vote', { target: target2 ? target2.id : null });
  }
  v = await state(room, A.playerId);
  eq(v.phase === 'lastword' || v.phase === 'night' || v.phase === 'ended', true, '全部投完后立即结算（不等倒计时）');
  // 等超过一个超时周期，确认没有重复结算/阶段错乱
  await sleep(2600);
  const v2 = await state(room, A.playerId);
  eq(['night', 'ended', 'lastword'].includes(v2.phase), true, '超时后无重复结算（阶段未错乱）');
  console.log('场景10完成');
}

async function main() {
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), PHASE_TIMEOUT: '2' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => process.stdout.write('[server] ' + d));
  server.stderr.on('data', d => process.stderr.write('[server-err] ' + d));
  // 等待服务器就绪
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${BASE}/healthz`); if (r.status === 200) break; } catch (e) {}
    await sleep(200);
  }
  try {
    await scenario();
  } catch (e) {
    failures++;
    console.error('!!异常: ' + e.stack);
  }
  server.kill();
  await sleep(300);
  if (failures) { console.error(`\n${failures} 个失败`); process.exit(1); }
  console.log('\n全部通过 ✔');
  process.exit(0);
}
main();
