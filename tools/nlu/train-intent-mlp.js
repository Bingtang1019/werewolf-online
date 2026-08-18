'use strict';
/* tools/nlu/train-intent-mlp.js —— 基于字符 bigram + 一对多 MLP 的意图分类器
 * 输入：data/nlu/corpus-clean.annotated.jsonl（或 --input）
 * 输出：models/nlu-intent-mlp.json（schema: nlu-intent-mlp@1）
 * 用法：node tools/nlu/train-intent-mlp.js [--input=data/nlu/corpus-clean.annotated.jsonl] [--out=models/nlu-intent-mlp.json] [--hidden=32] [--epochs=30]
 */
const fs = require('fs');
const path = require('path');
const { MLP } = require('../../server/ai/mlp.js');
const root = path.resolve(__dirname, '..', '..');
const args = {};
process.argv.slice(2).forEach(a => { const m = a.match(/^--([^=]+)=(.*)$/); if (m) args[m[1]] = m[2]; });
const input = path.resolve(root, args.input || 'data/nlu/corpus-clean.annotated.jsonl');
const outFile = path.resolve(root, args.out || 'models/nlu-intent-mlp.json');
const hidden = parseInt(args.hidden || '32', 10);
const epochs = parseInt(args.epochs || '30', 10);
const seed = parseInt(args.seed || '7', 10);
const minDf = parseInt(args['min-df'] || '2', 10);
const topN = parseInt(args.top || '3000', 10);

const rows = [];
for (const line of fs.readFileSync(input, 'utf8').trim().split('\n').filter(Boolean)) {
  const o = JSON.parse(line);
  if (o.text && o.intent) rows.push({ text: o.text, intent: o.intent });
}
function feats(text) {
  const t = ' ' + text.trim() + ' ';
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return [...out];
}
const df = new Map();
for (const r of rows) for (const f of feats(r.text)) df.set(f, (df.get(f) || 0) + 1);
const vocab = [...df.entries()].filter(([, c]) => c >= minDf).sort((a, b) => b[1] - a[1]).slice(0, topN).map(([f]) => f);
const V = vocab.length;
const idx = new Map(vocab.map((f, i) => [f, i]));
const classes = [...new Set(rows.map(r => r.intent))].sort();
const X = rows.map(r => { const x = new Array(V).fill(0); for (const f of feats(r.text)) { const vi = idx.get(f); if (vi != null) x[vi] = 1; } return x; });
console.log(`[nlu-mlp] rows=${rows.length} classes=${classes.length} vocab=${V}`);

const models = [];
for (const cls of classes) {
  const y = rows.map(r => r.intent === cls ? 1 : 0);
  const m = new MLP({ hidden, epochs, lr: 1e-3, batch: 32, l2: 1e-4, seed });
  const split = Math.floor(X.length * 0.8);
  m.fit(X.slice(0, split), y.slice(0, split), X.slice(split, split + 200), y.slice(split, split + 200), null, null);
  models.push({ cls, mlp: m.toJSON() });
  console.log(`[nlu-mlp] trained ${cls} (${y.filter(v => v === 1).length} pos)`);
}

// 训练集评估
let ok = 0;
for (let i = 0; i < rows.length; i++) {
  let best = null, bestP = -Infinity;
  for (const { cls, mlp } of models) {
    const mm = MLP.fromJSON(mlp);
    const p = mm.predict(X[i]);
    if (p > bestP) { bestP = p; best = cls; }
  }
  if (best === rows[i].intent) ok++;
}
const out = { schema: 'nlu-intent-mlp@1', classes, vocab, hidden, epochs, trainRows: rows.length, trainAccuracy: +(ok / rows.length).toFixed(4), models, trainedAt: new Date().toISOString() };
fs.writeFileSync(outFile, JSON.stringify(out));
console.log(`[nlu-mlp] train accuracy=${(ok / rows.length * 100).toFixed(1)}% saved -> ${outFile}`);
