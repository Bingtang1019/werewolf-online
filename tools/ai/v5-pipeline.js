'use strict';
/* tools/ai/v5-pipeline.js —— V5 一键采集-训练-验收流水线
 * 用法：node tools/ai/v5-pipeline.js [--games=30] [--sample-file=data/vote-v3-v5/samples.jsonl]
 * 步骤：lab 采集 V5 样本 → 训练 A5 π → 训练 A2 v3v3 → 生成 A3 意图价值模型 → 重启信号监控 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname, '..', '..');
const args = {};
process.argv.slice(2).forEach(a => { const m = a.match(/^--([^=]+)=(.*)$/); if (m) args[m[1]] = m[2]; });
const games = parseInt(args.games || '30', 10) || 30;
const sampleFile = args['sample-file'] || 'data/vote-v3-v5/samples.jsonl';

function run(cmd, env) {
  console.log(`\n>>> ${cmd.join(' ')}`);
  const r = spawnSync(process.execPath, cmd, { cwd: root, env: { ...process.env, ...(env || {}) }, stdio: 'inherit' });
  if (r.status !== 0) { console.error('!! 步骤失败: ' + cmd.join(' ')); process.exit(r.status || 1); }
}

// 1. lab 采集 V5 样本（并行=1 保证写入同一文件）
run(['test/lab/lab.js', 'sample', `--games=${games}`, '--parallel=1', '--out=data/v5-records-pipeline.jsonl', `--sample-file=${sampleFile}`], { V5_SAMPLES: '1' });

// 2. A5：π 意图版
run(['tools/ai/train-v5-lab.js', `--input=${sampleFile}`]);

// 3. A2：v3v3 AdaBoost
run(['tools/ai/train-v5-vote-ada.js', `--input=${sampleFile}`]);

// 4. A3：合成意图价值模型
run(['tools/ai/train-v5-value-intent.js']);

// 5. B：重启信号监控
run(['tools/ai/v5-restart-monitor.js']);

console.log('\nV5 pipeline 完成 ✔');
