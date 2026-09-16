'use strict';
/* tools/ai/train-v5-value-real.js —— V5 A3：用 lab 真实状态样本做价值层对照（非合成）
 * 数据：V5_VALUE_SAMPLES=1（建议同时 V5_INTENT_VALUE=1）采集的 v5v 行（投票时刻 state 快照）
 *       + lab 记录（gameId → result.winner）回填标签；state 与推理侧 buildVoteWorld 同源，无训练/服务分叉。
 * 对照：V3.1 / V4.2 生产模型（只读推理） / 本脚本训练的无意图 20 维 / 含意图 25 维 MLP。
 * 口径：按对局分组切分 80/20（同局样本不跨侧），AUC = P(好人胜) 排序质量；随机切分另记（偏乐观）。
 * 用法：node tools/ai/train-v5-value-real.js [--samples=... --records=... --out=... --quick=1 --no-contrast]
 */
const fs = require('fs');
const path = require('path');
const { MLP } = require('../../server/ai/mlp.js');
const v3 = require('../../server/ai/value-model.js');
const v4 = require('../../server/ai/value-model-v4.js');
const root = path.resolve(__dirname, '..', '..');
const args = {};
process.argv.slice(2).forEach(a => { const m = a.match(/^--([^=]+)=(.*)$/); if (m) args[m[1]] = m[2]; else if (a.startsWith('--')) args[a.slice(2)] = true; });
const sampleFile = path.resolve(root, args.samples || 'data/vote-v3-v5/samples-val.jsonl');
const recordFile = path.resolve(root, args.records || 'data/v5-records-val.jsonl');
const outFile = path.resolve(root, args.out || 'models/value-hicvn-v4-intent-real.json');
const quick = args.quick === '1';
const contrast = args['no-contrast'] ? false : true;
const KNOWN = v4.KNOWN_CONFIGS;

/* ---------- 数据装载 ---------- */
function loadWinnerMap(file) {
  const map = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      try { const o = JSON.parse(line); if (o && o.gameId && o.result) map[o.gameId] = o.result.winner; } catch (e) { /* skip */ }
    }
  } catch (e) { console.error(`[a3] 记录文件不可读: ${file}`); }
  return map;
}
function readJsonl(file) {
  const out = [];
  try { for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) { try { out.push(JSON.parse(line)); } catch (e) { /* skip */ } } } catch (e) { /* empty */ }
  return out;
}

const winners = loadWinnerMap(recordFile);
const rows = [];
let skippedNoWinner = 0;
for (const o of readJsonl(sampleFile)) {
  if (!o || o.v5v !== true || !o.state || !o.gameId) continue;
  const w = winners[o.gameId];
  if (w !== 'good' && w !== 'wolf') { skippedNoWinner++; continue; }
  const s = o.state;
  const R = s.R | 0, S = s.S | 0, M = s.M | 0;
  const T = Math.max(1, R + S + M);
  const cap = T;
  const base = [R / T, S / T, T, cap, (R / T) * (S / T), R, S, M, s.wolf0 | 0, s.god0 | 0, s.vill0 | 0];
  const cfgKey = o.config || (winners[o.gameId + ':cfg']) || '12p'; // lab sample 无 preset → 用生产 cap 兜底 key '12p'（保证 V4.2 cfg one-hot 维度正确）
  const cfgVec = KNOWN.map(k => (k === cfgKey ? 1 : 0));
  const inf = s.info || {};
  const info4 = [inf.checkedWolves || 0, inf.checkedCount || 0, inf.seerAlive || 0, inf.lastExileWasWolf || 0];
  const it = s.intent || {};
  const intent5 = [it.attackDensity || 0, it.claimSeerDensity || 0, it.defendDensity || 0, it.votePressure || 0, it.smalltalkRatio || 0];
  rows.push({
    g: o.gameId, s, cfg: cfgKey, y: w === 'good' ? 1 : 0,
    xBase: base.concat(cfgVec, info4), xIntent: base.concat(cfgVec, info4, intent5),
  });
}
if (!rows.length) { console.error(`[a3] 无可用样本（samples=${sampleFile} records=${recordFile}，缺胜方 ${skippedNoWinner} 行）`); process.exit(1); }

/* ---------- 工具 ---------- */
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function auc(y, p) {
  const idx = p.map((v, i) => i).sort((a, b) => p[a] - p[b]);
  let nPos = 0, nNeg = 0, rs = 0;
  for (let i = 0; i < y.length; i++) { if (y[i] > 0) nPos++; else nNeg++; }
  for (let k = 0; k < idx.length; k++) if (y[idx[k]] > 0) rs += k + 1;
  return (nPos && nNeg) ? (rs - nPos * (nPos + 1) / 2) / (nPos * nNeg) : 0.5;
}
function shuffle(a, rnd) { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }
function splitByGame(rs, frac, seed) {
  const rnd = mulberry32(seed);
  const groups = [...new Set(rs.map(r => r.g))];
  const trG = new Set(shuffle(groups, rnd).slice(0, Math.max(1, Math.floor(groups.length * frac))));
  return [rs.filter(r => trG.has(r.g)), rs.filter(r => !trG.has(r.g))];
}
/* 训练+分组评估；验证集只从训练侧取，绝不用测试集早停 */
function fitArm(tr, te, key) {
  const [itr0, val0] = splitByGame(tr, 0.85, 99);
  const itr = itr0.length ? itr0 : tr;
  const val = val0.length ? val0 : itr.slice(0, Math.max(1, Math.floor(itr.length * 0.1)));
  const m = new MLP({ hidden: 24, epochs: 30, lr: 1e-3, batch: 32, l2: 1e-4, seed: 7 });
  m.fit(itr.map(r => r[key]), itr.map(r => r.y), val.map(r => r[key]), val.map(r => r.y), null, null);
  return { m, a: te.length ? auc(te.map(r => r.y), te.map(r => m.predict(r[key]))) : 0.5 };
}

const [trG, teG] = splitByGame(rows, 0.8, 43);
const baseArm = fitArm(trG, teG, 'xBase');
const intentArm = fitArm(trG, teG, 'xIntent');
let randomA = null;
if (!quick) {
  const sh = shuffle(rows, mulberry32(42));
  const cut = Math.floor(sh.length * 0.8);
  randomA = {
    base33: +fitArm(sh.slice(0, cut), sh.slice(cut), 'xBase').a.toFixed(4),
    intent38: +fitArm(sh.slice(0, cut), sh.slice(cut), 'xIntent').a.toFixed(4),
  };
}

/* ---------- 生产模型对照（只读；同一测试集） ---------- */
let prod = null;
if (contrast && teG.length) {
  const y = teG.map(r => r.y);
  const v3p = teG.map(r => v3.value(r.s, r.cfg));
  const v4p = teG.map(r => v4.value(r.s, r.cfg));
  prod = {
    v3_1: +auc(y, v3p).toFixed(4),
    v4_2: +auc(y, v4p).toFixed(4),
    v3Loaded: v3.isLoaded(), v4Loaded: v4.isLoaded(),
  };
}

/* ---------- 输出 ---------- */
const payoffScale = {};
for (const k of KNOWN) payoffScale[k] = 1;
const art = {
  schema: 'value-hicvn@1', architecture: 'v4-info-intent-lab-real', backbone: 'mlp',
  featureSet: 'v4-info-intent', cfgKeys: KNOWN,
  features: ['r', 'sg', 'T', 'cap', 'r*sg', 'R', 'S', 'M', 'wolf0', 'god0', 'vill0', ...KNOWN.map(k => 'cfg_' + k),
    'checkedWolves', 'checkedCount', 'seerAlive', 'lastExileWasWolf', 'attackDensity', 'claimSeerDensity', 'defendDensity', 'votePressure', 'smalltalkRatio'],
  members: [intentArm.m.toJSON()],
  payoffScale,
  meta: {
    labReal: true, rows: rows.length, gameGroups: new Set(rows.map(r => r.g)).size,
    testRows: teG.length, skippedNoWinner,
    groupTestAUC: { base33: +baseArm.a.toFixed(4), intent38: +intentArm.a.toFixed(4) },
    randomTestAUC: randomA, prodContrast: prod,
    trainedAt: new Date().toISOString(),
    note: 'lab 真实状态（非合成）；cfg 在 sample 场景为 null → one-hot 全零；生产对照为只读推理。',
  },
};
fs.writeFileSync(outFile, JSON.stringify(art));
console.log(JSON.stringify({
  samples: path.relative(root, sampleFile), records: path.relative(root, recordFile),
  rows: rows.length, gameGroups: art.meta.gameGroups,
  groupTestAUC: art.meta.groupTestAUC, randomTestAUC: randomA, prodContrast: prod,
  output: outFile,
}, null, 2));
