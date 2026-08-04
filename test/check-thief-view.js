'use strict';
/* 盗贼视角视图专项测试：修复"非房主盗贼看不到选牌卡"的回归测试 */
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8499;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };
const api = async (p, body) => (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
const act = async (room, me, action, data) => { const r = await api('/api/action', { room, me, action, data: data || {} }); if (r.error) throw new Error(`action ${action}失败: ${r.error}`); return r.view; };
const state = async (room, me) => (await fetch(`${BASE}/api/state?room=${room}&me=${me}`)).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 客户端渲染分支复现：用与 client.js 相同的分支顺序判断盗贼能否看到卡 */
function renderRevealBranch(rv) {
  if (rv.canPick) return 'hostChoice';
  if (rv.isThief && rv.thiefCards && rv.thiefCards.length) return 'thiefCards';
  if (rv.thiefPicking) return 'thiefWaiting';
  if (!rv.dealt) return 'genericWaiting';
  return 'identity';
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), NIGHT_TIMEOUT: '30', CHAT_INTERVAL: '0' },
  });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${BASE}/healthz`); if (r.status === 200) { ready = true; break; } } catch (e) {}
    await sleep(200);
  }
  if (!ready) { console.error('服务器未就绪'); server.kill(); process.exit(1); }
  try {
    // 6 人局（提高盗贼为非房主的确定性：房主先取牌→必不可能为盗贼）
    const r = await api('/api/create', { name: '房主A' });
    const room = r.roomId, me = r.playerId;
    const ids = [me];
    for (let i = 0; i < 3; i++) { const j = await api('/api/join', { roomId: room, name: '玩家' + (i + 2) }); ids.push(j.playerId); }
    await act(room, me, 'setCounts', { counts: { wolf: 1, seer: 1, villager: 0, witch: 0, hunter: 0, dreamer: 0, guard: 0, wolfBeauty: 0, cupid: 0 } });
    await act(room, me, 'settings', { thief: true });
    await act(room, me, 'setCap', { cap: 4 });
    await act(room, me, 'start');
    await act(room, me, 'hostPick', { role: 'seer' }); // 房主取牌 → 房主必不是盗贼
    // 找盗贼（各玩家自己的视图 isThief）
    let thiefId = null;
    for (const id of ids) {
      const sv = await state(room, id);
      if (sv.reveal && sv.reveal.isThief) { thiefId = id; break; }
    }
    assert(!!thiefId && thiefId !== me, '盗贼为非房主玩家');
    const tv = await state(room, thiefId);
    // 关键断言：盗贼能看到两张牌（isThief + thiefCards），stage 保持隐藏
    assert(tv.reveal.isThief === true, '盗贼视图 isThief=true');
    assert(Array.isArray(tv.reveal.thiefCards) && tv.reveal.thiefCards.length === 2, `盗贼视图能看到两张身份牌（${(tv.reveal.thiefCards || []).map(c => c.key).join(',')}）`);
    assert(tv.reveal.stage === null, '盗贼视图 stage 保持隐藏（信息隐藏不破）');
    assert(tv.reveal.thiefPicking === true, '盗贼视图 thiefPicking=true（旁观文案可用）');
    // 客户端渲染分支：修复后应命中 thiefCards（修复前命中 thiefWaiting）
    const branch = renderRevealBranch(tv.reveal);
    assert(branch === 'thiefCards', `渲染分支命中"盗贼选牌卡"（实际: ${branch}）`);
    // 非盗贼玩家视角：看不到卡、看不到盗贼身份
    const other = ids.find(id => id !== me && id !== thiefId);
    const ov = await state(room, other);
    assert(ov.reveal.isThief === false && !ov.reveal.thiefCards, '非盗贼玩家看不到选牌卡');
    assert(renderRevealBranch(ov.reveal) === 'thiefWaiting', '非盗贼玩家看到"盗贼正在窃走......"');
    // 房主视角：stage 可见
    const hv = await state(room, me);
    assert(hv.reveal.stage === 'thiefPick', '房主视图 stage 可见（thiefPick）');
    // 盗贼正常选牌后流程继续
    const pick = tv.reveal.thiefCards.findIndex(c => c.key === 'wolf') >= 0 ? tv.reveal.thiefCards.findIndex(c => c.key === 'wolf') : 0;
    await act(room, thiefId, 'thief_pick', { idx: pick });
    await sleep(200);
    const dv = await state(room, me);
    assert(dv.reveal.dealt === true, '盗贼选牌后正常发牌');
  } catch (e) { failures++; console.error('!!异常: ' + ((e && e.stack) || e)); }
  server.kill();
  await sleep(300);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\n盗贼视角专项测试全部通过 ✔');
  process.exit(0);
}
main();
