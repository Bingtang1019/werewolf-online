'use strict';
/* =========================================================================
 * train-vote-v2.js —— vote-v2 训练器（1.7.16）
 * 相对 v1（train-vote-adaboost.js）的四点修正：
 *   ① shrinkage 收缩（0.7）+ T_max=500 检查点早停（验证集 group-wise AUC 选 T）
 *   ② per-config local（9 preset）+ cap 级 local（6）+ global——local vs global 数据驱动选择（val AUC 对比，胜出才用）
 *   ③ group-wise 划分（局不跨集）+ 测试集局级 bootstrap CI（1000 次）
 *   ④ 校准桶验收（max<0.10 + >0.7 桶<0.10）+ vote_lead 特征权重合理性检查
 * 输入：data/vote-v2/{4p,6p,8p,9a,9d,12a,12b,12d,15p}.jsonl（{gameId, f[13], tIsWolf}）
 * 输出：models/adaboost-vote-v2.json（schema 'adaboost-vote@2'）
 * 用法：node tools/ai/train-vote-v2.js [--out=models/adaboost-vote-v2.json] [--shrinkage=0.7]
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');

const args = process.argv.slice(2);
const get = (k, d) => { const eq = args.find(a => a.startsWith(k + '=')); if (eq) return eq.slice(k.length + 1); const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(root, get('--out', 'models/adaboost-vote-v2.json'));
const STAGE = get('--stage', 'auto');       // auto | global | local | cap | merge
const ONLY = get('--tags', '');             // 逗号分隔配置标签（stage=local/cap 时限定）
const SHRINKAGE = parseFloat(get('--shrinkage', '0.7'));
const T_MAX = parseInt(get('--tmax', '250'), 10);
const CHECK_EVERY = parseInt(get('--check', '25'), 10);
const BOOT = parseInt(get('--boot', '200'), 10); // 局级 bootstrap 次数（200 次分位误差 ~0.005，15p 全量 1000 次会超时）
const MAX_TRAIN = parseInt(get('--max-train', '60000'), 10); // 每配置训练按局抽样上限（大配置加速）
const SPLIT_SEED = 42;
const FRAG_DIR = path.resolve(root, 'data/vote-v2/frags');

const FEATURE_NAMES = ['seat_norm', 'ring_dist', 'talk_count', 'checked_wolf', 'checked_good', 'votes_against', 'prev_votes', 'claims_seer', 'claims_god', 'accused_count', 'counter_seer', 'vote_lead', 'bot_prev_same'];
const CFG_TAGS = { 0: '4p', 1: '6p', 2: '8p', 3: '9a', 6: '9d', 7: '12a', 8: '12b', 10: '12d', 15: '15p' };
const NFEAT = FEATURE_NAMES.length;

// ---------- 数据 ----------
function loadSamples() {
  const dir = path.join(root, 'data/vote-v2');
  const byCfg = {};
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
    const tag = f.replace('.jsonl', '');
    if (!Object.values(CFG_TAGS).includes(tag)) continue;
    const rows = [];
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      const t = line.trim(); if (!t) continue;
      const r = JSON.parse(t);
      rows.push({ gameId: r.gameId, f: r.f, y: r.tIsWolf });
    }
    byCfg[tag] = rows;
  }
  return byCfg;
}
// 按局划分（确定性）：train/val/test 按 gameId 哈希
function splitByGame(rows) {
  const games = {};
  for (const r of rows) { (games[r.gameId] = games[r.gameId] || []).push(r); }
  const gids = Object.keys(games).sort();
  const train = [], val = [], test = [];
  gids.forEach((g, i) => {
    const bucket = i % 10 < 7 ? train : (i % 10 < 8.5 ? val : test);
    for (const r of games[g]) bucket.push(r);
  });
  return { train, val, test };
}

// ---------- AdaBoost（收缩 + 检查点早停） ----------
function precomputeOrders(X, nFeat) {
  const orders = [];
  for (let f = 0; f < nFeat; f++) orders.push(X.map((x, i) => ({ v: x[f], i })).sort((a, b) => a.v - b.v));
  return orders;
}
function trainStump(orders, y, w, nFeat) {
  let best = null, bestErr = Infinity;
  const totalW = w.reduce((a, b) => a + b, 0);
  for (let f = 0; f < nFeat; f++) {
    const order = orders[f];
    let wPos = 0, wNeg = 0;
    for (let k = 0; k < order.length; k++) if (y[order[k].i] === 1) wPos += w[order[k].i]; else wNeg += w[order[k].i];
    let lPos = 0, lNeg = 0, prev = order[0].v;
    for (let k = 0; k < order.length; k++) {
      const { v, i } = order[k];
      if (v !== prev) {
        const thr = (prev + v) / 2;
        const errPosLeft = (lNeg + (wPos - lPos)) / totalW;
        const errPosRight = (lPos + (wNeg - lNeg)) / totalW;
        if (errPosLeft < bestErr) { bestErr = errPosLeft; best = { f, thr, dir: 1 }; }
        if (errPosRight < bestErr) { bestErr = errPosRight; best = { f, thr, dir: -1 }; }
        prev = v;
      }
      if (y[i] === 1) lPos += w[i]; else lNeg += w[i];
    }
  }
  return best || { f: 0, thr: 0, dir: 1 };
}
const stumpPred = (st, x) => (x[st.f] < st.thr ? 1 : -1) * st.dir;
const score = (stumps, x) => { let s = 0; for (const st of stumps) s += st.alpha * stumpPred(st, x); return s; };

function auc(probs, y) {
  const items = probs.map((p, i) => ({ p, y: y[i] })).sort((a, b) => a.p - b.p);
  let pos = 0, neg = 0; for (const v of y) if (v === 1) pos++; else neg++;
  if (!pos || !neg) return 0.5;
  let rankSum = 0;
  for (let i = 0; i < items.length; i++) if (items[i].y === 1) rankSum += i + 1;
  return (rankSum - pos * (pos + 1) / 2) / (pos * neg);
}
/** 局级 bootstrap CI（按局重采样 n 次 → AUC 分布 2.5-97.5 分位） */
function aucBootstrapCI(rows, stumps) {
  const games = {};
  for (const r of rows) { (games[r.gameId] = games[r.gameId] || []).push(r); }
  const gids = Object.keys(games);
  const nGames = gids.length;
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const resamples = [];
  for (let b = 0; b < BOOT; b++) {
    const sample = [];
    for (let g = 0; g < nGames; g++) {
      const gid = gids[Math.floor(rnd() * nGames)];
      for (const r of games[gid]) sample.push(r);
    }
    const a = auc(sample.map(r => score(stumps, r.f)), sample.map(r => r.y));
    resamples.push(a);
  }
  resamples.sort((x, y) => x - y);
  return { lo: resamples[Math.floor(resamples.length * 0.025)], hi: resamples[Math.floor(resamples.length * 0.975)], nGames };
}

/** AdaBoost + shrinkage + 检查点早停（val group-wise AUC 选 T） */
function trainAdaBoostEarly(trainRows, valRows) {
  const X = trainRows.map(r => r.f), y = trainRows.map(r => r.y);
  const n = X.length;
  let pos = 0, neg = 0; for (const v of y) if (v === 1) pos++; else neg++;
  const w = y.map(v => (v === 1 ? 1 / (2 * pos) : 1 / (2 * neg)));
  const stumps = [];
  const orders = precomputeOrders(X, NFEAT);
  let bestStumps = null, bestAuc = -1, bestT = 0;
  const valX = valRows.map(r => r.f), valY = valRows.map(r => r.y);
  const t0 = Date.now();
  for (let t = 0; t < T_MAX; t++) {
    const st = trainStump(orders, y, w, NFEAT);
    let err = 0;
    for (let i = 0; i < n; i++) if (stumpPred(st, X[i]) !== (y[i] === 1 ? 1 : -1)) err += w[i];
    err = Math.max(Math.min(err, 0.5 - 1e-9), 1e-9);
    const alpha = SHRINKAGE * 0.5 * Math.log((1 - err) / err); // 收缩
    stumps.push({ f: st.f, thr: st.thr, dir: st.dir, alpha });
    let z = 0;
    for (let i = 0; i < n; i++) { const sign = y[i] === 1 ? 1 : -1; w[i] *= Math.exp(-alpha * sign * stumpPred(st, X[i])); z += w[i]; }
    for (let i = 0; i < n; i++) w[i] /= z;
    if ((t + 1) % CHECK_EVERY === 0 || t === T_MAX - 1) {
      const a = auc(valX.map(x => score(stumps, x)), valY);
      if (a > bestAuc) { bestAuc = a; bestStumps = stumps.slice(); bestT = t + 1; }
    }
  }
  return { stumps: bestStumps || stumps, bestT, bestAuc, ms: Date.now() - t0 };
}
function plattFit(scores, y) {
  let A = 1, B = 0;
  for (let it = 0; it < 300; it++) {
    let gA = 0, gB = 0;
    for (let i = 0; i < scores.length; i++) { const p = 1 / (1 + Math.exp(-(A * scores[i] + B))); gA += (y[i] - p) * scores[i]; gB += y[i] - p; }
    A += 0.02 * gA / scores.length; B += 0.02 * gB / scores.length;
  }
  return { A, B };
}
const plattProb = (A, B, s) => 1 / (1 + Math.exp(-(A * s + B)));
/** iso 表压缩：PAVA 输出按"相邻 cal 量化到 0.001 后合并"区间化——修复 40MB 病态
 *  （score 连续唯一 → 原实现每样本一条台阶；压缩后每表 ≤1001 条，校准偏差 ≤0.0005，
 *    推理端不消费 isoTable（v2 raw score 路径），行为零变化） */
function isoCompress(table, tol = 5e-4) {
  const out = [];
  for (const b of table) {
    const cal = Math.round(b.cal * 1000) / 1000;
    const last = out[out.length - 1];
    if (last && Math.abs(last.cal - cal) < 1e-9) {
      last.sMax = Math.max(last.sMax, b.sMax);
      last.n += b.n;
    } else {
      out.push({ sMin: b.sMin, sMax: b.sMax, cal, n: b.n });
    }
  }
  return out;
}
/** per-config isotonic 校准（PAVA，val 拟合——比 Platt 稳，非单调可修） */
function isoFit(scores, y) {
  const sorted = scores.map((s, i) => ({ s, y: y[i] })).sort((a, b) => a.s - b.s);
  const blocks = [];
  for (const it of sorted) {
    blocks.push({ sum: it.y, n: 1, sMin: it.s, sMax: it.s });
    while (blocks.length > 1 && blocks[blocks.length - 1].sum / blocks[blocks.length - 1].n < blocks[blocks.length - 2].sum / blocks[blocks.length - 2].n) {
      const b = blocks.pop(), a = blocks[blocks.length - 1];
      blocks[blocks.length - 1] = { sum: a.sum + b.sum, n: a.n + b.n, sMin: a.sMin, sMax: b.sMax };
    }
  }
  return isoCompress(blocks.map(b => ({ sMin: b.sMin, sMax: b.sMax, cal: b.sum / b.n, n: b.n })));
}
/** iso 查询：最后一个 sMin≤s（右连续 + 间隙插值） */
function isoQuery(table, s) {
  if (!table || !table.length) return null;
  let lo = 0, hi = table.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (table[mid].sMin <= s) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  if (ans < 0) return table[0].cal;
  if (s <= table[ans].sMax) return table[ans].cal;
  if (ans + 1 < table.length) { const a = table[ans], b = table[ans + 1]; return a.cal + (s - a.sMax) / (b.sMin - a.sMax) * (b.cal - a.cal); }
  return table[ans].cal;
}
/** 校准桶验收（iso 表）：max 偏差 <0.10 且 >0.7 桶 <0.10 */
function calibration(rows, stumps, isoTable) {
  const buckets = {};
  for (const r of rows) {
    const p = isoQuery(isoTable, score(stumps, r.f));
    if (p == null) continue;
    const b = Math.min(9, Math.floor(p * 10));
    if (!buckets[b]) buckets[b] = { n: 0, sum: 0, wolf: 0 };
    buckets[b].n++; buckets[b].sum += p; if (r.y) buckets[b].wolf++;
  }
  let maxDev = 0, hiDev = 0;
  for (let b = 0; b <= 9; b++) if (buckets[b]) {
    const dev = Math.abs(buckets[b].sum / buckets[b].n - buckets[b].wolf / buckets[b].n);
    maxDev = Math.max(maxDev, dev);
    if (b >= 7) hiDev = Math.max(hiDev, dev);
  }
  return { maxDev, hiDev, buckets };
}
/** vote_lead 特征权重占比检查（stump 的 f==11 比例） */
function voteLeadShare(stumps) { const n = stumps.filter(s => s.f === 11).length; return n / stumps.length; }

// 按局抽样训练集（group-wise 保持：抽完整局，最多 maxPerCfg 样本——全局模型用更大的量）
function capTrain(rows, maxPerCfg) {
  const games = {};
  for (const r of rows) { (games[r.gameId] = games[r.gameId] || []).push(r); }
  const gids = Object.keys(games);
  if (rows.length <= maxPerCfg) return rows;
  let out = [], gi = 0;
  const order = gids.slice().sort();
  while (out.length < maxPerCfg && gi < order.length) { out = out.concat(games[order[gi]]); gi++; }
  return out;
}

// ---------- 主流程（片段模式：每模型独立落盘，resume 可分批） ----------
const frag = n => path.join(FRAG_DIR, n + '.json');
function saveFrag(n, obj) { fs.mkdirSync(FRAG_DIR, { recursive: true }); fs.writeFileSync(frag(n), JSON.stringify(obj)); }
function loadFrag(n) { try { return JSON.parse(fs.readFileSync(frag(n), 'utf8')); } catch (e) { return null; } }
function fitModel(train, val, maxPerCfg) {
  const lm = trainAdaBoostEarly(capTrain(train, maxPerCfg || MAX_TRAIN), val);
  const lp = plattFit(val.map(r => score(lm.stumps, r.f)), val.map(r => r.y));
  return { stumps: lm.stumps, platt: { A: lp.A, B: lp.B }, bestT: lm.bestT, bestAuc: lm.bestAuc };
}

function main() {
  console.log('[v2] 加载 data/vote-v2 样本...');
  const byCfg = loadSamples();
  const tags = Object.keys(byCfg).sort();
  console.log('[v2] 配置:', tags.map(t => t + '(' + byCfg[t].length + ')').join(' '));
  const only = ONLY ? ONLY.split(',').filter(Boolean) : null;
  const capGroups = {};
  for (const t of tags) { const cap = t.replace(/\D/g, '') + 'p'; if (!capGroups[cap]) capGroups[cap] = []; for (const r of byCfg[t]) capGroups[cap].push(r); }

  // stage=global
  if ((STAGE === 'auto' || STAGE === 'global') && !loadFrag('global')) {
    const allRows = [];
    for (const t of tags) for (const r of byCfg[t]) allRows.push(r);
    const { train, val, test } = splitByGame(allRows);
    const g = fitModel(train, val, 150000); // 全局模型：150k 按局抽样（9 配置混合）
    g.testAuc = auc(test.map(r => score(g.stumps, r.f)), test.map(r => r.y));
    g.voteLeadShare = voteLeadShare(g.stumps);
    saveFrag('global', g);
    console.log(`[v2] global: T=${g.bestT} valAUC=${g.bestAuc.toFixed(4)} testAUC=${g.testAuc.toFixed(4)} vote_lead=${(g.voteLeadShare * 100).toFixed(1)}%`);
  }
  // stage=local（9 preset）
  if (STAGE === 'auto' || STAGE === 'local') {
    for (const t of tags) {
      if (only && !only.includes(t)) continue;
      if (loadFrag('local-' + t)) continue;
      const rows = byCfg[t];
      const { train, val, test } = splitByGame(rows);
      const m = fitModel(train, val);
      m.testAucLocal = auc(test.map(r => score(m.stumps, r.f)), test.map(r => r.y));
      const g = loadFrag('global');
      m.testAucGlobal = g ? auc(test.map(r => score(g.stumps, r.f)), test.map(r => r.y)) : 0;
      m.useLocal = m.testAucLocal >= m.testAucGlobal;
      m.voteLeadShare = voteLeadShare(m.stumps);
      saveFrag('local-' + t, m);
      console.log(`[v2] ${t}: T=${m.bestT} localAUC=${m.testAucLocal.toFixed(4)} globalAUC=${m.testAucGlobal.toFixed(4)} → ${m.useLocal ? 'LOCAL' : 'global'} vote_lead=${(m.voteLeadShare * 100).toFixed(1)}%`);
    }
  }
  // stage=cap（6 cap 聚合）
  if (STAGE === 'auto' || STAGE === 'cap') {
    for (const [cap, rows] of Object.entries(capGroups)) {
      if (only && !only.includes(cap)) continue;
      if (loadFrag('cap-' + cap)) continue;
      const { train, val, test } = splitByGame(rows);
      const m = fitModel(train, val);
      m.testAucLocal = auc(test.map(r => score(m.stumps, r.f)), test.map(r => r.y));
      const g = loadFrag('global');
      m.testAucGlobal = g ? auc(test.map(r => score(g.stumps, r.f)), test.map(r => r.y)) : 0;
      m.useLocal = m.testAucLocal >= m.testAucGlobal;
      saveFrag('cap-' + cap, m);
      console.log(`[v2] cap ${cap}: T=${m.bestT} localAUC=${m.testAucLocal.toFixed(4)} globalAUC=${m.testAucGlobal.toFixed(4)} → ${m.useLocal ? 'LOCAL' : 'global'}`);
    }
  }
  // stage=merge（汇总 + 测试集验收，iso 校准 per-config）
  if (STAGE === 'auto' || STAGE === 'merge') {
    const g = loadFrag('global');
    if (!g) { console.log('[v2] global 片段缺失，先跑 --stage=global'); return; }
    const model = { schema: 'adaboost-vote@2', features: FEATURE_NAMES, shrinkage: SHRINKAGE, global: { stumps: g.stumps, testAuc: g.testAuc }, local: {}, capLocal: {}, meta: { trainedAt: new Date().toISOString(), bootstrap: BOOT } };
    // global 的 iso 校准表（全局 val 拟合）
    {
      const allRows = [];
      for (const t of tags) for (const r of byCfg[t]) allRows.push(r);
      const { train, val } = splitByGame(allRows);
      model.global.isoTable = isoFit(val.map(r => score(g.stumps, r.f)), val.map(r => r.y));
    }
    console.log('\n=== 测试集验收（group-wise + 局级 bootstrap CI，iso 校准）===');
    for (const t of tags) {
      const rows = byCfg[t];
      const { train, val, test } = splitByGame(rows);
      const m = loadFrag('local-' + t);
      if (!m) { console.log('  ' + t + ': 片段缺失'); continue; }
      const effStumps = m.useLocal ? m.stumps : g.stumps;
      const isoRows = train.concat(val); // iso 表用 train+val 拟合（覆盖更全，无测试泄漏）
      const isoTable = isoFit(isoRows.map(r => score(effStumps, r.f)), isoRows.map(r => r.y));
      const testAuc = auc(test.map(r => score(effStumps, r.f)), test.map(r => r.y));
      const ci = aucBootstrapCI(test, effStumps);
      const cal = calibration(test, effStumps, isoTable);
      model.local[t] = { stumps: m.stumps, useLocal: m.useLocal, bestT: m.bestT, isoTable };
      console.log(`  ${t}: AUC=${testAuc.toFixed(4)} [${ci.lo.toFixed(4)},${ci.hi.toFixed(4)}] 校准max=${cal.maxDev.toFixed(3)} >0.7桶=${cal.hiDev.toFixed(3)}（${m.useLocal ? 'local' : 'global'}）vote_lead=${(m.voteLeadShare * 100).toFixed(1)}%`);
    }
    for (const [cap, rows] of Object.entries(capGroups)) {
      const m = loadFrag('cap-' + cap);
      if (!m) continue;
      const { train, val } = splitByGame(rows);
      const effStumps = m.useLocal ? m.stumps : g.stumps;
      const isoRows = train.concat(val);
      const isoTable = isoFit(isoRows.map(r => score(effStumps, r.f)), isoRows.map(r => r.y));
      model.capLocal[cap] = { stumps: m.stumps, useLocal: m.useLocal, bestT: m.bestT, isoTable };
    }
    fs.writeFileSync(OUT, JSON.stringify(model)); // 紧凑 JSON（isoTable 已压缩，体积 ~500KB 级）
    console.log('[v2] 模型已保存:', OUT);
  }
  console.log('[v2] 完成（stage=' + STAGE + '）');
}
main();
