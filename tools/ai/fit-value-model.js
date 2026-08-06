'use strict';
/* 1.7.4（二期数据驱动 ΔV）：从 GameRecord 拟合胜率模型 V(R,S,M,N)，payoff 从 V 差分——曲率由数据定，不猜 p。
 * 运行：node tools/ai/fit-value-model.js [games] [seed] [bots]
 * 输出：models/value-vote-v1.json（逻辑回归系数 + 尺度系数 + 拟合统计）
 * 采集：每局每个 exile 事件记录投票时刻状态 (R,S,M,N) + 该局好人最终是否赢（事件流重建，players 表提供翻牌身份） */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const GAMES = parseInt(process.argv[2] || '1500', 10);
const SEED = process.argv[3] || 'fv';
const BOTS = process.argv[4] || 'simulate';
const tmp = root + '/data/_fv-records.jsonl';
const OUT = root + '/models/value-vote-v1.json';

function runLab() {
  execFileSync(process.execPath,
    [root + '/test/lab/lab.js', 'sample', '--games=' + GAMES, '--cap=13', '--bots=' + BOTS, '--seed=' + SEED, '--out=' + tmp],
    { cwd: root, stdio: 'pipe', timeout: 1200000 });
}
function loadRecords() {
  const recs = [];
  for (const l of fs.readFileSync(tmp, 'utf8').split('\n').filter(Boolean)) { try { recs.push(JSON.parse(l)); } catch (e) {} }
  return recs.filter(r => r.result.winner && !r.result.error);
}
function isW(r) { return r === 'wolf' || r === 'wolfBeauty'; }
function isG(r) { return ['seer', 'witch', 'hunter', 'guard', 'dreamer'].includes(r); }
/** 从事件流重建每个投票结算时刻的状态样本 */
function rebuildStates(rec) {
  // 1.7.4：roleKey=真实角色（英文，room-runner 已补）；role=中文文案不可用
  const roleOf = id => { const p = rec.players.find(x => x.id === id); return p ? p.roleKey : null; };
  let R = rec.players.filter(p => isW(p.role)).length;
  let S = rec.players.filter(p => isG(p.role)).length;
  let M = rec.players.filter(p => p.role === 'villager').length;
  let N = rec.players.length;
  const dead = new Set();
  const samples = [];
  const win = rec.result.winner === 'good' ? 1 : 0;
  for (const e of rec.events || []) {
    if (e.t === 'exile' && e.data && e.data.exiled) {
      samples.push({ R, S, M, N, win });
      const r = roleOf(e.data.exiled);
      if (r && !dead.has(e.data.exiled)) { dead.add(e.data.exiled); if (isW(r)) R--; else if (isG(r)) S--; else M--; N--; }
    } else if (e.t === 'deaths' && Array.isArray(e.data && e.data.deaths)) {
      for (const d of e.data.deaths) {
        if (!d || dead.has(d.id)) continue;
        dead.add(d.id);
        const r = roleOf(d.id);
        if (r) { if (isW(r)) R--; else if (isG(r)) S--; else M--; N--; }
      }
    }
  }
  return samples;
}
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
function fit(samples) {
  // 特征：[1, R, S, M, N, R*S, R*M, S*M]
  const X = samples.map(s => [1, s.R, s.S, s.M, s.N, s.R * s.S, s.R * s.M, s.S * s.M]);
  const y = samples.map(s => s.win);
  const n = X.length, d = X[0].length;
  const w = new Array(d).fill(0);
  const lr = 0.05;
  let prevLoss = Infinity;
  for (let it = 0; it < 3000; it++) {
    const g = new Array(d).fill(0);
    let loss = 0;
    for (let i = 0; i < n; i++) {
      const p = sigmoid(X[i].reduce((a, v, k) => a + v * w[k], 0));
      const err = y[i] - p;
      loss -= y[i] * Math.log(p + 1e-9) + (1 - y[i]) * Math.log(1 - p + 1e-9);
      for (let k = 0; k < d; k++) g[k] += err * X[i][k];
    }
    for (let k = 0; k < d; k++) w[k] += (lr / n) * g[k];
    if (it % 200 === 0 && Math.abs(prevLoss - loss) < 1e-4 * prevLoss && it > 500) break;
    prevLoss = loss;
  }
  // 训练集 AUC
  const items = samples.map((s, i) => ({ p: sigmoid(X[i].reduce((a, v, k) => a + v * w[k], 0)), y: s.win })).sort((a, b) => a.p - b.p);
  const pos = items.filter(x => x.y === 1).length, neg = items.length - pos;
  let rs = 0;
  for (let i = 0; i < items.length; i++) if (items[i].y === 1) rs += i + 1;
  const auc = pos && neg ? (rs - pos * (pos + 1) / 2) / (pos * neg) : 0.5;
  return { w, auc };
}
// 平均 |ΔV|（尺度系数：让数据版 payoff 幅度与解析版可比——保相对权重调绝对尺度）
function scaleInfo(w) {
  const V = (R, S, M, N) => sigmoid(w[0] + w[1] * R + w[2] * S + w[3] * M + w[4] * N + w[5] * R * S + w[6] * R * M + w[7] * S * M);
  let acc = 0, n = 0;
  for (let R = 1; R <= 3; R++) for (let S = 1; S <= 4; S++) for (let M = 1; M <= 6; M++) {
    const N = R + S + M;
    if (N < 3 || N > 13) continue;
    const dG = Math.abs(V(R - 1, S, M, N - 1) - V(R, S, M, N));
    const dV = Math.abs(V(R, S - 1, M, N - 1) - V(R, S, M, N));
    const dM = Math.abs(V(R, S, M - 1, N - 1) - V(R, S, M, N));
    acc += dG + dV + dM; n += 3;
  }
  const avg = acc / Math.max(1, n);
  return { avg, K: (3.0 + 1.5) / 2 / Math.max(1e-9, avg) }; // 目标平均幅度≈解析版 (3+1.5)/2
}

try { fs.unlinkSync(tmp); } catch (e) {}
console.log('跑局采集（' + GAMES + ' 局，' + BOTS + ' 档）...');
runLab();
const recs = loadRecords();
const samples = [];
for (const r of recs) samples.push(...rebuildStates(r));
console.log('有效局：' + recs.length + '，投票时刻样本：' + samples.length);
const { w, auc } = fit(samples);
const sc = scaleInfo(w);
console.log('逻辑回归系数：' + w.map(x => x.toFixed(3)).join(', '));
console.log('训练 AUC=' + auc.toFixed(4) + '，平均|ΔV|=' + sc.avg.toFixed(4) + '，尺度K=' + sc.K.toFixed(1));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ schema: 'value-vote@1', features: ['1', 'R', 'S', 'M', 'N', 'R*S', 'R*M', 'S*M'], w, K: sc.K, auc, n: samples.length, games: recs.length, generatedAt: new Date().toISOString() }, null, 1));
console.log('→ ' + OUT);
