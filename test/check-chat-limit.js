'use strict';
/* 聊天限流 + 已离开玩家防刷 专项测试 */
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8488;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };
const api = async (p, body) => (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
const act = async (room, me, action, data) => { const r = await api('/api/action', { room, me, action, data: data || {} }); if (r.error) throw new Error(`action ${action}失败: ${r.error}`); return r.view; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chat = (room, me, ch, text) => api('/api/chat', { room, me, data: { ch, text } });

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, SNAPSHOT_SEC: '0', PORT: String(PORT) }, // 默认 CHAT_INTERVAL=800
  });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${BASE}/healthz`); if (r.status === 200) { ready = true; break; } } catch (e) {}
    await sleep(200);
  }
  if (!ready) { console.error('服务器未就绪'); server.kill(); process.exit(1); }
  try {
    const r = await api('/api/create', { name: '房主A' });
    const room = r.roomId, me = r.playerId;
    const jr = await api('/api/join', { roomId: room, name: '玩家B' });
    const B = jr.playerId;
    // 同一玩家 800ms 内连发两条 →第二条被限流
    const c1 = await chat(room, me, 'all', '消息1');
    const c2 = await chat(room, me, 'all', '消息2');
    assert(!c1.error, '第一条消息正常');
    assert(!!c2.error && /太快/.test(c2.error), '800ms 内第二条被限流');
    // 等待后恢复
    await sleep(900);
    const c3 = await chat(room, me, 'all', '消息3');
    assert(!c3.error, '等待后恢复发言');
    // 不同玩家不受影响
    const c4 = await chat(room, B, 'all', 'B的消息');
    assert(!c4.error, '其他玩家不受限流影响');
    // 已离开玩家不能发消息/动作
    await api('/api/leave', { room, me: B });
    await sleep(200);
    const c5 = await chat(room, B, 'all', '离开后发言');
    assert(!!c5.error, '已离开玩家不能发言');
    const a1 = await api('/api/action', { room, me: B, action: 'confirm', data: {} });
    assert(!!a1.error, '已离开玩家不能操作');
  } catch (e) { failures++; console.error('!!异常: ' + ((e && e.stack) || e)); }
  server.kill();
  await sleep(300);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\n限流专项测试全部通过 ✔');
  process.exit(0);
}
main();
