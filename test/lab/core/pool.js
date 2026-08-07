'use strict';
/* 并发池 + seed 派生 + 进度/ETA + checkpoint 续跑
 * seed 派生：`${seedBase}-${i}`（配对/确定性模式的关键——同 base 同序 → 同种子）
 * v1.7.2（A-4）：虚拟模式下强制 parallel=1——clock 是单例，并发房间共享同一虚拟队列/now，
 * 交叉 tickNext 会串房；且一局虚拟时间 ~10ms 墙钟，并发无收益（2000 局串行约 20s）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
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
/* =========================================================================
 * v1.8.0：worker_threads 分片并行跑批（lab 吞吐根治）
 *   原理：虚拟时钟单例冲突只在进程内——worker 进程隔离 → 虚拟/真实模式皆可并行。
 *   核数：默认 os.cpus().length（动态，不硬编码），opts.parallel 可覆盖。
 *   写盘：统一在主线程（gameRecord/sample/done 追加）——多 worker 无竞态。
 *   checkpoint：doneSet 启动读一次 → 分片过滤；每局完成即时追加 done 行（崩溃可续）。
 *   采样：worker 模式 flushSamples=false（room-runner）→ 样本随 GameRecord 回传 → 主线程写。
 * ========================================================================= */
async function runPoolParallel(total, opts = {}) {
  const { tag, outDir, baseCfg = {}, seedBase = null, sampleFile = null, mode = 'virtual' } = opts;
  const n = Math.max(1, Math.min(opts.parallel || os.cpus().length, Math.max(1, total)));
  fs.mkdirSync(outDir, { recursive: true });
  // checkpoint：读 done 文件 → 跳过已完成局
  const donePath = path.join(outDir, `done-${tag}.txt`);
  const doneSet = new Set();
  try { for (const line of fs.readFileSync(donePath, 'utf8').split('\n')) { const t = line.trim(); if (t) doneSet.add(t); } } catch (e) { /* 首次跑批 */ }
  const jobs = [];
  for (let i = 0; i < total; i++) {
    const seed = seedBase ? `${seedBase}-${i}` : `g${i}`;
    if (doneSet.has(seed)) continue;
    jobs.push({ i, seed, cfg: { ...baseCfg, seed, gameId: `${tag}-${i}`, sampleFile, flushSamples: false } });
  }
  if (!jobs.length) return [];
  const jobByI = new Map(jobs.map(j => [j.i, j]));
  // 连续分片
  const slices = Array.from({ length: n }, () => []);
  jobs.forEach((j, idx) => slices[idx % n].push(j));
  const results = new Array(total);
  const t0 = Date.now();
  let finished = 0;
  await Promise.all(slices.filter(s => s.length).map(slice => new Promise((resolve) => {
    const w = new Worker(path.join(__dirname, 'lab-worker.js'), { workerData: { jobs: slice, mode } });
    w.on('message', (msg) => {
      if (msg.type === 'done') {
        const { i, rec } = msg;
        results[i] = rec;
        try {
          fs.appendFileSync(path.join(outDir, `${tag}.jsonl`), JSON.stringify(rec) + '\n');
          if (sampleFile && rec.samples && rec.samples.length) fs.appendFileSync(sampleFile, rec.samples.join('\n') + '\n');
          const job = jobByI.get(i);
          if (job) fs.appendFileSync(donePath, job.seed + '\n');
        } catch (e) { /* 写盘失败不中断（下局重试） */ }
        finished++;
        if (opts.onProgress) opts.onProgress(finished, jobs.length, Date.now() - t0);
      } else if (msg.type === 'finish') { resolve(); }
      else if (msg.type === 'error') { console.error('[lab] worker error:', msg.err); resolve(); }
    });
    w.on('error', (e) => { console.error('[lab] worker crash:', e); resolve(); });
  })));
  return results.filter(r => r != null);
}

module.exports = { runPool, runPoolParallel };
