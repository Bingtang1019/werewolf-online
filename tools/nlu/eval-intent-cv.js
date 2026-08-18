'use strict';
/* tools/nlu/eval-intent-cv.js —— 意图分类器严格验证（5-fold 交叉验证）
 * 用法：
 *   node tools/nlu/eval-intent-cv.js [--input=data/nlu/corpus-clean.annotated.jsonl] [--folds=5] [--seed=42]
 * 只读评估，不写模型。
 */
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
  for (const r of trainRows) {
    const ci = classIdx.get(r.intent);
    docCounts[ci]++;
    for (const f of feats(r.text)) { const vi = idx.get(f); if (vi != null) termCounts[ci][vi]++; }
  }
  const logPrior = docCounts.map(c => Math.log((c + alpha) / (trainRows.length + alpha * C)));
  const logProb = termCounts.map(tc => {
    const total = tc.reduce((a, b) => a + b, 0);
    return Array.from(tc, v => Math.log((v + alpha) / (total + alpha * V)));
  });
  return { classes, classIdx, logPrior, logProb, idx };
}

function predict(model, text) {
  let best = null, bestS = -Infinity;
  for (let ci = 0; ci < model.classes.length; ci++) {
    let s = model.logPrior[ci];
    for (const f of feats(text)) {
      const vi = model.idx.get(f);
      if (vi != null) s += model.logProb[ci][vi];
    }
    if (s > bestS) { bestS = s; best = model.classes[ci]; }
  }
  return best;
}

// deterministic shuffle
const rng = mulberry32(seed);
const order = rows.map((_, i) => i);
for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
const shuffled = order.map(i => rows[i]);

const allClasses = [...new Set(rows.map(r => r.intent))].sort();
const foldAcc = [];
const confusion = new Map(allClasses.map(c => [c, new Map(allClasses.map(t => [t, 0]))]));
let correct = 0, total = 0;

for (let f = 0; f < folds; f++) {
  const testSet = shuffled.filter((_, i) => i % folds === f);
  const trainSet = shuffled.filter((_, i) => i % folds !== f);
  const model = trainNB(trainSet);
  let ok = 0;
  for (const r of testSet) {
    const pred = predict(model, r.text);
    if (pred === r.intent) ok++;
    confusion.get(r.intent).set(pred, (confusion.get(r.intent).get(pred) || 0) + 1);
    correct += pred === r.intent ? 1 : 0;
    total++;
  }
  foldAcc.push(ok / testSet.length);
}

const accuracy = correct / total;
const perClass = {};
for (const c of allClasses) {
  let tp = 0, fp = 0, fn = 0;
  for (const t of allClasses) {
    const v = confusion.get(c).get(t) || 0;
    if (t === c) tp += v; else fp += v;
  }
  for (const t of allClasses) {
    const v = confusion.get(t).get(c) || 0;
    if (t !== c) fn += v;
  }
  const precision = tp / (tp + fp) || 0;
  const recall = tp / (tp + fn) || 0;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  perClass[c] = { tp, fp, fn, precision: +precision.toFixed(3), recall: +recall.toFixed(3), f1: +f1.toFixed(3) };
}
const macroF1 = Object.values(perClass).reduce((a, x) => a + x.f1, 0) / allClasses.length;

console.log(JSON.stringify({
  input: args.input || 'data/nlu/corpus-clean.annotated.jsonl',
  rows: rows.length,
  folds,
  seed,
  foldAcc: foldAcc.map(x => +x.toFixed(4)),
  accuracy: +accuracy.toFixed(4),
  macroF1: +macroF1.toFixed(4),
  perClass,
}, null, 2));
