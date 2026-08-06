'use strict';
/* 并发池 + seed 派生 + 进度/ETA + checkpoint 续跑
 * seed 派生：`${seedBase}-${i}`（配对/确定性模式的关键——同 base 同序 → 同种子）
 * v1.7.2（A-4）：虚拟模式下强制 parallel=1——clock 是单例，并发房间共享同一虚拟队列/now，
 * 交叉 tickNext 会串房；且一局虚拟时间 ~10ms 墙钟，并发无收益（2000 局串行约 20s）。
 */
const clock = require('../../../server/clock');
async function runPool(total, parallel, fn, { seedBase = null, doneSet = null, onProgress = null } = {}) {
  const effParallel = clock.isVirtual() ? 1 : Math.min(parallel, Math.max(1, total)); // v1.7.2（A-4）
  const results = new Array(total);
  let next = 0, finished = 0;
  const t0 = Date.now();
  const workers = Array.from({ length: effParallel }, async () => {
    while (next < total) {
      const i = next++;
      const seed = seedBase ? `${seedBase}-${i}` : null;
      const key = seed || `g${i}`;
      if (doneSet && doneSet.has(key)) { results[i] = null; continue; } // checkpoint 跳过已完成的局
      results[i] = await fn(i, seed);
      finished++;
      if (onProgress) onProgress(finished, total, Date.now() - t0);
    }
  });
  await Promise.all(workers);
  return results.filter(r => r !== null);
}
module.exports = { runPool };
