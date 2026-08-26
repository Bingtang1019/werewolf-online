'use strict';
/* tools/ai/v5-restart-monitor.js —— V5 B 系列重启信号监控
 * 检查 A1/A2/A3/A5 的关键产物是否存在并打印信号状态。
 * 用法：node tools/ai/v5-restart-monitor.js */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');

function exists(p) { return fs.existsSync(path.join(root, p)); }
function readMeta(p) {
  try { return JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')); } catch (e) { return null; }
}

const checks = [
  { id: 'A1', name: '意图分类器生产模型', file: 'models/nlu-intent-nb.json', ok: exists('models/nlu-intent-nb.json'), note: '已替换生产' },
  { id: 'A2', name: 'v3v3 投票模型', file: 'models/adaboost-vote-v3-v5.json', ok: exists('models/adaboost-vote-v3-v5.json'), note: 'lab 小样本模型' },
  { id: 'A3', name: '意图价值模型', file: 'models/value-hicvn-v4-intent.json', ok: exists('models/value-hicvn-v4-intent.json'), note: '尚未训练' },
  { id: 'A5', name: 'π 意图版模型', file: 'models/v5-pi-lab.json', ok: exists('models/v5-pi-lab.json'), note: 'lab 小样本模型' },
];

let signalCount = 0, missing = 0;
console.log('V5 重启信号监控');
console.log('================');
for (const c of checks) {
  const mark = c.ok ? '✅' : '❌';
  console.log(`${mark} ${c.id} ${c.name}: ${c.file}${c.ok ? ' 存在' : ' 缺失'}（${c.note}）`);
  if (c.ok && c.id !== 'A1' && c.id !== 'A3' && c.id !== 'A5') signalCount++;
  if (!c.ok) missing++;
}
console.log('----------------');
console.log('B2 多样化池重启条件：意图特征带动策略分化 → 待 A2/A4 规模化后评估');
console.log('B3 新信息源后重启：A1/A2/A5 已有 lab 产物，待真实样本/端到端验证后触发');
console.log(`缺失项：${missing}；可重启信号：${signalCount > 0 ? '部分出现（lab 级）' : '未出现'}`);
