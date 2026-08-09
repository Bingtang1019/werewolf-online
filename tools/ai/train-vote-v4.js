'use strict';
/* vote-v4：vote-v3 蒸馏（D0 投票线）——25d AdaBoost → 2 层 MLP（64/32），MSE 拟合 raw score。
 *
 * 动机：vote-v3 的 modelProb 每候选几百 stump 遍历（~1-3ms）——P1 快照后剩余瓶颈。
 *       蒸馏后 MLP 单前向 0.05-0.2ms（20-50×），且 soft-label 保留排序语义。
 *
 * 数据：data/vote-v3-online/*.jsonl（{gameId, f[25], tIsWolf}——在线 25 维，A-2 同源）
 * 标签：vote-v3 模型 raw score（modelProb 未 sigmoid）——软标签蒸馏（学分布非硬类）
 * 结构：MLP(25 → 64 → 32 → 1, linearOut) + MSE + Adam + val MSE 早停
 * 验收：Spearman ≥0.95（test 集 vs vote-v3 排序）+ 配对 dv 命中不劣化（外部做）
 *
 * 用法：node tools/ai/train-vote-v4.js [--dir data/vote-v3-online] [--out models/adaboost-vote-v4.json]
 *       [--epochs 30] [--hidden 64] [--seed 42] [--quick]
 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const { MLP } = require(path.join(root, 'server/ai/mlp.js'));
const { modelProb } = require(path.join(root, 'server/ai/model-loader.js'));

const a = process.argv.slice(2);
const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const has = k => a.includes(k);
const DIR = get('--dir', path.join(root, 'data', 'vote-v3-online'));
const OUT = get('--out', path.join(root, 'models', 'adaboost-vote-v4.json'));
const EPOCHS = parseInt(get('--epochs', '50'), 10); // 1.7.18+：50（128 容量下看 loss 曲线定）
const HIDDEN = parseInt(get('--hidden', '128'), 10); // 1.7.18+：128 起步（256 训练时间账≈26 分钟，128 先验证趋势）
const T = parseFloat(get('--temp', '2')); // 蒸馏温度：T=2 软化中间区（目标 = sigmoid(raw/T)）
const SEED = parseInt(get('--seed', '42'), 10);
const QUICK = has('--quick');
const v3Path = get('--v3', path.join(root, 'models', 'adaboost-vote-v3-25d.json'));

const v3 = JSON.parse(fs.readFileSync(v3Path, 'utf8'));

// 每配置按局划分（70/15/15，mulberry32 同 seed）——与 vote-v3 训练一致
function mulberry32(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function loadAll() {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.jsonl')).sort();
  const byGame = new Map(); // gameId -> [{f, soft}]
  for (const f of files) {
    const tag = f.replace('.jsonl', '');
    if (QUICK && !['12a', '9a'].includes(tag)) continue;
    for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line);
      if (!r.f || r.f.length !== 25) continue;
      if (!byGame.has(r.gameId)) byGame.set(r.gameId, []);
      byGame.get(r.gameId).push(r);
    }
  }
  return byGame;
}

// 软标签：vote-v3 raw score（configKey 由 gameId 前缀推断——tag 存于 gameId？gameId 无配置信息——改用配置从文件名带出）
// 注意：gameId 是 'g0' 等（无配置）——需要在加载时记录配置。修正：返回 {tag, samples}
function loadAllV2() {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.jsonl')).sort();
  const out = [];
  for (const f of files) {
    const tag = f.replace('.jsonl', '');
    if (QUICK && !['12a', '9a'].includes(tag)) continue;
    const samples = [];
    for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line);
      if (!r.f || r.f.length !== 25) continue;
      samples.push(r);
    }
    out.push({ tag, samples });
  }
  return out;
}

function main() {
  console.log('vote-v4 蒸馏开始（vote-v3 → MLP）');
  console.log('数据:', DIR, '| epochs:', EPOCHS, '| hidden:', HIDDEN, '| seed:', SEED, QUICK ? '（quick：仅 12a/9a）' : '');
  const configs = loadAllV2();
  const rng = mulberry32(SEED);
  const X = [], Y = [];
  let valX = [], valY = [], testX = [], testY = [];
  let total = 0, skipped = 0;
  for (const { tag, samples } of configs) {
    // 按局划分
    const games = new Map();
    for (const s of samples) { if (!games.has(s.gameId)) games.set(s.gameId, []); games.get(s.gameId).push(s); }
    const gids = Array.from(games.keys());
    // shuffle
    for (let i = gids.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [gids[i], gids[j]] = [gids[j], gids[i]]; }
    const nT = Math.floor(gids.length * 0.7), nV = Math.floor(gids.length * 0.15);
    const trainG = new Set(gids.slice(0, nT)), valG = new Set(gids.slice(nT, nT + nV)), testG = new Set(gids.slice(nT + nV));
    for (const s of samples) {
      const raw = modelProb(v3, s.f, tag);
      if (raw == null) { skipped++; continue; }
      // 1.7.18+：sigmoid 概率蒸馏 + 温度 T=2 软化——raw score 稀疏分布 + MSE 对极端值敏感是 0.81 的帮凶之一；概率空间 [0,1] 平滑有界，T=2 软化中间区，目标与 Spearman 直接对齐
      const soft = 1 / (1 + Math.exp(-raw / T));
      if (trainG.has(s.gameId)) { X.push(s.f); Y.push(soft); }
      else if (valG.has(s.gameId)) { valX.push(s.f); valY.push(soft); }
      else { testX.push(s.f); testY.push(soft); }
      total++;
    }
  }
  console.log('样本:', total, '（跳过', skipped, '）| train:', X.length, 'val:', valX.length, 'test:', testX.length);
  // 1.7.18+：sigmoid 输出 + MSE 早停（soft 概率蒸馏——softTarget；AUC 早停对连续 soft 标签无效是 Spearman 0.0009 根因）
  const m = new MLP({ hidden: HIDDEN, lr: 1e-3, epochs: EPOCHS, batch: 512, l2: 1e-4, seed: SEED, patience: 6, softTarget: true, stratifyK: 4000 });
  const t0 = Date.now();
  m.fit(X, Y, valX, valY);
  console.log('训练完成:', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  // test 评估：Spearman + MSE + 排序对比
  const pr = testX.map(x => m.predict(x));
  let mse = 0;
  for (let i = 0; i < testY.length; i++) { const d = pr[i] - testY[i]; mse += d * d; }
  mse /= testY.length;
  // Spearman（秩相关）
  const rank = arr => {
    const idx = Array.from({ length: arr.length }, (_, i) => i).sort((p, q) => arr[p] - arr[q]);
    const r = new Float64Array(arr.length);
    for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && arr[idx[j + 1]] === arr[idx[i]]) j++; const rr = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k]] = rr; i = j + 1; }
    return r;
  };
  const rp = rank(pr), rt = rank(testY);
  const n = pr.length;
  const ma = rp.reduce((s, v) => s + v, 0) / n, mb = rt.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (rp[i] - ma) * (rt[i] - mb); da += (rp[i] - ma) ** 2; db += (rt[i] - mb) ** 2; }
  const spearman = num / Math.sqrt(da * db);
  console.log('test MSE:', mse.toFixed(5), '| Spearman(vs vote-v3):', spearman.toFixed(4), spearman >= 0.95 ? '✅ PASS' : '❌ FAIL（<0.95——退回 vote-v3）');
  // 保存
  const json = m.toJSON();
  const model = {
    schema: 'vote-mlp@1',
    features: v3.features,
    hidden: json.hidden,
    softTarget: true, // 1.7.18+：sigmoid 输出 + MSE 早停（soft 概率蒸馏）
    norm: json.norm,
    params: json.params, // 1.8.0：toJSON 键名是 params（原写 p——undefined → 权重全丢 1.5KB）
    meta: {
      distil: 'vote-v3',
      data: 'vote-v3-online',
      train: X.length, val: valX.length, test: testX.length,
      testMSE: mse, spearman: spearman,
      epochs: EPOCHS, seed: SEED, createdAt: new Date().toISOString(),
    },
  };
  fs.writeFileSync(OUT, JSON.stringify(model));
  console.log('已保存:', OUT, '(' + (fs.statSync(OUT).size / 1024).toFixed(1) + 'KB)');
}
main();
