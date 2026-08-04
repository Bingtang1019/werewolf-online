'use strict';
/* 在线统计 /api/stats 专项（v1.2.0）：
 * 1. 初始 0 房间 0 玩家
 * 2. 创建房间后立即计入（rooms=1, players=1）
 * 3. 朋友加入后玩家数 +1（rooms=1, players=2）
 * 4. 空闲过滤：超过 STATS_ACTIVE_SEC 无轮询/SSE/操作 → 不计入（rooms=0）；重新轮询恢复活跃
 * 5. 方法限制：POST /api/stats → 404
 * 6. 全部离开 → 房间解散 → rooms=0
 * 运行：node test/check-stats.js
 */
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8387;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const eq = (a, b, m) => { if (a === b) console.log(' ✓ ' + m); else { failures++; console.error(` ✗ FAIL: ${m}（期望 ${b}，实际 ${a}）`); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function post(p, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}
async function getStats() { return (await fetch(BASE + '/api/stats')).json(); }

async function main() {
  // 用 2 秒活跃窗口：创建后立即计入，2.5 秒无轮询即被排除（测试不用等 30 秒）
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), STATS_ACTIVE_SEC: '2' } });
  let ready = false;
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`${BASE}/healthz`); if (r.status === 200) { ready = true; break; } } catch (e) {} await sleep(200); }
  if (!ready) { console.error('服务器未就绪'); srv.kill(); process.exit(1); }
  try {
    // 1. 初始为空
    let s = await getStats();
    eq(s.rooms, 0, '初始 rooms=0'); eq(s.players, 0, '初始 players=0');
    // 5. 方法限制：仅 GET
    const bad = await fetch(BASE + '/api/stats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    eq(bad.status, 404, 'POST /api/stats → 404');
    // 2. 创建房间（创建时 lastActive=now，立即计入）
    const A = await post('/api/create', { name: '房主' });
    s = await getStats();
    eq(s.rooms, 1, '创建后 rooms=1'); eq(s.players, 1, '创建后 players=1');
    // 3. 加入后玩家数 +1
    const B = await post('/api/join', { roomId: A.roomId, name: '朋友' });
    s = await getStats();
    eq(s.rooms, 1, '加入后 rooms=1'); eq(s.players, 2, '加入后 players=2');
    // 4a. 空闲过滤：不再轮询，超过活跃窗口后房间不计入
    await sleep(2600);
    s = await getStats();
    eq(s.rooms, 0, '超时无轮询 → rooms=0（空闲房间被排除）');
    // 4b. 重新轮询一次 → 恢复活跃
    await fetch(`${BASE}/api/state?room=${A.roomId}&me=${A.playerId}`);
    s = await getStats();
    eq(s.rooms, 1, '重新轮询后 rooms=1（活跃恢复）');
    // 6. 全部离开 → 房间解散
    await post('/api/leave', { room: A.roomId, me: A.playerId });
    await post('/api/leave', { room: A.roomId, me: B.playerId });
    s = await getStats();
    eq(s.rooms, 0, '房间解散后 rooms=0');
  } catch (e) { failures++; console.error('!!异常: ' + ((e && e.stack) || e)); }
  finally { srv.kill(); }
  await sleep(300);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\n在线统计 /api/stats 专项测试全部通过 ✔');
  process.exit(0);
}
main();
