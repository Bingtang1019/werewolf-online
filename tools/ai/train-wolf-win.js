'use strict';
/* tools/ai/train-wolf-win.js —— 狼刀胜率模型训练（V5.2 A 线）
 * 输入：data/wolf-win-samples.jsonl（features + y=狼胜）
 * 输出：models/wolf-win-v1.json（schema: wolf-win@1）
 * 用法：node tools/ai/train-wolf-win.js --samples=data/wolf-win-samples.jsonl --out=models/wolf-win-v1.json --rounds=150
 */
const fs = require('fs');
const path = require('path');
const { AdaBoost } = require('../../wolfTrain/adaboost.js');
const root = path.resolve(__dirname, '..', '..');

const args = {};
process.argv.slice(2).forEach(a => { const m = a.match(/^--([^=]+)=(.*)$/); if (m) args[m[1]] = m[2]; });
const sampleFile = path.resolve(root, args.samples || 'data/wolf-win-samples.jsonl');
const outFile = path.resolve(root, args.out || 'models/wolf-win-v1.json');

const rows = [];
for (const line of fs.readFileSync(sampleFile, 'utf8').split('\n').filter(Boolean)) {
  const o = JSON.parse(line);
  if (Array.isArray(o.features) && (o.y === 0 || o.y === 1)) rows.push(o);
}
console.log(`[wolf-win] samples: ${rows.length}`);
if (rows.length < 50) { console.error('样本太少，无法训练（至少 50）'); process.exit(1); }

const X = rows.map(r => r.features);
const y = rows.map(r => r.y);
const pos = y.filter(v => v === 1).length;
const neg = y.length - pos;
const initW = y.map(v => (v === 1 ? 1 / (2 * pos) : 1 / (2 * neg)));
const model = new AdaBoost({ rounds: parseInt(args.rounds || '150', 10) }).fit(X, y, initW);
const out = { schema: 'wolf-win@1', features: 'voteFeatures13', rounds: model.models.length, pos, neg, trainedAt: new Date().toISOString(), mlp: null, adaboost: model.toJSON() };
fs.writeFileSync(outFile, JSON.stringify(out));
console.log(`[wolf-win] trained rounds=${model.models.length} pos=${pos} neg=${neg} -> ${outFile}`);
