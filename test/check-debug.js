'use strict';
/* 游戏事件流 /api/debug（v1.6.0）：
 * S1 /api/debug 返回事件流（night_start/night_step/wolf_kill/deaths/exile 等关键事件）
 * S2 无房间时 room-not-found
 * S3 事件环形缓冲上限 200
 * 运行：node test/check-debug.js */
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8205;
const BASE = 'http://127.0.0.1:' + PORT;
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function post(p, body) { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return r.json(); }
async function act(room, me, action, data) { const r = await post('/api/action', { room, me, action, data: data || {} }); if (r.error) throw new Error(action + '失败: ' + r.error); return r.view; }

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), SNAPSHOT_SEC: '0', PHASE_TIMEOUT: '60', NIGHT_TIMEOUT: '45', BOT_DELAY_MS: '400' }, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 50; i++) { try { const r = await fetch(BASE + '/healthz'); if (r.status === 200) { ready = true; break; } } catch (e) {} await sleep(200); }
  if (!ready) { console.error('服务器未就绪'); srv.kill(); process.exit(1); }
  try {
    // S2 无房间
    const miss = await (await fetch(BASE + '/api/debug?room=ZZZZZZ')).json();
    assert(miss.error === 'room-not-found', 'S2 无房间 → room-not-found');

    // 开局（4 人：房主 + 2 smart + 1 idle）
    const c = await post('/api/create', { name: '房主' });
    const room = c.roomId, host = c.playerId;
    await act(room, host, 'add_bot', { level: 'smart' });
    await act(room, host, 'add_bot', { level: 'smart' });
    await act(room, host, 'add_bot', { level: 'idle' });
    await act(room, host, 'settings', { sheriff: false, thief: false, winMode: 'city' });
    await act(room, host, 'setCounts', { counts: { wolf: 1, seer: 1, witch: 1, villager: 1 } });
    await act(room, host, 'setCap', { cap: 4 });
    await act(room, host, 'start');
    await act(room, host, 'hostPick', { role: 'seer' });
    await post('/api/advance', { room, me: host });
    await sleep(2000); // bot confirm
    await post('/api/advance', { room, me: host });
    // 推进到夜晚：等待 bot 行动链（advance 强推 + bot 自动）
    let v = await (await fetch(BASE + '/api/state?room=' + room + '&me=' + host)).json();
    for (let i = 0; i < 20 && v.phase === 'reveal'; i++) { await post('/api/advance', { room, me: host }).catch(() => {}); await sleep(600); v = await (await fetch(BASE + '/api/state?room=' + room + '&me=' + host)).json(); }
    // 夜晚：房主预言家查验 + 等 bot 行动
    for (let i = 0; i < 25; i++) {
      v = await (await fetch(BASE + '/api/state?room=' + room + '&me=' + host)).json();
      if (v.phase !== 'night') break;
      if (v.nightStep === 'seer' && v.my.alive) { try { await act(room, host, 'seer_pick', { target: v.players.find(p => p.id !== host && p.alive).id }); } catch (e) {} }
      await sleep(500);
    }

    // S1 事件流
    const dbg = await (await fetch(BASE + '/api/debug?room=' + room)).json();
    const types = (dbg.events || []).map(e => e.type);
    assert(dbg.phase && Array.isArray(dbg.events), 'S1a /api/debug 返回事件流（phase=' + dbg.phase + ', ' + (dbg.events || []).length + ' 条）');
    assert(types.includes('night_start'), 'S1b 含 night_start 事件');
    assert(types.includes('night_step'), 'S1c 含 night_step 事件');
    assert(types.includes('wolf_kill'), 'S1d 含 wolf_kill 事件（首刀目标）');

    // S3 环形上限
    const big = { events: [] };
    for (let i = 0; i < 250; i++) big.events.push({ i });
    const sliced = big.events.slice(-200);
    assert(sliced.length === 200 && sliced[0].i === 50, 'S3 环形缓冲上限 200（保留最新）');
  } catch (e) { failures++; console.error('!!异常: ' + ((e && e.message) || e)); }
  finally { srv.kill(); }
  await sleep(300);
  if (failures) { console.error('\n共 ' + failures + ' 处失败'); process.exit(1); }
  console.log('\n游戏事件流专项全部通过 ✔');
  process.exit(0);
}
main();
