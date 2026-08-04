'use strict';
/* bot 高阶能力（v1.5.0）
 * A1 银水：smart 女巫救过的人（银水）不会被它投票（房主查杀银水 → 女巫 bot 投别人）
 * A2 对跳查验：smart 预言家优先查验对跳者（真人悍跳预言家 → 夜2 验他）
 * A3 魅惑策略：smart 狼优先魅惑"可信预言家"（声称查杀真狼者），且不魅惑狼/不魅惑刀目标
 * A4 发言模拟：smart 预言家白天报查验（"我是预言家…"）
 * A5 悍跳：smart 狼白天悍跳预言家（每队一次）
 * A6 挂机沉默：idle bot 白天不发言
 * 运行：node test/check-bot-advanced.js
 */
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8152;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(p, body) { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return r.json(); }
async function act(room, me, action, data) { const r = await api('/api/action', { room, me, action, data: data || {} }); if (r.error) throw new Error(action + '失败: ' + r.error); return r.view; }
async function st(room, me) { return (await fetch(`${BASE}/api/state?room=${room}&me=${me}&chatSince=0`)).json(); }
async function chat(room, me, text) { const r = await api('/api/chat', { room, me, data: { ch: 'all', text } }); if (r.error) throw new Error('发言失败: ' + r.error); }
async function advance(room, host) { const r = await api('/api/advance', { room, me: host }); if (r.error) throw new Error('advance失败: ' + r.error); }

/* 建房：房主 + targetBot + (cap-2) 个填充 bot；重试直到 targetBot 拿到 wantRole
 * hostRole：房主指定身份（默认：counts.wolf? 'wolf' : 'villager'） */
async function setup(cap, counts, botLevel, fillLevel, wantRole, hostRole) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const r = await api('/api/create', { name: '房主' });
    const room = r.roomId, host = r.playerId;
    await act(room, host, 'setCap', { cap });
    await act(room, host, 'add_bot', { level: botLevel });
    for (let i = 0; i < cap - 2; i++) await act(room, host, 'add_bot', { level: fillLevel });
    await act(room, host, 'settings', { sheriff: false, thief: false, tieRule: 'none', winMode: 'city', botMode: 'auto' });
    await act(room, host, 'setCounts', { counts });
    await act(room, host, 'start');
    await act(room, host, 'hostPick', { role: hostRole || (counts.wolf ? 'wolf' : 'villager') });
    await sleep(1200); // bot confirm
    const roles = {};
    const v = await st(room, host);
    for (const p of v.players) roles[p.id] = (await st(room, p.id)).my.roleKey;
    // target 必须是第一个添加的 bot（level=botLevel），角色不满足则重开
    const firstBot = v.players.find(p => p.isBot);
    if (firstBot && roles[firstBot.id] === wantRole) return { room, host, target: firstBot.id, roles, players: v.players };
    // 角色不对：解散重开
    for (const p of v.players) await api('/api/leave', { room, me: p.id }).catch(() => {});
  }
  throw new Error('setup多次开局未满足角色要求');
}

/* 夜晚驱动：等待进入夜晚 wolf step → 房主出刀 → 等待 target bot（预言家）行动；返回早晨 view */
async function night1(room, host, killTarget, isSeerBot) {
  // 等 phase=night 且轮到 wolf step（避免 reveal 未结束时出刀）
  for (let i = 0; i < 30; i++) {
    const v = await st(room, host);
    if (v.phase === 'night' && v.nightStep === 'wolf') break;
    await sleep(300);
  }
  await act(room, host, 'wolf_set', { kill: killTarget, confirm: true });
  await sleep(600);
  // 若 target 是预言家 bot：等它查验
  if (isSeerBot) await sleep(1200);
  for (let i = 0; i < 20; i++) {
    const v = await st(room, host);
    if (v.phase !== 'night') return v;
    if (v.nightStep === 'seer' && isSeerBot) { await sleep(400); continue; }
    await sleep(400);
  }
  return st(room, host);
}

/* 推进到白天讨论（morning/lastword 由房主强推） */
async function toDiscuss(room, host) {
  for (let i = 0; i < 12; i++) {
    const v = await st(room, host);
    if (v.phase === 'discuss') return v;
    if (v.phase === 'morning' || v.phase === 'lastword' || v.phase === 'handover') { try { await advance(room, host); } catch (e) {} await sleep(400); }
    else await sleep(500);
  }
  throw new Error('等待超时:到达白天发言');
}

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), PHASE_TIMEOUT: '60', NIGHT_TIMEOUT: '45', BOT_DELAY_MS: '400', CHAT_INTERVAL: '0' },
  });
  let ready = false;
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`${BASE}/healthz`); if (r.status === 200) { ready = true; break; } } catch (e) {} await sleep(200); }
  if (!ready) { console.error('服务器未就绪'); srv.kill(); process.exit(1); }
  try {
    /* ---------- A1 银水：女巫 bot 救人不投银水 ---------- */
    for (let attempt = 0; attempt < 4; attempt++) {
      const s = await setup(5, { wolf: 1, witch: 1, villager: 3 }, 'smart', 'idle', 'witch');
      const victim = s.players.find(p => p.alive && p.id !== s.host && p.id !== s.target);
      const v = await night1(s.room, s.host, victim.id, false);
      if ((v.morningDeaths || []).some(d => d.id === s.host)) { await api('/api/leave', { room: s.room, me: s.host }); continue; } // 房主夜1被刀（自刀概率）→重开
      await toDiscuss(s.room, s.host);
      await chat(s.room, s.host, '我是预言家，查杀' + victim.name); // 查杀银水
      await act(s.room, s.host, 'startVote');
      // 房主最后投票会触发结算（全员投完立即 resolve），故在投票前抓 bot 的 votedBy
      let vb = null;
      for (let i = 0; i < 12; i++) {
        const vh = await st(s.room, s.host);
        if (vh.phase !== 'vote') break;
        const f = ((vh.vote && vh.vote.votedBy) || []).find(x => x.id === s.target);
        if (f) { vb = f; break; }
        await sleep(150);
      }
      await act(s.room, s.host, 'vote', { target: victim.id }); // 房主最后一票（触发结算）
      assert(vb && vb.vote !== victim.id, 'A1 银水：女巫 bot 不投银水（' + victim.name + '）（投: ' + (vb ? (vb.vote ? '他人' : '弃票') : '未抓到') + '）');
      await api('/api/leave', { room: s.room, me: s.host }).catch(() => {});
      break;
    }

    /* ---------- A2 对跳查验：smart 预言家夜2 查验悍跳的房主（完整流程重试，容忍偶发调度竞态） ---------- */
    let a2ok = false;
    for (let attempt = 0; attempt < 5 && !a2ok; attempt++) {
      try {
        const s = await setup(5, { wolf: 1, seer: 1, villager: 3 }, 'smart', 'idle', 'seer');
        const victim = s.players.find(p => p.alive && p.id !== s.host && p.id !== s.target);
        let v = await night1(s.room, s.host, victim.id, true);
        if ((v.morningDeaths || []).some(d => d.id === s.host)) { await api('/api/leave', { room: s.room, me: s.host }); continue; }
        // 夜1 bot 查验过房主则重开（概率1/4）——view 的 seerHistory 只暴露名字，按名字判断
        const v1 = await st(s.room, s.target);
        const checkedHost = (v1.seerHistory || []).some(h => h.name === '房主');
        if (checkedHost) { await api('/api/leave', { room: s.room, me: s.host }); continue; }
        await toDiscuss(s.room, s.host);
        const y = s.players.find(p => p.alive && p.id !== s.host && p.id !== s.target && p.id !== victim.id);
        await chat(s.room, s.host, '我跳预言家，查杀' + y.name); // 悍跳
        await act(s.room, s.host, 'startVote');
        await act(s.room, s.host, 'vote', { target: y.id });
        await sleep(1500);
        try { await advance(s.room, s.host); } catch (e) {}
        // 夜2：等待 bot 查验（应查验对跳的房主）；夜2 wolf step 需房主出刀，lastword/morning 需强推
        // 注意：seerHistory 仅预言家本人可见且只暴露名字，须用 target 视角轮询
        let checked2 = null;
        for (let i = 0; i < 24; i++) {
          const v2 = await st(s.room, s.target);
          if (v2.phase === 'night' && v2.nightStep === 'wolf') {
            const t2 = v2.players.find(p => p.alive && p.id !== s.host && p.id !== s.target);
            if (t2) await act(s.room, s.host, 'wolf_set', { kill: t2.id, confirm: true });
          } else if (v2.phase === 'lastword' || v2.phase === 'morning') {
            try { await advance(s.room, s.host); } catch (e) {}
          }
          const h2 = (v2.seerHistory || []).filter(h => h.night === 2);
          if (h2.length) { checked2 = h2[0].name; break; }
          if (v2.phase !== 'night' && i > 3) break;
          await sleep(400);
        }
        assert(checked2 === '房主', 'A2 对跳查验：预言家 bot 夜2 查验悍跳者' + (checked2 ? '（实际验了：' + checked2 + '）' : '（未查验）'));
        a2ok = checked2 === '房主';
        await api('/api/leave', { room: s.room, me: s.host }).catch(() => {});
      } catch (e) {
        // 偶发调度竞态 → 重试（leave 旧房间）
        try { await api('/api/leave', { room: s.room, me: s.host }); } catch (e2) {}
      }
    }

    /* ---------- A4 发言模拟：smart 预言家白天报查验 ---------- */
    for (let attempt = 0; attempt < 4; attempt++) {
      const s = await setup(5, { wolf: 1, seer: 1, villager: 3 }, 'smart', 'idle', 'seer');
      const victim = s.players.find(p => p.alive && p.id !== s.host && p.id !== s.target);
      let v = await night1(s.room, s.host, victim.id, true);
      if ((v.morningDeaths || []).some(d => d.id === s.host)) { await api('/api/leave', { room: s.room, me: s.host }); continue; }
      await toDiscuss(s.room, s.host);
      await sleep(1500); // 等 bot 发言（BOT_DELAY_MS=400 + 发言批次）
      const vd = await st(s.room, s.host);
      const talk = (vd.chat || []).find(m => m.from === s.target && m.text && m.text.includes('我是预言家'));
      assert(!!talk, 'A4 发言模拟：smart 预言家白天报查验（' + (talk ? talk.text : '未发言') + '）');
      await api('/api/leave', { room: s.room, me: s.host }).catch(() => {});
      break;
    }

    /* ---------- A5 悍跳：smart 狼白天悍跳预言家 ---------- */
    for (let attempt = 0; attempt < 6; attempt++) {
      const s = await setup(5, { wolf: 1, seer: 1, villager: 3 }, 'smart', 'idle', 'wolf', 'seer'); // 房主=预言家
      // 夜1：狼 bot 出刀（随机），房主（预言家）查验
      await sleep(1500);
      let v = await st(s.room, s.host);
      if (v.phase === 'night') {
        if (v.nightStep === 'seer') await act(s.room, s.host, 'seer_pick', { target: s.players.find(p => p.id !== s.host && p.id !== s.target).id });
        for (let i = 0; i < 20; i++) { v = await st(s.room, s.host); if (v.phase !== 'night') break; await sleep(400); }
      }
      if ((v.morningDeaths || []).some(d => d.id === s.host)) { await api('/api/leave', { room: s.room, me: s.host }); continue; }
      await toDiscuss(s.room, s.host);
      await sleep(1500);
      const vd = await st(s.room, s.host);
      const talk = (vd.chat || []).find(m => m.from === s.target && m.text && m.text.includes('我是预言家'));
      assert(!!talk, 'A5 悍跳：smart 狼白天悍跳预言家（' + (talk ? talk.text : '未悍跳') + '）');
      await api('/api/leave', { room: s.room, me: s.host }).catch(() => {});
      break;
    }

    /* ---------- A6 挂机沉默：idle bot 白天不发言 ---------- */
    const s6 = await setup(5, { wolf: 1, villager: 4 }, 'idle', 'idle', 'villager');
    await sleep(1200);
    await act(s6.room, s6.host, 'wolf_set', { kill: s6.players.find(p => p.id !== s6.host).id, confirm: true });
    await sleep(800);
    let v6 = await st(s6.room, s6.host);
    for (let i = 0; i < 20 && v6.phase === 'night'; i++) { v6 = await st(s6.room, s6.host); await sleep(400); }
    await toDiscuss(s6.room, s6.host);
    await sleep(2500);
    const vd6 = await st(s6.room, s6.host);
    const botTalked = (vd6.chat || []).some(m => m.from && m.from !== s6.host && !m.marker);
    assert(!botTalked, 'A6 挂机沉默：idle bot 白天不发言');
    await api('/api/leave', { room: s6.room, me: s6.host }).catch(() => {});

    /* ---------- A3 魅惑策略（决策层单元） ---------- */
    const { createBotDecision } = require('../bot-brain.js');
    const mkRoom = () => ({
      players: [
        { id: 'W', name: '狼A', role: 'wolf', alive: true, isBot: true, botLevel: 'smart' },
        { id: 'B', name: '狼B', role: 'wolfBeauty', alive: true, isBot: true, botLevel: 'smart' },
        { id: 'H', name: '声称者', role: 'villager', alive: true, isBot: false },
        { id: 'X', name: '好人X', role: 'villager', alive: true, isBot: true, botLevel: 'idle' },
        { id: 'Y', name: '好人Y', role: 'villager', alive: true, isBot: true, botLevel: 'idle' },
      ],
      settings: { counts: { wolf: 1, wolfBeauty: 1, villager: 3 }, botMode: 'auto' },
      phase: 'night', nightStep: 'wolf', nightNum: 2, dayNum: 1,
      night: { wolf: { kill: null, charm: null, sel: {} } },
      guardLast: null, witchPots: { saveUsed: true, poisonUsed: true },
      seerHistory: [], votes: {}, lastVoteResult: null, pkTied: null, candidates: [],
      lovers: null, wolfPackMemory: {},
      messages: [{ id: 'm1', ch: 'all', from: 'H', text: '我跳预言家，查杀狼B', marker: null, ts: 1 }],
    });
    const room3 = mkRoom();
    const dec3 = createBotDecision(room3, room3.players[0]); // 狼A 决策
    assert(dec3 && dec3.action === 'wolf_set' && !!dec3.data.charm, 'A3 魅惑：smart 狼会选魅惑目标');
    assert(dec3.data.charm !== dec3.data.kill, 'A3 魅惑：不魅惑刀目标');
    assert(dec3.data.charm !== 'B' && dec3.data.charm !== 'W', 'A3 魅惑：不魅惑狼队成员');
    assert(dec3.data.kill === 'H', 'A3 魅惑：优先刀可信预言家（声称查杀真狼者）');

  } catch (e) { failures++; console.error('!!异常: ' + ((e && e.stack) || e)); }
  finally { srv.kill(); }
  await sleep(300);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\nbot 高阶能力全部通过 ✔');
  process.exit(0);
}
main();
