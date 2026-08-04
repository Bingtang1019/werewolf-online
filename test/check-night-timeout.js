'use strict';
/* 夜晚步骤/盗贼选牌 30 秒超时专项测试（NIGHT_TIMEOUT=2 加速） */
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8467;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };
const api = async (p, body) => (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
const act = async (room, me, action, data) => { const r = await api('/api/action', { room, me, action, data: data || {} }); if (r.error) throw new Error(`action ${action}失败: ${r.error}`); return r.view; };
const state = async (room, me) => (await fetch(`${BASE}/api/state?room=${room}&me=${me}`)).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const joinN = async (room, n) => { const ids = []; for (let i = 0; i < n; i++) { const j = await api('/api/join', { roomId: room, name: '玩家' + (i + 1) }); ids.push(j.playerId); } return ids; };

async function testNightTimeout() {
  console.log('\n== 夜晚步骤 30 秒超时（狼人不行动 →自动跳过） ==');
  const r = await api('/api/create', { name: '房主A' });
  const room = r.roomId, me = r.playerId;
  const others = await joinN(room, 3);
  const ids = [me, ...others];
  await act(room, me, 'setCounts', { counts: { wolf: 1, seer: 1, villager: 0, witch: 0, hunter: 0, dreamer: 0, guard: 0, wolfBeauty: 0, cupid: 0 } });
  await act(room, me, 'setCap', { cap: 4 });
  await act(room, me, 'start');
  await act(room, me, 'hostPick', { role: 'seer' });
  for (const id of ids) await act(room, id, 'confirm');
  await sleep(300);
  let v = await state(room, me);
  assert(v.phase === 'night', '进入夜晚');
  // 找狼人
  let wolfId = null;
  for (const id of ids) { const sv = await state(room, id); if (sv.my.roleKey === 'wolf') { wolfId = id; break; } }
  assert(!!wolfId, '找到狼人');
  // 狼人不行动：等 NIGHT_TIMEOUT=2 秒 → 自动跳过狼步
  await sleep(3500);
  v = await state(room, me);
  assert(v.phase === 'night' && v.nightStep === 'seer', `狼步超时自动跳过（当前步骤: ${v.nightStep}）`);
  // 预言家（房主）行动
  await act(room, me, 'seer_pick', { target: others[0] });
  await sleep(500);
  v = await state(room, me);
  assert(v.phase === 'morning' || v.phase === 'lastword', '夜晚自动推进到天亮（狼步超时跳过生效）');
}

async function testThiefTimeout() {
  console.log('\n== 盗贼选牌 30 秒超时（盗贼不选 →自动选牌） ==');
  const r = await api('/api/create', { name: '房主A' });
  const room = r.roomId, me = r.playerId;
  const others = await joinN(room, 3);
  const ids = [me, ...others];
  await act(room, me, 'setCounts', { counts: { wolf: 1, seer: 1, villager: 0, witch: 0, hunter: 0, dreamer: 0, guard: 0, wolfBeauty: 0, cupid: 0 } });
  await act(room, me, 'settings', { thief: true });
  await act(room, me, 'setCap', { cap: 4 });
  await act(room, me, 'start');
  await act(room, me, 'hostPick', { role: 'seer' });
  let v = await state(room, me);
  assert(v.reveal.stage === 'thiefPick' || v.reveal.thiefPicking === true, '进入盗贼选牌阶段');
  // 盗贼（人类，不操作）→ 等 NIGHT_TIMEOUT=2 秒 → 自动选牌并发牌（dealt 仅在盗贼选定后发生）
  await sleep(3500);
  v = await state(room, me);
  assert(v.reveal.dealt === true, '盗贼超时自动选牌并完成发牌');
  assert(v.reveal.thiefPicking === false, '选牌阶段结束');
  // 全员确认后等待 5 秒盗贼结果展示，再自动入夜
  for (const id of ids) await act(room, id, 'confirm');
  const t0 = Date.now();
  let v2 = null;
  while (Date.now() - t0 < 8000) {
    v2 = await state(room, me);
    if (v2.phase === 'night') break;
    await sleep(300);
  }
  assert(v2 && v2.phase === 'night', '确认后等待 5 秒展示自动进入夜晚（自动选牌不影响流程）');
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), NIGHT_TIMEOUT: '2' },
  });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${BASE}/healthz`); if (r.status === 200) { ready = true; break; } } catch (e) {}
    await sleep(200);
  }
  if (!ready) { console.error('服务器未就绪'); server.kill(); process.exit(1); }
  try {
    await testNightTimeout();
    await testThiefTimeout();
  } catch (e) { failures++; console.error('!!异常: ' + ((e && e.stack) || e)); }
  server.kill();
  await sleep(300);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\n夜晚/盗贼倒计时专项测试全部通过 ✔');
  process.exit(0);
}
main();
