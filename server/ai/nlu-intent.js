'use strict';
/* server/ai/nlu-intent.js —— NLU 意图分类推理（朴素贝叶斯，字符 bigram）
 * 加载 models/nlu-intent-nb.json；classify(text) → intent 字符串。
 * fail-open：模型缺失/损坏 → null。
 */
const fs = require('fs');
const path = require('path');
const MODEL_PATH = process.env.MODEL_NLU_INTENT || path.join(__dirname, '..', '..', 'models', 'nlu-intent-nb.json');
let _model = null, _tried = false;

function loadModel() {
  if (_tried) return _model;
  _tried = true;
  try {
    const m = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
    if (m.schema !== 'nlu-intent-nb@1' || !Array.isArray(m.classes) || !Array.isArray(m.vocab)) return null;
    const vocabIdx = new Map(m.vocab.map((f, i) => [f, i]));
    _model = { classes: m.classes, vocabIdx, logPrior: m.logPrior, logProb: m.logProb };
  } catch (e) { _model = null; }
  return _model;
}

function feats(text) {
  const t = ' ' + String(text || '').trim() + ' ';
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return [...out];
}

function classify(text) {
  const m = loadModel();
  if (!m || !text) return null;
  const fs2 = feats(text);
  let best = null, bestS = -Infinity;
  for (let ci = 0; ci < m.classes.length; ci++) {
    let s = m.logPrior[ci];
    for (const f of fs2) {
      const vi = m.vocabIdx.get(f);
      if (vi != null) s += m.logProb[ci][vi];
    }
    if (s > bestS) { bestS = s; best = m.classes[ci]; }
  }
  return best;
}

module.exports = { classify, loadModel };
