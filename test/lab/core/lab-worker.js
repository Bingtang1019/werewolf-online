'use strict';
/* v1.8.0：worker 执行器——独立进程内 clock 单例（虚拟时钟并行合法化）。
 * 每局执行 runOneLabGame → 流式回传主线程（统一写盘，无竞态）。
 * workerData: { jobs: [{i, seed, cfg}], mode: 'virtual'|'real' }
 */
const { parentPort, workerData } = require('worker_threads');
const clock = require('../../../server/clock');
const { runOneLabGame } = require('./room-runner');

clock.setMode(workerData.mode === 'real' ? 'real' : 'virtual'); // 进程内单例——与主线程/其他 worker 隔离

(async () => {
  try {
    for (const job of workerData.jobs) {
      const rec = await runOneLabGame(job.cfg);
      parentPort.postMessage({ type: 'done', i: job.i, rec });
    }
  } catch (e) {
    parentPort.postMessage({ type: 'error', err: String((e && e.stack) || e) });
  } finally {
    parentPort.postMessage({ type: 'finish' });
  }
})();
