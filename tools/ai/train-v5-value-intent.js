'use strict';
/* tools/ai/train-v5-value-intent.js —— V5 A3 合成意图价值模型（smoke）
 * 生成随机 36 维状态（含 cfg one-hot + info + intent），训练单 MLP，
 * 输出 value-hicvn@1 格式（featureSet=v4-info-intent），仅用于验证 A3 通路。 */
const fs = require('fs');
const path = require('path');
const { MLP } = require('../../server/ai/mlp.js');
const root = path.resolve(__dirname, '..', '..');
const args = {};
process.argv.slice(2).forEach(a => { const m = a.match(/^--([^=]+)=(.*)$/); if (m) args[m[1]] = m[2]; });
const outFile = path.resolve(root, args.out || 'models/value-hicvn-v4-intent.json');
const D = 36;
const N = 2000;
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = mulberry32(42);
const X = [], y = [];
for (let i = 0; i < N; i++) {
  const x = Array.from({ length: D }, () => rnd());
  X.push(x);
  y.push(x[0] * 0.7 + x[7] * 0.5 - 0.5 > 0 ? 1 : 0);
}
const split = Math.floor(N * 0.8);
const m = new MLP({ hidden: 24, epochs: 30, lr: 1e-3, batch: 32, l2: 1e-4, seed: 7 });
m.fit(X.slice(0, split), y.slice(0, split), X.slice(split, split + 200), y.slice(split, split + 200), null, null);
const known = ['4p', '6p', '8p', '9a', '9b', '9c', '9d', '12a', '12b', '12c', '12d', '12e', '12f', '12g', '12h', '15p', '9p', '12p'];
const payoffScale = {};
for (const k of known) payoffScale[k] = 1;
const out = {
  schema: 'value-hicvn@1',
  architecture: 'v4-info-intent-synthetic',
  backbone: 'mlp',
  featureSet: 'v4-info-intent',
  cfgKeys: known,
  features: ['r', 'sg', 'T', 'cap', 'r*sg', 'R', 'S', 'M', 'wolf0', 'god0', 'vill0', ...known.map(k => 'cfg_' + k), 'checkedWolves', 'checkedCount', 'seerAlive', 'lastExileWasWolf', 'attackDensity', 'claimSeerDensity', 'defendDensity', 'votePressure', 'smalltalkRatio'],
  members: [m.toJSON()],
  payoffScale,
  meta: { synthetic: true, note: 'V5 A3 合成意图价值模型（仅验证训练/加载通路，非生产）', trainedAt: new Date().toISOString(), trainSamples: split, testSamples: N - split },
};
fs.writeFileSync(outFile, JSON.stringify(out));
console.log(JSON.stringify({ output: outFile, schema: out.schema, featureSet: out.featureSet, members: out.members.length }, null, 2));
