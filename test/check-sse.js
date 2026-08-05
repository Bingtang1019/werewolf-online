'use strict';
/* SSE 推送唤醒专项（v1.1.0）：
 * 1. 连接合法性：非法房间号 / 非法玩家ID / 不存在玩家 → 404
 * 2. 初始推送：连接后立即收到 {v}
 * 3. 版本变化推送：另一客户端操作（聊天/设置）→ 1 秒扫描内收到新版本号
 * 4. 房间解散（无真人）→ 服务端主动结束所有 SSE 连接
 * 运行：node test/check-sse.js
 */
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8386;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const eq = (a, b, m) => { if (a === b) console.log(' ✓ ' + m); else { failures++; console.error(` ✗ FAIL: ${m}（期望 "${b}"，实际 "${a}"）`); } };
async function api(p, body) { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return r.json(); }
async function act(room, me, action, data) { const r = await api('/api/action', { room, me, action, data: data || {} }); if (r.error) throw new Error(action + '失败: ' + r.error); return r.view; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 打开 SSE 连接并解析 data: 行；next() 逐条取事件（超时抛错，流关闭返回 null） */
async function openSSE(room, me) {
  const res = await fetch(`${BASE}/api/stream?room=${room}&me=${me}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const queue = [];
  const waiters = [];
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { queue.push(null); flush(); break; }
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const line = block.split('\n').find(l => l.startsWith('data:'));
          if (line) { queue.push(line.slice(5).trim()); flush(); }
        }
      }
    } catch (e) { queue.push(null); flush(); }
  })();
  function flush() { while (waiters.length && queue.length) waiters.shift()(queue.shift()); }
  return {
    status: res.status,
    next(ms) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('等待 SSE 事件超时')), ms || 6000);
        const grab = ev => { clearTimeout(t); resolve(ev); };
        if (queue.length) grab(queue.shift()); else waiters.push(grab);
      });
    },
  };
}

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, SNAPSHOT_SEC: '0', PORT: String(PORT) } });
  let ready = false;
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`${BASE}/healthz`); if (r.status === 200) { ready = true; break; } } catch (e) {} await sleep(200); }
  if (!ready) { console.error('服务器未就绪'); srv.kill(); process.exit(1); }
  try {
    // 1. 连接合法性
    const badRoom = await fetch(`${BASE}/api/stream?room=ZZZZZZ&me=${'0'.repeat(16)}`);
    eq(badRoom.status, 404, '非法房间号 → 404');
    const badMe = await fetch(`${BASE}/api/stream?room=AAAAAA&me=${'0'.repeat(16)}`);
    eq(badMe.status, 404, '不存在的玩家 → 404');

    // 2. 初始推送 + 3. 版本变化推送
    const A = await api('/api/create', { name: 'A' });
    const room = A.roomId;
    const B = await api('/api/join', { roomId: room, name: 'B' });
    const sse = await openSSE(room, A.playerId);
    eq(sse.status, 200, 'SSE 连接 200');
    const first = JSON.parse(await sse.next());
    eq(typeof first.v, 'number', '初始推送携带版本号 v=' + first.v);
    // B 发言（全体频道）→ room.version 变化 → 1 秒扫描内推送给 A
    const chatR = await api('/api/chat', { room, me: B.playerId, data: { ch: 'all', text: 'SSE 推送测试' } });
    if (chatR.error) throw new Error('chat失败: ' + chatR.error);
    const push = JSON.parse(await sse.next());
    eq(push.v > first.v, true, '操作后收到新版本推送（' + first.v + '→' + push.v + '）');

    // 4. 房间解散 → SSE 连接被服务端结束
    await api('/api/leave', { room, me: A.playerId });
    await api('/api/leave', { room, me: B.playerId });
    const closed = await sse.next(8000);
    eq(closed, null, '房间解散后 SSE 连接被关闭');
  } catch (e) { failures++; console.error('!!异常: ' + ((e && e.stack) || e)); }
  finally { srv.kill(); }
  await sleep(300);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\nSSE 推送唤醒专项测试全部通过 ✔');
  process.exit(0);
}
main();
