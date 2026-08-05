'use strict';
/* Wilson 分数区间（95% 默认）——纯函数，零依赖，可单测 */
function wilsonCI(k, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const w = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - w), Math.min(1, c + w)];
}
module.exports = { wilsonCI };
