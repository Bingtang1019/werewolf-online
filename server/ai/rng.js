'use strict';
/* =========================================================================
 * 显式可注入 RNG（1.7.0，B1-8 第 0 步）
 * xorshift128+（零依赖）——配对验收/确定性重放的根基：
 *   - createRng(seed, sArr?) → { next(), int(n), pick(arr), shuffle(arr), state(), seed }
 *   - state() 返回 [s0, s1]（128 位拆两个 uint32）——快照只需存 s 数组，
 *     恢复后随机序列连续（不重演，rollout 决策不回滚）
 *   - 用途：server.js 启动建全局 RNG（SEED env 可注入）；房间创建时从全局派生房间种子；
 *     所有服务端决策随机（game.js/bot-brain.js）走注入 RNG，杜绝 Math.random 隐性状态。
 * ========================================================================= */
function mulberry32(seed) { // 种子扩展器：任意 seed → uint32 序列（初始化 xorshift 状态用）
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  };
}

function createRng(seed, sArr) {
  let s0, s1;
  if (Array.isArray(sArr) && sArr.length >= 2) {
    s0 = sArr[0] >>> 0;
    s1 = sArr[1] >>> 0;
    if (s0 === 0 && s1 === 0) s1 = 0x9E3779B9; // 全零态非法（xorshift 退化）
  } else {
    const g = mulberry32((seed >>> 0) || 1);
    s0 = g();
    s1 = g();
    if (s0 === 0 && s1 === 0) s1 = 0x9E3779B9;
  }
  function next() { // [0, 1)
    let x = s0, y = s1;
    s0 = y;
    x ^= (x << 23) >>> 0;
    s1 = (x ^ y ^ (x >>> 17) ^ (y >>> 26)) >>> 0;
    return ((s1 + y) >>> 0) / 4294967296;
  }
  function int(n) { return Math.floor(next() * (n > 0 ? n : 1)); }
  function pick(arr) { return arr && arr.length ? arr[int(arr.length)] : null; }
  function shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = int(i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  return {
    next, int, pick, shuffle,
    state: () => [s0 >>> 0, s1 >>> 0],
    seed: seed >>> 0,
  };
}

module.exports = { createRng };
