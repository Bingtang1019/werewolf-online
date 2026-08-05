'use strict';
/* 猎人被狼刀 → 夜间开枪链路检测 */
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8511;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };
const api = async (p, body) => (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
const act = async (room, me, action, data) => { const r = await api('/api/action', { room, me, action, data: data || {} }); if (r.error) throw new Error(action + '失败: ' + r.error); return r.view; };
const st = async (room, me) => (await fetch(`${BASE}/api/state?room=${room}&me=${me}`)).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, SNAPSHOT_SEC: '0', PORT: String(PORT), NIGHT_TIMEOUT: '60' } });
  let ready = false;
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`${BASE}/healthz`); if (r.status === 200) { ready = true; break; } } catch (e) {} await sleep(200); }
  if (!ready) { console.error('服务器未就绪'); server.kill(); process.exit(1); }
  try {
    const r = await api('/api/create', { name: '房主' });
    const room = r.roomId, host = r.playerId;
    const ids = [host];
    for (let i = 0; i < 3; i++) { const j = await api('/api/join', { roomId: room, name: '玩家' + (i + 2) }); ids.push(j.playerId); }
    await act(room, host, 'setCounts', { counts: { wolf: 1, hunter: 1, villager: 0, seer: 0, witch: 0, dreamer: 0, guard: 0, wolfBeauty: 0, cupid: 0 } });
    await act(room, host, 'setCap', { cap: 4 });
    await act(room, host, 'start');
    await act(room, host, 'hostPick', { role: 'hunter' }); // 房主=猎人
    for (const id of ids) await act(room, id, 'confirm', {});
    let roles = {};
    for (const id of ids) { const sv = await st(room, id); roles[id] = sv.my.roleKey; }
    console.log('角色:', ids.map(id => roles[id]).join(','));
    const wolfId = ids.find(id => roles[id] === 'wolf');
    const vills = ids.filter(id => roles[id] === 'villager');
    assert(!!wolfId, '找到狼人');
    // 夜1：狼人刀猎人（房主）
    let v = await st(room, host);
    for (let i = 0; i < 30 && v.phase === 'night'; i++) {
      v = await st(room, host);
      const step = v.night && v.night.step;
      if (step === 'wolf') { await act(room, wolfId, 'wolf_set', { kill: host, confirm: true }); await sleep(100); continue; }
      if (step === 'hunter') break; // 进入猎人开枪步
      if (step === 'lovers') { for (const id of ids) { const sv = await st(room, id); if ((sv.night.actors || []).some(a => a.id === id)) await act(room, id, 'lovers_ok', {}); } }
      await sleep(100);
    }
    v = await st(room, host);
    assert(v.night && v.night.step === 'hunter', '狼刀猎人后进入猎人开枪步骤（实际 step=' + (v.night && v.night.step) + '）');
    const hv = await st(room, host);
    assert(hv.night.hunter && hv.night.hunter.shooter === host, '猎人视图能看到开枪面板（shooter=自己）');
    assert(!!hv.night.hunter, 'night.hunter 视图字段存在');
    // 猎人开枪打死狼人
    const shotView = await act(room, host, 'hunter_shoot', { target: wolfId });
    assert(!!shotView, '猎人开枪动作成功');
    const wv = await st(room, wolfId);
    const wolfP = (wv.players || []).find(p => p.id === wolfId);
    assert(wolfP && wolfP.alive === false && wolfP.deadBy === 'shoot', '狼人被枪杀（deadBy=shoot）');
    // 等待夜晚结算 → 早晨
    let mv = null;
    for (let i = 0; i < 20; i++) { mv = await st(room, host); if (mv.phase !== 'night') break; await sleep(200); }
    assert(!!mv && mv.phase !== 'night', '开枪后夜晚正常结算进入天亮（phase=' + mv.phase + '）');
  } catch (e) { failures++; console.error('!!异常: ' + ((e && e.stack) || e)); }

  // === 场景2：猎人被放逐 → 白天开枪 ===
  console.log('\n== 猎人被放逐 → 白天开枪 ==');
  try {
    const r2 = await api('/api/create', { name: '房主B' });
    const room2 = r2.roomId, host2 = r2.playerId;
    const ids2 = [host2];
    for (let i = 0; i < 4; i++) { const j = await api('/api/join', { roomId: room2, name: '玩家' + (i + 2) }); ids2.push(j.playerId); }
    await act(room2, host2, 'setCounts', { counts: { wolf: 1, hunter: 1, seer: 1, villager: 0, witch: 0, dreamer: 0, guard: 0, wolfBeauty: 0, cupid: 0 } });
    await act(room2, host2, 'setCap', { cap: 5 });
    await act(room2, host2, 'start');
    await act(room2, host2, 'hostPick', { role: 'hunter' }); // 房主=猎人
    for (const id of ids2) await act(room2, id, 'confirm', {});
    const roles2 = {};
    for (const id of ids2) { const sv = await st(room2, id); roles2[id] = sv.my.roleKey; }
    const wolf2 = ids2.find(id => roles2[id] === 'wolf');
    const vills2 = ids2.filter(id => roles2[id] === 'villager');
    // 夜1：狼刀平民1
    let v2 = await st(room2, host2);
    for (let i = 0; i < 30 && v2.phase === 'night'; i++) {
      v2 = await st(room2, host2);
      const step = v2.night && v2.night.step;
      if (step === 'wolf') { await act(room2, wolf2, 'wolf_set', { kill: vills2[0], confirm: true }); await sleep(100); continue; }
      if (step === 'seer') { const sv = await st(room2, ids2.find(id => roles2[id] === 'seer')); const others = (sv.players || []).filter(p => p.alive && p.id !== sv.my.id).map(p => p.id); await act(room2, sv.my.id, 'seer_pick', { target: others[0] }); }
      await sleep(100);
    }
    assert(v2.phase !== 'night', '夜1结束（phase=' + v2.phase + '）');
    // 天1：猎人竞选警长并当选，然后被全员放逐 → 触发白天开枪
    let d2 = await st(room2, host2);
    for (let i = 0; i < 50; i++) {
      d2 = await st(room2, host2);
      const ph = d2.phase;
      if (ph === 'hunter_shot') break;
      if (ph === 'morning' || ph === 'discuss' || ph === 'pk_speech') { await api('/api/advance', { room: room2, me: host2 }); await sleep(60); continue; }
      if (ph === 'lastword') { for (const id of ids2) { const sv = await st(room2, id); if (((sv.lastword || {}).entitled || []).some(e => e.id === id && !e.posted)) await act(room2, id, 'skip', {}); } await sleep(60); continue; }
      if (ph === 'sheriff_campaign') { for (const id of ids2) { const sv = await st(room2, id); if (sv.campaign && !sv.campaign.myDecided) await act(room2, id, 'campaign', { run: id === host2 }); } await sleep(60); continue; }
      if (ph === 'sheriff_vote') { for (const id of ids2) { const sv = await st(room2, id); if (!sv.my.alive) continue; if (sv.sheriffVote && !sv.sheriffVote.myVoted) await act(room2, id, 'vote', { target: host2 }); } await sleep(60); continue; }
      if (ph === 'vote' || ph === 'pk_vote') { for (const id of ids2) { const sv = await st(room2, id); if (!sv.my.alive) continue; if (sv.vote && !sv.vote.myVoted) await act(room2, id, 'vote', { target: host2 }); } await sleep(60); continue; }
      await sleep(100);
    }
    assert(d2.phase === 'hunter_shot' && d2.hunterShot && d2.hunterShot.shooter === host2, '被放逐的猎人进入开枪阶段（实际 phase=' + d2.phase + '）');
    // 开枪打死狼人
    await act(room2, host2, 'hunter_shoot', { target: wolf2 });
    const w2v = await st(room2, wolf2);
    const wp2 = (w2v.players || []).find(p => p.id === wolf2);
    assert(wp2 && wp2.alive === false && wp2.deadBy === 'shoot', '放逐猎人开枪击杀狼人（deadBy=shoot）');
  } catch (e) { failures++; console.error('!!异常(场景2): ' + ((e && e.stack) || e)); }
  server.kill();
  await sleep(300);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\n猎人被狼刀开枪链路检测全部通过 ✔');
  process.exit(0);
}
main();
