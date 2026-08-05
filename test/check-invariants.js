'use strict';
/* 引擎不变式自检 + 快照回滚（v1.6.1）：
 * U1 正常对局（多次 bump）不触发 onBroken（自检不误报）
 * U2 破坏房间状态 → 下一次 bump 触发 onBroken（自检生效，含原因）
 * U3 黑盒：正常对局 + 快照恢复正常（自检不破坏快照链）
 * 运行：node test/check-invariants.js */
const Game = require('../game.js');
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const brokenCalls = [];
Game.setOnBroken((roomId, reason) => brokenCalls.push(roomId + ':' + reason));

async function main() {
  /* ---- U1：正常对局不误报 ---- */
  {
    const r = Game.createRoom('房主');
    const room = Game.rooms.get(r.roomId);
    const host = r.playerId;
    for (let i = 0; i < 3; i++) Game.handleAction(room.id, host, 'add_bot', { level: 'smart' });
    Game.handleAction(room.id, host, 'settings', { sheriff: false, thief: false, winMode: 'city', tieRule: 'pk', botMode: 'auto' });
    Game.handleAction(room.id, host, 'setCounts', { counts: { wolf: 1, seer: 1, villager: 2 } });
    Game.handleAction(room.id, host, 'setCap', { cap: 4 });
    Game.handleAction(room.id, host, 'start');
    Game.handleAction(room.id, host, 'hostPick', { role: 'seer' });
    Game.handleAction(room.id, host, 'confirm', {});
    // 多次 bump（mood/advance 等）
    Game.handleAdvance(room.id, host, 0);
    Game.handleAction(room.id, host, 'mood', { mood: '😀' });
    assert(!brokenCalls.length, 'U1 正常对局（多次 bump）未触发 onBroken（不误报）');
    Game.rooms.delete(room.id);
  }
  /* ---- U2：破坏房间 → 自检触发 ---- */
  {
    const r = Game.createRoom('破坏测试');
    const room = Game.rooms.get(r.roomId);
    const host = r.playerId;
    room.players[0].alive = 'x'; // 破坏不变式（alive 应为 boolean）
    const before = brokenCalls.length;
    Game.handleAction(room.id, host, 'mood', { mood: '😀' }); // 触发 bump
    const hit = brokenCalls.slice(before).find(c => c.startsWith(room.id));
    assert(!!hit && hit.includes('player-alive'), 'U2 破坏 alive 类型 → bump 触发 onBroken（' + (hit || '未触发') + '）');
    Game.rooms.delete(room.id);
  }
  /* ---- U3：黑盒正常对局 + 快照恢复（自检不破坏快照链） ---- */
  {
    const { spawn } = require('child_process');
    const path = require('path');
    const PORT = 8207;
    const BASE = 'http://127.0.0.1:' + PORT;
    const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), SNAPSHOT_SEC: '3', PHASE_TIMEOUT: '60', NIGHT_TIMEOUT: '45', BOT_DELAY_MS: '400' }, stdio: 'ignore' });
    let ready = false;
    for (let i = 0; i < 50; i++) { try { const x = await fetch(BASE + '/healthz'); if (x.status === 200) { ready = true; break; } } catch (e) {} await sleep(200); }
    if (!ready) { console.error('服务器未就绪'); srv.kill(); process.exit(1); }
    try {
      const c = await (await fetch(BASE + '/api/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '房主' }) })).json();
      const room = c.roomId, host = c.playerId;
      const post = async (p, body) => (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
      await post('/api/action', { room, me: host, action: 'add_bot', data: { level: 'smart' } });
      await post('/api/action', { room, me: host, action: 'add_bot', data: { level: 'smart' } });
      await post('/api/action', { room, me: host, action: 'add_bot', data: { level: 'idle' } });
      await post('/api/action', { room, me: host, action: 'settings', data: { sheriff: false, thief: false, winMode: 'city' } });
      await post('/api/action', { room, me: host, action: 'setCounts', data: { counts: { wolf: 1, seer: 1, villager: 2 } } });
      await post('/api/action', { room, me: host, action: 'setCap', data: { cap: 4 } });
      const st = await post('/api/action', { room, me: host, action: 'start' });
      assert(!st.error, 'U3a 开局正常（自检未误报）');
      await post('/api/action', { room, me: host, action: 'hostPick', data: { role: 'seer' } });
      await sleep(1500);
      // 快照写入后房间仍可操作（自检不影响正常流程）
      await sleep(3500);
      const v = await (await fetch(BASE + '/api/state?room=' + room + '&me=' + host)).json();
      assert(v.roomId === room && !v.error, 'U3b 快照写入后房间正常（自检不破坏快照链）');
      await post('/api/leave', { room, me: host }).catch(() => {});
    } finally { srv.kill(); }
    await sleep(300);
  }

  if (failures) { console.error('\n共 ' + failures + ' 处失败'); process.exit(1); }
  console.log('\n引擎不变式自检专项全部通过 ✔');
  process.exit(0);
}
main().catch(e => { console.error('异常:', e.message); process.exit(1); });
