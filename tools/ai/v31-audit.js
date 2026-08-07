'use strict';
/* v31-audit.js — V3.1 验收补缺（v1.7.16）
 * ① 重现 fit-value-v3 的 holdout 划分（seed42 rnd<0.2 按局）
 * ② 每配置 AUC + 局级 bootstrap CI + 等权 AUC CI
 * ③ v3（13 维旧特征）在 V3.1 holdout 上的同测试集归因
 * ④ 12d 形态（α 混合）确认
 * 用法：node tools/ai/v31-audit.js
 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const { rebuildEventStates, eventsToDays, auc } = require(root + '/server/ai/fit-value-v3.js');
const vm = require(root + '/server/ai/value-model.js'); // V3.1 的 15 维 buildFeatures（deadFrac→3frac）

const RECS = root + '/data/records-v4';
const V3 = JSON.parse(fs.readFileSync(root + '/models/value-vote-v3.json', 'utf8')); // 13 维旧模型
const V4 = JSON.parse(fs.readFileSync(root + '/models/value-vote-v31.json', 'utf8')); // V3.1（原名 value-vote-v4.json）

/* v3 的 13 维特征（deadFrac 版）——与 v3 训练时代一致 */
function buildFeaturesV3(s) {
  const T = (s.R + s.S + s.M) || 1;
  const r = s.R / T, sg = s.S / T;
  return [1, r, sg, T, s.N / (s.cap || T), s.cap || T, r * sg, s.R, s.S, s.M, s.wolf0, s.god0, s.vill0];
}
function dot(w, x) { let a = 0; for (let i = 0; i < x.length; i++) a += w[i] * x[i]; return a; }

/* 重现 fit-value-v3 的划分（seed=42 LCG，按局） */
function splitByGame(rows) {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  return rows.filter(r => rnd() >= 0.2); // train 是 <0.2 → test；这里返回 test（rnd >= 0.2 是 train？——注意：fit 里 split: rnd()<0.2?'test':'train'——所以 rnd<0.2 是 test）
}
function loadRecords(p) {
  const files = fs.readdirSync(p).filter(f => /\.jsonl$/.test(f)).map(f => path.join(p, f));
  const out = [];
  for (const f of files) {
    const base = path.basename(f);
    const tag = base.replace(/\.jsonl$/, '');
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const t = line.trim(); if (!t) continue;
      try { out.push(Object.assign(JSON.parse(t), { tag })); } catch (e) {}
    }
  }
  return out;
}

function main() {
  const recs = loadRecords(RECS);
  console.log('[audit] records:', recs.length, '局');
  // 重现划分：fit 里 split = rnd()<0.2 ? test : train（seed=42 每局一次，按 rec 顺序）
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const testRecs = recs.filter(r => rnd() < 0.2);
  console.log('[audit] test 局（seed42 rnd<0.2，与 fit-value-v3 同序）:', testRecs.length);

  // 每配置 test 样本（pre 节点，V3.1 blended 值 + v3 旧模型值 + y）
  const byCfg = new Map();
  for (const rec of testRecs) {
    const cfg = rec.tag;
    const days = eventsToDays(rec);
    const nodes = rebuildEventStates(Object.assign({}, rec, { days }));
    for (const n of nodes) {
      if (n.phase !== 'pre') continue;
      const s15 = { R: n.R, S: n.S, M: n.M, N: n.N, cap: n.cap, wolf0: n.wolf0, god0: n.god0, vill0: n.vill0 };
      const v31 = vm.value(s15, cfg);
      const v3v = dot(V3.global.weights, buildFeaturesV3(s15)); // v3 用 global（v3 时代无 per-config local 混合评估路径——用 global 公平对比）
      const y = String(rec.result.winner).toLowerCase().includes('good') ? 1 : 0;
      if (!byCfg.has(cfg)) byCfg.set(cfg, []);
      byCfg.get(cfg).push({ gameId: rec.gameId, v31, v3v, y });
    }
  }

  const cfgs = [...byCfg.keys()].sort();
  const eqAucs31 = [], eqAucs3 = [];
  console.log('\n配置    n(样本) n(局)   V3.1 AUC   局级CI95        v3同集AUC  12d形态(α)');
  for (const cfg of cfgs) {
    const items = byCfg.get(cfg);
    const n = items.length;
    const games = new Set(items.map(i => i.gameId)).size;
    const a31 = auc(items.map(i => i.y), items.map(i => i.v31));
    const a3 = auc(items.map(i => i.y), items.map(i => i.v3v));
    eqAucs31.push(a31); eqAucs3.push(a3);
    // 局级 bootstrap CI（按 gameId 重采样 200 次）
    const gids = [...new Set(items.map(i => i.gameId))];
    const bootAucs = [];
    for (let b = 0; b < 200; b++) {
      const sampled = [];
      for (let i = 0; i < gids.length; i++) {
        const g = gids[Math.floor(Math.random() * gids.length)];
        sampled.push(...items.filter(x => x.gameId === g));
      }
      bootAucs.push(auc(sampled.map(x => x.y), sampled.map(x => x.v31)));
    }
    bootAucs.sort((a, b) => a - b);
    const lo = bootAucs[5], hi = bootAucs[194];
    const alpha = (V4.alpha && V4.alpha[cfg]) != null ? V4.alpha[cfg] : '-';
    console.log(`${cfg.padEnd(5)} ${String(n).padEnd(8)} ${String(games).padEnd(6)} ${a31.toFixed(4).padStart(7)}   [${lo.toFixed(3)},${hi.toFixed(3)}]   ${a3.toFixed(4).padStart(7)}   α=${alpha}`);
  }
  const eq31 = eqAucs31.reduce((a, b) => a + b, 0) / eqAucs31.length;
  const eq3 = eqAucs3.reduce((a, b) => a + b, 0) / eqAucs3.length;
  console.log(`\n配置等权: V3.1=${eq31.toFixed(4)}  v3(同集) =${eq3.toFixed(4)}  → 提升=${(eq31 - eq3).toFixed(4)}`);
}

main();
