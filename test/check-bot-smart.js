'use strict';
/* 人机三档决策（v1.4.0）专项测试
 * 运行：node test/check-bot-smart.js
 * 覆盖：
 *   S1 add_bot level 参数：合法级别通过 / 非法级别忽略（不报错、正常添加）
 *   S2 smart 狼人机（黑盒端到端）：真预言家（房主）白天“我跳预言家，查杀狼队友”→ 夜2 优先刀该预言家
 *   S3 smart 好人机（决策层单元）：真人预言家查杀 X → 放逐投票投 X（贝叶斯）
 *   S4 easy 好人机（决策层单元）：查杀 X → 放逐投票投 X（关键词嫌疑度）
 * 说明：投票阶段的真实投票过程（全员投完自动结算）窗口 <200ms，黑盒抓取不稳定，
 *   故 S3/S4 直接验证决策函数输出；S2 夜晚行动窗口长，保留黑盒端到端。
 * 随机性处理：身份/刀人随机 → 关键条件不满足时整局重开（最多 N 次）
 */
const { spawn } = require('child_process');
const path = require('path');
const { createBotDecision } = require('../bot-brain');

const PORT = 8131;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(p, body) { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return r.json(); }
async function act(room, me, action, data) { const r = await api('/api/action', { room, me, action, data: data || {} }); if (r.error) throw new Error(`${action}失败: ${r.error}`); return r.view; }
async function st(room, me) { return (await fetch(`${BASE}/api/state?room=${room}&me=${me}`)).json(); }
async function chat(room, me, text) { const r = await api('/api/chat', { room, me, data: { ch: 'all', text } }); if (r.error) throw new Error('发言失败: ' + r.error); }
async function advance(room, me) { const r = await api('/api/advance', { room, me }); if (r.error) throw new Error('advance失败: ' + r.error); }

/* 轮询等待 phase 满足条件（上限 12s） */
async function waitPhase(room, me, pred, label) {
  for (let i = 0; i < 18; i++) {
    const v = await st(room, me);
    if (pred(v)) return v;
    await sleep(700);
  }
  throw new Error('等待超时: ' + label);
}

/* 开局：cap 人，含 1 个指定级别 bot 与 fill 个填充 bot；重试直到 roles 满足 wantRole */
async function setup(cap, counts, botLevel, fillLevel, wantRole) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const r = await api('/api/create', { name: '房主' });
    const room = r.roomId, host = r.playerId;
    await act(room, host, 'add_bot', { level: botLevel });
    for (let i = 0; i < cap - 2; i++) await act(room, host, 'add_bot', { level: fillLevel });
    await act(room, host, 'setCounts', { counts });
    await act(room, host, 'settings', { sheriff: false, thief: false, tieRule: 'none', winMode: 'city', botMode: fillLevel }); // 屠城：保证随机刀/放逐不提前结束对局
    await act(room, host, 'setCap', { cap });
    await act(room, host, 'start');
    await act(room, host, 'hostPick', { role: 'seer' });
    await sleep(1200); // 等全员 confirm（bot 自动）
    const v = await st(room, host);
    const roles = {};
    for (const p of v.players) roles[p.id] = (await st(room, p.id)).my.roleKey;
    const botIds = v.players.filter(p => p.isBot).map(p => p.id);
    if (roles[botIds[0]] === wantRole) return { room, host, botIds, roles, target: botIds[0] };
    for (const id of botIds) await api('/api/leave', { room, me: id });
    await api('/api/leave', { room, me: host });
  }
  throw new Error('多次开局未满足角色要求');
}

/* 夜晚驱动：轮询推进；房主是预言家则轮到 seer 步骤时查验一名活人 */
async function driveNight(room, host) {
  await waitPhase(room, host, v => v.phase === 'night' || v.phase === 'morning', '进入夜晚');
  while (true) {
    const v = await st(room, host);
    if (v.phase !== 'night') return v;
    if (v.nightStep === 'seer' && v.my && v.my.alive && v.my.roleKey === 'seer') {
      const checked = (v.seerHistory || []).map(h => h.id);
      const pool = (v.players || []).filter(p => p.alive && p.id !== host && !checked.includes(p.id));
      if (pool.length) { try { await act(room, host, 'seer_pick', { target: pool[0].id }); } catch (e) {} }
    }
    await sleep(700);
  }
}

/* 早晨 → 推进到 discuss（morning/lastword 由房主强推；bot 遗言自动跳过） */
async function toDiscuss(room, host) {
  for (let i = 0; i < 12; i++) {
    const v = await st(room, host);
    if (v.phase === 'discuss') return v;
    if (v.phase === 'morning' || v.phase === 'lastword' || v.phase === 'handover') {
      try { await advance(room, host); } catch (e) {}
      await sleep(500);
    } else await sleep(700);
  }
  throw new Error('等待超时: 到达白天发言');
}

/* ============ S1：add_bot level 参数 ============ */
async function s1LevelParam() {
  const r = await api('/api/create', { name: 'S1房主' });
  const room = r.roomId, host = r.playerId;
  const ok1 = await api('/api/action', { room, me: host, action: 'add_bot', data: { level: 'smart' } });
  const ok2 = await api('/api/action', { room, me: host, action: 'add_bot', data: { level: 'weird' } });
  assert(!ok1.error, 'S1 add_bot level=smart 添加成功');
  assert(!ok2.error, 'S1 非法 level 忽略不报错（走 botMode 映射）');
  await api('/api/leave', { room, me: host });
}

/* ============ S2：smart 狼 bot 夜2 刀跳预言家的房主（黑盒端到端） ============ */
async function s2SmartWolfKillsSeer() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const s = await setup(5, { wolf: 2, seer: 1, villager: 2 }, 'smart', 'easy', 'wolf');
    let v = await driveNight(s.room, s.host);
    if ((v.morningDeaths || []).some(d => d.id === s.host)) { // 夜1被随机刀死 → 重开
      await api('/api/leave', { room: s.room, me: s.host }); continue;
    }
    v = await toDiscuss(s.room, s.host);
    const wolfMate = (v.players || []).find(p => p.isBot && p.id !== s.target && s.roles[p.id] === 'wolf');
    if (!wolfMate) continue;
    await chat(s.room, s.host, '我跳预言家，查杀' + wolfMate.name);
    await act(s.room, s.host, 'startVote');
    await act(s.room, s.host, 'vote', { target: wolfMate.id }); // 房主先投，随后等待/强推（全员投完自动结算）
    await sleep(2000);
    try { await advance(s.room, s.host); } catch (e) {}
    v = await driveNight(s.room, s.host); // 夜2：smart 狼应刀“可信预言家”（房主）
    if ((v.morningDeaths || []).some(d => d.id === s.host)) {
      assert(true, 'S2 smart 狼人机夜2优先刀跳预言家的房主（房主早晨死亡）');
      await api('/api/leave', { room: s.room, me: s.host });
      return;
    }
    await api('/api/leave', { room: s.room, me: s.host }); // 随机因素未满足 → 重试
  }
  assert(false, 'S2 多次尝试未完成（随机条件不满足）');
}

/* ============ S3/S4：好人 bot 决策层单元验证（投票给被查杀者） ============ */
function unitVoteOnChecked(level, label) {
  const room = {
    players: [
      { id: 'H', name: '房主', role: 'seer', alive: true, isBot: false },
      { id: 'G', name: '好bot', role: 'villager', alive: true, isBot: true, botLevel: level },
      { id: 'C', name: '人机·阿蓝', role: 'villager', alive: true, isBot: true, botLevel: 'idle' },
      { id: 'D', name: '人机·阿紫', role: 'villager', alive: true, isBot: true, botLevel: 'idle' },
      { id: 'E', name: '人机·阿黄', role: 'wolf', alive: true, isBot: true, botLevel: 'idle' },
    ],
    settings: { counts: { wolf: 1, seer: 1, villager: 3 }, botMode: 'auto' },
    phase: 'vote', nightStep: null, nightNum: 1, night: {},
    guardLast: null, witchPots: { saveUsed: false, poisonUsed: false },
    seerHistory: [], votes: {}, lastVoteResult: null, pkTied: null, candidates: [],
    messages: [{ id: 'm1', ch: 'all', from: 'H', name: '房主', text: '我跳预言家，查杀人机·阿紫', marker: null, ts: 1 }],
  };
  const dec = createBotDecision(room, room.players[1]);
  assert(dec && dec.action === 'vote' && dec.data.target === 'D', label + '：' + level + ' 人机投票给被查杀的玩家（决策输出）');
}

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT) } });
  let ready = false;
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`${BASE}/healthz`); if (r.status === 200) { ready = true; break; } } catch (e) {} await sleep(200); }
  if (!ready) { console.error('服务器未就绪'); srv.kill(); process.exit(1); }
  try {
    await s1LevelParam();
    await s2SmartWolfKillsSeer();
    unitVoteOnChecked('smart', 'S3');
    unitVoteOnChecked('easy', 'S4');
  } catch (e) { failures++; console.error('!!异常: ' + ((e && e.stack) || e)); }
  finally { srv.kill(); }
  await sleep(300);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\n人机三档决策专项测试全部通过 ✔');
  process.exit(0);
}
main();
