'use strict';
/* =========================================================================
 * mpool.js —— 多进程对局池（零依赖，child_process.fork）
 * 动机：虚拟模式下 clock 是进程内单例（pool.js 强制 parallel=1），
 *       跨进程各自持有独立 clock / 全局 RNG → 进程级并行是唯一正确的扩容方式。
 * master：任务分发（pull）、wall-clock 超时、失败/崩溃重试（seed 决定论 → 幂等）、进度回执
 * worker：fork 自身（--mpool-worker），一任务一局
 * 协议 v1：
 *   w→m: {type:'ready'} | {type:'done', id, gameId, seed, record}
 *        | {type:'fail', id, error}
 *   m→w: {type:'task', v:1, cfg, task:{id, gameId, seed, overrides?, full?}}
 * ========================================================================= */
const { fork } = require('child_process');
const os = require('os');

const SELF = __filename;
const IS_WORKER = process.argv.includes('--mpool-worker');

if (IS_WORKER) runWorker();
else module.exports = { runMPool };

/* ---------------- worker 侧 ---------------- */
function runWorker() {
  // ★ 坑：worker 是独立进程，必须自行设置虚拟环境（lab.js 的 env 设置不会跨进程）
  // env 须在 require game.js 之前（room-runner 在下方延迟 require，安全）
  process.env.BOT_DELAY_MS = '100';
  process.env.PHASE_TIMEOUT = '30';
  process.env.NIGHT_TIMEOUT = '20';
  process.env.CHAT_INTERVAL = '0';
  const clock = require('../../../server/clock'); // core/ → test/ → 项目根 → server/clock
  clock.setMode('virtual');
  const { runOneLabGame } = require('./room-runner');

  process.on('message', async (msg) => {
    if (msg.type !== 'task') return;
    const { cfg, task } = msg;
    try {
      // vote 样本采集：多 worker 并发 append 同一文件会交错损坏 → 每 worker 独立文件
      const cfg2 = Object.assign({}, cfg);
      if (cfg2.sampleFile) cfg2.sampleFile = `${cfg2.sampleFile}.${process.pid}`;
      const rec = await runOneLabGame(Object.assign({}, cfg2, task.overrides || {}, {
        seed: task.seed, gameId: task.gameId,
      }));
      process.send({ type: 'done', id: task.id, gameId: task.gameId, seed: task.seed,
        record: task.full ? rec : Object.assign({}, rec, { events: [] }) }); // 摘要模式剥事件
    } catch (e) {
      process.send({ type: 'fail', id: task.id, error: (e && (e.msg || e.message)) || String(e) });
    }
  });
  process.send({ type: 'ready' }); // 启动即就绪；后续由 master 在 done/fail 后派发
}

/* ---------------- master 侧 ---------------- */
/**
 * runMPool({ gen, cfg, onResult, workers, taskTimeoutMs, maxRetry })
 *   gen: { total, next() } —— next() 返回 {id, gameId, seed, overrides?, full?} | {skip:true} | null
 *   onResult: 每个终态（done/fail/skip）调一次；done 带 record
 */
function runMPool({ gen, cfg, onResult, workers = 'auto', taskTimeoutMs = 120000, maxRetry = 2 }) {
  return new Promise((resolve) => {
    const poolSize = workers === 'auto' ? Math.max(1, os.cpus().length - 1) : Math.max(1, Number(workers) || 1);
    // v1.7.6 第二部分：CONCURRENCY_PER_WORKER——每 worker 可多 in-flight（真实模式跑局交错收益）；虚拟模式强制 1（clock 进程内单例，并发串房）
    let conc = 1;
    try { const clock = require('../../../server/clock'); conc = clock.isVirtual() ? 1 : Math.max(1, Number(cfg.conc) || 1); } catch (e) { conc = 1; }
    const total = gen.total;
    const pending = [];
    const retries = new Map();    // taskId -> 已重试次数
    const inflight = new Map();   // worker -> [{task, sentAt}]（支持 conc 个 in-flight）
    const crashReason = new Map();// worker -> 崩溃原因（超时等）
    const pool = new Set();
    let done = 0, exhausted = 0, finished = false;
    let statTimeout = 0, statRetry = 0; // v4.2：超时/重试统计（诊断"误杀 vs 真卡死"）

    const refill = () => {
      while (pending.length < poolSize * 4) {
        const t = gen.next();
        if (!t) break;
        if (t.skip) { done++; onResult({ type: 'skip', gameId: t.gameId }); tryFinish(); continue; } // checkpoint 跳过（计入完成，并尝试收尾）
        pending.push({ task: t, retries: 0 });
      }
    };
    const take = () => { refill(); return pending.shift() || null; };
    const tryFinish = () => {
      if (finished || done + exhausted < total) return;
      finished = true;
      clearInterval(timer);
      if (statTimeout || statRetry) console.log(`\n[mpool] 诊断：墙钟超时 ${statTimeout} 次、重试 ${statRetry} 次、耗尽 ${exhausted} 任务（超时多 → task-timeout 偏小或推理慢；仅偶发 → 正常自愈）`);
      for (const w of pool) w.kill('SIGKILL');
      resolve();
    };
    const dispatch = (w) => {
      const list = inflight.get(w);
      if (list && list.length >= conc) return;
      const it = take();
      if (!it) return;
      if (!list) inflight.set(w, []);
      inflight.get(w).push({ task: it.task, sentAt: Date.now() });
      w.send({ type: 'task', v: 1, cfg, task: it.task });
    };
    const requeue = (task, why) => {
      const r = (retries.get(task.id) || 0) + 1;
      statRetry++; // v4.2：诊断统计
      if (r > maxRetry) { exhausted++; onResult({ type: 'fail', id: task.id, error: `${why}（重试耗尽）` }); return; }
      retries.set(task.id, r);
      pending.unshift({ task, retries: r }); // 重试优先
    };
    const spawn = () => {
      const w = fork(SELF, ['--mpool-worker'], { stdio: 'inherit' });
      pool.add(w);
      w.on('message', (msg) => {
        if (msg.type === 'ready') { dispatch(w); return; }
        const list = inflight.get(w) || [];
        const cur = list.find(x => x.task.id === msg.id) || null;
        if (msg.type === 'done') {
          list.splice(list.indexOf(cur), 1); if (!list.length) inflight.delete(w);
          done++;
          onResult(msg);
          dispatch(w); tryFinish();
        } else if (msg.type === 'fail') {
          list.splice(list.indexOf(cur), 1); if (!list.length) inflight.delete(w);
          if (cur) requeue(cur.task, `fail: ${msg.error}`);
          dispatch(w); tryFinish();
        }
      });
      w.on('exit', (code) => {
        pool.delete(w);
        const list = inflight.get(w);
        if (list && list.length) {
          inflight.delete(w);
          const why = crashReason.get(w) || `worker 崩溃(${code})`;
          for (const x of list) requeue(x.task, why);
        }
        crashReason.delete(w);
        refill();
        if (!finished && pending.length) spawn(); // 还有任务则重建
        tryFinish();
      });
      return w;
    };
    // wall-clock 超时：进程内 guard 兜不住死循环，靠杀进程 + seed 决定论重跑
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [w, list] of inflight) {
        if (list.some(x => now - x.sentAt > taskTimeoutMs)) { statTimeout++; crashReason.set(w, `wall-clock 超时 ${taskTimeoutMs}ms`); w.kill('SIGKILL'); }
      }
    }, 5000);
    for (let i = 0; i < poolSize; i++) spawn();
    tryFinish(); // 兜底：total=0 或全部 skip
  });
}
