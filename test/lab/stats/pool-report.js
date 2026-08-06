'use strict';
/* pool-report：seed 池配对差异报告（v1.7.9，β 方法论·交付物①）
 * 输入：两个 JSONL 记录文件（同 seed 池、同 seedBase，来自 pool scenario），按 seed 串逐局配对。
 * 输出（不再报单点——点估计只作描述，验收全部走区间）：
 *   1. 单变体描述：好/狼/第三方胜率点估计 + Wilson 95% CI（仅描述）
 *   2. 配对 Δ：Δ = pA − pB（好胜率差；狼胜率差 = −Δ，第三方不参与狼/好差），McNemar χ²/p（翻盘对检验）
 *   3. 配对 CI：逐局差 d_i ∈ {−1,0,1} 的 Wald 95% CI（配对掉 seed 间方差）
 *   4. 组级配对（鲁棒性复核）：按 seed 组 s 聚合（每组 perGroup 局）→ groups 个 Δ_s，
 *      配对 t 检验 95% CI（t 分位用 Cornish-Fisher 近似，Abramowitz-Stegun 26.7.5）
 *   5. 落带判定：狼胜率 Wilson CI ⊂ [45,55]（默认）→ PASS，否则 FAIL（指出越界侧）
 * 用法：node test/lab/stats/pool-report.js <A.jsonl> <B.jsonl> [--groups=100] [--label-a=β0a] [--label-b=favens]
 *   [--band=45,55] [--md=<file.md>]
 */
const fs = require('fs');
const { wilsonCI } = require('./wilson');
const { mcnemar } = require('./mcnemar');

/* ---- 分位数（统计正确性：组级配对 t 检验需要 t 分位，不用 z 近似）---- */
function normInv(p) { // Acklam 有理近似（|误差|<1.15e-9）
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5]) * q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}
function tQuantile(df, p) { // Cornish-Fisher（AS 26.7.5），df≥30 误差 <1e-4
  const z = normInv(p);
  const g1 = (z*z*z + z) / 4;
  const g2 = (5*z*z*z*z*z + 16*z*z*z + 3*z) / 96;
  const g3 = (3*z*z*z*z*z*z*z + 19*z*z*z*z*z + 17*z*z*z - 15*z) / 384;
  const g4 = (79*z*z*z*z*z*z*z*z*z + 776*z*z*z*z*z*z*z + 1482*z*z*z*z*z - 1920*z*z*z - 945*z) / 92160;
  return z + g1/df + g2/(df*df) + g3/(df*df*df) + g4/(df*df*df*df);
}

/* ---- 加载与配对 ---- */
function loadRecords(file) {
  const bySeed = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try {
      const r = JSON.parse(line);
      if (!r.seed || !r.result) continue;
      if (bySeed.has(r.seed)) throw new Error(`重复 seed: ${r.seed}`);
      bySeed.set(r.seed, r.result.winner); // 'good' | 'wolf' | 'third' | null
    } catch (e) { throw new Error(`${file} 解析失败: ${e.message}`); }
  }
  return bySeed;
}
function seedGroupOf(seedStr, groups) { // 解析 `{seedBase}-{s}-{g}`（从尾部匹配；不匹配时全归组0）
  const m = String(seedStr).match(/-(\d+)-(\d+)$/);
  return m ? (Number(m[1]) % groups) : 0;
}

/* ---- 主报告 ---- */
function pairedReport(fileA, fileB, opts = {}) {
  const A = loadRecords(fileA), B = loadRecords(fileB);
  const groups = opts.groups || 100;
  const seeds = [...new Set([...A.keys(), ...B.keys()])];
  const onlyA = seeds.filter(s => A.has(s) && !B.has(s));
  const onlyB = seeds.filter(s => !A.has(s) && B.has(s));
  const matched = seeds.filter(s => A.has(s) && B.has(s));
  const n = matched.length;
  // 逐局配对差（好胜率视角：d=1 → A 好胜 B 非好胜；d=-1 → 反之；d=0 → 同向或第三方）
  let thirdA = 0, thirdB = 0, goodA = 0, goodB = 0, wolfA = 0, wolfB = 0;
  let dSum = 0, d2 = 0;
  let mAB = 0, mBA = 0, same = 0, thirdPairs = 0;
  const groupD = new Array(groups).fill(0), groupN = new Array(groups).fill(0);
  const groupGoodA = new Array(groups).fill(0), groupGoodB = new Array(groups).fill(0);
  for (const s of matched) {
    const wa = A.get(s), wb = B.get(s);
    if (wa === 'good') goodA++; else if (wa === 'wolf') wolfA++; else if (wa === 'third') thirdA++;
    if (wb === 'good') goodB++; else if (wb === 'wolf') wolfB++; else if (wb === 'third') thirdB++;
    const d = (wa === 'good' ? 1 : 0) - (wb === 'good' ? 1 : 0);
    dSum += d; d2 += d * d;
    if (wa === 'good' && wb === 'wolf') mAB++;
    else if (wa === 'wolf' && wb === 'good') mBA++;
    else if (wa === wb) same++;
    else thirdPairs++;
    const gi = seedGroupOf(s, groups);
    groupN[gi]++; groupD[gi] += d;
    if (wa === 'good') groupGoodA[gi]++; if (wb === 'good') groupGoodB[gi]++;
  }
  const pA = goodA / n, pB = goodB / n, delta = pA - pB;
  const sd = Math.sqrt(Math.max(0, (d2 - dSum * dSum / n) / (n - 1)));
  const sePair = sd / Math.sqrt(n);
  const z95 = 1.959963984540054;
  const pairCI = [delta - z95 * sePair, delta + z95 * sePair];
  const mc = mcnemar(mAB, mBA);
  // 组级配对 t
  let gdSum = 0, gd2 = 0, gUse = 0;
  for (let i = 0; i < groups; i++) { if (groupN[i] > 0) { gUse++; gdSum += groupD[i] / groupN[i]; gd2 += (groupD[i] / groupN[i]) ** 2; } }
  const gMean = gUse ? gdSum / gUse : 0;
  const gSd = gUse > 1 ? Math.sqrt(Math.max(0, (gd2 - gdSum * gdSum / gUse) / (gUse - 1))) : 0;
  const gSe = gSd / Math.sqrt(gUse);
  const t97 = gUse > 1 ? tQuantile(gUse - 1, 0.975) : z95;
  const gCI = [gMean - t97 * gSe, gMean + t97 * gSe];
  // 落带（狼胜率 Wilson CI ⊂ band）
  const band = (opts.band || '45,55').split(',').map(Number);
  const ciW = (k, m) => { const c = wilsonCI(k, m); return [c[0] * 100, c[1] * 100]; };
  const wolfA_ci = ciW(wolfA, n), wolfB_ci = ciW(wolfB, n);
  const pass = c => c[0] >= band[0] && c[1] <= band[1];
  return {
    meta: { fileA, fileB, groups, n, matched: n, onlyA: onlyA.length, onlyB: onlyB.length, seedBase: 'favens-pool' },
    single: {
      A: { n, good: goodA, wolf: wolfA, third: thirdA, goodPct: pA * 100, wolfPct: wolfA / n * 100, thirdPct: thirdA / n * 100, goodCI: ciW(goodA, n), wolfCI: wolfA_ci, bandPass: pass(wolfA_ci) },
      B: { n, good: goodB, wolf: wolfB, third: thirdB, goodPct: pB * 100, wolfPct: wolfB / n * 100, thirdPct: thirdB / n * 100, goodCI: ciW(goodB, n), wolfCI: wolfB_ci, bandPass: pass(wolfB_ci) },
    },
    paired: {
      deltaPct: delta * 100, deltaWolfPct: -delta * 100,
      sePairPct: sePair * 100,
      pairCI: [pairCI[0] * 100, pairCI[1] * 100], // 好胜率 Δ 的配对 95% CI
      wolfPairCI: [-pairCI[1] * 100, -pairCI[0] * 100],
      mAB, mBA, same, thirdPairs,
      mc,
    },
    group: { gUse, gMeanPct: gMean * 100, gSdPct: gSd * 100, gCIPct: [gCI[0] * 100, gCI[1] * 100], t97 },
    band,
  };
}

/* ---- 输出 ---- */
function fmtCI(c, dp = 1) { return `[${c[0].toFixed(dp)}, ${c[1].toFixed(dp)}]`; }
function fmtP(p) { return p < 1e-16 ? '<1e-16' : p.toFixed(4); }
function render(r, opts = {}) {
  const L = [];
  const la = opts.labelA || 'A', lb = opts.labelB || 'B';
  L.push(`=== seed 池配对报告：${la}(A) vs ${lb}(B) ===`);
  L.push(`池规格: ${r.meta.seedBase} × ${r.meta.groups} groups × ${r.meta.n / r.meta.groups}/group = ${r.meta.n} 局/变体`);
  L.push(`配对: ${r.meta.matched}/${r.meta.matched} seed 命中（仅A ${r.meta.onlyA}，仅B ${r.meta.onlyB}）\n`);
  L.push('── 单变体（描述性，不作验收）──');
  L.push(`  ${la.padEnd(16)} good ${r.single.A.goodPct.toFixed(2)}%${fmtCI(r.single.A.goodCI)} | wolf ${r.single.A.wolfPct.toFixed(2)}%${fmtCI(r.single.A.wolfCI)} | third ${r.single.A.thirdPct.toFixed(2)}%${r.single.A.bandPass ? ' | 落带 PASS' : ' | 落带 FAIL'}`);
  L.push(`  ${lb.padEnd(16)} good ${r.single.B.goodPct.toFixed(2)}%${fmtCI(r.single.B.goodCI)} | wolf ${r.single.B.wolfPct.toFixed(2)}%${fmtCI(r.single.B.wolfCI)} | third ${r.single.B.thirdPct.toFixed(2)}%${r.single.B.bandPass ? ' | 落带 PASS' : ' | 落带 FAIL'}`);
  L.push('  （落带判定：狼胜率 Wilson 95% CI ⊂ [' + r.band.join(',') + ']）\n');
  L.push('── 配对差异（验收口径）──');
  L.push(`  Δ(good) = ${r.paired.deltaPct >= 0 ? '+' : ''}${r.paired.deltaPct.toFixed(2)}pp  [A 好胜率 − B 好胜率]`);
  L.push(`  配对 95% CI: ${fmtCI(r.paired.pairCI)}pp  (SE=${r.paired.sePairPct.toFixed(2)}pp, Wald)  → 狼视角 ${fmtCI(r.paired.wolfPairCI)}pp`);
  const sig = r.paired.pairCI[1] < 0 ? `→ 显著 ${la} 偏狼（好胜率降）` : r.paired.pairCI[0] > 0 ? `→ 显著 ${la} 偏好人` : '→ 配对 CI 含 0，不可判定';
  L.push(`  McNemar: 翻盘对 ${r.paired.mAB}(A好/B狼) : ${r.paired.mBA}(A狼/B好)，χ²=${r.paired.mc.chi2.toFixed(2)}，p=${fmtP(r.paired.mc.p)}，同胜 ${r.paired.same}，含第三方 ${r.paired.thirdPairs} ${sig}\n`);
  L.push('── 组级配对复核（t 检验，鲁棒性）──');
  L.push(`  ${r.group.gUse} groups 有效，mean Δ_s(good) = ${r.group.gMeanPct >= 0 ? '+' : ''}${r.group.gMeanPct.toFixed(2)}pp，sd=${r.group.gSdPct.toFixed(2)}pp`);
  L.push(`  配对 t 95% CI: ${fmtCI(r.group.gCIPct)}pp (df=${r.group.gUse - 1}, t=${r.group.t97.toFixed(4)})\n`);
  L.push('── 结论行 ──');
  L.push(`  [1] ${la} 狼胜率 ${r.single.A.wolfPct.toFixed(2)}%${fmtCI(r.single.A.wolfCI)} → ${r.single.A.bandPass ? 'PASS' : 'FAIL'}（落带口径 [45,55]）`);
  L.push(`  [2] ${lb} 狼胜率 ${r.single.B.wolfPct.toFixed(2)}%${fmtCI(r.single.B.wolfCI)} → ${r.single.B.bandPass ? 'PASS' : 'FAIL'}（落带口径 [45,55]）`);
  L.push(`  [3] Δ=${r.paired.deltaPct >= 0 ? '+' : ''}${r.paired.deltaPct.toFixed(2)}pp 配对CI=${fmtCI(r.paired.pairCI)}pp → ${sig.replace('→ ', '')}`);
  return L.join('\n');
}
function renderMarkdown(r, opts = {}) {
  const la = opts.labelA || 'A', lb = opts.labelB || 'B';
  const L = [];
  L.push(`## seed 池配对报告：${la}(A) vs ${lb}(B)`);
  L.push(`- 池规格：${r.meta.seedBase} × ${r.meta.groups} groups × ${r.meta.n / r.meta.groups}/group = **${r.meta.n} 局/变体**（同池配对）`);
  L.push(`- 配对命中：${r.meta.matched}/${r.meta.matched}（仅A ${r.meta.onlyA}，仅B ${r.meta.onlyB}）`);
  L.push('');
  L.push('| 变体 | good% | wolf% | third% | 落带 |');
  L.push('|---|---|---|---|---|');
  L.push(`| ${la} | ${r.single.A.goodPct.toFixed(2)} ${fmtCI(r.single.A.goodCI)} | ${r.single.A.wolfPct.toFixed(2)} ${fmtCI(r.single.A.wolfCI)} | ${r.single.A.thirdPct.toFixed(2)} | ${r.single.A.bandPass ? 'PASS' : 'FAIL'} |`);
  L.push(`| ${lb} | ${r.single.B.goodPct.toFixed(2)} ${fmtCI(r.single.B.goodCI)} | ${r.single.B.wolfPct.toFixed(2)} ${fmtCI(r.single.B.wolfCI)} | ${r.single.B.thirdPct.toFixed(2)} | ${r.single.B.bandPass ? 'PASS' : 'FAIL'} |`);
  L.push('');
  L.push(`**配对差异（验收口径）**：Δ(good) = ${r.paired.deltaPct >= 0 ? '+' : ''}${r.paired.deltaPct.toFixed(2)}pp，配对 95% CI **${fmtCI(r.paired.pairCI)}pp**（SE ${r.paired.sePairPct.toFixed(2)}pp，Wald）；狼视角 ${fmtCI(r.paired.wolfPairCI)}pp。`);
  L.push(`McNemar：翻盘对 ${r.paired.mAB} : ${r.paired.mBA}，χ²=${r.paired.mc.chi2.toFixed(2)}，p=${fmtP(r.paired.mc.p)}；同胜 ${r.paired.same}，含第三方 ${r.paired.thirdPairs}。`);
  L.push(`组级配对 t（${r.group.gUse} groups）：mean Δ_s=${r.group.gMeanPct >= 0 ? '+' : ''}${r.group.gMeanPct.toFixed(2)}pp，95% CI **${fmtCI(r.group.gCIPct)}pp**（df=${r.group.gUse - 1}）。`);
  L.push('');
  const sig = r.paired.pairCI[1] < 0 ? `显著 ${la} 偏狼` : r.paired.pairCI[0] > 0 ? `显著 ${la} 偏好人` : '不可判定';
  L.push(`**结论**：${la} wolf ${r.single.A.wolfPct.toFixed(2)}% ${r.single.A.bandPass ? 'PASS' : 'FAIL'}；${lb} wolf ${r.single.B.wolfPct.toFixed(2)}% ${r.single.B.bandPass ? 'PASS' : 'FAIL'}；Δ=${r.paired.deltaPct >= 0 ? '+' : ''}${r.paired.deltaPct.toFixed(2)}pp 配对CI=${fmtCI(r.paired.pairCI)}pp → ${sig}。`);
  return L.join('\n');
}

/* ---- CLI ---- */
if (require.main === module) {
  const argv = process.argv.slice(2);
  const [fileA, fileB] = argv.filter(a => !a.startsWith('--'));
  const opts = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const k = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    opts[k] = /^\d+(\.\d+)?$/.test(m[2]) ? Number(m[2]) : m[2];
  }
  if (!fileA || !fileB) { console.error('用法: node test/lab/stats/pool-report.js <A.jsonl> <B.jsonl> [--groups=100] [--label-a=x] [--label-b=y] [--band=45,55] [--md=out.md]'); process.exit(1); }
  try {
    const r = pairedReport(fileA, fileB, opts);
    console.log(render(r, opts));
    if (opts.md) { fs.writeFileSync(opts.md, renderMarkdown(r, opts) + '\n'); console.log(`[pool-report] md → ${opts.md}`); }
  } catch (e) { console.error('pool-report 失败:', e.message); process.exit(1); }
}
module.exports = { pairedReport, render, renderMarkdown, loadRecords };
