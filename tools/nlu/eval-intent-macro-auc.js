'use strict';
/* tools/nlu/eval-intent-macro-auc.js —— V5 A1 验收：意图分类器 5-fold 宏平均 AUC
 * 用法：node tools/nlu/eval-intent-macro-auc.js [--input=data/nlu/corpus-clean.annotated.jsonl] [--folds=5] [--seed=42]
 * 只读评估；AUC 采用逐类 one-vs-rest ROC AUC，再宏平均。 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const args = {};
process.argv.slice(2).forEach(a => { const m = a.match(/^--([^=]+)=(.*)$/); if (m) args[m[1]] = m[2]; });
const input = path.resolve(root, args.input || 'data/nlu/corpus-clean.annotated.jsonl');
const folds = parseInt(args.folds || '5', 10);
const seed = parseInt(args.seed || '42', 10);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function feats(text) {
  const t = ' ' + text.trim() + ' ';
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return [...out];
}
function trainNB(trainRows) {
  const classes = [...new Set(trainRows.map(r => r.intent))].sort();
  const classIdx = new Map(classes.map((c, i) => [c, i]));
  const df = new Map();
  for (const r of trainRows) for (const f of feats(r.text)) df.set(f, (df.get(f) || 0) + 1);
  const vocab = [...df.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3000).map(([f]) => f);
  const idx = new Map(vocab.map((f, i) => [f, i]));
  const V = vocab.length, C = classes.length, alpha = 0.3;
  const docCounts = new Array(C).fill(0);
  const termCounts = Array.from({ length: C }, () => new Float64Array(V));
  for (const r of trainRows) { const ci = classIdx.get(r.intent); docCounts[ci]++; for (const f of feats(r.text)) { const vi = idx.get(f); if (vi != null) termCounts[ci][vi]++; } }
  const logPrior = docCounts.map(c => Math.log((c + alpha) / (trainRows.length + alpha * C)));
  const logProb = termCounts.map(tc => { const total = tc.reduce((a, b) => a + b, 0); return Array.from(tc, v => Math.log((v + alpha) / (total + alpha * V))); });
  return { classes, classIdx, logPrior, logProb, idx };
}
function scores(model, text) {
  const fs2 = feats(text);
  return model.classes.map((c, ci) => {
    let s = model.logPrior[ci];
    for (const f of fs2) { const vi = model.idx.get(f); if (vi != null) s += model.logProb[ci][vi]; }
    return s;
  });
}
function auc(labels, scoresArr) {
  // one-vs-rest: labels[i]=1 正类
  const pos = [], neg = [];
  for (let i = 0; i < labels.length; i++) (labels[i] ? pos : neg).push(scoresArr[i]);
  if (!pos.length || !neg.length) return null;
  let sum = 0;
  for (const p of pos) for (const n of neg) sum += p > n ? 1 : p === n ? 0.5 : 0;
  return sum / (pos.length * neg.length);
}
const rows = [];
for (const line of fs.readFileSync(input, 'utf8').trim().split('\n').filter(Boolean)) {
  const o = JSON.parse(line);
  if (o.text && o.intent) rows.push({ text: o.text, intent: o.intent });
}
const rng = mulberry32(seed);
const order = rows.map((_, i) => i);
for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
const shuffled = order.map(i => rows[i]);
const allClasses = [...new Set(rows.map(r => r.intent))].sort();
const perClassScores = {}; for (const c of allClasses) perClassScores[c] = { labels: [], scores: [] };
for (let f = 0; f < folds; f++) {
  const testSet = shuffled.filter((_, i) => i % folds === f);
  const trainSet = shuffled.filter((_, i) => i % folds !== f);
  const model = trainNB(trainSet);
  for (const r of testSet) {
    const sc = scores(model, r.text);
    for (let ci = 0; ci < model.classes.length; ci++) {
      const c = model.classes[ci];
      perClassScores[c].labels.push(r.intent === c ? 1 : 0);
      perClassScores[c].scores.push(sc[ci]);
    }
  }
}
const classAuc = {};
let macroSum = 0, macroN = 0;
for (const c of allClasses) {
  const a = auc(perClassScores[c].labels, perClassScores[c].scores);
  if (a != null) { classAuc[c] = +a.toFixed(4); macroSum += a; macroN++; }
}
const macroAuc = macroN ? macroSum / macroN : null;
console.log(JSON.stringify({ input, rows: rows.length, folds, seed, macroAuc: macroAuc == null ? null : +macroAuc.toFixed(4), classAuc }, null, 2));
