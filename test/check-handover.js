'use strict';
/* 警徽移交规则专项验证（正式规则，见 rules.md 关键规则裁定 #2）：
 * 警长出局，除 被魅惑带走 / 被摄梦人带走 / 被毒杀 外（狼刀/枪杀/放逐/殉情等），均可移交警徽。
 * 本测试即该规则的锁定件：若日后规则改回「仅狼刀可移交」，需同步修改本文件。
 * 1. 警长被放逐 → 次日早晨进入 handover 阶段，可移交给存活玩家
 * 2. 警长被毒杀 → 次日早晨不进入 handover
 */
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8363;
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
async function st(room, me) { return (await fetch(`${BASE}/api/state?room=${room}&me=${me}`)).json(); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 开局：6人局（狼1/预1/巫1/民3），房主A=预言家 */
async function setup() {
  const r = await api('/api/create', { name: '房主' });
  const room = r.roomId, host = r.playerId;
  const ids = [host];
  for (let i = 0; i < 5; i++) { const j = await api('/api/join', { roomId: room, name: '玩家' + (i + 2) }); ids.push(j.playerId); }
  await act(room, host, 'setCounts', { counts: { wolf: 1, seer: 1, witch: 1, villager: 0 } });
  await act(room, host, 'setCap', { cap: 6 });
  await act(room, host, 'start');
  await act(room, host, 'hostPick', { role: 'seer' });
  for (const id of ids) await act(room, id, 'confirm');
  const roles = {};
  for (const id of ids) { const v = await st(room, id); roles[id] = v.my.roleKey; }
  return { room, host, ids, roles };
}

/* 夜晚驱动：狼指定刀人；预言家查验；女巫可解毒药目标（poison）+ 是否用解药（save） */
async function driveNight(room, ids, roles, { kill, poison, save } = {}) {
  let v = await st(room, ids[0]);
  while (v.phase === 'night') {
    const n = v.night || {};
    if (n.step === 'hunter') break;
    for (const a of (n.actors || [])) {
      const id = a.id, role = roles[id];
      if (!a.acted) {
        const aliveOthers = () => (v.players || []).filter(p => p.alive && p.id !== id).map(p => p.id);
        if (role === 'wolf') await act(room, id, 'wolf_set', { kill: kill !== undefined ? kill : aliveOthers()[0], confirm: true });
        else if (role === 'seer') await act(room, id, 'seer_pick', { target: aliveOthers()[0] });
        else if (role === 'witch') await act(room, id, 'witch_act', { save: !!save, poison: poison || null });
        else if (n.step === 'lovers') await act(room, id, 'lovers_ok', {});
      }
    }
    await sleep(250);
    v = await st(room, ids[0]);
  }
  return v;
}

/* 白天驱动：竞选（房主参选，其余弃权→房主为警长）→投票放逐 voteFor 指定玩家 */
async function driveDay(room, host, ids, voteFor) {
  let v = await st(room, host);
  while (['morning', 'lastword', 'sheriff_campaign', 'sheriff_vote', 'discuss', 'vote', 'pk_speech', 'pk_vote', 'hunter_shot'].includes(v.phase)) {
    const ph = v.phase;
    if (ph === 'sheriff_campaign') {
      for (const id of ids) { const sv = await st(room, id); if (sv.campaign && !sv.campaign.myDecided) await act(room, id, 'campaign', { run: id === host }); }
      v = await st(room, host); continue;
    }
    if (ph === 'sheriff_vote' || ph === 'vote' || ph === 'pk_vote') {
      for (const id of ids) {
        const sv = await st(room, id);
        if (!sv.my.alive) continue; // 引擎规则：已出局玩家不得投票（驱动只代存活玩家操作）
        const myVoted = (sv.vote && sv.vote.myVoted) || (sv.sheriffVote && sv.sheriffVote.myVoted);
        if (!myVoted) {
          if (ph === 'sheriff_vote') await act(room, id, 'vote', { target: host }); // 全员投房主 → 房主当选警长
          else if (ph === 'pk_vote') await act(room, id, 'vote', { target: ((sv.vote || {}).pkTied || []).map(t => t.id)[0] || null });
          else await act(room, id, 'vote', { target: voteFor(id) || null });
        }
      }
      v = await st(room, host); continue;
    }
    if (ph === 'lastword') {
      for (const id of ids) { const sv = await st(room, id); if (((sv.lastword || {}).entitled || []).some(e => e.id === id && !e.posted)) await act(room, id, 'skip', {}); }
      v = await st(room, host); continue;
    }
    if (ph === 'hunter_shot') { const sv = await st(room, host); if (sv.hunterShot && sv.hunterShot.shooter === host) await act(room, host, 'hunter_shoot', { target: null }); v = await st(room, host); continue; }
    await api('/api/advance', { room, me: host });
    await sleep(150);
    v = await st(room, host);
  }
  return v;
}

async function testExileHandover() {
  console.log('\n== 警长被放逐 → 次日早晨可移交警徽 ==');
  const { room, host, ids, roles } = await setup();
  const vills = ids.filter(x => roles[x] === 'villager'); // 2 个平民
  let v = await driveNight(room, ids, roles, { kill: vills[0] }); // 首夜刀平民1
  assert(v.phase === 'morning', '第一晚结束进入天亮');
  v = await driveDay(room, host, ids, () => host); // 白天1：房主当选警长 → 全员投房主 → 警长被放逐
  assert(v.phase === 'night', '白天1结束（警长被放逐）进入第二晚');
  v = await driveNight(room, ids, roles, { kill: vills[1], save: true }); // 第二晚：刀平民2 + 女巫解药 → 平安夜
  assert(v.phase === 'morning', '第二晚结束进入天亮');
  v = await driveDay(room, host, ids, () => null);
  assert(v.phase === 'handover', '被放逐的警长次日早晨可移交（实际 phase=' + v.phase + '）');
  if (v.phase === 'handover') {
    const alive = v.players.filter(p => p.alive && p.id !== host).map(p => p.id);
    await act(room, host, 'handover', { target: alive[0] });
    v = await st(room, host);
    assert(v.sheriff === alive[0], '警徽已移交给存活玩家（sheriff=' + (v.sheriff || 'null') + '）');
  }
}

async function testPoisonNoHandover() {
  console.log('\n== 警长被毒杀 → 不可移交警徽 ==');
  const { room, host, ids, roles } = await setup();
  const vills = ids.filter(x => roles[x] === 'villager');
  let v = await driveNight(room, ids, roles, { kill: vills[0] }); // 首夜刀平民1
  assert(v.phase === 'morning', '第一晚结束进入天亮');
  v = await driveDay(room, host, ids, () => vills[1]); // 白天1：房主当选警长 → 放逐平民2
  assert(v.phase === 'night', '白天1结束进入第二晚');
  v = await driveNight(room, ids, roles, { kill: null, poison: host, save: false }); // 第二晚：空刀 + 女巫毒警长（每晚仅一瓶药）
  assert(v.phase === 'morning', '第二晚结束进入天亮');
  v = await driveDay(room, host, ids, () => null);
  assert(v.phase !== 'handover', '被毒杀的警长不进入移交（实际 phase=' + v.phase + '）');
}

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), PHASE_TIMEOUT: '2' } });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${BASE}/healthz`); if (r.status === 200) { ready = true; break; } } catch (e) {}
    await sleep(200);
  }
  if (!ready) { console.error('服务器未就绪'); srv.kill(); process.exit(1); }
  try {
    await testExileHandover();
    await testPoisonNoHandover();
  } catch (e) { failures++; console.error('!!异常: ' + (e && e.stack || e)); }
  srv.kill();
  await sleep(300);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\n警徽移交专项测试全部通过 ✔');
  process.exit(0);
}
main();
