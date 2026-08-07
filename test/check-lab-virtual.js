'use strict';
/* 1.7.1 守卫：虚拟时间加速 + 确定性（L2 级）
 * 守卫1：一局真实 ≥30s 的对局，墙钟必须 <3s（虚拟时间加速生效）
 * 守卫2：同 seed 两遍，事件流 hash 逐字节一致（确定性保持）
 * 运行：node test/check-lab-virtual.js */
process.env.CHAT_INTERVAL = '0';
const assert = require('assert');
const crypto = require('crypto');
const clock = require('../server/clock.js');
const { runOneLabGame } = require('./lab/core/room-runner.js');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
// 归一化：玩家 uid 每局不同，对比前 id→seat（deterministic scenario 同款）
function norm(rec) {
  const seatOf = id => { const pl = rec.players.find(x => x.id === id); return pl ? pl.seat : id; };
  const normKey = k => (typeof k === 'string' && seatOf(k) !== k) ? seatOf(k) : k; // v4.2：speech 事件 counts 以 player id 作对象 key——key 也须归一化
  const normData = d => { const o = {}; for (const k of Object.keys(d)) { const v = d[k];
    if (Array.isArray(v)) o[normKey(k)] = v.map(x => (typeof x === 'string') ? (seatOf(x) !== x ? seatOf(x) : x) : (x && typeof x === 'object' ? normData(x) : x));
    else if (typeof v === 'string' && seatOf(v) !== v) o[normKey(k)] = seatOf(v);
    else if (v && typeof v === 'object') o[normKey(k)] = normData(v);
    else o[normKey(k)] = v; } return o; };
  return rec.events.map(e => ({ t: e.t, night: e.night, actor: e.actor ? seatOf(e.actor) : null, target: e.target ? seatOf(e.target) : null, data: normData(e.data || {}) }));
}

async function main() {
  // 守卫1：虚拟时间对局墙钟 < 3s
  clock.setMode('virtual');
  const t0 = Date.now();
  const rec = await runOneLabGame({ cap: 8, counts: { wolf: 2, seer: 1, witch: 1, villager: 4 }, winMode: 'edge', botLevel: 'simulate', seed: 'guard-1', gameId: 'g-1' });
  const wall = Date.now() - t0;
  assert(wall < 3000, `守卫1墙钟 ${wall}ms（应 <3s）`);
  assert(rec.result.winner, '守卫1对局应正常终局');

  // 守卫2：同 seed 两遍事件流 hash 一致
  clock.setMode('virtual');
  const a = await runOneLabGame({ cap: 8, counts: { wolf: 2, seer: 1, witch: 1, villager: 4 }, seed: 'det-1', gameId: 'd-1' });
  const b = await runOneLabGame({ cap: 8, counts: { wolf: 2, seer: 1, witch: 1, villager: 4 }, seed: 'det-1', gameId: 'd-2' });
  assert.strictEqual(hash(JSON.stringify(norm(a))), hash(JSON.stringify(norm(b))), '守卫2同 seed 事件流 hash 应一致');

  console.log(`✓ L2守卫：虚拟时间对局墙钟 ${wall}ms（<3s），winner=${rec.result.winner}`);
  console.log(`✓ L2守卫：同 seed 两遍事件流 hash 一致（${a.events.length} 条事件）`);
  console.log('共 2 处守卫断言全部通过');
  process.exit(0);
}
main().catch(e => { console.error('✗ FAIL: ' + e.message); process.exit(1); });
