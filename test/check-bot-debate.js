'use strict';
/* bot 辩论/穿衣服/气氛发言（v1.4.4）
 * B1 对跳辩论：真人悍跳预言家 → smart 预言家 bot 白天次发言反驳（"悍跳/乱带节奏"）
 * B2 狼夜频道：smart 狼 bot 夜晚出刀/确认后在狼频道发言（真人狼可见）
 * B3 遗言：smart 预言家 bot 被刀后发遗言（"我是预言家…"）
 * 运行：node test/check-bot-debate.js
 */
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8171;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(p, body) { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return r.json(); }
async function act(room, me, action, data) { const r = await api('/api/action', { room, me, action, data: data || {} }); if (r.error) throw new Error(action + '失败: ' + r.error); return r.view; }
async function st(room, me) { return (await fetch(`${BASE}/api/state?room=${room}&me=${me}&chatSince=0`)).json(); }
async function chat(room, me, text) { const r = await api('/api/chat', { room, me, data: { ch: 'all', text } }); if (r.error) throw new Error('发言失败: ' + r.error); }
async function advance(room, host) { const r = await api('/api/advance', { room, me: host }); if (r.error) throw new Error('advance失败: ' + r.error); }

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
    await sleep(1200);
    const v = await st(room, host);
    const roles = {};
    for (const p of v.players) roles[p.id] = (await st(room, p.id)).my.roleKey;
    const firstBot = v.players.find(p => p.isBot);
    if (firstBot && roles[firstBot.id] === wantRole) return { room, host, target: firstBot.id, roles, players: v.players };
    for (const p of v.players) await api('/api/leave', { room, me: p.id }).catch(() => {});
  }
  throw new Error('setup多次开局未满足角色要求');
}
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
    env: { ...process.env, SNAPSHOT_SEC: '0', PORT: String(PORT), PHASE_TIMEOUT: '60', NIGHT_TIMEOUT: '45', BOT_DELAY_MS: '400', CHAT_INTERVAL: '0', BOT_DEBUG: '1' },
  });
  let srvOut = '';
  srv.stdout.on('data', d => srvOut += d);
  srv.stderr.on('data', d => srvOut += d);
  let ready = false;
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`${BASE}/healthz`); if (r.status === 200) { ready = true; break; } } catch (e) {} await sleep(200); }
  if (!ready) { console.error('服务器未就绪'); srv.kill(); process.exit(1); }
  try {
    /* ---------- B1 对跳辩论：真人悍跳 → 预言家 bot 次发言反驳（完整流程重试，容忍偶发调度竞态） ---------- */
    let b1ok = false;
    for (let attempt = 0; attempt < 6 && !b1ok; attempt++) {
      try {
        const s = await setup(5, { wolf: 1, seer: 1, villager: 3 }, 'smart', 'idle', 'seer');
        const victim = s.players.find(p => p.alive && p.id !== s.host && p.id !== s.target);
        // 夜1：房主刀 victim，bot 查验
        for (let i = 0; i < 30; i++) { const vv = await st(s.room, s.host); if (vv.phase === 'night' && vv.nightStep === 'wolf') break; await sleep(300); }
        await act(s.room, s.host, 'wolf_set', { kill: victim.id, confirm: true });
        let v = null;
        for (let i = 0; i < 30; i++) { v = await st(s.room, s.host); if (v.phase !== 'night') break; await sleep(400); }
        if ((v.morningDeaths || []).some(d => d.id === s.host)) { await api('/api/leave', { room: s.room, me: s.host }); continue; }
        await toDiscuss(s.room, s.host);
        const y = s.players.find(p => p.alive && p.id !== s.host && p.id !== s.target && p.id !== victim.id);
        await chat(s.room, s.host, '我跳预言家，查杀' + y.name); // 悍跳
        await sleep(2500); // 等 bot 主发言 + 次发言（辩论）
        const vd = await st(s.room, s.host);
        const debate = (vd.chat || []).find(m => m.from === s.target && m.text && (m.text.includes('悍跳') || m.text.includes('乱带节奏') || m.text.includes('带偏') || m.text.includes('标狼')));
        b1ok = !!debate; // v1.5.6：循环内不 assert（失败尝试只 continue），循环外统一断言
        await api('/api/leave', { room: s.room, me: s.host }).catch(() => {});
      } catch (e) {
        try { await api('/api/leave', { room: s.room, me: s.host }); } catch (e2) {}
      }
    }
    if (!b1ok) assert(false, 'B1 对跳辩论：预言家 bot 未反驳悍跳');

    /* ---------- B2 狼夜频道：smart 狼 bot 夜晚狼频道发言（server 日志确认——狼频道消息仅在夜晚可见，而 bot confirm 后立即进入早晨，view 窗口 <1 个 HTTP 往返，黑盒 view 断言必然错过） ---------- */
    for (let attempt = 0; attempt < 8; attempt++) {
      const s = await setup(5, { wolf: 2, villager: 3 }, 'smart', 'idle', 'wolf'); // 房主=狼真人 + smart 狼 bot
      for (let i = 0; i < 30; i++) { const vv = await st(s.room, s.host); if (vv.phase === 'night' && vv.nightStep === 'wolf') break; await sleep(300); }
      const t2 = s.players.find(p => p.alive && p.id !== s.host && p.id !== s.target);
      await act(s.room, s.host, 'wolf_set', { kill: t2.id, confirm: true });
      await sleep(1200); // 等狼 bot 出刀 + 狼频道发言（server 日志）
      const wolfTalk = /狼频道: \{"action":"chat","data":\{"ch":"wolf"/.test(srvOut);
      assert(wolfTalk, 'B2 狼夜频道：狼 bot 夜晚在狼频道发言（server 日志确认）');
      await api('/api/leave', { room: s.room, me: s.host }).catch(() => {});
      break;
    }

    /* ---------- B3 遗言：smart 预言家 bot 被刀后发遗言 ---------- */
    let b3ok = false;
    for (let attempt = 0; attempt < 10 && !b3ok; attempt++) {
      try {
        const s = await setup(5, { wolf: 1, seer: 1, villager: 3 }, 'smart', 'idle', 'seer');
        const victim = s.players.find(p => p.alive && p.id !== s.host && p.id !== s.target);
        for (let i = 0; i < 30; i++) { const vv = await st(s.room, s.host); if (vv.phase === 'night' && vv.nightStep === 'wolf') break; await sleep(300); }
        await act(s.room, s.host, 'wolf_set', { kill: victim.id, confirm: true });
        let v = null;
        for (let i = 0; i < 30; i++) { v = await st(s.room, s.host); if (v.phase !== 'night') break; await sleep(400); }
        if ((v.morningDeaths || []).some(d => d.id === s.host)) { await api('/api/leave', { room: s.room, me: s.host }); continue; }
        await toDiscuss(s.room, s.host);
        await act(s.room, s.host, 'startVote');
        await sleep(1200); // 等 bot 投票
        try { await advance(s.room, s.host); } catch (e) {} // 结算（可能无人出局 → 直接夜2；或放逐某人 → lastword）
        // 夜2：房主刀预言家 bot → 早晨 bot 死 → lastword 遗言（遗言不依赖验谁，只要 bot 有查验记录即可）
        for (let i = 0; i < 30; i++) {
          const v2 = await st(s.room, s.target);
          if (v2.phase === 'night' && v2.nightStep === 'wolf') {
            await act(s.room, s.host, 'wolf_set', { kill: s.target, confirm: true });
          } else if (v2.phase === 'lastword' || v2.phase === 'morning') {
            try { await advance(s.room, s.host); } catch (e) {}
          }
          const lm = (v2.chat || []).find(m => m.from === s.target && m.text && m.text.includes('我是预言家'));
          if (lm) { assert(true, 'B3 遗言：预言家 bot 遗言（' + lm.text.slice(0, 30) + '…）'); b3ok = true; break; }
          if (v2.phase === 'ended') break;
          await sleep(400);
        }
        await api('/api/leave', { room: s.room, me: s.host }).catch(() => {});
      } catch (e) {
        try { await api('/api/leave', { room: s.room, me: s.host }); } catch (e2) {}
      }
    }
    if (!b3ok) assert(false, 'B3 遗言：预言家 bot 被刀后未发遗言');

  } catch (e) { failures++; console.error('!!异常: ' + ((e && e.stack) || e)); }
  finally { srv.kill(); }
  await sleep(300);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\nbot 辩论/穿衣服/气氛发言全部通过 ✔');
  process.exit(0);
}
main();
