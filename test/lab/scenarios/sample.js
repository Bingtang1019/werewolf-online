'use strict';
/* sample：样本管道（B1-2）——records 流式落盘 JSONL + vote 样本并行采集；特征提取放训练侧（B1-7②）
 * v1.7.6：拆 planTasks/report —— 多进程时 records 落盘在 master（单写无竞争）、vote 样本按 pid 分文件后合并。 */
const path = require('path');
const { runOneLabGame } = require('../core/room-runner');
const { runPool } = require('../core/pool');
const { createRecorder } = require('../core/recorder');

function planTasks(cfg) {
  const ROOT = path.resolve(__dirname, '..', '..', '..'); // test/lab/scenarios → 项目根
  const out = path.isAbsolute(cfg.out || '') ? cfg.out : path.join(ROOT, cfg.out || 'data/lab-records.jsonl');
  if (cfg.sampleFile) cfg.sampleFile = path.isAbsolute(cfg.sampleFile) ? cfg.sampleFile : path.join(ROOT, cfg.sampleFile); // vote 样本采集路径（game.js 钩子写；多进程 worker 加 pid 后缀）
  const rec = createRecorder(out);
  let i = -1;
  return {
    total: cfg.games, rec, out, sampleFile: cfg.sampleFile,
    next() {
      if (++i >= cfg.games) return null;
      const gameId = `smp-${i}`;
      if (rec.has(gameId)) return { skip: true, gameId }; // checkpoint 续跑
      return { id: gameId, gameId, seed: `${cfg.seed || 'smp'}-${i}`, full: true }; // 落盘 records 需完整 events（训练/ΔV 重放）
    },
  };
}
function report(statsOrRecords, cfg) {
  const n = Array.isArray(statsOrRecords) ? statsOrRecords.length : statsOrRecords.result().total;
  console.log(`\n[sample] 已落盘 ${n} 局 → ${cfg.out || 'data/lab-records.jsonl'}`);
  if (cfg.sampleFile) console.log(`[sample] vote 样本 → ${cfg.sampleFile}`);
}
async function run(cfg) {
  const gen = planTasks(cfg);
  const fn = async (i, seed) => {
    const r = await runOneLabGame(Object.assign({}, cfg, { seed, gameId: `smp-${i}` }));
    if (!gen.rec.has(r.gameId)) gen.rec.write(r); // 每局完成即写（checkpoint：续跑跳过）
    return r;
  };
  await runPool(cfg.games, cfg.parallel, fn,
    { seedBase: cfg.seed || 'smp', doneSet: gen.rec, onProgress: (f, t, ms) => process.stderr.write(`\r[lab] ${f}/${t}  (${(ms / 1000).toFixed(0)}s)`) });
  gen.rec.close();
  report([], cfg);
}
module.exports = { run, planTasks, report, streamable: true }; // streamable：多进程分支用流式统计
