'use strict';
/* sample：样本管道（B1-2）——records 流式落盘 JSONL；特征提取放训练侧（B1-7②，共用 observe 接口） */
const path = require('path');
const { runRoom } = require('../core/room-runner');
const { runPool } = require('../core/pool');
const { createRecorder } = require('../core/recorder');

async function run(cfg) {
  const ROOT = path.resolve(__dirname, '..', '..', '..'); // test/lab/scenarios → 项目根
  const out = path.isAbsolute(cfg.out || '') ? cfg.out : path.join(ROOT, cfg.out || 'data/lab-records.jsonl');
  if (cfg.sampleFile) cfg.sampleFile = path.isAbsolute(cfg.sampleFile) ? cfg.sampleFile : path.join(ROOT, cfg.sampleFile); // vote 样本采集路径（game.js 钩子写）
  const rec = createRecorder(out);
  const fn = async (i, seed) => {
    const r = await runRoom(Object.assign({}, cfg, { seed }), `smp-${i}`);
    if (!rec.has(r.gameId)) rec.write(r); // 每局完成即写（checkpoint：续跑跳过）
    return r;
  };
  await runPool(cfg.games, cfg.parallel, fn,
    { seedBase: cfg.seed || 'smp', doneSet: rec, onProgress: (f, t, ms) => process.stderr.write(`\r[lab] ${f}/${t}  (${(ms / 1000).toFixed(0)}s)`) });
  rec.close();
  console.log(`\n[sample] 已落盘 ${rec.size()} 局 → ${out}`);
}
module.exports = { run };
