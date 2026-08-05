'use strict';
process.env.LAB_NO_MODEL = '1'; // 1.7.0（B1-4）：单元/黑盒验证 simulate 核心逻辑，隔离运行时 vote 模型（集成层增强另行对比验证）
/* simulate 态度模型档（v1.5.0）：
 * U1 单元：simulate 投票决策合法
 * U2 单元：查杀一次 → 投被查杀者
 * U3 单元：多次查杀 → 仍投被查杀者（情感记忆累积，不会瞬间满格但方向稳定）
 * S1 add_bot：level='simulate' 合法、非法 style 忽略
 * S2 黑盒：simulate 好人 bot 白天被"查杀"发言影响 → 投票给被查杀者（房主 votedBy 可见）
 * S3 黑盒：simulate 狼 bot 夜晚正常出刀/confirm，夜晚正常推进
 * 运行：node test/check-bot-simulate.js
 */
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8172;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
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
async function chat(room, me, text) { await api('/api/chat', { room, me, data: { ch: 'all', text } }); }
async function advance(room, me) { const r = await api('/api/advance', { room, me }); if (r.error) throw new Error('advance失败: ' + r.error); }

/* ---------- 单元 ---------- */
const { createBotDecision } = require('../bot-brain.js');
function mkRoom(msgs, phase, style) {
  return {
    players: [
      { id: 'H', name: '房主', role: 'wolf', alive: true, isBot: false },
      { id: 'B', name: '好bot', role: 'villager', alive: true, isBot: true, botLevel: 'simulate', botStyle: style || 'balanced', botMemory: {} },
      { id: 'C', name: '人机·阿蓝', role: 'villager', alive: true, isBot: true, botLevel: 'idle' },
      { id: 'D', name: '人机·阿紫', role: 'villager', alive: true, isBot: true, botLevel: 'idle' },
      { id: 'E', name: '人机·阿黄', role: 'villager', alive: true, isBot: true, botLevel: 'idle' },
    ],
    settings: { counts: { wolf: 1, seer: 1, villager: 3 }, botMode: 'auto' },
    phase: phase || 'vote', nightStep: null, nightNum: 1, dayNum: 1,
    night: { wolf: { kill: null, charm: null, sel: {} } },
    guardLast: null, witchPots: { saveUsed: false, poisonUsed: false },
    seerHistory: [], votes: {}, lastVoteResult: null, pkTied: null, candidates: [],
    lovers: null, wolfPackMemory: {},
    messages: msgs || [],
  };
}
function unitTests() {
  const d1 = createBotDecision(mkRoom([], 'vote'), mkRoom([], 'vote').players[1]);
  assert(d1 && d1.action === 'vote' && d1.data.target !== null && d1.data.target !== 'B', 'U1 simulate 投票决策合法（投他人）');
  const room2 = mkRoom([{ id: 'm1', ch: 'all', from: 'H', text: '我跳预言家，查杀人机·阿紫', marker: null, ts: 1 }], 'vote');
  const d2 = createBotDecision(room2, room2.players[1]);
  assert(d2 && d2.data.target === 'D', 'U2 查杀一次 → 投被查杀者（态度 CHAT_BAD）');
  const room3 = mkRoom([
    { id: 'm1', ch: 'all', from: 'H', text: '我跳预言家，查杀人机·阿紫', marker: null, ts: 1 },
    { id: 'm2', ch: 'all', from: 'H', text: '阿紫就是狼，我查杀他', marker: null, ts: 2 },
    { id: 'm3', ch: 'all', from: 'C', text: '阿紫是狼，同意出他', marker: null, ts: 3 },
  ], 'vote');
  const d3 = createBotDecision(room3, room3.players[1]);
  assert(d3 && d3.data.target === 'D', 'U3 多次查杀 → 仍投被查杀者（情感记忆累积，方向稳定）');
  // 风格参数不影响决策合法性
  for (const st of ['aggressive', 'conservative', 'weird']) {
    const r4 = mkRoom([], 'vote', st);
    const d4 = createBotDecision(r4, r4.players[1]);
    assert(d4 && d4.action === 'vote', 'U4 风格 ' + st + ' 决策正常（非法值回落 balanced）');
  }
}

/* ---------- 黑盒 setup ---------- */
async function setup(cap, counts, botLevel, fillLevel, wantRole) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const r = await api('/api/create', { name: '房主' });
    const room = r.roomId, host = r.playerId;
    await act(room, host, 'setCap', { cap });
    await act(room, host, 'add_bot', { level: botLevel, style: 'aggressive' });
    for (let i = 0; i < cap - 2; i++) await act(room, host, 'add_bot', { level: fillLevel });
    await act(room, host, 'settings', { sheriff: false, thief: false, tieRule: 'none', winMode: 'city' });
    await act(room, host, 'setCounts', { counts });
    await act(room, host, 'start');
    await act(room, host, 'hostPick', { role: counts.wolf ? 'wolf' : 'villager' });
    await sleep(1300);
    let v = await st(room, host);
    const firstBot = (v.players || []).find(p => p.isBot);
    const roles = {};
    for (const p of (v.players || [])) { const pv = await st(room, p.id); roles[p.id] = pv.my ? pv.my.roleKey : null; }
    if (firstBot && roles[firstBot.id] === wantRole) {
      return { room, host, players: v.players, roles, target: firstBot.id };
    }
    for (const p of (v.players || [])) await api('/api/leave', { room, me: p.id }).catch(() => {});
  }
  throw new Error('setup多次开局未满足角色要求: ' + wantRole);
}
async function toDiscuss(room, host) {
  for (let i = 0; i < 14; i++) {
    const v = await st(room, host);
    if (v.phase === 'discuss') return v;
    if (v.phase === 'morning' || v.phase === 'lastword' || v.phase === 'handover') { try { await advance(room, host); } catch (e) {} await sleep(400); }
    else await sleep(500);
  }
  throw new Error('等待超时:到达白天发言');
}

/* ---------- S2：simulate 好人投被查杀者 ---------- */
async function s2VoteOnChecked() {
  for (let attempt = 0; attempt < 5; attempt++) {
    let s;
    try {
      s = await setup(5, { wolf: 1, seer: 1, villager: 3 }, 'simulate', 'idle', 'villager');
      const victim = s.players.find(p => p.alive && p.id !== s.host && p.id !== s.target);
      await sleep(300);
      await act(s.room, s.host, 'wolf_set', { kill: victim ? victim.id : null, confirm: true });
      let v = await st(s.room, s.host);
      for (let i = 0; i < 20 && v.phase === 'night'; i++) { v = await st(s.room, s.host); await sleep(400); }
      if ((v.morningDeaths || []).some(d => d.id === s.host)) { await api('/api/leave', { room: s.room, me: s.host }).catch(() => {}); continue; }
      v = await toDiscuss(s.room, s.host);
      const Y = (v.players || []).find(p => p.alive && p.id !== s.host && p.id !== s.target);
      if (!Y) { await api('/api/leave', { room: s.room, me: s.host }).catch(() => {}); continue; }
      await chat(s.room, s.host, '我跳预言家，查杀' + Y.name);
      await act(s.room, s.host, 'startVote');
      let vb = null;
      for (let i = 0; i < 14; i++) {
        const vh = await st(s.room, s.host);
        if (vh.phase === 'vote') {
          const f = ((vh.vote && vh.vote.votedBy) || []).find(x => x.id === s.target);
          if (f) { vb = f; break; }
        } else break;
        await sleep(150);
      }
      await act(s.room, s.host, 'vote', { target: Y.id }).catch(() => {});
      assert(vb && vb.vote === Y.id, 'S2 simulate 好人 bot 投被查杀者' + (vb ? '（投:' + (vb.vote || '空') + '）' : '（未抓到投票窗口）'));
      await api('/api/leave', { room: s.room, me: s.host }).catch(() => {});
      return;
    } catch (e) {
      if (s) await api('/api/leave', { room: s.room, me: s.host }).catch(() => {});
    }
  }
  assert(false, 'S2 多次尝试未完成');
}

/* ---------- S3：simulate 狼夜晚正常行动 ---------- */
async function s3SimulateWolfNight() {
  for (let attempt = 0; attempt < 5; attempt++) {
    let s;
    try {
      s = await setup(5, { wolf: 2, villager: 3 }, 'simulate', 'idle', 'wolf');
      let v = await st(s.room, s.host);
      for (let i = 0; i < 12 && (v.phase !== 'night' || v.nightStep !== 'wolf'); i++) { v = await st(s.room, s.host); await sleep(400); }
      const t = (v.players || []).find(p => p.alive && p.id !== s.host && p.id !== s.target);
      await act(s.room, s.host, 'wolf_set', { kill: t ? t.id : null, confirm: true });
      let ok = false;
      for (let i = 0; i < 12; i++) {
        v = await st(s.room, s.host);
        if (v.phase !== 'night') { ok = true; break; }
        await sleep(400);
      }
      assert(ok, 'S3 simulate 狼夜晚正常行动并对局推进（不崩溃）');
      await api('/api/leave', { room: s.room, me: s.host }).catch(() => {});
      return;
    } catch (e) {
      if (s) await api('/api/leave', { room: s.room, me: s.host }).catch(() => {});
    }
  }
  assert(false, 'S3 多次尝试未完成');
}

async function main() {
  unitTests();
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, SNAPSHOT_SEC: '0', PORT: String(PORT), PHASE_TIMEOUT: '60', NIGHT_TIMEOUT: '45', BOT_DELAY_MS: '400', CHAT_INTERVAL: '0' },
  });
  let ready = false;
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`${BASE}/healthz`); if (r.status === 200) { ready = true; break; } } catch (e) {} await sleep(200); }
  if (!ready) { console.error('服务器未就绪'); srv.kill(); process.exit(1); }
  try {
    // S1 add_bot 级别/风格参数
    const r = await api('/api/create', { name: '房主' });
    const rr = await act(r.roomId, r.playerId, 'add_bot', { level: 'simulate', style: 'aggressive', wolfStyle: 'charge' });
    const rv = await st(r.roomId, r.playerId);
    assert(rv.players.length === 2 && rv.players[1].isBot, 'S1 add_bot simulate 成功');
    await api('/api/leave', { room: r.roomId, me: r.playerId });
    await s2VoteOnChecked();
    await s3SimulateWolfNight();
  } catch (e) { failures++; console.error('!!异常: ' + ((e && e.stack) || e)); }
  finally { srv.kill(); }
  await sleep(400);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\nsimulate 态度模型专项测试全部通过 ✔');
  process.exit(0);
}
main();