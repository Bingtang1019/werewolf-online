'use strict';
/* tools/ai/train-v5-vote-ada.js —— V5 A2：用 lab V5 样本训练 v3v3 风格 AdaBoost 投票模型
 * 输出 adaboost-vote@3 格式（global stumps），供 model-loader 消费；
 * 小样本 lab 模型，仅作训练通路验证，非生产。 */
const fs = require('fs');
const path = require('path');
const { AdaBoost } = require('../../wolfTrain/adaboost.js');
const { V5_FEATURE_NAMES, FEATURE_NAMES } = require('../../server/ai/intent-features.js');
const root = path.resolve(__dirname, '..', '..');
const args = {};
process.argv.slice(2).forEach(a => { const m = a.match(/^--([^=]+)=(.*)$/); if (m) args[m[1]] = m[2]; });
const input = path.resolve(root, args.input || 'data/vote-v3-v5/samples.jsonl');
const outFile = path.resolve(root, args.out || 'models/adaboost-vote-v3-v5.json');
const useBase = args.features === 'base'; // 消融：只用 13 维基础特征（对照 intent 特征增益）
const NF = useBase ? FEATURE_NAMES.length : V5_FEATURE_NAMES.length;
const quick = args.quick === '1'; // 跳过高成本随机切分评估（只算分组口径）

function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function auc(y, raw) {
  const idx = raw.map((v, i) => i).sort((a, b) => raw[a] - raw[b]);
  let nPos = 0, nNeg = 0, rs = 0;
  for (let i = 0; i < y.length; i++) { if (y[i] > 0) nPos++; else nNeg++; }
  for (let k = 0; k < idx.length; k++) if (y[idx[k]] > 0) rs += k + 1;
  return (rs - nPos * (nPos + 1) / 2) / (nPos * nNeg);
}

const rows = [];
for (const line of fs.readFileSync(input, 'utf8').trim().split('\n').filter(Boolean)) {
  const o = JSON.parse(line);
  if (o && (o.v5 === true || useBase) && Array.isArray(o.features) && o.features.length >= NF && typeof o.label === 'number') {
    rows.push({ x: o.features.slice(0, NF), y: Number(o.label), g: o.gameId || `row${rows.length}` });
  }
}
if (!rows.length) { console.error(`[v5-ada] 无 V5 样本: ${input}`); process.exit(1); }

function shuffle(a, rnd) { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }
/* 按对局（gameId）分组切分：同局样本只落在一侧，避免同局泄漏抬高 AUC */
function splitByGame(rs, trainFrac, seed) {
  const rnd = mulberry32(seed);
  const groups = [...new Set(rs.map(r => r.g))];
  const gtr = new Set(shuffle(groups, rnd).slice(0, Math.max(1, Math.floor(groups.length * trainFrac))));
  return [rs.filter(r => gtr.has(r.g)), rs.filter(r => !gtr.has(r.g))];
}
function fitEval(tr, te) {
  const model = new AdaBoost({ rounds: 80, bins: 20 }).fit(tr.map(r => r.x), tr.map(r => r.y));
  const a = te.length ? auc(te.map(r => r.y), te.map(r => model.predict(r.x))) : 0.5;
  return { model, a };
}
const shuffledRows = shuffle(rows, mulberry32(42));
const cut = Math.floor(shuffledRows.length * 0.75);
const randomA = quick ? null : fitEval(shuffledRows.slice(0, cut), shuffledRows.slice(cut)).a;
const [trG, teG] = splitByGame(rows, 0.75, 43);
const groupA = fitEval(trG, teG).a;
const full = fitEval(rows, []); // 全量重训
// 转换为 model-loader 的 adaboost-vote@3 全局格式
const stumps = full.model.models.map(m => ({ f: m.j, thr: m.th, dir: m.dir === 1 ? -1 : 1, alpha: m.alpha }));
const out = {
  schema: 'adaboost-vote@3', features: useBase ? FEATURE_NAMES : V5_FEATURE_NAMES, configs: {},
  global: { stumps, useLocal: true, valAUC: +groupA.toFixed(4), testAUC: +groupA.toFixed(4), randomTestAUC: randomA == null ? null : +randomA.toFixed(4) },
  meta: {
    trainedAt: new Date().toISOString(), labV5: true, rows: rows.length,
    featureMode: useBase ? 'base13' : 'intent21',
    gameGroups: new Set(rows.map(r => r.g)).size,
    randomTestAUC: randomA == null ? null : +randomA.toFixed(4), groupTestAUC: +groupA.toFixed(4),
    evalNote: 'testAUC 取按对局分组口径；randomTestAUC 为同局混合口径（偏乐观）',
  },
};
fs.writeFileSync(outFile, JSON.stringify(out));
console.log(JSON.stringify({ input, rows: rows.length, featureMode: out.meta.featureMode, gameGroups: out.meta.gameGroups, randomTestAUC: out.meta.randomTestAUC, groupTestAUC: out.meta.groupTestAUC, output: outFile }, null, 2));
