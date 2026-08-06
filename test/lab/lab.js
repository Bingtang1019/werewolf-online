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
  console.log(`[lab] scenario=${raw} games=${cfg.games} cap=${cfg.cap} parallel=${cfg.parallel} counts=${JSON.stringify(cfg.counts)}${cfg.seed ? ' seed=' + cfg.seed : ''}`);
  await scenarios[scenario].run(cfg);
  process.exit(0);
}
main().catch(e => { console.error('异常:', e.message); process.exit(1); });
