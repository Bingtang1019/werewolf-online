'use strict';
/* 蒙特卡洛实验室平台入口（数据生产/消费分离）
 * 用法：node test/lab/lab.js <scenario> [--key=value ...]
 *   smoke | baseline | sample | deterministic | paired
 * 依赖方向（单向）：scenario → core → game.js；stats 谁都不依赖；core 不 import stats。
 */
const { buildConfig } = require('./core/config');
const clock = require('../../server/clock');
clock.setMode('virtual'); // v1.7.1：实验室统一虚拟时间（墙钟不随游戏流逝，驱动靠 tickNext 推时钟）
process.env.CHAT_INTERVAL = '0'; // 虚拟模式下发言限流也是虚拟的，跑量时关闭
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
