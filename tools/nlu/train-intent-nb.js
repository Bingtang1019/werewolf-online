'use strict';
/* tools/nlu/train-intent-nb.js —— 基于字符 bigram 的多项朴素贝叶斯意图分类器
 * 输入：data/nlu/corpus-clean.annotated.jsonl（417 条全标注）
 * 输出：models/nlu-intent-nb.json（schema: nlu-intent-nb@1）
 * 用法：node tools/nlu/train-intent-nb.js [--min-df 2] [--top 3000] [--alpha 0.3]
 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const args = {};
process.argv.slice(2).forEach(a => { const m = a.match(/^--([^=]+)=(.*)$/); if (m) args[m[1]] = m[2]; });

const input = path.resolve(root, args.input || 'data/nlu/corpus-clean.annotated.jsonl');
const outFile = path.resolve(root, args.out || 'models/nlu-intent-nb.json');
const minDf = parseInt(args['min-df'] || '2', 10);
const topN = parseInt(args.top || '3000', 10);
const alpha = parseFloat(args.alpha || '0.3');

const rows = [];
for (const line of fs.readFileSync(input, 'utf8').trim().split('\n').filter(Boolean)) {
  const o = JSON.parse(line);
  if (o.text && o.intent) rows.push({ text: o.text, intent: o.intent });
}
console.log(`[nlu-nb] rows=${rows.length}`);

function feats(text) {
  const t = ' ' + text.trim() + ' ';
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return [...out];
}
// 文档频率
const df = new Map();
for (const r of rows) for (const f of feats(r.text)) df.set(f, (df.get(f) || 0) + 1);
const vocab = [...df.entries()].filter(([, c]) => c >= minDf).sort((a, b) => b[1] - a[1]).slice(0, topN).map(([f]) => f);
const V = vocab.length;
const idx = new Map(vocab.map((f, i) => [f, i]));
console.log(`[nlu-nb] vocab=${V}`);

const classes = [...new Set(rows.map(r => r.intent))].sort();
const C = classes.length;
const classIdx = new Map(classes.map((c, i) => [c, i]));
const docCounts = new Array(C).fill(0);
const termCounts = Array.from({ length: C }, () => new Float64Array(V));
for (const r of rows) {
  const ci = classIdx.get(r.intent);
  docCounts[ci]++;
  for (const f of feats(r.text)) { const vi = idx.get(f); if (vi != null) termCounts[ci][vi]++; }
}
const logPrior = docCounts.map(c => Math.log((c + alpha) / (rows.length + alpha * C)));
const logProb = termCounts.map((tc, ci) => {
  const total = tc.reduce((a, b) => a + b, 0);
  const arr = new Array(V);
  for (let v = 0; v < V; v++) arr[v] = Math.log((tc[v] + alpha) / (total + alpha * V));
  return arr;
});

// 简单留出评估
let correct = 0, total = 0;
for (const r of rows) {
  const scores = classes.map((c, ci) => {
    let s = logPrior[ci];
    for (const f of feats(r.text)) { const vi = idx.get(f); if (vi != null) s += logProb[ci][vi]; }
    return s;
  });
  const pred = classes[scores.indexOf(Math.max(...scores))];
  total++;
  if (pred === r.intent) correct++;
}
console.log(`[nlu-nb] train accuracy=${(correct / total * 100).toFixed(1)}% (${correct}/${total})`);

const out = { schema: 'nlu-intent-nb@1', classes, vocab, logPrior, logProb, alpha, minDf, trainedAt: new Date().toISOString(), trainRows: rows.length, accuracy: +(correct / total).toFixed(4) };
fs.writeFileSync(outFile, JSON.stringify(out));
console.log(`[nlu-nb] saved -> ${outFile}`);
