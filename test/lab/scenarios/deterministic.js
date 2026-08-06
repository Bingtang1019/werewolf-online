'use strict';
/* deterministic：B1-0 验收——同 seed 跑两遍（a/b 两个独立任务，跨进程并行），事件流 hash 逐字节一致。
 * 前置：B1-8 显式 RNG 注入（room-runner 每局 seed 注入）→ 两遍应一致；跨进程隔离下一致才是真一致。 */
const crypto = require('crypto');
const { runOneLabGame } = require('../core/room-runner');

function planTasks(cfg) {
  const seedBase = cfg.seed || 'det';
  let i = -1, half = 1;
  return {
    total: cfg.games * 2, // a/b 两遍 = 两个独立任务（两遍从串行变并行）
    next() {
      if (++half >= 2) { half = 0; i++; }
      if (i >= cfg.games) return null;
      const isA = half === 0;
      return { id: `det-${i}-${isA ? 'a' : 'b'}`, gameId: `det-${i}-${isA ? 'a' : 'b'}`, seed: `${seedBase}-${i}`, full: true }; // 需要 events 做 hash
    },
  };
}
function norm(rec) {
  const seatOf = id => { const p = (rec.players || []).find(x => x.id === id); return p ? p.seat : id; };
  const normVal = (v) => {
    if (Array.isArray(v)) return v.map(normVal);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = normVal(v[k]); return o; }
    if (typeof v === 'string' && seatOf(v) !== v) return seatOf(v);
    return v;
  };
  return (rec.events || []).map(e => ({ ...e, actor: e.actor ? seatOf(e.actor) : null, target: e.target ? seatOf(e.target) : null, data: normVal(e.data) }));
}
function report(records, cfg) {
  const byIdx = {};
  for (const r of records) {
    const m = String(r.gameId).match(/^det-(\d+)-([ab])$/);
    if (m) byIdx[Number(m[1]) + (m[2] === 'a' ? 0 : 100000)] = r;
  }
  let same = 0, n = 0, diffAt = -1;
  for (const k of Object.keys(byIdx)) {
    const idx = Number(k);
    if (idx >= 100000) continue;
    const r1 = byIdx[idx], r2 = byIdx[idx + 100000];
    if (!r2) continue;
    n++;
    const h1 = crypto.createHash('sha256').update(JSON.stringify(norm(r1))).digest('hex');
    const h2 = crypto.createHash('sha256').update(JSON.stringify(norm(r2))).digest('hex');
    if (h1 === h2) same++; else if (diffAt < 0) diffAt = idx;
  }
  console.log(`[deterministic] 事件流 hash（id→座位归一化后）一致 ${same}/${n}`);
  if (same === n) console.log('✔ 同种子对局事件流逐字节一致（B1-8 RNG 注入生效，跨进程并行下仍一致）');
  else {
    console.log(`✗ 第 ${diffAt + 1} 局起不一致——检查：①RNG 注入是否彻底；②驱动是否仍有调度竞态`);
    process.exitCode = 1;
  }
}
async function run(cfg) {
  const gen = planTasks(cfg);
  const records = [];
  for (let t = gen.next(); t; t = gen.next()) {
    if (t.skip) continue;
    const r = await runOneLabGame(Object.assign({}, cfg, t.overrides || {}, { seed: t.seed, gameId: t.gameId }));
    records.push(r);
  }
  report(records, cfg);
}
module.exports = { run, planTasks, report };
