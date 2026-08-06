'use strict';
/* =========================================================================
 * wolfTrain/adaboost.js —— 狼侧刀神分类器（分箱决策桩 AdaBoost，v1.7.7 α3）
 * 与好人版 train-vote-adaboost.js 同管线（类平衡/轮次/置信度），分箱版 lab 无关可单测。
 * label 语义：1=神职（seer/hunter/guard/witch/dreamer），0=民（狼美不算）。
 * ========================================================================= */
function bestStump(X, y, D, d, bins) {
  let best = null;
  const n = X.length;
  for (let j = 0; j < d; j++) {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < n; i++) { const v = X[i][j]; if (v < min) min = v; if (v > max) max = v; }
    if (max - min < 1e-12) continue;
    for (let b = 1; b < bins; b++) {
      const th = min + (max - min) * b / bins;
      for (const dir of [1, -1]) {
        let err = 0;
        for (let i = 0; i < n; i++) if ((dir * X[i][j] >= dir * th ? 1 : 0) !== y[i]) err += D[i];
        if (!best || err < best.err) best = { j, th, dir, err, predict: x => (dir * x[j] >= dir * th ? 1 : 0) };
      }
    }
  }
  return best;
}

class AdaBoost {
  constructor({ rounds = 50, bins = 20 } = {}) { this.rounds = rounds; this.bins = bins; this.models = []; }

  // X: [n][d]，y: [n] ∈ {0,1}，initW: 初始样本权重（失败样本重加权入口——狼败局过采样 2×）
  fit(X, y, initW = null) {
    const n = X.length, d = X[0].length;
    const D = new Array(n);
    if (initW) { const s = initW.reduce((a, b) => a + b, 0) || 1; for (let i = 0; i < n; i++) D[i] = initW[i] / s; }
    else D.fill(1 / n);
    for (let r = 0; r < this.rounds; r++) {
      const stump = bestStump(X, y, D, d, this.bins);
      if (!stump || stump.err >= 0.5) break;
      if (stump.err <= 1e-9) { this.models.push({ ...stump, alpha: 1 }); break; }
      const alpha = 0.5 * Math.log((1 - stump.err) / stump.err);
      let Z = 0;
      for (let i = 0; i < n; i++) { D[i] *= Math.exp(-alpha * (stump.predict(X[i]) === y[i] ? 1 : -1)); Z += D[i]; }
      for (let i = 0; i < n; i++) D[i] /= Z;
      this.models.push({ ...stump, alpha });
    }
    return this;
  }

  // 返回有符号置信度（正=神，负=民），幅值供决策层组合
  predict(X) { return this.models.reduce((s, m) => s + m.alpha * (m.predict(X) ? 1 : -1), 0); }

  toJSON() { return { type: 'wolf-god-adaboost@1', bins: this.bins, models: this.models }; }
  static fromJSON(o) {
    const m = new AdaBoost({ bins: o.bins || 20 });
    // 序列化只存桩参数（predict 是函数不入 JSON）——反序列化重建 predict（v1.7.7 修复：此前丢失导致运行时 TypeError）
    m.models = (o.models || []).map(st => ({ ...st, predict: x => (st.dir * x[st.j] >= st.dir * st.th ? 1 : 0) }));
    return m;
  }
}
module.exports = { AdaBoost };
