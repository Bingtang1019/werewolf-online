'use strict';
/* 临时调试：bot1 角色分布（setup 复现） */
const { spawn } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const PORT = 8136;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(p, body) { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return r.json(); }
async function act(room, me, action, data) { const r = await api('/api/action', { room, me, action, data: data || {} }); if (r.error) throw new Error(action + '失败: ' + r.error); return r.view; }
(async () => {
  const srv = spawn(process.execPath, [path.join(root, 'server.js')], { env: { ...process.env, SNAPSHOT_SEC: '0', PORT: String(PORT), BOT_DELAY_MS: '200' } });
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`${BASE}/healthz`); if (r.status === 200) break; } catch (e) {} await sleep(200); }
  const hits = {};
  for (let attempt = 0; attempt < 10; attempt++) {
    const r = await api('/api/create', { name: '房主' });
    const room = r.roomId, host = r.playerId;
    await act(room, host, 'add_bot', { level: 'smart' });
    for (let i = 0; i < 3; i++) await act(room, host, 'add_bot', { level: 'idle' });
    await act(room, host, 'setCounts', { counts: { wolf: 1, seer: 1, villager: 3 } });
    await act(room, host, 'settings', { sheriff: false, thief: false, tieRule: 'none', winMode: 'city', botMode: 'idle' });
    await act(room, host, 'setCap', { cap: 5 });
    await act(room, host, 'start');
    await act(room, host, 'hostPick', { role: 'seer' });
    await sleep(800);
    const v = await (await fetch(`${BASE}/api/state?room=${room}&me=${host}`)).json();
    const roles = {};
    for (const p of v.players) { const pv = await (await fetch(`${BASE}/api/state?room=${room}&me=${p.id}`)).json(); roles[p.id] = pv.my.roleKey; }
    const botIds = v.players.filter(p => p.isBot).map(p => p.id);
    hits[roles[botIds[0]] || '?'] = (hits[roles[botIds[0]] || '?'] || 0) + 1;
    console.log(`attempt${attempt + 1}: bot1=${roles[botIds[0]]} host=${roles[host]}`);
    for (const id of botIds) await api('/api/leave', { room, me: id });
    await api('/api/leave', { room, me: host });
  }
  console.log('分布:', JSON.stringify(hits));
  srv.kill();
  process.exit(0);
})().catch(e => { console.error('异常:', e.message); process.exit(1); });
