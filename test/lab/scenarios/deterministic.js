'use strict';
/* deterministic：B1-0 验收——同 seed 跑两遍（gameId 区分 a/b 遍，种子相同），事件流 hash 逐字节一致。
 * 前置：B1-8 显式 RNG 注入已落地（本库 room-runner 每局 seed 注入）→ 两遍应一致；若不一致即回归信号。
 */
const crypto = require('crypto');
const { runOneLabGame } = require('../core/room-runner');
const { runPool } = require('../core/pool');

async function run(cfg) {
  const seedBase = cfg.seed || 'det';
  const run1 = await runPool(cfg.games, 1, (i) => runOneLabGame(Object.assign({}, cfg, { seed: `${seedBase}-${i}`, gameId: `det-a-${i}` })));
  const run2 = await runPool(cfg.games, 1, (i) => runOneLabGame(Object.assign({}, cfg, { seed: `${seedBase}-${i}`, gameId: `det-b-${i}` })));
  // 对比前归一化：玩家 uid 每局不同（crypto 随机）→ 映射到座位号（同配置两遍座位分配一致）
  const norm = (rec) => {
    const seatOf = id => { const p = (rec.players || []).find(x => x.id === id); return p ? p.seat : id; };
    const normVal = (v) => {
      if (Array.isArray(v)) return v.map(normVal);
      if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = normVal(v[k]); return o; }
      if (typeof v === 'string' && seatOf(v) !== v) return seatOf(v);
      return v;
    };
    return (rec.events || []).map(e => ({ ...e, actor: e.actor ? seatOf(e.actor) : null, target: e.target ? seatOf(e.target) : null, data: normVal(e.data) }));
  };
  let same = 0, diffAt = -1;
  for (let i = 0; i < run1.length; i++) {
    const h1 = crypto.createHash('sha256').update(JSON.stringify(norm(run1[i]))).digest('hex');
    const h2 = crypto.createHash('sha256').update(JSON.stringify(norm(run2[i]))).digest('hex');
    if (h1 === h2) same++;
    else if (diffAt < 0) diffAt = i;
  }
  console.log(`[deterministic] 事件流 hash（id→座位归一化后）一致 ${same}/${run1.length}`);
  if (same === run1.length) console.log('✔ 同种子对局事件流逐字节一致（B1-8 RNG 注入生效）');
  else {
    console.log(`✗ 第 ${diffAt + 1} 局起不一致——检查：①RNG 注入是否彻底；②驱动是否仍有调度竞态（room-runner 已确定性驱动）`);
    console.log('  A 事件条数:', run1[diffAt] ? run1[diffAt].events.length : '?', ' B:', run2[diffAt] ? run2[diffAt].events.length : '?');
    process.exitCode = 1;
  }
}
module.exports = { run };
