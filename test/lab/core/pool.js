'use strict';
/* 并发池 + seed 派生 + 进度/ETA + checkpoint 续跑
 * seed 派生：`${seedBase}-${i}`（配对/确定性模式的关键——同 base 同序 → 同种子）
 */
async function runPool(total, parallel, fn, { seedBase = null, doneSet = null, onProgress = null } = {}) {
  const results = new Array(total);
  let next = 0, finished = 0;
  const t0 = Date.now();
  const workers = Array.from({ length: Math.min(parallel, Math.max(1, total)) }, async () => {
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
