'use strict';
/* 房间快照持久化与恢复（v1.5.6）：
 * S1 建房开局推进到夜晚/白天 → 快照写入（SNAPSHOT_SEC=3 定期兜底）
 * S2 杀掉服务器（TerminateProcess）→ 新实例启动 → 房间与对局进度恢复
 * S3 恢复后继续推进（advance + bot 行动）→ 对局正常（间接验证 bot 记忆 Set 恢复）
 * 运行：node test/check-snapshot.js */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const PORT_A = 8200, PORT_B = 8201;
const SNAP = path.join(ROOT, 'rooms.json');
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitReady(base, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(base + '/healthz'); if (r.status === 200) return true; } catch (e) {}
    await sleep(200);
  }
  return false;
}
async function post(base, p, body) { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return r.json(); }
async function state(base, room, me) { return (await fetch(`${base}/api/state?room=${room}&me=${me}`)).json(); }

async function main() {
  // 清理旧快照
  try { fs.unlinkSync(SNAP); } catch (e) {}
  try { fs.unlinkSync(SNAP + '.tmp'); } catch (e) {}

  // ---- 实例 A：建房并推进到夜晚 ----
  const envA = { ...process.env, PORT: String(PORT_A), SNAPSHOT_SEC: '3', PHASE_TIMEOUT: '60', NIGHT_TIMEOUT: '45', BOT_DELAY_MS: '400' };
  const srvA = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: envA, stdio: 'ignore' });
  if (!(await waitReady('http://127.0.0.1:' + PORT_A))) { console.error('实例 A 未就绪'); srvA.kill(); process.exit(1); }
  const BA = 'http://127.0.0.1:' + PORT_A;
  const c = await post(BA, '/api/create', { name: '快照房主' });
  const room = c.roomId, host = c.playerId;
  await post(BA, '/api/action', { room, me: host, action: 'add_bot', data: { level: 'smart' } });
  await post(BA, '/api/action', { room, me: host, action: 'add_bot', data: { level: 'smart' } });
  await post(BA, '/api/action', { room, me: host, action: 'add_bot', data: { level: 'idle' } });
  await post(BA, '/api/action', { room, me: host, action: 'settings', data: { sheriff: false, thief: false, winMode: 'city' } }); // 屠城：第一夜刀死神职不结束，保证推进稳定
  await post(BA, '/api/action', { room, me: host, action: 'setCounts', data: { counts: { wolf: 1, seer: 1, villager: 2 } } });
  await post(BA, '/api/action', { room, me: host, action: 'setCap', data: { cap: 4 } });
  const st = await post(BA, '/api/action', { room, me: host, action: 'start' });
  assert(!st.error, 'S1a 开局');
  await post(BA, '/api/action', { room, me: host, action: 'hostPick', data: { role: 'seer' } });
  await post(BA, '/api/advance', { room, me: host });
  await sleep(2500); // bot confirm
  await post(BA, '/api/advance', { room, me: host }); // 发牌 → 进夜（或 reveal 停留）
  // 推进到夜晚（recover 前记录进度）
  let v = await state(BA, room, host);
  for (let i = 0; i < 25 && v.phase === 'reveal'; i++) {
    await post(BA, '/api/advance', { room, me: host }).catch(() => {});
    await sleep(600);
    v = await state(BA, room, host);
  }
  const savedPhase = v.phase, savedNightStep = v.nightStep;
  console.log('  快照时对局进度: phase=' + savedPhase + ' nightStep=' + savedNightStep + ' players=' + (v.players || []).length);
  assert((savedPhase === 'night' || savedPhase === 'morning' || savedPhase === 'reveal' || savedPhase === 'discuss') && (v.players || []).length === 4, 'S1b 对局已推进（夜晚/早晨/发牌后）');

  // 等待定期快照写入（SNAPSHOT_SEC=3 兜底；markDirty 防抖也会写）
  await sleep(4500);
  assert(fs.existsSync(SNAP), 'S2a 快照文件已生成');
  const snapRaw = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
  assert(snapRaw.version === 1 && Array.isArray(snapRaw.rooms), 'S2b 快照格式 version=1');
  const found = snapRaw.rooms.find(r => r.id === room);
  assert(!!found, 'S2c 快照含目标房间');

  // 杀掉实例 A
  srvA.kill();
  await sleep(1500);

  // ---- 实例 B：恢复 ----
  const envB = { ...process.env, PORT: String(PORT_B), SNAPSHOT_SEC: '3', PHASE_TIMEOUT: '60', NIGHT_TIMEOUT: '45', BOT_DELAY_MS: '400' };
  const srvB = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: envB, stdio: 'ignore' });
  if (!(await waitReady('http://127.0.0.1:' + PORT_B))) { console.error('实例 B 未就绪'); srvB.kill(); process.exit(1); }
  const BB = 'http://127.0.0.1:' + PORT_B;
  const v2 = await state(BB, room, host);
  assert(v2.roomId === room && !v2.error, 'S3a 房间恢复（room-not-found 未出现）');
  assert((v2.players || []).length === 4, 'S3b 玩家列表恢复');
  assert(v2.phase === savedPhase, 'S3c 对局阶段恢复（' + v2.phase + '）');

  // ---- S4：恢复后继续推进（夜晚 bot 行动 / advance） ----
  if (v2.phase === 'reveal') {
    for (let i = 0; i < 6; i++) { await post(BB, '/api/advance', { room, me: host }).catch(() => {}); await sleep(600); }
  }
  let v3 = await state(BB, room, host);
  let progressed = false;
  for (let i = 0; i < 20; i++) {
    if (v3.phase === 'morning' || v3.phase === 'discuss' || v3.phase === 'vote') { progressed = true; break; }
    if (v3.phase === 'night') {
      // 夜晚：等待 bot 行动（含 smart 查验/出刀——Set 恢复的间接验证）
      await sleep(1200);
    } else {
      await post(BB, '/api/advance', { room, me: host }).catch(() => {});
    }
    await sleep(500);
    v3 = await state(BB, room, host);
  }
  assert(progressed, 'S4 恢复后对局可继续推进（bot 行动正常，Set 记忆恢复）');

  // 收尾：解散房间 + 清理快照
  await post(BB, '/api/leave', { room, me: host }).catch(() => {});
  await sleep(1000);
  try { fs.unlinkSync(SNAP); } catch (e) {}
  try { fs.unlinkSync(SNAP + '.tmp'); } catch (e) {}
  srvB.kill();
  await sleep(300);

  if (failures) { console.error('\n共 ' + failures + ' 处失败'); process.exit(1); }
  console.log('\n房间快照恢复专项全部通过 ✔');
  process.exit(0);
}
main().catch(e => { console.error('异常:', e.message); try { fs.unlinkSync(SNAP); } catch (x) {} process.exit(1); });
