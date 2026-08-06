process.env.LAB_NO_MODEL = '1'; // 1.7.0（B1-4）：单元测试隔离运行时 vote 模型（模型是集成层增强，核心逻辑验证不受其干扰）
'use strict';
/* 所有职业获胜逻辑适配（v1.5.1）：第三方阵营认知（人狼恋/丘比特）
 * v1.6.2 公平化：人机定位为公平玩家——狼不再避让恋人（恋人关系对狼是不可见信息），仅避狼队友；
 *   第三方 bot（恋人成员，互知身份）仍不投自己阵营。
 * U1 单元：factionOf 阵营判定（全好/全狼/人狼恋/丘比特自连/普通）
 * U2 单元：狼 bot 夜晚不刀狼队友（公平化后允许刀恋人）
 * U3 单元：第三方 bot（好人恋人）投票不投自己阵营（保恋人保自己）
 * U4 单元：狼 bot 优先刀"自称神职者"（守卫/女巫/猎人穿衣服）
 * S1 黑盒：人狼恋局（房主=丘比特真人）完整推进两夜，狼 bot 不刀狼队友
 * 运行：node test/check-bot-third.js
 */
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8173;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 单元 ---------- */
const { createBotDecision, factionOf } = require('../bot-brain.js');
function mkRoom(msgs, phase, lovers) {
  return {
    players: [
      { id: 'W', name: '狼bot', role: 'wolf', alive: true, isBot: true, botLevel: 'smart', botMemory: {} },
      { id: 'L', name: '狼恋人', role: 'wolf', alive: true, isBot: true, botLevel: 'idle', botMemory: {} },
      { id: 'G', name: '好人恋人', role: 'villager', alive: true, isBot: true, botLevel: 'idle', botMemory: {} },
      { id: 'X', name: '人机·阿蓝', role: 'villager', alive: true, isBot: true, botLevel: 'idle' },
      { id: 'Y', name: '人机·阿紫', role: 'villager', alive: true, isBot: true, botLevel: 'idle' },
    ],
    settings: { counts: { wolf: 2, cupid: 1, villager: 2 }, botMode: 'auto' },
    phase: phase || 'night', nightStep: 'wolf', nightNum: 1, dayNum: 1,
    night: { wolf: { kill: null, charm: null, sel: {} } },
    guardLast: null, witchPots: { saveUsed: false, poisonUsed: false },
    seerHistory: [], votes: {}, lastVoteResult: null, pkTied: null, candidates: [],
    lovers: lovers || null, wolfPackMemory: {},
    messages: msgs || [],
  };
}
function unitTests() {
  const room = mkRoom([]);
  // U1 factionOf
  assert(factionOf(room, room.players[0]) === 'wolf', 'U1 普通狼 → wolf');
  assert(factionOf(room, room.players[3]) === 'good', 'U1 普通好人 → good');
  room.lovers = ['L', 'G']; // 人狼恋
  assert(factionOf(room, room.players[1]) === 'third', 'U1 人狼恋中的狼 → third');
  assert(factionOf(room, room.players[2]) === 'third', 'U1 人狼恋中的好人 → third');
  room.lovers = ['L', 'W']; // 狼狼恋
  assert(factionOf(room, room.players[1]) === 'wolf', 'U1 全狼情侣 → wolf');
  room.lovers = ['G', 'X']; // 好情侣
  assert(factionOf(room, room.players[2]) === 'good', 'U1 全好情侣 → good');
  // 丘比特
  const cupidRoom = mkRoom([], ['C1', 'L']); // 丘比特在情侣中（自连）
  cupidRoom.players.push({ id: 'C1', name: '丘比特', role: 'cupid', alive: true, isBot: false });
  // v1.7.6：丘比特可得知自己当前阵营——factionOf 直接读 cupidCamp（首轮=好人、重选=当前阵营）
  cupidRoom.cupidCamp = null; // 未指定 → 按好人
  assert(factionOf(cupidRoom, cupidRoom.players[5]) === 'good', 'U1 丘比特未指定（cupidCamp=null）→ good（实际 ' + factionOf(cupidRoom, cupidRoom.players[5]) + '）');
  cupidRoom.cupidCamp = 'third';
  assert(factionOf(cupidRoom, cupidRoom.players[5]) === 'third', 'U1 丘比特属第三方（cupidCamp=third）→ third（实际 ' + factionOf(cupidRoom, cupidRoom.players[5]) + '）');
  cupidRoom.cupidCamp = 'wolf';
  assert(factionOf(cupidRoom, cupidRoom.players[5]) === 'wolf', 'U1 丘比特属狼人阵营（cupidCamp=wolf）→ wolf（实际 ' + factionOf(cupidRoom, cupidRoom.players[5]) + '）');
  // U2 狼 bot 夜晚不刀狼队友（v1.6.2 公平化：狼不避让恋人——恋人关系对狼不可见，可刀好人恋人）
  const r2 = mkRoom([], 'night', ['L', 'G']);
  const d2 = createBotDecision(r2, r2.players[0]);
  assert(d2 && d2.action === 'wolf_set' && d2.data.kill !== 'L',
    'U2 狼 bot 夜晚不刀狼队友' + (d2 ? '（刀:' + d2.data.kill + '）' : '（null）'));
  // U3 第三方 bot 投票不投恋人
  const r3 = mkRoom([], 'vote', ['L', 'G']);
  r3.nightStep = null;
  const d3 = createBotDecision(r3, r3.players[2]); // 好人恋人（第三方）
  assert(d3 && d3.action === 'vote' && d3.data.target !== 'L' && d3.data.target !== 'G',
    'U3 第三方 bot 投票不投恋人' + (d3 ? '（投:' + d3.data.target + '）' : '（null）'));
  // U4 狼 bot 优先刀自称神职者
  const r4 = mkRoom([{ id: 'm1', ch: 'all', from: 'G', text: '我是守卫，昨晚守的自己', marker: null, ts: 1 }], 'night', null);
  r4.players[2].role = 'guard'; // 好人恋人改守卫身份（非第三方局）
  const d4 = createBotDecision(r4, r4.players[0]);
  assert(d4 && d4.action === 'wolf_set' && d4.data.kill === 'G', 'U4 狼刀自称守卫者' + (d4 ? '（刀:' + d4.data.kill + '）' : '（null）'));
}

/* ---------- 黑盒 ---------- */
async function api(p, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}
async function act(room, me, action, data) {
  const r = await api('/api/action', { room, me, action, data: data || {} });
  if (r.error) throw new Error(action + '失败: ' + r.error);
  return r.view;
}
async function st(room, me) { return (await fetch(`${BASE}/api/state?room=${room}&me=${me}&chatSince=0`)).json(); }
async function advance(room, me) { const r = await api('/api/advance', { room, me }); if (r.error) throw new Error('advance失败: ' + r.error); }

async function s1ThirdPartyLovers() {
  for (let attempt = 0; attempt < 5; attempt++) {
    let room = null, host = null;
    try {
      const r = await api('/api/create', { name: '丘比特房主' });
      room = r.roomId; host = r.playerId;
      await act(room, host, 'setCap', { cap: 6 });
      await act(room, host, 'add_bot', { level: 'simulate' });
      for (let i = 0; i < 4; i++) await act(room, host, 'add_bot', { level: 'idle' }); // 共 5 人机（cap6=房主+5）
      await act(room, host, 'settings', { sheriff: false, thief: false, tieRule: 'none', winMode: 'city', cupid: true });
      await act(room, host, 'setCounts', { counts: { wolf: 2, cupid: 1, seer: 0, witch: 0, hunter: 0, dreamer: 0, guard: 0, wolfBeauty: 0, thief: 0, villager: 3 } });
      await act(room, host, 'start');
      await act(room, host, 'hostPick', { role: 'cupid' });
      await sleep(1400);
      let v = await st(room, host);
      const roles = {};
      for (const p of (v.players || [])) { const pv = await st(room, p.id); roles[p.id] = pv.my ? pv.my.roleKey : null; }
      const simWolf = (v.players || []).find(p => p.isBot && roles[p.id] === 'wolf');
      const partnerWolf = (v.players || []).find(p => p.isBot && p.id !== (simWolf && simWolf.id) && roles[p.id] === 'wolf');
      if (!simWolf || !partnerWolf) { await api('/api/leave', { room, me: host }).catch(() => {}); continue; }
      // 夜晚：cupid step 连 [simulate狼, 好人bot]
      v = await st(room, host);
      for (let i = 0; i < 12 && !(v.phase === 'night' && v.nightStep === 'cupid'); i++) { v = await st(room, host); await sleep(400); }
      const goodBot = (v.players || []).find(p => p.isBot && p.id !== simWolf.id && roles[p.id] !== 'wolf');
      await act(room, host, 'cupid_pick', { ids: [simWolf.id, goodBot.id] });
      // 推进两夜：等夜晚结束 → morning → advance 到下一夜（vote 强推）
      // v1.6.2 公平化：狼可能刀恋人（不知情侣关系），断言改为“狼不刀狼队友”
      let loversSafe = true;
      for (let night = 1; night <= 2 && loversSafe; night++) {
        let vv = await st(room, host);
        for (let i = 0; i < 30 && vv.phase === 'night'; i++) { vv = await st(room, host); await sleep(400); }
        const wolfKilled = (vv.morningDeaths || []).find(d => d.deadBy === 'wolf');
        if (wolfKilled && (wolfKilled.id === simWolf.id || wolfKilled.id === partnerWolf.id)) loversSafe = false; // 狼被狼刀（狼不刀狼）
        // 白天：强推 vote → 下一夜
        for (let i = 0; i < 12; i++) {
          vv = await st(room, host);
          if (vv.phase === 'night') break;
          try { await advance(room, host); } catch (e) {}
          await sleep(400);
        }
      }
      assert(loversSafe, 'S1 人狼恋局：两夜内狼 bot 不刀狼队友');
      await api('/api/leave', { room, me: host }).catch(() => {});
      return;
    } catch (e) {
      if (room) await api('/api/leave', { room, me: host }).catch(() => {});
    }
  }
  assert(false, 'S1 多次尝试未完成');
}

async function main() {
  unitTests();
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, SNAPSHOT_SEC: '0', PORT: String(PORT), PHASE_TIMEOUT: '60', NIGHT_TIMEOUT: '45', BOT_DELAY_MS: '400', CHAT_INTERVAL: '0' },
  });
  let ready = false;
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`${BASE}/healthz`); if (r.status === 200) { ready = true; break; } } catch (e) {} await sleep(200); }
  if (!ready) { console.error('服务器未就绪'); srv.kill(); process.exit(1); }
  try { await s1ThirdPartyLovers(); }
  catch (e) { failures++; console.error('!!异常: ' + ((e && e.stack) || e)); }
  finally { srv.kill(); }
  await sleep(400);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\n第三方阵营适配专项测试全部通过 ✔');
  process.exit(0);
}
main();