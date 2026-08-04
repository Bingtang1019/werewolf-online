'use strict';
/* 专项验证 S1：狼频道消息白天不再下发到 view.chat（服务端 chatView 夜晚限制） */
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8345;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const assert = (c, m) => { if (c) console.log('  ✓ ' + m); else { failures++; console.error('  ✗ FAIL: ' + m); } };
async function api(p, body) {
  const res = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return res.json();
}
async function act(room, me, action, data) {
  const r = await api('/api/action', { room, me, action, data: data || {} });
  if (r.error) throw new Error(`action ${action} 失败: ${r.error}`);
  return r.view;
}
async function state(room, me) {
  const res = await fetch(`${BASE}/api/state?room=${room}&me=${me}`);
  return res.json();
}
async function chat(room, me, ch, text) {
  const r = await api('/api/chat', { room, me, data: { ch, text } });
  if (r.error) throw new Error(`chat 失败: ${r.error}`);
  return r.view;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), CHAT_INTERVAL: '0' }, stdio: 'ignore' });
  await sleep(700);
  try {
    // 4 人房：房主 A（选狼人），B/C/D 平民（纯平民局，狼刀任意人不会立刻触发屠边结算）
    const cr = await api('/api/create', { name: 'A' });
    const A = cr.playerId;
    const ids = [A];
    for (const n of ['B', 'C', 'D']) {
      const jr = await api('/api/join', { roomId: cr.roomId, name: n });
      ids.push(jr.playerId);
    }
    await act(cr.roomId, A, 'setCounts', { counts: { wolf: 1, villager: 3, seer: 0, witch: 0, hunter: 0, guard: 0, dreamer: 0, wolfBeauty: 0, cupid: 0 } });
    await act(cr.roomId, A, 'setCap', { cap: 4 });
    await act(cr.roomId, A, 'start');
    // 身份展示：房主选狼人，其余自动
    await act(cr.roomId, A, 'hostPick', { role: 'wolf' });
    for (const id of ids) await act(cr.roomId, id, 'confirm');
    await sleep(300);
    let v = await state(cr.roomId, A);
    assert(v.phase === 'night', '进入夜晚');
    assert(v.my.role === '狼人', 'A 是狼人');
    // 夜晚：狼人发一条狼频道消息
    await chat(cr.roomId, A, 'wolf', '今晚刀B');
    v = await state(cr.roomId, A);
    assert(v.myChannels.includes('wolf'), '夜晚：狼频道存在');
    assert(v.chat.some(m => m.ch === 'wolf' && m.text === '今晚刀B'), '夜晚：狼频道消息可见');
    // 狼行动 → 推进直到夜晚结束（若夜间无其它步骤会在狼行动时自动天亮；有则 advance 跳过）
    await act(cr.roomId, A, 'wolf_set', { kill: ids[1], confirm: true });
    for (let i = 0; i < 6; i++) {
      v = await state(cr.roomId, A);
      if (v.phase !== 'night') break;
      await api('/api/advance', { room: cr.roomId, me: A });
      await sleep(250);
    }
    v = await state(cr.roomId, A);
    assert(v.phase !== 'night', '夜晚结束（进入天亮流程）');
    // 推进到白天发言（可能经过遗言/警长竞选等阶段，循环推进）
    for (let i = 0; i < 8; i++) {
      v = await state(cr.roomId, A);
      if (v.phase === 'discuss') break;
      const ar = await api('/api/advance', { room: cr.roomId, me: A });
      if (ar.error) break;
    }
    v = await state(cr.roomId, A);
    assert(v.phase === 'discuss', '进入白天发言');
    // S1 核心断言：白天 view.chat 不应再包含狼频道消息
    assert(!v.myChannels.includes('wolf'), '白天：无狼频道标签');
    assert(!v.chat.some(m => m.ch === 'wolf'), 'S1 PASS：白天 view.chat 不再下发狼频道历史');
    // 白天全体频道仍可用
    await chat(cr.roomId, A, 'all', '白天好');
    v = await state(cr.roomId, A);
    assert(v.chat.some(m => m.ch === 'all' && m.text === '白天好'), '白天：全体频道消息正常');
  } catch (e) {
    failures++;
    console.error('✗ 异常:', e.message);
  } finally {
    srv.kill();
    console.log(failures === 0 ? '\nS1 专项验证：全部通过 ✔' : `\nS1 专项验证：${failures} 个失败 ✘`);
    process.exit(failures === 0 ? 0 : 1);
  }
})();
