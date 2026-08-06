'use strict';
/* 蒙特卡洛实验室平台入口（数据生产/消费分离）
 * 用法：node test/lab/lab.js <scenario> [--key=value ...]
 *   smoke | baseline | sample | deterministic | paired
 * 依赖方向（单向）：scenario → core → game.js；stats 谁都不依赖；core 不 import stats。
 */
const { buildConfig } = require('./core/config');
// v1.7.1：实验室统一虚拟时间（墙钟不随游戏流逝，驱动靠 tickNext 推时钟）
// v1.7.2（A-4）：fast pace env 必须在此设置（require game.js 之前）——虚拟时间下阶段超时/bot 延迟都按虚拟毫秒计，
// 不设小值则一局虚拟时间轻松超时被误判 stall；发言限流同样关闭
process.env.BOT_DELAY_MS = '100';
process.env.PHASE_TIMEOUT = '30';
process.env.NIGHT_TIMEOUT = '20';
process.env.CHAT_INTERVAL = '0';
const clock = require('../../server/clock');
clock.setMode('virtual');
const fs = require('fs');
const path = require('path');
const { runMPool } = require('./core/mpool');
const scenarios = {
  baseline: require('./scenarios/baseline'),
  sample: require('./scenarios/sample'),
  deterministic: require('./scenarios/deterministic'),
  paired: require('./scenarios/paired'),
};
async function main() {
  const raw = process.argv[2];
  const scenario = raw === 'smoke' ? 'baseline' : raw; // smoke = baseline 的冒烟 preset（PRESETS.smoke）
  if (!raw || !scenarios[scenario]) {
    console.error(`用法: node test/lab/lab.js <smoke|baseline|sample|deterministic|paired> [--key=value ...]\n  例: node test/lab/lab.js baseline --games=500 --cap=13 --parallel=8`);
    process.exit(1);
  }
  const cfg = buildConfig(raw, process.argv.slice(3));
  console.log(`[lab] scenario=${raw} games=${cfg.games} cap=${cfg.cap} parallel=${cfg.parallel} workers=${cfg.workers} counts=${JSON.stringify(cfg.counts)}${cfg.seed ? ' seed=' + cfg.seed : ''}`);
  const s = scenarios[scenario];
  if (cfg.workers > 1) { // v1.7.6：多进程分支（worker 独立 clock/全局 RNG，进程级并行是唯一正确的扩容方式）
    if (!s.planTasks) { console.error('[lab] scenario 未实现 planTasks，无法多进程'); process.exit(1); }
    const gen = s.planTasks(cfg);
    const records = [];
    let fin = 0;
    const t0 = Date.now();
    const onResult = (msg) => {
      if (msg.type === 'done') { if (gen.rec && !gen.rec.has(msg.gameId)) gen.rec.write(msg.record); records.push(msg.record); }
      else if (msg.type === 'fail') console.error('\n[lab:mp] 任务失败:', msg.id, msg.error);
      fin++;
      process.stderr.write(`\r[lab:mp] ${fin}/${gen.total}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    };
    await runMPool({ gen, cfg, onResult, workers: cfg.workers });
    if (gen.rec) gen.rec.close();
    // vote 样本合并：多 worker 各自写 sampleFile.<pid>，跑完统一追加到主文件
    if (cfg.sampleFile && gen.sampleFile) {
      const base = gen.sampleFile;
      const dir = path.dirname(base);
      const baseName = path.basename(base);
      try {
        const files = fs.readdirSync(dir).filter(f => f.startsWith(baseName + '.')).sort();
        if (files.length) {
          // 同步合并（异步 createWriteStream + process.exit 可能未 flush 丢数据）
          let buf = '';
          for (const f of files) { const p = path.join(dir, f); buf += fs.readFileSync(p, 'utf8'); try { fs.unlinkSync(p); } catch (e) {} }
          fs.appendFileSync(base, buf);
          console.log(`\n[sample] vote 样本已合并 ${files.length} 个 worker 文件 → ${base}`);
        }
      } catch (e) { console.error('[lab] vote 样本合并失败:', e.message); }
    }
    if (s.report) s.report(records, cfg);
    process.exit(0);
  }
  await s.run(cfg);
  process.exit(0);
}
main().catch(e => { console.error('异常:', e.message); process.exit(1); });
