'use strict';
/**
 * mlp.js — zero-dependency multilayer perceptron (1 hidden layer, default), BCE + Adam.
 * V4 backbone #2. Pure Node (no npm). Float64Array weights; column-major-friendly loops.
 *
 *   const { MLP } = require('./mlp');
 *   const m = new MLP({ hidden: 128, lr: 1e-3, epochs: 20, batch: 256, l2: 1e-4, seed: 42 });
 *   m.fit(X, y, valX, valY);   // val used for AUC early stopping (from train, by-game — never test)
 *   m.predict(x);              // -> [0,1] sigmoid (good-win probability semantic)
 *   m.toJSON() / MLP.fromJSON(j)
 */
class MLP {
  constructor(o = {}) {
    this.hidden = o.hidden || 128;
    this.lr = o.lr != null ? o.lr : 1e-3;
    this.epochs = o.epochs || 20;
    this.batch = o.batch || 256;
    this.l2 = o.l2 != null ? o.l2 : 1e-4;
    this.seed = o.seed != null ? o.seed : 42;
    this.patience = o.patience || 4;
    this.stratifyK = o.stratifyK || 2000; // V4.1: 配置等权采样——每 epoch 每配置抽 stratifyK 条
    this.norm = null;  // { mean, std }
    this.p = null;     // { W1T:[h*d], b1:[h], W2T:[h], b2 }  (W1T row j = hidden unit j)
    this.d = 0;
  }

  _rnd() {
    this.seed = (this.seed * 1103515245 + 12345) % 2147483648;
    return this.seed / 2147483648;
  }

  /* small AUC (ties averaged) — self-contained, no cross-module dep */
  static _auc(y, s) {
    const n = y.length;
    const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => s[a] - s[b]);
    const rank = new Float64Array(n);
    for (let i = 0; i < n;) {
      let j = i;
      while (j + 1 < n && s[idx[j + 1]] === s[idx[i]]) j++;
      const r = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) rank[idx[k]] = r;
      i = j + 1;
    }
    let sp = 0, np = 0, nn = 0;
    for (let k = 0; k < n; k++) {
      if (y[k] === 1) { sp += rank[k]; np++; } else nn++;
    }
    return np && nn ? (sp - np * (np + 1) / 2) / (np * nn) : 0.5;
  }

  _snapshot(p) {
    return {
      W1T: Float64Array.from(p.W1T), b1: Float64Array.from(p.b1),
      W2T: Float64Array.from(p.W2T), b2: p.b2,
    };
  }

  fit(X, y, valX, valY, stratifyGroups, weights) {
    // V4.1: stratifyGroups = [[idx...], ...]（每组一个配置）——每 epoch 组内等量采样拼接，
    // 大配置不再主导梯度（小配置重复出现=软加权）。null 时保持全局 shuffle（V4.0 行为）。
    // V5.2a: weights = Float64Array/数组（逐样本重要性权重，RWR/PPO 用）——null 时等权。
    this.stratifyGroups = stratifyGroups || null;
    const n = X.length, d = X[0].length, h = this.hidden;
    this.d = d;
    if (n === 0) throw new Error('mlp: empty training set');

    /* ---- feature normalization (stored in model) ---- */
    const mean = new Float64Array(d), std = new Float64Array(d);
    for (let j = 0; j < d; j++) { let s = 0; for (let i = 0; i < n; i++) s += X[i][j]; mean[j] = s / n; }
    for (let j = 0; j < d; j++) { let s = 0; for (let i = 0; i < n; i++) { const v = X[i][j] - mean[j]; s += v * v; } std[j] = Math.sqrt(s / n) || 1e-8; }
    this.norm = { mean: Array.from(mean), std: Array.from(std) };

    /* ---- normalized dense copy (row-major) ---- */
    const Xn = new Float64Array(n * d);
    for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) Xn[i * d + j] = (X[i][j] - mean[j]) / std[j];

    /* ---- Xavier init ---- */
    const p = { W1T: new Float64Array(h * d), b1: new Float64Array(h), W2T: new Float64Array(h), b2: 0 };
    const s1 = Math.sqrt(6 / (d + h)), s2 = Math.sqrt(6 / (h + 1));
    for (let j = 0; j < h * d; j++) p.W1T[j] = (this._rnd() * 2 - 1) * s1;
    for (let j = 0; j < h; j++) p.W2T[j] = (this._rnd() * 2 - 1) * s2;
    this.p = p;

    /* ---- Adam state (4 param groups: W1T, b1, W2T, b2) ---- */
    const groups = [p.W1T, p.b1, p.W2T, null]; // null = scalar b2
    const gm = groups.map(g => g ? new Float64Array(g.length) : 0);
    const gv = groups.map(g => g ? new Float64Array(g.length) : 0);
    const b1 = 0.9, b2 = 0.999, eps = 1e-8;

    const idxCap = Math.max(n, this.stratifyGroups ? this.stratifyGroups.length * this.stratifyK : 0);
    const idx = new Uint32Array(idxCap);
    for (let i = 0; i < n; i++) idx[i] = i;

    let bestP = this._snapshot(p);
    let bestVal = valY ? MLP._auc(valY, valX.map(x => this.predict(x))) : 0;
    let noImprov = 0;
    let t = 0;

    /* scratch buffers (batch cap 512) */
    const CAP = Math.max(this.batch, 512);
    const hh = new Float64Array(CAP * h);
    const relu = new Float64Array(CAP * h);
    const out = new Float64Array(CAP);
    const dout = new Float64Array(CAP);
    const dh = new Float64Array(CAP * h);

    for (let ep = 0; ep < this.epochs; ep++) {
      let epochLen = n;
      if (this.stratifyGroups) {
        /* V4.1 配置等权采样：组内 shuffle → 各取 stratifyK → 拼接 → 全局 shuffle */
        epochLen = 0;
        for (let g = 0; g < this.stratifyGroups.length; g++) {
          const grp = this.stratifyGroups[g];
          for (let i = grp.length - 1; i > 0; i--) { const j = Math.floor(this._rnd() * (i + 1)); const tmp = grp[i]; grp[i] = grp[j]; grp[j] = tmp; }
          const k = Math.min(this.stratifyK, grp.length);
          for (let i = 0; i < k; i++) idx[epochLen++] = grp[i];
        }
        for (let i = epochLen - 1; i > 0; i--) { const j = Math.floor(this._rnd() * (i + 1)); const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp; }
      } else {
        /* shuffle (seeded) */
        for (let i = n - 1; i > 0; i--) { const j = Math.floor(this._rnd() * (i + 1)); const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp; }
      }

      for (let off = 0; off < epochLen; off += this.batch) {
        const m = Math.min(this.batch, epochLen - off);
        /* forward（教训：样本必须按 idx 取——shuffle 后 X 与 y 同步，否则错配） */
        for (let i = 0; i < m; i++) {
          const base = idx[off + i];
          for (let j = 0; j < h; j++) {
            let acc = p.b1[j];
            for (let k = 0; k < d; k++) acc += Xn[base * d + k] * p.W1T[j * d + k];
            hh[i * h + j] = acc;
            relu[i * h + j] = acc > 0 ? acc : 0;
          }
          let acc = p.b2;
          for (let j = 0; j < h; j++) acc += relu[i * h + j] * p.W2T[j];
          out[i] = 1 / (1 + Math.exp(-acc));
        }
        /* output-layer gradients（V5.2a：weights 乘入——RWR/PPO 重要性加权） */
        for (let i = 0; i < m; i++) dout[i] = (out[i] - y[idx[off + i]]) * (weights ? weights[idx[off + i]] : 1) / m;
        const gW2 = new Float64Array(h);
        let gb2 = 0;
        for (let j = 0; j < h; j++) {
          let g = 0;
          for (let i = 0; i < m; i++) g += dout[i] * relu[i * h + j];
          gW2[j] = g + this.l2 * p.W2T[j];
        }
        for (let i = 0; i < m; i++) gb2 += dout[i];
        /* hidden-layer gradients */
        for (let i = 0; i < m; i++) for (let j = 0; j < h; j++) dh[i * h + j] = dout[i] * p.W2T[j] * (hh[i * h + j] > 0 ? 1 : 0);
        const gW1 = new Float64Array(h * d);
        const gb1 = new Float64Array(h);
        for (let j = 0; j < h; j++) {
          let gb = 0;
          for (let i = 0; i < m; i++) gb += dh[i * h + j];
          gb1[j] = gb;
          for (let k = 0; k < d; k++) {
            let g = 0;
            for (let i = 0; i < m; i++) g += dh[i * h + j] * Xn[idx[off + i] * d + k];
            gW1[j * d + k] = g + this.l2 * p.W1T[j * d + k];
          }
        }
        /* Adam updates */
        t++;
        const lrT = this.lr * Math.sqrt(1 - Math.pow(b2, t)) / (1 - Math.pow(b1, t));
        const upd = (arr, g, mm, vv) => {
          for (let i = 0; i < arr.length; i++) {
            mm[i] = b1 * mm[i] + (1 - b1) * g[i];
            vv[i] = b2 * vv[i] + (1 - b2) * g[i] * g[i];
            arr[i] -= lrT * mm[i] / (Math.sqrt(vv[i]) + eps);
          }
        };
        upd(p.W1T, gW1, gm[0], gv[0]);
        upd(p.b1, gb1, gm[1], gv[1]);
        upd(p.W2T, gW2, gm[2], gv[2]);
        gm[3] = b1 * gm[3] + (1 - b1) * gb2;
        gv[3] = b2 * gv[3] + (1 - b2) * gb2 * gb2;
        p.b2 -= lrT * gm[3] / (Math.sqrt(gv[3]) + eps);
      }

      /* early stop on val AUC */
      if (valY && valY.length >= 8) {
        const va = MLP._auc(valY, valX.map(x => this.predict(x)));
        if (va > bestVal + 1e-6) { bestVal = va; bestP = this._snapshot(p); noImprov = 0; }
        else if (++noImprov >= this.patience) break;
      }
    }
    this.p = bestP;
    return this;
  }

  predict(x) {
    const { mean, std } = this.norm;
    const d = mean.length, h = this.hidden;
    const p = this.p;
    let acc2 = p.b2;
    for (let j = 0; j < h; j++) {
      let acc = p.b1[j];
      for (let k = 0; k < d; k++) acc += ((x[k] - mean[k]) / std[k]) * p.W1T[j * d + k];
      const a = acc > 0 ? acc : 0;
      acc2 += a * p.W2T[j];
    }
    return 1 / (1 + Math.exp(-acc2));
  }

  toJSON() {
    return {
      hidden: this.hidden,
      norm: this.norm,
      params: { W1T: Array.from(this.p.W1T), b1: Array.from(this.p.b1), W2T: Array.from(this.p.W2T), b2: this.p.b2 },
    };
  }

  static fromJSON(j) {
    const m = new MLP({ hidden: j.hidden });
    m.norm = j.norm;
    m.p = { W1T: Float64Array.from(j.params.W1T), b1: Float64Array.from(j.params.b1), W2T: Float64Array.from(j.params.W2T), b2: j.params.b2 };
    m.d = j.norm.mean.length;
    return m;
  }
}

module.exports = { MLP };
