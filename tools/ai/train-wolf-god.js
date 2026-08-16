'use strict';
/* Phase W：wolf-god 刀神分类器训练（v2）
 * 读取 lab sample 输出的 wolf 夜刀样本（含 night 字段），训练 AdaBoost 并保存模型。
 * 用法：node tools/ai/train-wolf-god.js --samples=data/wolf-samples2.jsonl --out=models/wolf-god-v2.json
 */
const fs = require('fs');
const path = require('path');
const { AdaBoost } = require('../../wolfTrain/adaboost.js');
const root = path.resolve(__dirname, '..', '..');

const args = {};
process.argv.slice(2).forEach(a => { const m = a.match(/^--([^=]+)=(.*)$/); if (m) args[m[1]] = m[2]; });
const sampleFile = path.resolve(root, args.samples || 'data/wolf-samples2.jsonl');
const outFile = path.resolve(root, args.out || 'models/wolf-god-v2.json');

const rows = [];
for (const line of fs.readFileSync(sampleFile, 'utf8').split('\n').filter(Boolean)) {
  try {
    const o = JSON.parse(line);
    if (o.night != null && Array.isArray(o.features) && (o.label === 0 || o.label === 1)) rows.push(o);
  } catch (e) {}
}
console.log(`[wolf-god] wolf samples: ${rows.length}`);
if (rows.length < 50) { console.error('样本太少，无法训练（至少 50）'); process.exit(1); }

const X = rows.map(r => r.features);
const y = rows.map(r => r.label);
const pos = y.filter(v => v === 1).length;
const neg = y.length - pos;
const initW = y.map(v => (v === 1 ? 1 / (2 * pos) : 1 / (2 * neg)));
const model = new AdaBoost({ rounds: parseInt(args.rounds || '100', 10) }).fit(X, y, initW);
fs.writeFileSync(outFile, JSON.stringify(model.toJSON()));
console.log(`[wolf-god] trained rounds=${model.models.length} pos=${pos} neg=${neg} -> ${outFile}`);
