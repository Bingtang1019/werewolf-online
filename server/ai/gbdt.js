'use strict';
/**
 * gbdt.js — zero-dependency gradient-boosted regression trees (L2 loss, histogram splits).
 * V4 backbone #1. Pure Node (no npm). LightGBM-style quantile binning keeps training fast
 * on ~200k rows while the inference path stays tiny (pure comparisons, no multiplications).
 *
 *   const { GBDT } = require('./gbdt');
 *   const g = new GBDT({ trees: 200, depth: 3, bins: 64, minLeaf: 50, lr: 0.1, seed: 42 });
 *   g.fit(X, y);      // X: number[][], y: (0|1)[]
 *   g.predict(x);     // -> [0,1] clipped (good-win probability semantic)
 *   g.predictRaw(x);  // -> unclipped (ensemble sigma)
 *   g.toJSON() / GBDT.fromJSON(j)  // model persistence (value-hicvn@1)
 */
class GBDT {
  constructor(o = {}) {
    this.trees = o.trees || 200;
    this.depth = Math.max(1, o.depth || 3);
    this.lr = o.lr != null ? o.lr : 0.1;
    this.bins = Math.max(8, o.bins || 64);
    this.minLeaf = Math.max(5, o.minLeaf || 50);
    this.subsample = o.subsample || 1.0;
    this.stratifyK = o.stratifyK || 2000; // V4.1: 配置等权采样——每轮每配置抽 stratifyK 条
    this.seed = o.seed != null ? o.seed : 42;
    this.base = 0;       // mean(y)
    this.edges = null;   // [d][bins-1] quantile thresholds (actual feature values)
    this.forest = null;  // array of tree roots
    this.d = 0;
  }

  _rnd() {
    this.seed = (this.seed * 1103515245 + 12345) % 2147483648;
    return this.seed / 2147483648;
  }

  fit(X, y, stratifyGroups) {
    // V4.1: stratifyGroups = [[idx...], ...]（每组一个配置）——每轮 boosting 组间等量采样，
    // 大配置不再抢占分裂（小配置重复出现=软加权）。null 时保持原 subsample 行为。
    this.stratifyGroups = stratifyGroups || null;
    const n = X.length;
    const d = X[0].length;
    const B = this.bins;
    this.d = d;
    if (n === 0) throw new Error('gbdt: empty training set');

    /* ---- quantile binning: per-feature sorted order -> uniform rank bins ---- */
    const edges = new Array(d);
    const Xb = new Uint8Array(n * d);
    for (let f = 0; f < d; f++) {
      const order = new Uint32Array(n);
      for (let i = 0; i < n; i++) order[i] = i;
      order.sort((a, b) => X[a][f] - X[b][f]);
      const e = new Float64Array(B - 1);
      for (let b = 1; b < B; b++) e[b - 1] = X[order[Math.min(n - 1, Math.floor((n * b) / B))]][f];
      edges[f] = e;
      for (let i = 0; i < n; i++) {
        const bin = Math.min(B - 1, Math.floor((i * B) / n));
        Xb[order[i] * d + f] = bin;
      }
    }
    this.edges = edges;

    /* ---- boosting loop (L2: residual = y - F) ---- */
    const F = new Float64Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) mean += y[i];
    this.base = mean / n;
    F.fill(this.base);

    const forest = [];
    const resid = new Float64Array(n);
    const allIdx = new Uint32Array(n);
    for (let i = 0; i < n; i++) allIdx[i] = i;

    for (let t = 0; t < this.trees; t++) {
      for (let i = 0; i < n; i++) resid[i] = y[i] - F[i];
      let rows = allIdx;
      if (this.stratifyGroups) {
        const m = this.stratifyK;
        const s = new Uint32Array(m * this.stratifyGroups.length);
        let p = 0;
        for (let g = 0; g < this.stratifyGroups.length; g++) {
          const grp = this.stratifyGroups[g];
          for (let i = 0; i < m; i++) s[p++] = grp[Math.floor(this._rnd() * grp.length)];
        }
        rows = s;
      } else if (this.subsample < 1) {
        const m = Math.max(50, Math.floor(n * this.subsample));
        const s = new Uint32Array(m);
        for (let i = 0; i < m; i++) s[i] = allIdx[Math.floor(this._rnd() * n)];
        rows = s;
      }
      const tree = this._grow(resid, Xb, rows, d, B, 0);
      this._apply(tree, X, F, n, d);
      forest.push(tree);
    }
    this.forest = forest;
    return this;
  }

  _grow(resid, Xb, rows, d, B, depth) {
    const n = rows.length;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += resid[rows[i]];
    const mean = sum / n;
    if (depth >= this.depth || n < this.minLeaf * 2) return { v: mean, leaf: 1 };

    /* best split: scan bins of every feature (histogram + prefix sums) */
    let bestGain = 1e-12, bestF = -1, bestB = 0;
    for (let f = 0; f < d; f++) {
      const cnt = new Int32Array(B);
      const s = new Float64Array(B);
      for (let i = 0; i < n; i++) {
        const b = Xb[rows[i] * d + f];
        cnt[b]++; s[b] += resid[rows[i]];
      }
      let lc = 0, ls = 0;
      for (let b = 0; b < B - 1; b++) {
        lc += cnt[b]; ls += s[b];
        const rc = n - lc, rs = sum - ls;
        if (lc < this.minLeaf || rc < this.minLeaf) continue;
        const gain = (ls * ls) / lc + (rs * rs) / rc - (sum * sum) / n;
        if (gain > bestGain) { bestGain = gain; bestF = f; bestB = b + 1; }
      }
    }
    if (bestF < 0) return { v: mean, leaf: 1 };

    /* partition by bin < bestB */
    const left = [], right = [];
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      if (Xb[r * d + bestF] < bestB) left.push(r); else right.push(r);
    }
    if (!left.length || !right.length) return { v: mean, leaf: 1 };
    return {
      f: bestF,
      b: bestB,
      thr: this.edges[bestF][bestB - 1],
      L: this._grow(resid, Xb, new Uint32Array(left), d, B, depth + 1),
      R: this._grow(resid, Xb, new Uint32Array(right), d, B, depth + 1),
    };
  }

  /* 更新 F：训练/预测分区必须一致（用实际特征值比较，不用 bin 号——bin 边界值在两种比较下判定不同） */
  _apply(tree, X, F, n, d) {
    const lr = this.lr;
    for (let i = 0; i < n; i++) {
      let t = tree;
      while (!t.leaf) t = X[i][t.f] < t.thr ? t.L : t.R;
      F[i] += lr * t.v;
    }
  }

  _predictRow(x, tree) {
    let t = tree;
    while (!t.leaf) t = x[t.f] < t.thr ? t.L : t.R;
    return t.v;
  }

  predictRaw(x) {
    let v = this.base;
    const lr = this.lr;
    for (const t of this.forest) v += lr * this._predictRow(x, t);
    return v;
  }

  predict(x) {
    const v = this.predictRaw(x);
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  toJSON() {
    return { base: this.base, edges: this.edges, forest: this.forest, lr: this.lr, depth: this.depth, trees: this.trees, d: this.d };
  }

  static fromJSON(j) {
    const g = new GBDT({ trees: j.trees, depth: j.depth, lr: j.lr });
    g.base = j.base; g.edges = j.edges; g.forest = j.forest; g.d = j.d;
    return g;
  }
}

module.exports = { GBDT };
