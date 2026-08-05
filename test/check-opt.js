'use strict';
/* 优化专项验证：
 * 1. 聊天增量传输：since 之后只返回新消息；ts 严格递增
 * 2. 盗贼玩法 + 神职卡作废 → 屠边不误判（狼人首刀不应直接判胜）
 */
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8361;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };
async function api(p, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}
async function act(room, me, action, data) {
  const r = await api('/api/action', { room, me, action, data: data || {} });
  if (r.error) throw new Error(action + '失败: ' + r.error);
  return r.view;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function testChatDelta() {
  console.log('\n== 聊天增量传输 ==');
  const r = await api('/api/create', { name: '房主' });
  const room = r.roomId, me = r.playerId;
  const j = await api('/api/join', { roomId: room, name: '玩家B' });
  const B = j.playerId;
  const chat = async (id, text) => (await api('/api/chat', { room, me: id, data: { ch: 'all', text }, chatSince: 0 })).view;
  let v = await chat(me, '消息1');
  await chat(B, '消息2');
  v = await chat(me, '消息3');
  assert(v.chat.length === 3, '全量（无since）返回3条');
  const lastTs = v.chat[v.chat.length - 1].ts;
  assert(v.chat[0].ts < v.chat[1].ts && v.chat[1].ts < v.chat[2].ts, '消息 ts 严格递增');
  // 带 since 轮询：先制造一次“非聊天”的版本变化（settings 恒 bump），验证聊天增量为 0 条
  await api('/api/action', { room, me, action: 'settings', data: { tieRule: 'pk' } });
  const st = await (await fetch(`${BASE}/api/state?room=${room}&me=${me}&v=${v.v}&since=${lastTs}`)).json();
  assert(Array.isArray(st.chat) && st.chat.length === 0, '非聊天变化时 since 增量返回0条');
  await chat(B, '消息4');
  const st2 = await (await fetch(`${BASE}/api/state?room=${room}&me=${me}&v=${st.v}&since=${lastTs}`)).json();
  assert(st2.chat.length === 1 && st2.chat[0].text === '消息4', 'since 之后 → 增量返回1条新消息');
  assert(st2.chatFull === false, '增量响应带 chatFull=false');
}

async function testThiefGodDiscard() {
  console.log('\n== 盗贼玩法：神职卡作废不触发屠边误判 ==');
  const GOD_KEYS = ['seer', 'witch', 'hunter', 'dreamer', 'guard'];
  let seerDiscarded = 0, allOk = true, runs = 0;
  // 循环开局直到命中“预言家被作废”的关键场景（最多 12 局：实测单局命中率约 40%，8 局上限约 1.7% 概率 0 命中 → 12 局降到 0.2%）
  for (let attempt = 0; attempt < 12 && seerDiscarded === 0; attempt++) {
    runs++;
    const r = await api('/api/create', { name: '房主' });
    const room = r.roomId, me = r.playerId;
    const ids = [me];
    for (let i = 0; i < 3; i++) { const j = await api('/api/join', { roomId: room, name: '玩家' + (i + 2) }); ids.push(j.playerId); }
    await act(room, me, 'setCounts', { counts: { wolf: 1, seer: 1, villager: 0, witch: 0, hunter: 0, dreamer: 0, guard: 0, wolfBeauty: 0, cupid: 0 } });
    await act(room, me, 'settings', { thief: true });
    await act(room, me, 'setCap', { cap: 4 });
    await act(room, me, 'start');
    await act(room, me, 'hostPick', { role: 'villager' });
    let thiefId = null, thiefCards = null;
    for (const id of ids) {
      const sv = await (await fetch(`${BASE}/api/state?room=${room}&me=${id}`)).json();
      if (sv.reveal && sv.reveal.isThief && sv.reveal.thiefCards) { thiefId = id; thiefCards = sv.reveal.thiefCards; break; }
    }
    if (!thiefId || !thiefCards) { allOk = false; break; }
    const seerIdx = thiefCards.findIndex(c => c.key === 'seer');
    const wolfIdx = thiefCards.findIndex(c => c.key === 'wolf' || c.key === 'wolfBeauty');
    let pickIdx;
    if (seerIdx >= 0 && wolfIdx < 0) pickIdx = 1 - seerIdx;      // 中心无狼且含预言家 → 作废预言家
    else pickIdx = wolfIdx >= 0 ? wolfIdx : 0;                    // 有狼必选狼；否则随便选（预言家可能被作废）
    await act(room, thiefId, 'thief_pick', { idx: pickIdx });
    const kept = thiefCards[pickIdx].key, discarded = thiefCards[1 - pickIdx].key;
    if (discarded === 'seer') seerDiscarded++;
    console.log(`   第${attempt + 1}局: 中心牌[${thiefCards.map(c => c.key)}] → 盗贼拿${kept}, 作废${discarded}`);
    for (const id of ids) await act(room, id, 'confirm');
    // 盗贼局强制 5 秒展示盗贼结果后才入夜
    const t0 = Date.now();
    let v = null;
    while (Date.now() - t0 < 9000) {
      v = await (await fetch(`${BASE}/api/state?room=${room}&me=${me}`)).json();
      if (v.phase === 'night') break;
      await sleep(300);
    }
    if (!v || v.phase !== 'night') { allOk = false; break; }
    let wolfId = null;
    const roles = {};
    for (const id of ids) {
      const sv = await (await fetch(`${BASE}/api/state?room=${room}&me=${id}`)).json();
      roles[id] = sv.my.roleKey;
      if (sv.my.roleKey === 'wolf') wolfId = id;
    }
    if (!wolfId) { allOk = false; break; }
    // 选一个非狼、非神职的刀人目标（若预言家在场，避免误杀神职触发合法屠边）
    const prey = ids.find(id => id !== wolfId && !GOD_KEYS.includes(roles[id])) || ids.find(id => id !== wolfId);
    await act(room, wolfId, 'wolf_set', { kill: prey, confirm: true });
    await api('/api/advance', { room, me });
    await sleep(150);
    v = await (await fetch(`${BASE}/api/state?room=${room}&me=${me}`)).json();
    if (v.phase !== 'morning' && v.phase !== 'lastword') { allOk = false; console.error('   异常阶段: ' + v.phase + (v.endInfo ? ' ' + v.endInfo.text : '')); }
  }
  assert(allOk, '所有局次：狼人首刀后均正常进入天亮（未误判屠边）');
  assert(seerDiscarded > 0, `关键场景“预言家卡被作废”已覆盖（${runs} 局中命中 ${seerDiscarded} 次）`);
}

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, SNAPSHOT_SEC: '0', PORT: String(PORT), PHASE_TIMEOUT: '2', CHAT_INTERVAL: '0' },
  });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${BASE}/healthz`); if (r.status === 200) { ready = true; break; } } catch (e) {}
    await sleep(200);
  }
  if (!ready) { console.error('服务器未就绪'); srv.kill(); process.exit(1); }
  try {
    await testChatDelta();
    await testThiefGodDiscard();
  } catch (e) { failures++; console.error('!!异常: ' + (e && e.stack || e)); }
  srv.kill();
  await sleep(300);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\n优化专项测试全部通过 ✔');
  process.exit(0);
}
main();
