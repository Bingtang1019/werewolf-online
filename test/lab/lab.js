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
  matrix: require('./scenarios/matrix'), // v1.7.6 第二部分：配置矩阵扫描
  balance: require('./scenarios/balance'), // v1.7.6：预设+随机比例预测（第三方胜率）
  pool: require('./scenarios/pool'), // v1.7.9：固定 seed 池配对（β 方法论——Δ 与配对 CI，配对分析见 stats/pool-report.js）
};
async function main() {
  const raw = process.argv[2];
  const scenario = raw === 'smoke' ? 'baseline' : raw; // smoke = baseline 的冒烟 preset（PRESETS.smoke）
  if (!raw || !scenarios[scenario]) {
    console.error(`用法: node test/lab/lab.js <smoke|baseline|sample|deterministic|paired|matrix|balance|pool> [--key=value ...]\n  例: node test/lab/lab.js balance --games=3000 --cupid-only=1 --workers=8\n      node test/lab/lab.js pool --preset=10 --out=test/lab/data/pool/x.jsonl --workers=14（固定 seed 池配对）`);
    process.exit(1);
  }
  const cfg = buildConfig(raw, process.argv.slice(3));
  console.log(`[lab] scenario=${raw} games=${cfg.games} cap=${cfg.cap} parallel=${cfg.parallel} workers=${cfg.workers} counts=${JSON.stringify(cfg.counts)}${cfg.seed ? ' seed=' + cfg.seed : ''}`);
  const s = scenarios[scenario];
  if (cfg.workers > 1) { // v1.7.6：多进程分支（worker 独立 clock/全局 RNG，进程级并行是唯一正确的扩容方式）
    if (!s.planTasks) { console.error('[lab] scenario 未实现 planTasks，无法多进程'); process.exit(1); }
    const gen = s.planTasks(cfg);
    const { createStreamStats } = require('./stats/report');
    const stream = s.streamable ? createStreamStats() : null; // v1.7.6 第二部分：流式场景 O(1) 内存（万局不存全量 records）
    const records = stream ? null : [];
    let fin = 0;
    const t0 = Date.now();
    const onResult = (msg) => {
      if (msg.type === 'done') {
        if (gen.rec && !gen.rec.has(msg.gameId)) gen.rec.write(msg.record);
        if (stream) stream.add(msg.record); else records.push(msg.record);
      }
      else if (msg.type === 'fail') console.error('\n[lab:mp] 任务失败:', msg.id, msg.error);
      fin++;
      process.stderr.write(`\r[lab:mp] ${fin}/${gen.total}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    };
    // v4.2：task-timeout 可配（--task-timeout=ms）——mpool 默认 120s 是线性 V 时代的墙钟上限，
    // V4.2 MLP 单局可超 → 频繁误杀 + seed 重跑 → 重试耗尽失败（"经常超时"根因）
    // 默认按 VALUE_MODEL 自适应：v4 → 600s，否则保持 120s 旧行为
    const taskTimeoutMs = cfg.taskTimeout != null ? Number(cfg.taskTimeout) : (process.env.VALUE_MODEL === 'v4' ? 600000 : 120000);
    const maxRetry = cfg.retry != null ? Number(cfg.retry) : 2;
    await runMPool({ gen, cfg, onResult, workers: cfg.workers, taskTimeoutMs, maxRetry });
    if (gen.rec) await gen.rec.close(); // v1.7.9：flush 完成后再 exit（异步写盘抢跑会丢末条）
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
    if (s.report) s.report(stream || records, cfg);
    process.exit(0);
  }
  await s.run(cfg);
  if (global._voteAudit && global._voteAudit.length) {
    const auditRows = global._voteAudit.map(r => JSON.stringify(r));
    fs.writeFileSync('data/_vote-audit.jsonl', auditRows.join('\n'));
    console.log('[audit] vote 审计导出', global._voteAudit.length, '条 → data/_vote-audit.jsonl');
  }
  process.exit(0);
}
main().catch(e => { console.error('异常:', e.message); process.exit(1); });
