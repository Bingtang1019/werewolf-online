'use strict';
/* McNemar 配对检验（二元结果配对比较的正确检验，B1-6）——纯函数，可单测 */
function erfc(x) { // Abramowitz-Stegun 7.1.26，精度 ~1e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const e = y * Math.exp(-x * x);
  return x >= 0 ? e : 2 - e;
}
/** a = A 赢 B 输的对数；b = A 输 B 赢的对数；返回 { chi2, p, better }（连续性校正） */
function mcnemar(a, b) {
  if (a + b === 0) return { chi2: 0, p: 1, better: null };
  const chi2 = (Math.abs(a - b) - 1) ** 2 / (a + b);
  return { chi2, p: erfc(Math.sqrt(chi2 / 2)), better: a > b ? 'A' : a < b ? 'B' : null };
}
module.exports = { mcnemar };
