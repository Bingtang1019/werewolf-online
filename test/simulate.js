'use strict';
/* =========================================================================
 * 狼人杀引擎自动化测试（无 UI，直接走 HTTP API）
 * 运行：node test/simulate.js
 * 会临时启动 server.js（端口 8123），跑完自动关闭。
 * ========================================================================= */
const { spawn } = require('child_process');
const path = require('path');

const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;
const WOLF_KEYS = ['wolf', 'wolfBeauty'];

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { failures++; console.error('  ✗ FAIL: ' + msg); }
}
function eq(a, b, msg) { assert(a === b, `${msg} (期望 ${JSON.stringify(b)}, 实际 ${JSON.stringify(a)})`); }

async function api(p, body) {
  if (process.env.DEBUG_CLIENT) console.log('[client] POST ' + p + ' body=' + JSON.stringify(body));
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
async function advance(room, me) {
  const r = await api('/api/advance', { room, me });
  if (r.error) throw new Error(`advance 失败: ${r.error}`);
  return r.view;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function rolesOf(room, ids) {
  // 读取每个玩家的身份（身份展示阶段后）
  const map = {};
  for (const id of ids) { const v = await state(room, id); map[id] = { role: v.my.role, camp: v.my.camp, alive: v.my.alive }; }
  return map;
}

/* 身份展示阶段：房主选身份 →（若开启盗贼玩法）盗贼从两张身份牌中选择 → 全员确认 */
async function playReveal(room, A, ids, hostRole) {
  await act(room, A, 'hostPick', { role: hostRole || 'random' });
  let v = await state(room, A);
  let thief = null, thiefCards = null;
  for (const id of ids) {
    const sv = await state(room, id);
    if (sv.reveal && sv.reveal.isThief) { thief = id; v = sv; break; }
  }
  if (thief) {
    thiefCards = v.reveal.thiefCards.map(x => x.key);
    if (thiefCards.some(k => WOLF_KEYS.includes(k))) {
      const wolfCount = thiefCards.filter(k => WOLF_KEYS.includes(k)).length;
      if (wolfCount === 1) {
        const badIdx = WOLF_KEYS.includes(thiefCards[0]) ? 1 : 0;
        const bad = await api('/api/action', { room, me: thief, action: 'thief_pick', data: { idx: badIdx } });
        assert(bad.error, '盗贼不选狼被拒绝');
      }
      await act(room, thief, 'thief_pick', { idx: thiefCards.findIndex(k => WOLF_KEYS.includes(k)) });
    } else {
      await act(room, thief, 'thief_pick', { idx: 0 });
    }
  }
  // 全员确认（可提前开始；盗贼局强制等待 5 秒展示盗贼结果后自动入夜）
  for (const id of ids) {
    const sv = await state(room, id);
    const meP = (sv.players || []).find(p => p.isMe);
    if (sv.phase === 'reveal' && meP && !meP.confirmed) await act(room, id, 'confirm');
  }
  // 盗贼局：等待 5 秒展示“盗贼窃走”结果后再入夜；非盗贼局：全员确认后立即入夜
  const nightWait = thief ? 9000 : 3000;
  const t0 = Date.now();
  while (Date.now() - t0 < nightWait) {
    v = await state(room, A);
    if (v.phase === 'night') break;
    await sleep(300);
  }
  eq(v.phase, 'night', '进入第一晚');
  return { thief, thiefCards, roles: await rolesOf(room, ids) };
}

async function playSheriffElection(room, players, runIds, voteMap) {
  const st = await state(room, players[0]);
  const alive = st.players.filter(p => p.alive).map(p => p.id);
  // 警长竞选：runIds 竞选，其余弃权
  for (const id of alive) {
    const v = await state(room, id);
    if (v.phase === 'discuss') return;
    if (v.phase !== 'sheriff_campaign') throw new Error(`阶段不是竞选: ${v.phase}`);
    await act(room, id, 'campaign', { run: runIds.includes(id) });
  }
  // 投票
  for (const id of alive) {
    const v = await state(room, id);
    if (v.phase === 'discuss') return;
    if (v.phase !== 'sheriff_vote') throw new Error(`阶段不是警长投票: ${v.phase}`);
    await act(room, id, 'vote', { target: voteMap[id] || null });
  }
}

async function playExileVote(room, players, voteMap) {
  const st = await state(room, players[0]);
  const alive = st.players.filter(p => p.alive).map(p => p.id);
  for (const id of alive) {
    const v = await state(room, id);
    if (v.phase === 'lastword' || v.phase === 'night' || v.phase === 'ended' || v.phase === 'discuss') return;
    if (v.phase !== 'vote' && v.phase !== 'pk_vote') throw new Error(`阶段不是投票: ${v.phase}`);
    await act(room, id, 'vote', { target: voteMap[id] || null });
  }
}

/* ============================ 场景1：基础 6 人局 ============================ */
async function scenario1() {
  console.log('\n===== 场景1：6人局（狼2/预1/巫1/民2，警长开，屠边，平票PK）=====');
  const A = await api('/api/create', { name: 'A' });
  const room = A.roomId;
  eq(A.playerId ? true : false, true, '创建房间成功');
  const ids = [A.playerId];
  for (const n of ['B', 'C', 'D', 'E', 'F']) {
    const r = await api('/api/join', { roomId: room, name: n });
    if (r.error) throw new Error('join 失败: ' + r.error);
    ids.push(r.playerId);
  }
  const [a, b, c, d, e, f] = ids;
  // 满员后才可开局
  let v = await act(room, a, 'start');
  eq(v.phase, 'reveal', '进入身份展示阶段');
  // 房主选预言家
  v = await act(room, a, 'hostPick', { role: 'seer' });
  eq(v.my.role, '预言家', '房主选择了预言家');
  // 其他人确认
  for (const id of [b, c, d, e, f]) { await act(room, id, 'confirm'); }
  v = await state(room, a);
  eq(v.phase, 'night', '所有人确认后进入第一晚');
  eq(v.nightNum, 1, '夜晚编号=1');

  const roles = await rolesOf(room, ids);
  const wolves = ids.filter(id => roles[id].role === '狼人');
  const witch = ids.find(id => roles[id].role === '女巫');
  const villagers = ids.filter(id => roles[id].role === '平民');
  eq(wolves.length, 2, '本局有 2 只狼');
  eq(roles[a].role, '预言家', 'A 是预言家');
  assert(witch && villagers.length === 2, '女巫与 2 平民存在');

  // 夜晚：狼人杀平民C，女巫救 → 平安夜
  const killTarget = villagers[0];
  for (const w of wolves) {
    const vw = await state(room, w);
    eq(vw.night.step, 'wolf', `狼 ${roles[w]} 在狼人阶段`);
    eq(vw.night.wolf.teammates.length, 2, '狼队友可见');
    await act(room, w, 'wolf_set', { kill: killTarget });
    await act(room, w, 'wolf_set', { confirm: true });
  }
  v = await state(room, a);
  eq(v.nightStep, 'seer', '狼人行动后轮到预言家');
  const seerCheck = wolves[0];
  await act(room, a, 'seer_pick', { target: seerCheck });
  v = await state(room, witch);
  eq(v.nightStep, 'witch', '轮到女巫');
  await act(room, witch, 'witch_act', { save: true });
  v = await state(room, a);
  eq(v.phase, 'morning', '女巫用解药后进入早晨');
  eq(v.morningDeaths.length, 0, '平安夜（女巫救活）');

  // 早晨 → 警长竞选（A、B 竞选，A 当选）
  await advance(room, a);
  await playSheriffElection(room, ids, [a, b], { [a]: a, [b]: a, [c]: a, [d]: a, [e]: b, [f]: b });
  v = await state(room, a);
  eq(v.phase, 'discuss', '进入白天发言');
  eq(v.sheriff, a, 'A 当选警长');

  // 放逐投票：A(1.5)+2好人 → 狼1 (3.5)；1好人+狼1+狼2 → 狼2 (3) → 狼1 被放逐（验证 1.5 票）
  const w1 = wolves[0], w2 = wolves[1];
  await act(room, a, 'startVote');
  const nonWolves = ids.filter(id => !wolves.includes(id)); // a(预) + 女巫 + 2民
  const voteMap = {};
  nonWolves.forEach((id, i) => { voteMap[id] = i === nonWolves.length - 1 ? w2 : w1; }); // 前3票投狼1，最后1票投狼2
  wolves.forEach(w => { voteMap[w] = w2; });
  await playExileVote(room, ids, voteMap);
  v = await state(room, a);
  eq(v.phase, 'lastword', '放逐后进入遗言阶段');
  eq(v.lastVoteResult.exiled, w1, '得票最多者（狼1）被放逐');
  const totalW1 = v.lastVoteResult.totals[w1];
  const totalW2 = v.lastVoteResult.totals[w2];
  assert(Math.abs(totalW1 - 3.5) < 1e-9, `警长 1.5 票生效：狼1 得 ${totalW1} 票（期望 3.5）`);
  assert(Math.abs(totalW2 - 3) < 1e-9, `狼2 得 ${totalW2} 票（期望 3）`);
  // 遗言
  v = await state(room, w1);
  await act(room, w1, 'post', { text: '我是狼，冲了' });
  v = await state(room, a);
  eq(v.phase, 'night', '遗言后进入第二晚');

  // 第二晚：狼2 杀 A(警长/预言家)；预言家(已死前)仍要操作？——预言家 A 活着时先查验；女巫跳过
  v = await state(room, w2);
  eq(v.nightStep, 'wolf', '第二晚狼人行动');
  await act(room, w2, 'wolf_set', { kill: a, confirm: true });
  v = await state(room, a);
  eq(v.nightStep, 'seer', '预言家查验');
  const aliveNow = v.players.filter(p => p.alive && p.id !== a);
  await act(room, a, 'seer_pick', { target: aliveNow[0].id });
  v = await state(room, witch);
  eq(v.nightStep, 'witch', '女巫行动（跳过）');
  await act(room, witch, 'witch_act', { save: false });
  v = await state(room, a);
  eq(v.phase, 'morning', '第二晚结束进入早晨');
  eq(v.morningDeaths.length, 1, 'A 被狼刀');
  const deadA = v.morningDeaths[0];
  eq(deadA.id, a, '死亡者为 A');
  eq(deadA.deadBy, 'wolf', 'A 死于狼刀');
  eq(deadA.role, '预言家', 'A 翻牌为预言家');

  // 警徽移交：A(被狼刀) → 移交给一名存活玩家
  await advance(room, a);
  v = await state(room, a);
  eq(v.phase, 'handover', '进入警徽移交阶段');
  const aliveOther = v.players.find(p => p.alive && p.id !== a);
  await act(room, a, 'handover', { target: aliveOther.id });
  v = await state(room, a);
  eq(v.sheriff, aliveOther.id, '警徽移交给存活玩家');
  eq(v.phase, 'discuss', '进入白天发言');

  // 放逐最后一只狼 → 好人获胜
  await act(room, a, 'startVote');
  // 引擎规则（rules.md 三.10）：已出局玩家不得投票——在活跃投票阶段验证（旧断言在 ended 阶段是假通过）
  const deadVote = await api('/api/action', { room, me: a, action: 'vote', data: { target: w2 } });
  eq(deadVote.error, '你已出局，无法投票', '已出局玩家在投票阶段投票被拒绝');
  const aliveVoters = ids.filter(id => id !== w1 && id !== a);
  const voteMap2 = {};
  aliveVoters.forEach(id => { voteMap2[id] = id === w2 ? aliveVoters.find(x => x !== w2) : w2; });
  await playExileVote(room, aliveVoters, voteMap2);
  v = await state(room, a);
  if (v.phase === 'lastword') { const lw = await state(room, w2); await act(room, w2, 'post', { text: 'gg' }); v = await state(room, a); }
  eq(v.phase, 'ended', '游戏结束');
  eq(v.winner, 'good', '好人阵营获胜');
  eq(v.endInfo.text, '好人阵营获胜', '胜利信息正确');
  // 死亡玩家不可投票但可发言（投票拒绝已在上述活跃投票阶段验证）
  await chat(room, a, 'all', '我死了但我还能说话');
  const vAfter = await state(room, a);
  assert(vAfter.chat.some(m => m.from === a && m.text === '我死了但我还能说话'), '死亡玩家可以发言');
  console.log('  场景1 完成');
}

/* ============================ 场景2：12人全职业局 ============================ */
async function scenario2() {
  console.log('\n===== 场景2：12人全职业局+盗贼玩法（狼2/狼美1/民3/预1/巫1/猎1/守1/摄1/丘1，屠城，警长开）=====');
  const A = await api('/api/create', { name: 'A' });
  const room = A.roomId;
  const ids = [A.playerId];
  // 盗贼玩法开启时身份牌总数 = 玩家人数 + 1（13 张）
  const counts = { wolf: 2, wolfBeauty: 1, villager: 4, seer: 1, witch: 1, hunter: 1, guard: 1, dreamer: 1, cupid: 1 };
  await act(room, A.playerId, 'setCap', { cap: 12 });
  await act(room, A.playerId, 'setCounts', { counts });
  await act(room, A.playerId, 'settings', { winMode: 'city', thief: true });
  for (let i = 0; i < 11; i++) {
    const r = await api('/api/join', { roomId: room, name: String.fromCharCode(66 + i) });
    if (r.error) throw new Error('join 失败: ' + r.error);
    ids.push(r.playerId);
  }
  eq(ids.length, 12, '12 人满员');
  let v = await act(room, A.playerId, 'start');
  eq(v.phase, 'reveal', '进入身份展示');
  // 房主选预言家 → 盗贼选卡（身份展示阶段完成，无需夜晚睁眼）→ 全员确认
  const { thief, thiefCards, roles } = await playReveal(room, A.playerId, ids, 'seer');
  assert(!!thief && thiefCards && thiefCards.length === 2, '盗贼被随机指定并看到两张身份牌');
  eq(roles[A.playerId].role, '预言家', 'A 是预言家');
  v = await state(room, A.playerId);
  eq(v.nightNum, 1, '进入第一晚');

  const wolves = ids.filter(id => roles[id].role === '狼人');
  const beauty = ids.find(id => roles[id].role === '狼美人');
  const cupid = ids.find(id => roles[id].role === '丘比特');
  const hunter = ids.find(id => roles[id].role === '猎人');
  const guard = ids.find(id => roles[id].role === '守卫');
  const dreamer = ids.find(id => roles[id].role === '摄梦人');
  const witch = ids.find(id => roles[id].role === '女巫');
  const villagers = ids.filter(id => roles[id].role === '平民');
  // 盗贼抽走的作废牌可能使任意职业不在场（守卫/摄梦人/女巫/猎人等均可能被作废），
  // 只断言核心职业；夜晚通用驱动可容忍缺失职业（对应步骤自动跳过）
  assert(wolves.length >= 1, '狼人在场');
  assert(villagers.length >= 1, '平民在场');
  const w1 = wolves[0], w2 = wolves[1] || wolves[0]; // 两张狼牌可能都被抽给盗贼，场上仅 1 只狼
  const v1 = villagers[0], v2 = villagers[1] || villagers[0];
  // 刀人目标：猎人（若被作废则刀另一名平民，避开情侣 v1，避免影响后续魅惑/殉情断言）
  const killT = hunter || v2 || v1;

  // ===== 夜晚通用驱动 =====
  // 盗贼可能抽到与配置重复的职业牌（两个守卫/摄梦人/预言家/女巫/丘比特），
  // 此时该步骤的所有同职业玩家都需要行动；此循环逐人推进所有步骤。
  // 丘比特目标统一指定 w1+v1；狼人统一刀猎人（若被作废则刀平民）、魅惑 v1；女巫不救（触发猎人开枪）。
  for (let i = 0; i < 40; i++) {
    v = await state(room, A.playerId);
    if (v.phase !== 'night' || !v.nightStep || v.nightStep === 'hunter') break;
    const step = v.nightStep;
    const actor = (v.night.actors || []).find(a => !a.acted);
    if (!actor) break;
    const av = await state(room, actor.id);
    if (step === 'cupid') {
      await act(room, actor.id, 'cupid_pick', { ids: [w1, v1] });
    } else if (step === 'lovers') {
      await act(room, actor.id, 'lovers_ok');
    } else if (step === 'guard') {
      const last = av.night.guard && av.night.guard.last;
      const target = av.players.find(p => p.alive && p.id !== last && p.id !== actor.id && p.id !== killT);
      await act(room, actor.id, 'guard_pick', { target: target ? target.id : av.players.find(p => p.alive && p.id !== actor.id).id });
    } else if (step === 'dreamer') {
      const target = av.players.find(p => p.alive && p.id !== actor.id && p.id !== killT);
      await act(room, actor.id, 'dreamer_pick', { target: target ? target.id : av.players.find(p => p.alive && p.id !== actor.id).id });
    } else if (step === 'wolf') {
      const wData = { kill: killT };
      if (beauty) wData.charm = v1; // 狼美人若被作废则本局无魅惑
      await act(room, actor.id, 'wolf_set', wData);
      await act(room, actor.id, 'wolf_set', { confirm: true });
    } else if (step === 'seer') {
      const target = av.players.find(p => p.alive && p.id !== actor.id);
      await act(room, actor.id, 'seer_pick', { target: target ? target.id : w1 });
    } else if (step === 'witch') {
      await act(room, actor.id, 'witch_act', { save: false });
    } else break;
  }
  // 猎人被狼刀（若猎人在场）→ 开枪打 w2
  v = await state(room, A.playerId);
  if (hunter && v.nightStep === 'hunter') {
    await act(room, hunter, 'hunter_shoot', { target: w2 });
    v = await state(room, A.playerId);
  }
  if (hunter) eq(v.phase, 'morning', '进入早晨');
  const byIdMap = {};
  (v.morningDeaths || []).forEach(x => byIdMap[x.id] = x);
  if (hunter) {
    eq(byIdMap[hunter] && byIdMap[hunter].deadBy, 'wolf', '猎人死于狼刀');
    eq(byIdMap[w2] && byIdMap[w2].deadBy, 'shoot', 'w2 被猎人枪杀');
    eq(byIdMap[hunter] && byIdMap[hunter].role, '猎人', '猎人翻牌');
  } else {
    eq(byIdMap[killT] && byIdMap[killT].deadBy, 'wolf', '刀人目标死于狼刀');
  }

  // 早晨（夜晚1死亡有遗言）
  await advance(room, A.playerId);
  for (const id of (v.morningDeaths || [])) {
    const vl = await state(room, id.id);
    if (vl.phase === 'lastword') await act(room, id.id, 'post', { text: '遗言' });
  }
  v = await state(room, A.playerId);
  if (v.phase === 'sheriff_campaign') {
    // A 竞选，A 当选
    await playSheriffElection(room, ids, [A.playerId], ids.reduce((m, id) => { m[id] = A.playerId; return m; }, {}));
    v = await state(room, A.playerId);
  }
  eq(v.phase, 'discuss', '白天发言');
  if (v.sheriff) eq(v.sheriff, A.playerId, 'A 当选警长');

  // 放逐狼美人（若被作废则放逐 w1）→ 触发魅惑/殉情（若盗贼选了狼则游戏继续）
  await act(room, A.playerId, 'startVote');
  const exileTarget = beauty || w1;
  const voteMap = ids.reduce((m, id) => { m[id] = exileTarget; return m; }, {});
  await playExileVote(room, ids, voteMap);
  v = await state(room, A.playerId);
  if (v.phase === 'lastword') { await act(room, exileTarget, 'post', { text: '遗言' }); v = await state(room, A.playerId); }
  const dMap = {};
  (v.dayDeaths || []).forEach(x => dMap[x.id] = x);
  const allDeaths = {};
  (v.morningDeaths || []).forEach(x => allDeaths[x.id] = x);
  (v.dayDeaths || []).forEach(x => allDeaths[x.id] = x);
  eq(dMap[exileTarget] && dMap[exileTarget].deadBy, 'exile', '放逐目标出局');
  // 狼美人被放逐触发魅惑（rules.md 三.6）：v1 若死于白天必为魅惑带走——直接查 dayDeaths。
  // 修复前守卫写成 !allDeaths[v1]，但 allDeaths 已并入 dayDeaths（魅惑正是白天死因）→ 守卫恒假、断言从未执行（死代码）
  if (beauty && dMap[v1]) eq(dMap[v1] && dMap[v1].deadBy, 'charm', 'v1 被魅惑带走');
  // 仅当丘比特在场（存在情侣）且场上还有第二只狼（w2≠w1，猎人未直接带走情侣）时才存在殉情
  if (cupid && w2 !== w1) eq((allDeaths[w1] && allDeaths[w1].deadBy === 'lover') || (allDeaths[v1] && allDeaths[v1].deadBy === 'lover'), true, '情侣殉情');
  if (allDeaths[v1]) eq(allDeaths[v1].role, '平民', 'v1 翻牌为平民');
  if (v.sheriff) eq(v.sheriff, A.playerId, 'A 仍为警长');
  // 若盗贼被迫选狼，则狼队尚有盗贼，游戏继续到好人胜
  if (v.phase === 'night') {
    console.log('   [info] 盗贼选了狼，游戏继续');
    // 夜晚通用驱动：丘比特放弃重选；守卫/摄梦人/狼/预言家/女巫行动；女巫毒盗贼
    for (let i = 0; i < 20; i++) {
      const sv = await state(room, A.playerId);
      if (sv.phase !== 'night' || !sv.nightStep) break;
      const step = sv.nightStep;
      if (step === 'hunter') { const sh = sv.night.hunter && sv.night.hunter.shooter; if (sh) await act(room, sh, 'hunter_shoot', { target: null }); continue; }
      const actor = (sv.night.actors || []).find(a => !a.acted);
      if (!actor) break;
      const av = await state(room, actor.id);
      if (step === 'cupid') { await act(room, actor.id, 'cupid_pick', { ids: null }); }
      else if (step === 'guard') { const last = av.night.guard && av.night.guard.last; const t = av.players.find(p => p.alive && p.id !== last && p.id !== actor.id); await act(room, actor.id, 'guard_pick', { target: t ? t.id : av.players.find(p => p.alive && p.id !== actor.id).id }); }
      else if (step === 'dreamer') { const t = av.players.find(p => p.alive && p.id !== actor.id); await act(room, actor.id, 'dreamer_pick', { target: t.id }); }
      else if (step === 'wolf') { await act(room, actor.id, 'wolf_set', { kill: A.playerId }); await act(room, actor.id, 'wolf_set', { confirm: true }); }
      else if (step === 'seer') { const t = av.players.find(p => p.alive && p.id !== actor.id); await act(room, actor.id, 'seer_pick', { target: t ? t.id : null }); }
      else if (step === 'witch') {
        // 毒一个存活的狼（盗贼若已殉情则毒其他狼；无狼可毒则跳过）
        let wolfT = null;
        for (const id of ids) { const wv2 = await state(room, id); if (wv2.night && wv2.night.wolf && wv2.my.alive) { wolfT = id; break; } }
        if (wolfT) await act(room, actor.id, 'witch_act', { poison: wolfT });
        else await act(room, actor.id, 'witch_act', { save: false });
      }
      else break;
    }
    v = await state(room, A.playerId);
    if (v.phase === 'morning') {
      // 女巫被作废 / 狼刀未命中 → 白天放逐盗贼（狼）兜底
      await advance(room, A.playerId);
      v = await state(room, A.playerId);
      if (v.phase === 'lastword') { for (const id of v.lastword.entitled) { const dv = await state(room, id.id); if (dv.phase === 'lastword') await act(room, id.id, 'post', { text: '遗言' }); } v = await state(room, A.playerId); }
      if (v.phase === 'handover') { await act(room, A.playerId, 'handover', { target: null }); v = await state(room, A.playerId); }
      if (v.phase === 'discuss') {
        // 白天放逐一个存活的狼兜底
        await act(room, A.playerId, 'startVote');
        v = await state(room, A.playerId);
        const alive = v.players.filter(p => p.alive);
        const wolfIds = [];
        for (const id of ids) { const wv2 = await state(room, id); if (wv2.night && wv2.night.wolf && wv2.my.alive) wolfIds.push(id); }
        const target = alive.find(x => wolfIds.includes(x.id)) || alive[0];
        for (const q of alive) { const qv = await state(room, q.id); if (qv.phase === 'vote') await act(room, q.id, 'vote', { target: target ? target.id : null }); }
        v = await state(room, A.playerId);
        if (v.phase === 'lastword') { const lw = await state(room, target.id); if (lw.phase === 'lastword') await act(room, target.id, 'post', { text: '遗言' }); v = await state(room, A.playerId); }
      }
    }
    eq(v.phase, 'ended', '游戏结束（好人胜）');
    eq(v.winner, 'good', '好人阵营获胜');
  } else {
    eq(v.phase, 'ended', '游戏结束');
    eq(v.winner, 'good', '好人阵营获胜');
  }
  console.log('  场景2 完成');
}

/* ============================ 场景3：守卫+解药=同守同救、摄梦人免疫 ============================ */
async function scenario3() {
  console.log('\n===== 场景3：8人局（狼2/预1/巫1/守1/摄1/民2）=====');
  const A = await api('/api/create', { name: 'A' });
  const room = A.roomId;
  const ids = [A.playerId];
  const counts = { wolf: 2, villager: 2, seer: 1, witch: 1, guard: 1, dreamer: 1 };
  await act(room, A.playerId, 'setCap', { cap: 8 });
  await act(room, A.playerId, 'setCounts', { counts });
  for (let i = 0; i < 7; i++) {
    const r = await api('/api/join', { roomId: room, name: String.fromCharCode(66 + i) });
    ids.push(r.playerId);
  }
  let v = await act(room, A.playerId, 'start');
  v = await act(room, A.playerId, 'hostPick', { role: 'seer' });
  for (const id of ids.slice(1)) await act(room, id, 'confirm');
  v = await state(room, A.playerId);
  eq(v.phase, 'night', '进入第一晚');
  const roles = await rolesOf(room, ids);
  const wolves = ids.filter(id => roles[id].role === '狼人');
  const w1 = wolves[0], w2 = wolves[1];
  const guard = ids.find(id => roles[id].role === '守卫');
  const dreamer = ids.find(id => roles[id].role === '摄梦人');
  const witch = ids.find(id => roles[id].role === '女巫');
  const villagers = ids.filter(id => roles[id].role === '平民');
  const v1 = villagers[0];
  assert(villagers.length === 2, '2 平民存在');

  // 守卫守平民，狼人杀平民，女巫救 → 同守同救死亡
  await act(room, guard, 'guard_pick', { target: v1 });
  await act(room, dreamer, 'dreamer_pick', { target: w2 });
  for (const w of wolves) { await act(room, w, 'wolf_set', { kill: v1 }); await act(room, w, 'wolf_set', { confirm: true }); }
  await act(room, A.playerId, 'seer_pick', { target: w1 });
  await act(room, witch, 'witch_act', { save: true });
  v = await state(room, A.playerId);
  eq(v.phase, 'morning', '进入早晨');
  eq(v.morningDeaths.length, 1, '同守同救死亡 1 人');
  eq(v.morningDeaths[0].id, v1, '死者是平民');
  eq(v.morningDeaths[0].deadBy, 'wolf', '死亡原因标记为狼刀（同守同救）');
  assert((v.morningDeaths[0].deadNote || '').includes('同守同救'), '标注同守同救');

  // 白天：竞选（A 当选）→ 放逐 w1（先处理夜1死亡的遗言）
  await advance(room, A.playerId);
  v = await state(room, A.playerId);
  if (v.phase === 'lastword') { await act(room, v1, 'post', { text: '遗言' }); }
  await playSheriffElection(room, ids, [A.playerId], ids.reduce((m, id) => { m[id] = A.playerId; return m; }, {}));
  await act(room, A.playerId, 'startVote');
  const voteMap = ids.reduce((m, id) => { m[id] = w1; return m; }, {});
  await playExileVote(room, ids, voteMap);
  v = await state(room, A.playerId);
  if (v.phase === 'lastword') { await act(room, w1, 'post', { text: '遗言' }); }
  v = await state(room, A.playerId);
  eq(v.phase, 'night', '进入第二晚');

  // 第二晚：守卫守女巫；摄梦人继续梦 w2；狼人杀女巫（被守，不死）；女巫毒 w2（被梦，免疫）
  await act(room, guard, 'guard_pick', { target: witch });
  await act(room, dreamer, 'dreamer_pick', { target: w2 });
  await act(room, w2, 'wolf_set', { kill: witch, confirm: true });
  await act(room, A.playerId, 'seer_pick', { target: w2 });
  await act(room, witch, 'witch_act', { poison: w2 });
  v = await state(room, A.playerId);
  eq(v.phase, 'morning', '第二晚结束进入早晨');
  eq(v.morningDeaths.length, 0, '平安夜：女巫被守不死、w2 被梦免疫毒药');
  eq(v.sheriff, A.playerId, '警长不变');

  // 白天放逐 w2 → 好人胜
  await advance(room, A.playerId);
  await act(room, A.playerId, 'startVote');
  const voteMap2 = ids.reduce((m, id) => { m[id] = w2; return m; }, {});
  await playExileVote(room, ids, voteMap2);
  v = await state(room, A.playerId);
  if (v.phase === 'lastword') { await act(room, w2, 'post', { text: '遗言' }); v = await state(room, A.playerId); }
  eq(v.phase, 'ended', '游戏结束');
  eq(v.winner, 'good', '好人获胜');
  console.log('  场景3 完成');
}

/* ============================ 场景4：4人局（含盗贼）+ 房主踢人/离开 ============================ */
async function scenario4() {
  console.log('\n===== 场景4：4人局+盗贼玩法（狼1/民2/预1/守1，5张牌）+ 踢人/离开 =====');
  const A = await api('/api/create', { name: 'A' });
  const room = A.roomId;
  const ids = [A.playerId];
  const counts = { wolf: 1, villager: 2, seer: 1, guard: 1 };
  await act(room, A.playerId, 'settings', { thief: true });
  await act(room, A.playerId, 'setCap', { cap: 4 });
  await act(room, A.playerId, 'setCounts', { counts });
  for (let i = 0; i < 3; i++) {
    const r = await api('/api/join', { roomId: room, name: String.fromCharCode(66 + i) });
    ids.push(r.playerId);
  }
  // 房间满时拒绝加入
  const over = await api('/api/join', { roomId: room, name: 'X' });
  assert(over.error, '满员时拒绝加入');
  let v = await act(room, A.playerId, 'start');
  // 房主选预言家 → 盗贼在身份展示阶段选卡 → 全员确认
  const { thief, thiefCards, roles } = await playReveal(room, A.playerId, ids, 'seer');
  const cards = thiefCards || [];
  const thiefRole = roles[thief].role;
  console.log(`  盗贼抽到 [${cards.join(',')}]，选择了 ${thiefRole}`);
  assert(!String(thiefRole).startsWith('盗贼'), `盗贼选定后身份变为所选职业（当前:${thiefRole}）`);
  const wolf = ids.find(id => roles[id].role === '狼人');
  // 通用夜晚驱动：盗贼可能变成任何职业（守卫/摄梦人/女巫/预言家/猎人/丘比特…），
  // 每个步骤循环驱动所有未行动的演员
  const wolfTeam = [];
  for (const id of ids) { const r = await state(room, id); if (r.night && r.night.wolf) wolfTeam.push(id); }
  const killT = ids.find(id => !wolfTeam.includes(id));
  for (let i = 0; i < 20; i++) {
    v = await state(room, A.playerId);
    if (v.phase !== 'night' || !v.nightStep) break;
    const step = v.nightStep;
    if (step === 'hunter') {
      const shooter = v.night.hunter && v.night.hunter.shooter;
      if (shooter) await act(room, shooter, 'hunter_shoot', { target: null }); // 弃枪
      continue;
    }
    const actor = (v.night.actors || []).find(a => !a.acted);
    if (!actor) break;
    const av = await state(room, actor.id);
    if (step === 'cupid') {
      const targets = av.players.filter(p => p.alive && p.id !== actor.id).slice(0, 2);
      await act(room, actor.id, 'cupid_pick', { ids: [targets[0].id, targets[1].id] });
    } else if (step === 'lovers') {
      await act(room, actor.id, 'lovers_ok');
    } else if (step === 'guard') {
      const last = av.night.guard && av.night.guard.last;
      const target = av.players.find(p => p.alive && p.id !== last && p.id !== actor.id);
      await act(room, actor.id, 'guard_pick', { target: target ? target.id : av.players.find(p => p.alive && p.id !== actor.id).id });
    } else if (step === 'dreamer') {
      const target = av.players.find(p => p.alive && p.id !== actor.id);
      await act(room, actor.id, 'dreamer_pick', { target: target.id });
    } else if (step === 'wolf') {
      await act(room, actor.id, 'wolf_set', { kill: killT });
      await act(room, actor.id, 'wolf_set', { confirm: true });
    } else if (step === 'seer') {
      const target = av.players.find(p => p.alive && p.id !== actor.id);
      await act(room, actor.id, 'seer_pick', { target: target ? target.id : wolfTeam[0] });
    } else if (step === 'witch') {
      const victim = av.night.witch && av.night.witch.victim;
      if (victim) await act(room, actor.id, 'witch_act', { save: true });
      else await act(room, actor.id, 'witch_act', { save: false });
    } else break;
  }
  v = await state(room, A.playerId);
  // 夜1后：可能直接结束（屠边），也可能进入早晨
  if (v.phase === 'ended') {
    console.log(`  4人局夜1即结束，胜者: ${v.winner}（${v.endInfo.text}）`);
  } else {
    eq(v.phase, 'morning', '进入早晨');
    await advance(room, A.playerId);
    v = await state(room, A.playerId);
    // 夜1死亡的遗言
    if (v.phase === 'lastword') {
      for (const d of v.morningDeaths) {
        const dv = await state(room, d.id);
        if (dv.phase === 'lastword') await act(room, d.id, 'post', { text: '遗言' });
      }
      v = await state(room, A.playerId);
    }
    // 警长竞选（A 竞选并当选）
    if (v.phase === 'sheriff_campaign') {
      for (const id of ids) { const vl = await state(room, id); if (vl.phase === 'sheriff_campaign') await act(room, id, 'campaign', { run: id === A.playerId }); }
      for (const id of ids) { const vl = await state(room, id); if (vl.phase === 'sheriff_vote') await act(room, id, 'vote', { target: A.playerId }); }
      v = await state(room, A.playerId);
    }
    // 放逐投票：放逐第一个存活狼
    if (v.phase === 'discuss') {
      await act(room, A.playerId, 'startVote');
      v = await state(room, A.playerId);
      const alive = v.players.filter(p => p.alive);
      const target = alive.find(p => wolfTeam.includes(p.id)) || alive[0];
      for (const p of alive) {
        const vl = await state(room, p.id);
        if (vl.phase === 'vote') await act(room, p.id, 'vote', { target: target ? target.id : null });
      }
      v = await state(room, A.playerId);
      if (v.phase === 'lastword') {
        if (target) {
          const lw = await state(room, target.id);
          if (lw.phase === 'lastword') await act(room, target.id, 'post', { text: '遗言' });
        }
        v = await state(room, A.playerId);
      }
    }
    console.log(`  4人局当前阶段: ${v.phase}${v.phase === 'ended' ? '，胜者: ' + v.winner + '（' + v.endInfo.text + '）' : ''}`);
  }

  // 踢人与离开测试（新房间）
  console.log('  --- 踢人/离开测试 ---');
  const R2 = await api('/api/create', { name: 'H' });
  const r2room = R2.roomId;
  const r2ids = [R2.playerId];
  const J2 = await api('/api/join', { roomId: r2room, name: 'P2' });
  r2ids.push(J2.playerId);
  const kick = await api('/api/kick', { room: r2room, me: R2.playerId, target: J2.playerId });
  assert(!kick.error, '房主踢人成功');
  const sAfter = await state(r2room, R2.playerId);
  eq(sAfter.players.length, 1, '房间剩 1 人');
  const leave = await api('/api/leave', { room: r2room, me: R2.playerId });
  assert(!leave.error, '房主离开');
  const gone = await fetch(`${BASE}/api/state?room=${r2room}&me=${R2.playerId}`);
  const goneJson = await gone.json();
  eq(goneJson.error, 'room-not-found', '空房间自动解散');
  console.log('  场景4 完成');
}

/* ============================ 场景5：平票 PK 与 平票无人出局 ============================ */
async function setupBaseRoom(cap, tieRule) {
  const A = await api('/api/create', { name: 'A' });
  const room = A.roomId;
  const ids = [A.playerId];
  await act(room, A.playerId, 'settings', { sheriff: false, tieRule });
  for (let i = 1; i < cap; i++) {
    const r = await api('/api/join', { roomId: room, name: String.fromCharCode(65 + i) });
    ids.push(r.playerId);
  }
  let v = await act(room, A.playerId, 'start');
  v = await act(room, A.playerId, 'hostPick', { role: 'seer' });
  for (const id of ids.slice(1)) await act(room, id, 'confirm');
  const roles = await rolesOf(room, ids);
  const wolves = ids.filter(id => roles[id].role === '狼人');
  const witch = ids.find(id => roles[id].role === '女巫');
  const villager = ids.find(id => roles[id].role === '平民');
  const w1 = wolves[0], w2 = wolves[1];
  // 夜1：狼刀平民，女巫救 → 平安夜；预言家查验
  for (const w of wolves) { await act(room, w, 'wolf_set', { kill: villager }); await act(room, w, 'wolf_set', { confirm: true }); }
  await act(room, A.playerId, 'seer_pick', { target: w1 });
  await act(room, witch, 'witch_act', { save: true });
  return { room, ids, A: A.playerId, wolves, w1, w2, roles };
}

async function scenario5() {
  console.log('\n===== 场景5：平票 PK（无警长，6人局）=====');
  const { room, ids, A, wolves, w1, w2, roles } = await setupBaseRoom(6, 'pk');
  let v = await state(room, A);
  eq(v.phase, 'morning', '夜1结束（平安夜）');
  await advance(room, A);
  v = await state(room, A);
  eq(v.phase, 'discuss', '无警长局直接进入白天发言');
  // 放逐投票：3 好人 → w1；1 好人+2 狼 → w2 → 3:3 平票
  await act(room, A, 'startVote');
  const nonW = ids.filter(id => !wolves.includes(id)); // A+女巫+2民 = 4
  const voteMap = {};
  nonW.forEach((id, i) => { voteMap[id] = i === nonW.length - 1 ? w2 : w1; });
  wolves.forEach(w => { voteMap[w] = w2; });
  await playExileVote(room, ids, voteMap);
  v = await state(room, A);
  eq(v.phase, 'pk_speech', '平票进入 PK 发言');
  eq(v.lastVoteResult.result, 'tie', '投票结果为平票');
  await act(room, A, 'startVote');
  v = await state(room, A);
  eq(v.phase, 'pk_vote', '进入 PK 投票');
  // PK 投票：4 好人 → w1；2 狼 → w2 → 4:2 放逐 w1
  const pkMap = {};
  nonW.forEach(id => { pkMap[id] = w1; });
  wolves.forEach(w => { pkMap[w] = w2; });
  await playExileVote(room, ids, pkMap);
  v = await state(room, A);
  eq(v.phase, 'lastword', 'PK 后放逐进入遗言');
  eq(v.lastVoteResult.exiled, w1, 'w1 被放逐（4:2）');
  await act(room, w1, 'post', { text: '遗言' });
  v = await state(room, A);
  eq(v.phase, 'night', '进入第二晚');
  // 夜2：w2 杀 A；预言家查验；女巫跳过 → A 死 → 白天放逐 w2 → 好人胜
  const witch = ids.find(id => roles[id].role === '女巫');
  await act(room, w2, 'wolf_set', { kill: A, confirm: true });
  await act(room, A, 'seer_pick', { target: w2 });
  await act(room, witch, 'witch_act', { save: false });
  v = await state(room, A);
  eq(v.phase, 'morning', '第二晚结束');
  await advance(room, A);
  v = await state(room, A);
  eq(v.phase, 'discuss', '进入白天');
  await act(room, A, 'startVote');
  const aliveV = (await state(room, A)).players.filter(p => p.alive);
  const voteMap2 = {};
  aliveV.forEach(p => { voteMap2[p.id] = p.id === w2 ? aliveV.find(x => x.id !== w2).id : w2; });
  await playExileVote(room, aliveV.map(p => p.id), voteMap2);
  v = await state(room, A);
  if (v.phase === 'lastword') { await act(room, w2, 'post', { text: '遗言' }); v = await state(room, A); }
  eq(v.phase, 'ended', '游戏结束');
  eq(v.winner, 'good', '好人获胜');
  // 再来一局
  await act(room, A, 'rematch');
  v = await state(room, A);
  eq(v.phase, 'lobby', '再来一局回到大厅');
  eq(v.players.length, 6, '玩家保留');
  console.log('  场景5(PK) 完成');

  console.log('\n===== 场景5b：平票无人出局 =====');
  const r2 = await setupBaseRoom(6, 'none');
  let v2 = await state(r2.room, r2.A);
  await advance(r2.room, r2.A);
  await act(r2.room, r2.A, 'startVote');
  const ids2 = r2.ids;
  const wolves2 = r2.wolves;
  const w1b = r2.w1, w2b = r2.w2;
  const nonW2 = ids2.filter(id => !wolves2.includes(id));
  const vm = {};
  nonW2.forEach((id, i) => { vm[id] = i === nonW2.length - 1 ? w2b : w1b; });
  wolves2.forEach(w => { vm[w] = w2b; });
  await playExileVote(r2.room, ids2, vm);
  v2 = await state(r2.room, r2.A);
  eq(v2.phase, 'night', '平票无人出局，直接进入夜晚');
  eq(v2.lastVoteResult.result, 'tie', '结果为平票');
  console.log('  场景5b 完成');
}

/* ============================ 场景6：丘比特重选 / 频道限制 / 盗贼身份 ============================ */
async function scenario6() {
  console.log('\n===== 场景6：丘比特重选情侣 + 频道规则（8人：狼2/民2/预1/巫1/丘1）=====');
  const A = await api('/api/create', { name: 'A' });
  const room = A.roomId;
  const ids = [A.playerId];
  await act(room, A.playerId, 'settings', { sheriff: false });
  await act(room, A.playerId, 'setCap', { cap: 8 });
  const counts = { wolf: 2, villager: 3, seer: 1, witch: 1, cupid: 1 };
  await act(room, A.playerId, 'setCounts', { counts });
  for (let i = 1; i < 8; i++) {
    const r = await api('/api/join', { roomId: room, name: String.fromCharCode(65 + i) });
    if (r.error) throw new Error('场景6 join 失败: ' + r.error);
    ids.push(r.playerId);
  }
  let v = await act(room, A.playerId, 'start');
  v = await act(room, A.playerId, 'hostPick', { role: 'seer' });
  for (const id of ids.slice(1)) await act(room, id, 'confirm');
  v = await state(room, A.playerId);
  eq(v.phase, 'night', '进入第一晚');
  const roles = await rolesOf(room, ids);
  const wolves = ids.filter(id => roles[id].role === '狼人');
  const w1 = wolves[0], w2 = wolves[1];
  const villagers = ids.filter(id => roles[id].role === '平民');
  const v1 = villagers[0], v2 = villagers[1];
  const cupid = ids.find(id => roles[id].role === '丘比特');
  const witch = ids.find(id => roles[id].role === '女巫');

  // 夜1：丘比特连 w1+v1（一狼一好 → 第三方）
  v = await state(room, cupid);
  eq(v.nightStep, 'cupid', '丘比特首夜睁眼');
  await act(room, cupid, 'cupid_pick', { ids: [w1, v1] });
  for (const id of [w1, v1]) {
    const vl = await state(room, id);
    if (vl.nightStep === 'lovers') {
      eq(vl.night.lovers.partner, id === w1 ? v1 : w1, '情侣互相确认');
      if (id === v1) eq(vl.night.lovers.partnerRole, '狼人', '情侣互知身份：v1 看到 w1 是狼人');
      else eq(vl.night.lovers.partnerRole, '平民', '情侣互知身份：w1 看到 v1 是平民');
      assert(!!vl.night.lovers.cupidName, '情侣知道指认自己的丘比特是谁');
      await act(room, id, 'lovers_ok');
    }
  }
  // 丘比特不知道情侣身份（无法确定自己阵营）
  const cupidV = await state(room, cupid);
  assert(!cupidV.myLover, '丘比特不知道情侣身份（无 myLover 信息）');
  // v1.7.6（丘比特规则补足）：丘比特可得知自己当前阵营——人狼恋 = 第三方
  assert(cupidV.my.camp === '神眷者', '丘比特应知自己为神眷者（v1.7.6：丘比特可知当前阵营，人狼恋=神眷者）');
  // 1.8.x（丘比特削弱）：丘比特不可见情侣频道
  assert(!cupidV.myChannels.includes('lover'), '丘比特不可见情侣频道（1.8.x 削弱）');
  // 狼人杀 v2，女巫救 → 平安夜；预言家查验
  for (const w of wolves) { await act(room, w, 'wolf_set', { kill: v2 }); await act(room, w, 'wolf_set', { confirm: true }); }

  // 狼人频道：夜晚可用；情侣频道：夜晚可用；全体频道：夜间关闭（在夜晚进行中检测）
  const wv = await state(room, w1);
  eq(wv.phase, 'night', '仍在夜晚');
  assert(wv.myChannels.includes('wolf') && wv.myChannels.includes('lover'), '夜晚：狼人有狼频道+情侣频道');
  assert(!wv.myChannels.includes('all'), '夜晚：没有全体频道标签');
  const r1 = await api('/api/chat', { room, me: w1, data: { ch: 'wolf', text: '今晚刀谁' } });
  assert(r1.ok, '夜晚：狼人私聊可用');
  const r2 = await api('/api/chat', { room, me: v1, data: { ch: 'lover', text: '我是你情侣' } });
  assert(r2.ok, '夜晚：情侣私聊可用');
  const rCupidLover = await api('/api/chat', { room, me: cupid, data: { ch: 'lover', text: '我也看看' } });
  assert(!!rCupidLover.error, '丘比特不能进情侣频道发言（1.8.x 削弱）');
  const rAll = await api('/api/chat', { room, me: A.playerId, data: { ch: 'all', text: '测试' } });
  assert(!!rAll.error, '夜晚：全体频道关闭');

  await act(room, A.playerId, 'seer_pick', { target: w1 });
  await act(room, witch, 'witch_act', { save: true });

  v = await state(room, A.playerId);
  eq(v.phase, 'morning', '夜1平安夜');
  await advance(room, A.playerId);
  v = await state(room, A.playerId);
  eq(v.phase, 'discuss', '进入白天发言');

  // 白天：狼人频道关闭；情侣频道仍开
  const wv2 = await state(room, w1);
  assert(!wv2.myChannels.includes('wolf'), '白天：狼人没有狼频道');
  const r3 = await api('/api/chat', { room, me: w1, data: { ch: 'wolf', text: '白天不能聊' } });
  assert(r3.error, '白天：狼人私聊被拒绝');
  const r4 = await api('/api/chat', { room, me: v1, data: { ch: 'lover', text: '白天也能聊' } });
  assert(r4.ok, '白天：情侣私聊仍可用');
  const r5 = await api('/api/chat', { room, me: A.playerId, data: { ch: 'all', text: '白天好' } });
  assert(r5.ok, '白天：全体频道开放');
  // 白天情侣仍能看到对方身份与丘比特
  const dayLover = await state(room, v1);
  assert(dayLover.myLover && dayLover.myLover.role === '狼人' && dayLover.myLover.cupidName, '白天：情侣信息（对方身份+丘比特）仍可见');

  // 白天放逐 w1 → v1 殉情 → 情侣全灭
  await act(room, A.playerId, 'startVote');
  const voteMap = ids.reduce((m, id) => { m[id] = w1; return m; }, {});
  await playExileVote(room, ids, voteMap);
  v = await state(room, A.playerId);
  if (v.phase === 'lastword') { await act(room, w1, 'post', { text: '遗言' }); v = await state(room, A.playerId); }
  eq(v.phase, 'night', '进入第二晚');
  // 放逐+殉情公告保留过夜（次日天亮才清空，N3）
  eq(v.dayDeaths.some(d => d.id === v1 && d.deadBy === 'lover'), true, 'v1 殉情');

  // 夜2：情侣全灭 → 丘比特重新指定 [w2, v2]
  v = await state(room, cupid);
  eq(v.nightStep, 'cupid', '丘比特重新睁眼（可重选）');
  await act(room, cupid, 'cupid_pick', { ids: [w2, v2] });
  for (const id of [w2, v2]) {
    const vl = await state(room, id);
    if (vl.nightStep === 'lovers') { eq(vl.night.lovers.partner, id === w2 ? v2 : w2, '新情侣互相确认'); await act(room, id, 'lovers_ok'); }
  }
  // w2 杀 A；女巫毒 w2 → w2 死 → v2 殉情 → 狼人全灭 → 好人胜
  await act(room, w2, 'wolf_set', { kill: A.playerId });
  await act(room, w2, 'wolf_set', { confirm: true });
  await act(room, A.playerId, 'seer_pick', { target: w2 });
  await act(room, witch, 'witch_act', { poison: w2 });
  v = await state(room, A.playerId);
  eq(v.phase, 'ended', '游戏结束');
  eq(v.winner, 'good', '好人获胜（狼人全灭，无需消灭第三方）');
  console.log('  场景6 完成');
}

/* ============================ 主流程 ============================ */
async function main() {
  console.log('启动服务器...');
  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SNAPSHOT_SEC: '0', PORT: String(PORT), CHAT_INTERVAL: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => process.stdout.write('[server] ' + d));
  server.stderr.on('data', d => process.stderr.write('[server-err] ' + d));
  // 等待就绪
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${BASE}/api/state?room=x&me=y`); if (r.status === 200) { ready = true; break; } } catch (e) {}
    await sleep(200);
  }
  if (!ready) { console.error('服务器未就绪'); server.kill(); process.exit(1); }
  try {
    await scenario1();
    await scenario2();
    await scenario3();
    await scenario4();
    await scenario5();
    await scenario6();
  } catch (e) {
    failures++;
    console.error('!! 异常: ' + (e && e.stack || e));
  }
  server.kill();
  await sleep(300);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\n全部测试通过 ✔');
  process.exit(0);
}
main();
