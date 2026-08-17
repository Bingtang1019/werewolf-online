'use strict';
/* tools/ai/build-wolf-win-samples.js —— 从夜刀样本 + 终局结果构建“狼刀→狼胜”训练集
 * 只取 isKill=1 的真实出刀样本；y = 该局终局是否狼胜（1/0）。
 * 用法：node tools/ai/build-wolf-win-samples.js --samples=data/wolf-selfplay-eps.jsonl --records=data/records-selfplay-eps.jsonl --out=data/wolf-win-samples.jsonl
 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
function get(k, d) { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; }

const sampleFile = path.resolve(root, get('samples', 'data/wolf-selfplay-eps.jsonl'));
const recordFile = path.resolve(root, get('records', 'data/records-selfplay-eps.jsonl'));
const outFile = path.resolve(root, get('out', 'data/wolf-win-samples.jsonl'));

const winners = new Map();
for (const line of fs.readFileSync(recordFile, 'utf8').split('\n').filter(Boolean)) {
  const r = JSON.parse(line);
  if (r.gameId && r.result && r.result.winner) winners.set(r.gameId, r.result.winner);
}
const rows = [];
for (const line of fs.readFileSync(sampleFile, 'utf8').split('\n').filter(Boolean)) {
  const o = JSON.parse(line);
  if (o.night == null || o.isKill !== 1 || !Array.isArray(o.features) || o.label == null) continue;
  const winner = winners.get(o.gameId);
  if (!winner) continue;
  rows.push({ features: o.features, y: winner === 'wolf' ? 1 : 0, isGod: o.label, gameId: o.gameId, night: o.night });
}
fs.writeFileSync(outFile, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const pos = rows.filter(r => r.y === 1).length;
console.log(JSON.stringify({ total: rows.length, wolfWin: pos, goodWin: rows.length - pos, output: outFile }, null, 2));
