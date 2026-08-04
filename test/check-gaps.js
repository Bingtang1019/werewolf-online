'use strict';
/* 覆盖缺口补全（v1.0.2）：7 个引擎规则专项
 * G1 女巫自救：被狼刀时自救 → 平安夜（场景3只测过救别人）
 * G2 摄梦人夜死带梦游者：摄梦人夜间出局 → 梦游者一并出局（deadBy=dream）
 * G3 猎人被毒杀不能开枪：毒杀 → 无 hunter_shot 阶段（只测过狼刀/放逐两条）
 * G4 守卫连守同一人被拒：连续两晚守同一人 → 拒绝（bot场景只间接碰到）
 * G5 警长竞选全员弃权 → 无人当选（lastVoteResult.result=none，sheriff=null）
 * G6 PK 再平票 → 无人出局，直接入夜（场景5只测了PK一轮出结果）
 * G7 房主离开 → 房主转移给真人（跳过人机）；无真人 → 解散（只测过空房解散）
 * 运行：node test/check-gaps.js
 */
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8381;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };
const eq = (a, b, m) => { if (a === b) console.log(' ✓ ' + m); else { failures++; console.error(` ✗ FAIL: ${m}（期望 "${b}"，实际 "${a}"）`); } };
async function api(p, body) { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return r.json(); }
async function act(room, me, action, data) { const r = await api('/api/action', { room, me, action, data: data || {} }); if (r.error) throw new Error(action + '失败: ' + r.error); return r.view; }
async function st(room, me) { return (await fetch(`${BASE}/api/state?room=${room}&me=${me}`)).json(); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function advance(room, me) { await api('/api/advance', { room, me }); }

/* 开局：cap 人，counts 全职业显式指定；可选 preSettings（开局前设置，如关闭警长/平票规则） */
async function setup(cap, counts, hostRole, preSettings) {
  const r = await api('/api/create', { name: '房主' });
  const room = r.roomId, host = r.playerId;
  const ids = [host];
  for (let i = 1; i < cap; i++) { const j = await api('/api/join', { roomId: room, name: '玩家' + (i + 1) }); ids.push(j.playerId); }
  if (preSettings) await act(room, host, 'settings', preSettings);
  await act(room, host, 'setCounts', { counts });
  await act(room, host, 'setCap', { cap });
  await act(room, host, 'start');
  await act(room, host, 'hostPick', { role: hostRole });
  for (const id of ids) await act(room, id, 'confirm');
  const roles = {};
  for (const id of ids) { const v = await st(room, id); roles[id] = v.my.roleKey; }
  return { room, host, ids, roles };
}
/* 放逐/PK 投票驱动：只代存活玩家投票（已出局玩家被引擎拒绝，不能代投） */
async function voteAll(room, ids, map) {
  for (const id of ids) {
    const sv = await st(room, id);
    if (!sv.my.alive) continue;
    if (sv.vote && !sv.vote.myVoted) await act(room, id, 'vote', { target: map[id] === undefined ? null : map[id] });
  }
}
/* 夜晚驱动：按 step 回调处理各职业；wolfKill 需两狼都确认 */
async function driveNight(room, ids, roles, steps) {
  let v = await st(room, ids[0]);
  for (let i = 0; i < 40 && v.phase === 'night'; i++) {
    v = await st(room, ids[0]);
    const step = v.night && v.night.step;
    if (!step) break;
    const fn = steps[step];
    if (fn) await fn(v);
    await sleep(80);
  }
  return v;
}

/* G1 女巫自救 */
async function gap1() {
  console.log('\n== G1 女巫被狼刀时自救 → 平安夜 ==');
  const { room, host, ids, roles } = await setup(4, { wolf: 1, seer: 0, witch: 1, hunter: 0, dreamer: 0, guard: 0, wolfBeauty: 0, cupid: 0, villager: 2 }, 'witch');
  const wolf = ids.find(id => roles[id] === 'wolf');
  const v = await driveNight(room, ids, roles, {
    wolf: async () => { await act(room, wolf, 'wolf_set', { kill: host, confirm: true }); },
    witch: async () => { await act(room, host, 'witch_act', { save: true }); }, // 自救
  });
  eq(v.phase, 'morning', '夜晚结束进入天亮');
  eq(v.morningDeaths.length, 0, '女巫自救成功（平安夜，0 死亡）');
  eq(v.players.find(p => p.id === host).alive, true, '女巫存活');
}

/* G2 摄梦人夜死带梦游者 */
async function gap2() {
  console.log('\n== G2 摄梦人夜死 → 梦游者一并出局 ==');
  const { room, host, ids, roles } = await setup(4, { wolf: 1, seer: 0, witch: 0, hunter: 0, dreamer: 1, guard: 0, wolfBeauty: 0, cupid: 0, villager: 2 }, 'dreamer', { winMode: 'city' });
  const wolf = ids.find(id => roles[id] === 'wolf');
  const villager = ids.find(id => roles[id] === 'villager');
  const v = await driveNight(room, ids, roles, {
    wolf: async () => { await act(room, wolf, 'wolf_set', { kill: host, confirm: true }); }, // 刀摄梦人
    dreamer: async () => { await act(room, host, 'dreamer_pick', { target: villager }); }, // 梦游平民
  });
  eq(v.phase, 'morning', '夜晚结束进入天亮');
  eq(v.morningDeaths.length, 2, '摄梦人+梦游者两人死亡');
  eq(v.morningDeaths.find(d => d.id === villager) && v.morningDeaths.find(d => d.id === villager).deadBy, 'dream', '梦游者 deadBy=dream');
  eq(v.morningDeaths.find(d => d.id === host) && v.morningDeaths.find(d => d.id === host).deadBy, 'wolf', '摄梦人 deadBy=wolf');
}

/* G3 猎人被毒杀不能开枪 */
async function gap3() {
  console.log('\n== G3 猎人被毒杀 → 不能开枪 ==');
  const { room, host, ids, roles } = await setup(5, { wolf: 1, seer: 0, witch: 1, hunter: 1, dreamer: 0, guard: 0, wolfBeauty: 0, cupid: 0, villager: 2 }, 'hunter');
  const wolf = ids.find(id => roles[id] === 'wolf');
  const witch = ids.find(id => roles[id] === 'witch');
  const villager = ids.find(id => roles[id] === 'villager');
  const v = await driveNight(room, ids, roles, {
    wolf: async () => { await act(room, wolf, 'wolf_set', { kill: villager, confirm: true }); },
    witch: async () => { await act(room, witch, 'witch_act', { save: false, poison: host }); }, // 毒猎人
  });
  eq(v.phase, 'morning', '夜晚结束进入天亮');
  eq(v.morningDeaths.find(d => d.id === host) && v.morningDeaths.find(d => d.id === host).deadBy, 'poison', '猎人死于毒杀');
  // 毒杀不触发猎人开枪：天亮后推进应直接进入白天流程（无 hunter_shot 阶段）
  let mv = v;
  for (let i = 0; i < 20; i++) { mv = await st(room, host); if (mv.phase !== 'morning') break; await sleep(200); }
  eq(mv.phase === 'hunter_shot', false, '毒杀不进入 hunter_shot（实际 phase=' + mv.phase + '）');
}

/* G4 守卫连守同一人被拒 */
async function gap4() {
  console.log('\n== G4 守卫连守同一人 → 拒绝 ==');
  const { room, host, ids, roles } = await setup(4, { wolf: 1, seer: 0, witch: 0, hunter: 0, dreamer: 0, guard: 1, wolfBeauty: 0, cupid: 0, villager: 2 }, 'guard', { sheriff: false });
  const wolf = ids.find(id => roles[id] === 'wolf');
  const vills = ids.filter(id => roles[id] === 'villager');
  // 夜1：守卫守 vills[0]，狼刀 vills[1]
  const v = await driveNight(room, ids, roles, {
    wolf: async () => { await act(room, wolf, 'wolf_set', { kill: vills[1], confirm: true }); },
    guard: async () => { await act(room, host, 'guard_pick', { target: vills[0] }); },
  });
  eq(v.phase, 'morning', '夜1结束进入天亮');
  // 白天：直接推进到第二晚（无警长局）
  await advance(room, host);
  let d = await st(room, host);
  for (let i = 0; i < 40 && d.phase !== 'night'; i++) {
    d = await st(room, host);
    if (['morning', 'lastword', 'discuss', 'vote'].includes(d.phase)) { await advance(room, host); await sleep(120); }
    else await sleep(120);
  }
  eq(d.phase, 'night', '进入第二晚');
  // 夜2：守卫连守同一人 → 拒绝；改守自己 → 通过，夜晚正常推进
  const r = await api('/api/action', { room, me: host, action: 'guard_pick', data: { target: vills[0] } });
  eq(r.error, '不能连续两晚守护同一名玩家', '连守同一人被拒绝');
  const v2 = await driveNight(room, ids, roles, {
    wolf: async () => { const tv = await st(room, wolf); const others = (tv.players || []).filter(p => p.alive && p.id !== wolf).map(p => p.id); await act(room, wolf, 'wolf_set', { kill: others[0], confirm: true }); },
    guard: async () => { await act(room, host, 'guard_pick', { target: host }); }, // 改守自己
  });
  eq(v2.phase === 'morning', true, '第二晚正常结束（改守他人后流程不卡）');
}

/* G5 警长竞选全员弃权 → 无人当选 */
async function gap5() {
  console.log('\n== G5 警长竞选全员弃权 → 无人当选 ==');
  const { room, host, ids, roles } = await setup(5, { wolf: 1, seer: 1, witch: 0, hunter: 0, dreamer: 0, guard: 0, wolfBeauty: 0, cupid: 0, villager: 3 }, 'seer');
  const wolf = ids.find(id => roles[id] === 'wolf');
  const vills = ids.filter(id => roles[id] === 'villager');
  const v = await driveNight(room, ids, roles, {
    wolf: async () => { await act(room, wolf, 'wolf_set', { kill: vills[0], confirm: true }); },
    seer: async () => { await act(room, host, 'seer_pick', { target: wolf }); },
  });
  eq(v.phase, 'morning', '夜1结束进入天亮');
  await advance(room, host);
  let d = await st(room, host);
  for (let i = 0; i < 40 && d.phase !== 'discuss'; i++) {
    d = await st(room, host);
    const ph = d.phase;
    if (ph === 'discuss') break; // 已进入发言阶段：停止推进（否则 fall-through 的 advance 会触发 startVote）
    if (ph === 'sheriff_campaign') { for (const id of ids) { const sv = await st(room, id); if (!sv.my.alive) continue; if (sv.campaign && !sv.campaign.myDecided) await act(room, id, 'campaign', { run: false }); } await sleep(60); continue; }
    if (ph === 'sheriff_vote') { for (const id of ids) { const sv = await st(room, id); if (!sv.my.alive) continue; if (sv.sheriffVote && !sv.sheriffVote.myVoted) await act(room, id, 'vote', { target: null }); } await sleep(60); continue; }
    if (ph === 'lastword') { for (const id of ids) { const sv = await st(room, id); if (((sv.lastword || {}).entitled || []).some(e => e.id === id && !e.posted)) await act(room, id, 'skip', {}); } await sleep(60); continue; }
    await advance(room, host); await sleep(120);
  }
  d = await st(room, host);
  eq(d.phase, 'discuss', '进入白天发言');
  eq(d.sheriff, null, '无人当选警长（sheriff=null）');
  eq(d.lastVoteResult && d.lastVoteResult.result, 'none', '竞选结果为 none（无人当选）');
}

/* G6 PK 再平票 → 无人出局，直接入夜 */
async function gap6() {
  console.log('\n== G6 PK 再平票 → 无人出局，直接入夜 ==');
  const { room, host, ids, roles } = await setup(6, { wolf: 2, seer: 1, witch: 1, hunter: 0, dreamer: 0, guard: 0, wolfBeauty: 0, cupid: 0, villager: 2 }, 'seer', { sheriff: false, tieRule: 'pk' });
  const wolves = ids.filter(id => roles[id] === 'wolf');
  const w1 = wolves[0], w2 = wolves[1];
  const witch = ids.find(id => roles[id] === 'witch');
  const villager = ids.find(id => roles[id] === 'villager');
  // 夜1：两狼确认刀平民，女巫救 → 平安夜；预言家查验
  for (const w of wolves) { await act(room, w, 'wolf_set', { kill: villager }); await act(room, w, 'wolf_set', { confirm: true }); }
  await act(room, host, 'seer_pick', { target: w1 });
  await act(room, witch, 'witch_act', { save: true });
  let v = await st(room, host);
  for (let i = 0; i < 20 && v.phase !== 'morning'; i++) { await sleep(150); v = await st(room, host); }
  eq(v.phase, 'morning', '夜1结束（平安夜）');
  await advance(room, host);
  v = await st(room, host);
  eq(v.phase, 'discuss', '无警长局直接进入白天发言');
  // 放逐投票 3:3 平票 → PK
  await act(room, host, 'startVote');
  const nonW = ids.filter(id => !wolves.includes(id)); // 4 人
  const tieMap = {};
  nonW.forEach((id, i) => { tieMap[id] = i === nonW.length - 1 ? w2 : w1; }); // 3:1
  wolves.forEach(w => { tieMap[w] = w2; }); // w2 = 1+2 = 3，w1 = 3 → 平票
  await voteAll(room, ids, tieMap);
  v = await st(room, host);
  eq(v.phase, 'pk_speech', '平票进入 PK 发言');
  eq(v.lastVoteResult.result, 'tie', '首轮投票平票');
  await act(room, host, 'startVote');
  v = await st(room, host);
  eq(v.phase, 'pk_vote', '进入 PK 投票');
  // PK 再平票（同 3:3）→ 无人出局，直接入夜
  await voteAll(room, ids, tieMap);
  v = await st(room, host);
  eq(v.phase, 'night', 'PK 再平票 → 无人出局，直接入夜');
  eq(v.lastVoteResult.result, 'tie', 'PK 结果仍为平票');
  eq((v.dayDeaths || []).length, 0, '无人出局（dayDeaths 为空）');
}

/* G7 房主离开 → 房主转移给真人（跳过人机）；无真人 → 解散 */
async function gap7() {
  console.log('\n== G7 房主离开 → 房主转移给真人（跳过人机） ==');
  const r = await api('/api/create', { name: '房主' });
  const room = r.roomId, host = r.playerId;
  const j1 = await api('/api/join', { roomId: room, name: '真人1' });
  const j2 = await api('/api/join', { roomId: room, name: '真人2' });
  await act(room, host, 'add_bot', {});
  await api('/api/leave', { room, me: host });
  const v = await st(room, j1.playerId);
  eq(v.host, j1.playerId, '房主转移给最早加入的真人（实际=' + (v.host || 'null') + '）');
  // 人机不接手：确认新房主不是人机
  const botP = (v.players || []).find(p => p.isBot);
  eq(v.host !== (botP && botP.id), true, '新房主不是人机');
  // 真人全部离开 → 房间解散
  await api('/api/leave', { room, me: j1.playerId });
  const v2 = await st(room, j2.playerId);
  eq(v2.host, j2.playerId, '房主再次转移（剩余真人接手）');
  await api('/api/leave', { room, me: j2.playerId });
  await sleep(200);
  const gone = await st(room, j1.playerId);
  eq(gone.error, 'room-not-found', '无真人时房间解散');
}

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), PHASE_TIMEOUT: '3', NIGHT_TIMEOUT: '30' } });
  let ready = false;
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`${BASE}/healthz`); if (r.status === 200) { ready = true; break; } } catch (e) {} await sleep(200); }
  if (!ready) { console.error('服务器未就绪'); srv.kill(); process.exit(1); }
  const tests = [gap1, gap2, gap3, gap4, gap5, gap6, gap7];
  for (const t of tests) {
    try { await t(); }
    catch (e) { failures++; console.error('!!异常: ' + ((e && e.stack) || e)); }
  }
  srv.kill();
  await sleep(300);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\n覆盖缺口专项（G1~G7）全部通过 ✔');
  process.exit(0);
}
main();
