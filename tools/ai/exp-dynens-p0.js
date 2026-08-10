// DynEns Phase 0 诊断：V3.1 vs V4.2 分歧度 + 分层优势表
// 重放 data/batch/p16-12a-v2.jsonl（300 局）→ 每票时刻构造双模型特征 → 输出分歧度
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');

const V31 = JSON.parse(fs.readFileSync(path.join(root, 'models/value-vote-v31.json'), 'utf8'));
const V4MOD = require(path.join(root, 'server/ai/value-model-v4.js')); // 复用 V4.2 推理（MLP 前向在 mlp.js）

// V4.2 推理（复用 value-model-v4——state 对象直接传）
function v42Value(s, configKey) {
  return V4MOD.value(s, configKey);
}
// V3.1 线性
function v31Value(x, config) {
  const vg = V31.global.weights.reduce((s, v, i) => s + v * x[i], 0);
  const lc = V31.local[config];
  const vl = lc ? lc.weights.reduce((s, v, i) => s + v * x[i], 0) : vg;
  const a = (V31.alpha && V31.alpha[config]) || 0;
  return a * vl + (1 - a) * vg;
}

// 特征构造（state 视角——好人视角 V：P(好人胜)）
function buildF31(s) {
  const T = (s.R + s.S + s.M) || 1;
  const r = s.R / T, sg = s.S / T;
  const wolfDead = s.wolf0 > 0 ? (s.wolf0 - s.R) / s.wolf0 : 0;
  const godDead = s.god0 > 0 ? (s.god0 - s.S) / s.god0 : 0;
  const villDead = s.vill0 > 0 ? (s.vill0 - s.M) / s.vill0 : 0;
  return [1, r, sg, T, wolfDead, godDead, villDead, s.cap || T, r * sg, s.R, s.S, s.M, s.wolf0, s.god0, s.vill0];
}

const jl = path.join(root, 'data/batch/p16-12a-v2.jsonl');
const lines = fs.readFileSync(jl, 'utf8').split('\n').filter(Boolean);

// 重放：维护 state
let nSample = 0;
const pairs = []; // {v31, v42, yIsWolf(该候选), layer}
const layerMap = { balanced: 0, mid: 0, extreme: 0 };
let s = { R: 0, S: 0, M: 0, N: 0, cap: 12, wolf0: 4, god0: 4, vill0: 4, checkedWolves: 0, checkedCount: 0, seerAlive: true, lastExileWasWolf: null };

for (const l of lines.slice(0, 200)) { // 200 局足够诊断
  const r = JSON.parse(l);
  const roleById = {};
  for (const p of r.players) roleById[p.id] = p.roleKey;
  const wolves = new Set(r.players.filter(p => p.roleKey && p.roleKey.includes('wolf')).map(p => p.id));
  // 初始化 state
  s = { R: wolves.size, S: r.players.filter(p => p.roleKey && !p.roleKey.includes('wolf') && p.roleKey !== 'villager').length, M: r.players.filter(p => p.roleKey === 'villager').length, N: r.players.length, cap: r.players.length, wolf0: wolves.size, god0: r.players.filter(p => p.roleKey && !p.roleKey.includes('wolf') && p.roleKey !== 'villager').length, vill0: r.players.filter(p => p.roleKey === 'villager').length, checkedWolves: 0, checkedCount: 0, seerAlive: true, lastExileWasWolf: null };
  const alive = new Set(r.players.map(p => p.id));
  let deadByWolf = 0;
  for (const ev of r.events) {
    if (ev.t === 'wolf_kill' && ev.data && ev.data.kill && !ev.data.saved) {
      alive.delete(ev.data.kill);
      deadByWolf++;
      const k = roleById[ev.data.kill];
      if (k && !k.includes('wolf')) s.S -= (k !== 'villager' ? 1 : 0); s.M -= (k === 'villager' ? 1 : 0);
      if (k && k.includes('wolf')) s.R--;
    }
    if (ev.t === 'deaths' && ev.data && ev.data.deaths) {
      for (const d of ev.data.deaths) {
        if (!alive.has(d.id)) continue;
        alive.delete(d.id);
        const k = roleById[d.id];
        if (k && !k.includes('wolf')) { if (k !== 'villager') s.S--; else s.M--; }
        if (k && k.includes('wolf')) s.R--;
      }
    }
    if (ev.t === 'exile' && ev.data && ev.data.exiled) {
      alive.delete(ev.data.exiled);
      const k = roleById[ev.data.exiled];
      const wasWolf = !!(k && k.includes('wolf'));
      s.lastExileWasWolf = wasWolf;
      if (k && !k.includes('wolf')) { if (k !== 'villager') s.S--; else s.M--; }
      if (wasWolf) s.R--;
    }
    if (ev.t === 'claim' && ev.data && ev.data.type === 'check_wolf') { s.checkedCount++; }
    if (ev.t === 'vote_cast') {
      const voter = ev.data.voter, target = ev.data.target;
      if (!voter || !target) continue;
      // 候选视角（好人被投）
      const k = roleById[target];
      if (!k) continue;
      const x31 = buildF31(s);
            const v31 = v31Value(x31, r.presetKey || r.cap + 'p');
      const v42 = v42Value(s, r.presetKey || (r.cap + 'p'));
      pairs.push({ v31, v42, y: k.includes('wolf') ? 1 : 0 });
      nSample++;
      // 分层（按 S+M 剩余 vs R）
      const tot = s.R + s.S + s.M;
      const layer = tot <= 0 ? 'mid' : (s.R / tot > 0.45 ? 'extreme' : (s.S + s.M) / tot > 0.55 ? 'balanced' : 'mid');
      layerMap[layer]++;
    }
  }
}

// 分析
console.log('样本数:', nSample);
// 1. 相关性（Pearson + Spearman rank）
function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return num / Math.sqrt(da * db || 1);
}
const va = pairs.map(p => p.v31), vb = pairs.map(p => p.v42);
console.log('Pearson 相关:', pearson(va, vb).toFixed(4));
// Spearman
const rank = arr => {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const rk = new Array(arr.length);
  idx.forEach((e, i) => rk[e[1]] = i / (arr.length - 1));
  return rk;
};
console.log('Spearman 相关:', pearson(rank(va), rank(vb)).toFixed(4));
// 2. 错误重叠率（以"狼候选应得高 V"为正确方向——注意：V 是好人胜率，投狼时 ΔV 应高）
// 语义：V31/V42 对"候选是狼"的判别（高 V 差 = 投狼好）——用简单代理：候选为狼时 V 应低（狼多则好人胜率低）
// 错误重叠：两模型在"狼候选排序"上的不一致（V 差值符号相反）
let agree = 0, disagree = 0;
for (const p of pairs) {
  // V 差（相对均值）方向一致性
  const d31 = p.v31 - 0.5, d42 = p.v42 - 0.5;
  if ((d31 > 0) === (d42 > 0)) agree++; else disagree++;
}
console.log('V 方向一致率:', (agree / pairs.length * 100).toFixed(1) + '%', '| 分歧:', (disagree / pairs.length * 100).toFixed(1) + '%');
// 3. 分层分布
console.log('分层分布:', JSON.stringify(layerMap));
// 4. 各模型在分层上的判别（候选是狼 → V 应偏离——AUC 用 V 排序）
function aucOf(vals, ys) {
  const nPos = ys.reduce((a, b) => a + b, 0), nNeg = ys.length - nPos;
  const order = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  let rs = 0, rk = 1;
  for (const [, i] of order) { if (ys[i]) rs += rk; rk++; }
  return (rs - nPos * (nPos + 1) / 2) / (nPos * nNeg || 1);
}
console.log('\n=== 判别力（候选是狼 → 高 V 差——AUC，>0.5 表示 V 高时更可能狼）===');
console.log('V3.1 AUC:', aucOf(va, pairs.map(p => p.y)).toFixed(4));
console.log('V4.2 AUC:', aucOf(vb, pairs.map(p => p.y)).toFixed(4));
// 注意：V 是好人胜率——狼多则低——所以候选是狼时 V 应低 → AUC < 0.5 是"正常方向"（V 低 → 狼）——这里显示原始值供判断
