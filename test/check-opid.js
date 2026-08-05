'use strict';
/* 写操作 opId 幂等去重（v1.6.4，A1-P1-1）：
 * O1 同 opId 重复 POST（mood）→ 第二次 replayed，只执行一次
 * O2 并发窗口：同 opId 同时到达 → 后到者命中 pending 视为成功，不双执行
 * O3 不同 opId → 各自正常执行
 * O4 无 opId 的旧客户端 → 放行，正常执行
 * O5 chat 同 opId 重试 → 消息不重复（“一句话说两遍”场景）
 * O6 advance 同 opId → 阶段只推进一次（不会连跳两格）
 * 运行：node test/check-opid.js
 */
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8401;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function post(p, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}
async function state(room, me) { return (await fetch(`${BASE}/api/state?room=${room}&me=${me}`)).json(); }

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, SNAPSHOT_SEC: '0', PORT: String(PORT), BOT_DELAY_MS: '300' } });
  let ready = false;
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`${BASE}/healthz`); if (r.status === 200) { ready = true; break; } } catch (e) {} await sleep(200); }
  if (!ready) { console.error('服务器未就绪'); srv.kill(); process.exit(1); }
  try {
    // ---- O1/O3/O4：mood 幂等（lobby 阶段任意可执行） ----
    const c = await post('/api/create', { name: '房主' });
    const room = c.roomId, me = c.playerId;

    const r1 = await post('/api/action', { room, me, action: 'mood', data: { mood: '😀' }, opId: 'op-mood-1' });
    const r2 = await post('/api/action', { room, me, action: 'mood', data: { mood: '😀' }, opId: 'op-mood-1' });
    assert(r1.ok && !r1.replayed, 'O1a 首次执行（ok，非重放）');
    assert(r2.ok && r2.replayed === true, 'O1b 同 opId 重试 → 命中重放确认，不双执行');
    let v = await state(room, me);
    assert(v.my.mood === '😀', 'O1c 状态只应用一次（mood 正确）');

    const r3 = await post('/api/action', { room, me, action: 'mood', data: { mood: '😤' }, opId: 'op-mood-2' });
    v = await state(room, me);
    assert(r3.ok && !r3.replayed && v.my.mood === '😤', 'O3 不同 opId → 正常执行');

    await post('/api/action', { room, me, action: 'mood', data: { mood: '🤔' } }); // 无 opId
    await post('/api/action', { room, me, action: 'mood', data: { mood: '😱' } }); // 无 opId 第二次
    v = await state(room, me);
    assert(v.my.mood === '😱', 'O4 无 opId 旧客户端 → 放行（两次均执行）');

    // ---- O5：chat 同 opId 重试 → 不重复发言 ----
    await post('/api/chat', { room, me, data: { ch: 'all', text: '我投预言家' }, opId: 'op-chat-1' });
    const r5 = await post('/api/chat', { room, me, data: { ch: 'all', text: '我投预言家' }, opId: 'op-chat-1' });
    v = await state(room, me);
    const msgs = (v.chat || []).filter(m => m.text === '我投预言家');
    assert(r5.replayed === true && msgs.length === 1, 'O5 同 opId 重试 chat → 只有 1 条消息（防“说两遍”）');
    // 不同 opId 同文本 → 正常 2 条（先等过 CHAT_INTERVAL 800ms 限流）
    await sleep(900);
    await post('/api/chat', { room, me, data: { ch: 'all', text: '我投预言家' }, opId: 'op-chat-2' });
    v = await state(room, me);
    assert((v.chat || []).filter(m => m.text === '我投预言家').length === 2, 'O5b 不同 opId 同文本 → 正常各 1 条');

    // ---- O2：并发窗口（同时到达同 opId）→ 不双执行 ----
    await sleep(900);
    await Promise.all([
      post('/api/chat', { room, me, data: { ch: 'all', text: '并发测试' }, opId: 'op-conc-1' }),
      post('/api/chat', { room, me, data: { ch: 'all', text: '并发测试' }, opId: 'op-conc-1' }),
    ]);
    v = await state(room, me);
    assert((v.chat || []).filter(m => m.text === '并发测试').length === 1, 'O2 并发同 opId → 只有 1 条消息（pending 窗口堵死）');

    // ---- O6：advance 同 opId → 阶段只推进一次 ----
    await post('/api/action', { room, me: c.playerId, action: 'add_bot', data: { level: 'idle' } });
    await post('/api/action', { room, me: c.playerId, action: 'add_bot', data: { level: 'idle' } });
    await post('/api/action', { room, me: c.playerId, action: 'add_bot', data: { level: 'idle' } });
    await post('/api/action', { room, me: c.playerId, action: 'settings', data: { sheriff: false, thief: false } });
    await post('/api/action', { room, me: c.playerId, action: 'setCounts', data: { counts: { wolf: 1, villager: 3 } } }); // 先 counts 后 cap
    await post('/api/action', { room, me: c.playerId, action: 'setCap', data: { cap: 4 } });
    const st = await post('/api/action', { room, me: c.playerId, action: 'start' });
    assert(!st.error, 'O6a 开局');
    await post('/api/action', { room, me: c.playerId, action: 'hostPick', data: { role: 'random' } });
    const a1 = await post('/api/advance', { room, me: c.playerId, opId: 'op-adv-1' }); // 发牌 → 进夜
    const a2 = await post('/api/advance', { room, me: c.playerId, opId: 'op-adv-1' }); // 同 opId 重试
    assert(a2.replayed === true, 'O6b 同 opId advance 重试 → 命中重放');
    v = await state(room, c.playerId);
    assert(v.phase === 'night' && v.nightStep === 'wolf', 'O6c 阶段只推进一次（night/wolf，未连跳两格）');
  } catch (e) { failures++; console.error('!!异常: ' + ((e && e.stack) || e)); }
  finally { srv.kill(); }
  await sleep(300);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\nopId 幂等去重专项测试全部通过 ✔');
  process.exit(0);
}
main();
