'use strict';
/* tools/ai/train-v5-lab.js —— 用 lab 采集的 V5 样本（v5:true，21 维）训练 π 意图版 MLP
 * 用法：node tools/ai/train-v5-lab.js [--input=data/vote-v3-v5/samples.jsonl] [--out=models/v5-pi-lab.json]
 * 仅用于验证真实 lab 数据训练链路；样本量小，不作为生产模型。 */
const fs = require('fs');
const path = require('path');
const { MLP } = require('../../server/ai/mlp.js');
const { V5_FEATURE_NAMES, FEATURE_NAMES } = require('../../server/ai/intent-features.js');
const root = path.resolve(__dirname, '..', '..');
const args = {};
process.argv.slice(2).forEach(a => { const m = a.match(/^--([^=]+)=(.*)$/); if (m) args[m[1]] = m[2]; });
const input = path.resolve(root, args.input || 'data/vote-v3-v5/samples.jsonl');
const outFile = path.resolve(root, args.out || 'models/v5-pi-lab.json');
const useBase = args.features === 'base'; // 消融：只用 13 维基础特征（对照 intent 特征增益）
const NF = useBase ? FEATURE_NAMES.length : V5_FEATURE_NAMES.length;
const quick = args.quick === '1'; // 跳过高成本随机切分评估（只算分组口径）

function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function auc(y, p) {
  const idx = p.map((v, i) => i).sort((a, b) => p[a] - p[b]);
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
if (!rows.length) { console.error(`[v5-lab] 无 V5 样本: ${input}`); process.exit(1); }

function shuffle(a, rnd) { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }
/* 按对局（gameId）分组切分：同局样本只落在一侧，避免同局泄漏抬高 AUC */
function splitByGame(rs, trainFrac, seed) {
  const rnd = mulberry32(seed);
  const groups = [...new Set(rs.map(r => r.g))];
  const gtr = new Set(shuffle(groups, rnd).slice(0, Math.max(1, Math.floor(groups.length * trainFrac))));
  return [rs.filter(r => gtr.has(r.g)), rs.filter(r => !gtr.has(r.g))];
}
/* 训练+评估：早停验证集只从训练侧按对局取（修复旧版用测试集早停的泄漏） */
function fitEval(tr, te) {
  const [itr0, val0] = splitByGame(tr, 0.85, 99);
  const itr = itr0.length ? itr0 : tr;
  const val = val0.length ? val0 : itr.slice(0, Math.max(1, Math.floor(itr.length * 0.1)));
  const m = new MLP({ hidden: 32, epochs: 40, lr: 1e-3, batch: 16, l2: 1e-4, seed: 7 });
  m.fit(itr.map(r => r.x), itr.map(r => r.y), val.map(r => r.x), val.map(r => r.y), null, null);
  const a = te.length ? auc(te.map(r => r.y), te.map(r => m.predict(r.x))) : 0.5;
  return { m, a };
}
const shuffledRows = shuffle(rows, mulberry32(42));
const cut = Math.floor(shuffledRows.length * 0.8);
const randomA = quick ? null : fitEval(shuffledRows.slice(0, cut), shuffledRows.slice(cut)).a;
const [trG, teG] = splitByGame(rows, 0.8, 43);
const groupA = fitEval(trG, teG).a;
const full = fitEval(rows, []); // 全量重训：早停验证来自自身 15% 对局
const out = {
  schema: 'vote-pi@1', features: useBase ? FEATURE_NAMES : V5_FEATURE_NAMES, synthetic: false, lab: true, hidden: 32, epochs: 40,
  trainSamples: rows.length, testSamples: teG.length,
  testAUC: +groupA.toFixed(4), randomTestAUC: randomA == null ? null : +randomA.toFixed(4), groupTestAUC: +groupA.toFixed(4),
  featureMode: useBase ? 'base13' : 'intent21',
  gameGroups: new Set(rows.map(r => r.g)).size,
  evalNote: 'testAUC 取按对局分组口径；randomTestAUC 为同局混合口径（偏乐观）',
  trainedAt: new Date().toISOString(), mlp: full.m.toJSON(),
};
fs.writeFileSync(outFile, JSON.stringify(out));
console.log(JSON.stringify({ input, rows: rows.length, featureMode: out.featureMode, gameGroups: out.gameGroups, randomTestAUC: out.randomTestAUC, groupTestAUC: out.groupTestAUC, output: outFile }, null, 2));
