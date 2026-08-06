'use strict';
/* v1.7.2（A-3）跨配置 AUC 验证：用"带模型"的 bot 重新采集样本，测模型 AUC。
 * 若显著低于训练时 0.736，实锤生态内过拟合（模型只在采集它的生态里有效）。
 * 运行：node tools/ai/eval-vote-auc.js <samples.jsonl> */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const file = process.argv[2] || (root + '/data/vote-samples-cross.jsonl');
const { getVoteModel, modelProb } = require(root + '/server/ai/model-loader.js');
const m = getVoteModel();
if (!m) { console.error('模型未加载（LAB_NO_MODEL? 或模型损坏）'); process.exit(1); }
const rows = [];
for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) { try { rows.push(JSON.parse(line)); } catch (e) {} }
if (!rows.length) { console.error('样本为空'); process.exit(1); }
let pos = 0, neg = 0;
const items = [];
for (const r of rows) {
  if (!Array.isArray(r.features) || r.features.length !== m.features.length) { console.warn('特征维度不匹配，跳过', r.features && r.features.length, m.features.length); continue; }
  const p = modelProb(m, r.features);
  if (p == null) continue;
  items.push({ p, y: r.label });
  if (r.label === 1) pos++; else neg++;
}
function auc(probs, y) {
  const it = probs.map((p, i) => ({ p, y: y[i] })).sort((a, b) => a.p - b.p);
  const npos = y.filter(v => v === 1).length, nneg = y.length - npos;
  if (!npos || !nneg) return 0.5;
  let rs = 0;
  for (let i = 0; i < it.length; i++) if (it[i].y === 1) rs += i + 1;
  return (rs - npos * (npos + 1) / 2) / (npos * nneg);
}
const a = auc(items.map(x => x.p), items.map(x => x.y));
const sub = rows.filter(r => Array.isArray(r.features) && r.features[3] === 0 && r.features[5] === 0);
let subAUC = null;
if (sub.length > 20) {
  const it2 = sub.map(r => ({ p: modelProb(m, r.features), y: r.label })).filter(x => x.p != null);
  subAUC = auc(it2.map(x => x.p), it2.map(x => x.y));
}
console.log('跨配置评估：' + rows.length + ' 条样本 | 正例 ' + pos + ' 负例 ' + neg);
console.log('全样本 AUC = ' + a.toFixed(4) + '（训练时 0.7362；显著更低 ⇒ 生态内过拟合实锤）');
if (subAUC != null) console.log('无查杀无票子集 AUC = ' + subAUC.toFixed(4) + '（n=' + sub.length + '；训练时 0.6466）');
process.exit(0);
