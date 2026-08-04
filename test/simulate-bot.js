'use strict';
/* =========================================================================
 * 人机玩家（房主调试功能）自动化测试
 * 运行：node test/simulate-bot.js
 * 会临时启动 server.js（端口 8126，PHASE_TIMEOUT=1），跑完自动关闭。
 * 覆盖：
 *   1. add_bot / remove_bot 权限与人数上限校验；view 中 isBot 标记
 *   2. T2 简单AI：5人局（房主预言家 + 人机狼/女巫/丘比特/平民）完整跑通，不卡死、有胜者
 *   3. T1 挂机 + 盗贼玩法：4人局完整跑通
 * 说明：房主（唯一真人）由测试脚本驱动代打，人机由服务端引擎自动行动。
 * ========================================================================= */
const { spawn } = require('child_process');
const path = require('path');

const PORT = 8126;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { failures++; console.error('  ✗ FAIL: ' + msg); }
}
const randInt = n => Math.floor(Math.random() * n);
const pick = arr => arr[randInt(arr.length)];
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
async function advance(room, me) {
  const r = await api('/api/advance', { room, me });
  if (r.error) throw new Error(`advance 失败: ${r.error}`);
  return r.view;
}

/* 建房间 + 加人机 + 配置（thief 需在 setCap 前设置，身份牌总数=人数+1） */
async function setup(hostName, botCount, cap, counts, botMode, extraSettings) {
  const r = await api('/api/create', { name: hostName });
  const room = r.roomId, me = r.playerId;
  for (let i = 0; i < botCount; i++) await act(room, me, 'add_bot', {});
  await act(room, me, 'setCounts', { counts });
  if (extraSettings) await act(room, me, 'settings', extraSettings);
  await act(room, me, 'setCap', { cap });
  await act(room, me, 'settings', { botMode });
  return { room, me };
}

/* 房主（唯一真人）的脚本驱动：轮到自己就代打（与人机共用同一套服务端动作） */
async function hostDriver(room, me, v) {
  const myRole = v.my.roleKey;
  const aliveIds = () => v.players.filter(p => p.alive && p.id !== me).map(p => p.id);
  switch (v.phase) {
    case 'reveal':
      if (v.reveal.canPick) await act(room, me, 'hostPick', { role: 'seer' });
      else if (v.reveal.isThief && v.reveal.thiefCards) await act(room, me, 'thief_pick', { idx: 0 });
      else if (v.reveal.dealt && !v.reveal.confirmed.some(c => c.id === me && c.ok)) await act(room, me, 'confirm', {});
      break;
    case 'night': {
      const n = v.night || {};
      if (n.step === 'hunter') {
        if (n.hunter && n.hunter.shooter === me) await act(room, me, 'hunter_shoot', { target: null });
      } else if (n.step === 'lovers' && (n.actors || []).some(a => a.id === me)) {
        await act(room, me, 'lovers_ok', {}); // 情侣步优先于职业分支（避免房主被丘比特选进情侣时误发本职业动作）
      } else if ((n.actors || []).some(a => a.id === me)) {
        const ids = aliveIds();
        if (myRole === 'wolf') await act(room, me, 'wolf_set', { kill: ids.length ? pick(ids) : null, confirm: true });
        else if (myRole === 'seer') await act(room, me, 'seer_pick', { target: pick(ids) });
        else if (myRole === 'witch') await act(room, me, 'witch_act', { save: false, poison: null });
        else if (myRole === 'guard') await act(room, me, 'guard_pick', { target: pick(ids) });
        else if (myRole === 'dreamer') await act(room, me, 'dreamer_pick', { target: pick(ids) });
        else if (myRole === 'cupid') { const a = pick(ids); const b = pick(ids.filter(id => id !== a)); if (b) await act(room, me, 'cupid_pick', { ids: [a, b] }); }
        else if (n.step === 'lovers') await act(room, me, 'lovers_ok', {});
        else await advance(room, me);
      }
      break;
    }
    case 'lastword':
      if ((v.lastword.entitled || []).some(e => e.id === me && !e.posted)) await act(room, me, 'skip', {});
      else await advance(room, me);
      break;
    case 'handover':
      if (v.handover.from === me) await act(room, me, 'handover', { target: null });
      else await advance(room, me);
      break;
    case 'sheriff_campaign':
      if (!v.campaign.myDecided) await act(room, me, 'campaign', { run: false });
      break;
    case 'sheriff_vote':
      await act(room, me, 'vote', { target: null });
      break;
    case 'vote':
      await act(room, me, 'vote', { target: pick(aliveIds()) || null });
      break;
    case 'pk_vote': {
      const tied = ((v.vote && v.vote.pkTied) || []).map(t => t.id);
      await act(room, me, 'vote', { target: tied.length ? pick(tied) : null });
      break;
    }
    case 'hunter_shot':
      if (v.hunterShot.shooter === me) await act(room, me, 'hunter_shoot', { target: null });
      break;
    case 'morning': case 'discuss': case 'pk_speech':
      await advance(room, me);
      break;
    default: break;
  }
}

/* 驱动房主直到对局结束 */
async function playUntilEnd(room, me, timeoutMs, label) {
  const t0 = Date.now();
  let lastPhase = '';
  while (Date.now() - t0 < timeoutMs) {
    let v;
    try { v = await state(room, me); } catch (e) { await sleep(200); continue; }
    if (v.phase === 'ended') { console.log('  ✓ ' + label + '：对局结束'); return v; }
    const key = v.phase + (v.phase === 'night' && v.nightStep ? ':' + v.nightStep : '');
    if (key !== lastPhase) { lastPhase = key; console.log('   → ' + key); }
    try { await hostDriver(room, me, v); } catch (e) { /* 阶段竞态：下轮重试 */ }
    await sleep(250);
  }
  assert(false, label + '：超时未结束（可能卡死）');
  return null;
}

async function testBasics() {
  console.log('\n== 基础：add_bot / remove_bot 权限与校验 ==');
  const r = await api('/api/create', { name: '房主A' });
  const room = r.roomId, host = r.playerId;
  const jr = await api('/api/join', { roomId: room, name: '真人B' });
  const B = jr.playerId;
  const r1 = await api('/api/action', { room, me: B, action: 'add_bot', data: {} });
  assert(!!r1.error, '非房主 add_bot 被拒绝');
  for (let i = 0; i < 4; i++) await act(room, host, 'add_bot', {});
  let v = await state(room, host);
  assert(v.players.filter(p => p.isBot).length === 4, '添加4个人机（2人+4人机=6人满员）');
  const r2 = await api('/api/action', { room, me: host, action: 'add_bot', data: {} });
  assert(!!r2.error, '满员后 add_bot 被拒绝');
  const r3 = await api('/api/action', { room, me: B, action: 'remove_bot', data: {} });
  assert(!!r3.error, '非房主 remove_bot 被拒绝');
  await act(room, host, 'remove_bot', {});
  v = await state(room, host);
  assert(v.players.filter(p => p.isBot).length === 3, 'remove_bot 移除一个人机');
  assert(v.players.filter(p => p.isBot).every(b => /^人机/.test(b.name)), '人机名字带"人机"前缀');
  assert(v.players.some(p => p.isBot), 'view.players 带 isBot 标记');
}

async function testAutoGame() {
  console.log('\n== T2 简单AI：5人局（房主预言家 + 人机狼/女巫/丘比特/平民） ==');
  const { room, me } = await setup('房主A', 4, 5, { wolf: 1, seer: 1, witch: 1, cupid: 1, villager: 1 }, 'auto');
  await act(room, me, 'start');
  await act(room, me, 'hostPick', { role: 'seer' });
  // 发牌后应自动进入夜晚（人机自动确认）
  const t0 = Date.now();
  const nightV = await waitPhase(room, me, 'night', 15000);
  assert(!!nightV, '发牌后进入夜晚（人机自动确认）');
  if (nightV) {
    assert(Date.now() - t0 < 15000, '进入夜晚耗时 <15s');
    // 夜晚检查：人机步骤自动完成；房主（预言家）步骤由驱动代打
    const nightStart = Date.now();
    const moved = await waitNotNightDrive(room, me, 8000);
    assert(!!moved, '夜晚自动完成（人机步骤不卡死，房主步骤由驱动代打）');
    if (moved) console.log('   → 首夜耗时 ' + (Date.now() - nightStart) + 'ms');
  }
  const end = await playUntilEnd(room, me, 150000, 'T2简单AI');
  if (end) {
    assert(!!end.winner, '有胜者（' + end.winner + '）');
    assert(!!end.endInfo, '有结束信息');
  }
}

async function testPassiveGame() {
  console.log('\n== T1 挂机 + 盗贼玩法：4人局（房主预言家 + 3人机） ==');
  const { room, me } = await setup('房主A', 3, 4, { wolf: 1, seer: 1, villager: 1 }, 'passive', { thief: true });
  await act(room, me, 'start');
  const end = await playUntilEnd(room, me, 150000, 'T1挂机');
  if (end) {
    assert(!!end.winner, '有胜者（' + end.winner + '）');
    assert(!!end.endInfo, '有结束信息');
  }
}

/* 等待某个阶段出现（期间由人机自行推进，不驱动房主） */
async function waitPhase(room, me, phase, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await state(room, me);
    if (v.phase === phase) return v;
    await sleep(250);
  }
  return null;
}
async function waitNotNightDrive(room, me, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await state(room, me);
    if (v.phase !== 'night') return v;
    try { await hostDriver(room, me, v); } catch (e) { /* 阶段竞态：下轮重试 */ }
    await sleep(250);
  }
  return null;
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), PHASE_TIMEOUT: '1' },
  });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${BASE}/healthz`); if (r.status === 200) { ready = true; break; } } catch (e) { /* retry */ }
    await sleep(200);
  }
  if (!ready) { console.error('服务器未就绪'); server.kill(); process.exit(1); }
  try {
    await testBasics();
    await testAutoGame();
    await testPassiveGame();
  } catch (e) {
    failures++;
    console.error('!! 异常: ' + (e && e.stack || e));
  }
  server.kill();
  await sleep(300);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\n人机测试全部通过 ✔');
  process.exit(0);
}
main();
