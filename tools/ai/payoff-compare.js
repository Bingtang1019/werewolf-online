'use strict';
/* 1.7.4（步骤2）：payoff 动态化配对验收——同 seed 双配置（动态 p=q=1 vs 静态 p=q=0）逐局 McNemar。
 * 运行：node tools/ai/payoff-compare.js [games] [seed] [bots]
 * 参数纪律：每版 payoffP/payoffQ 记入实施记录；不显著就回退（单侧分解定位旋钮）。 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const GAMES = parseInt(process.argv[2] || '400', 10);
const SEED = process.argv[3] || 'pc';
const BOTS = process.argv[4] || 'simulate';
// 单侧分解（1.7.4 验收纪律）：通过环境变量指定 A/B 两版的 (p,q)
const PA = parseFloat(process.env.PC_PA || '1'), QA = parseFloat(process.env.PC_QA || '1');
const PB = parseFloat(process.env.PC_PB || '0'), QB = parseFloat(process.env.PC_QB || '0');
const tmpA = root + '/data/_pc-dyn.jsonl';
const tmpB = root + '/data/_pc-static.jsonl';
function runLab(pP, pQ, mode, out) {
  const env = Object.assign({}, process.env, { PAYOFF_P: String(pP), PAYOFF_Q: String(pQ) });
  if (mode === 'value') env.PAYOFF_MODE = 'value'; else delete env.PAYOFF_MODE;
  execFileSync(process.execPath,
    [root + '/test/lab/lab.js', 'baseline', '--games=' + GAMES, '--cap=13', '--bots=' + BOTS, '--seed=' + SEED, '--out=' + out],
    { cwd: root, env, stdio: 'pipe', timeout: 900000 });
}
function load(f) { const o = {}; for (const l of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) { try { const r = JSON.parse(l); o[r.gameId] = r.result.winner; } catch (e) {} } return o; }
function mcnemar(a, b) {
  if (!(a + b)) return { chi2: 0, p: 1, better: null };
  const chi2 = (Math.abs(a - b) - 1) ** 2 / (a + b);
  const erfc = x => { const t = 1 / (1 + 0.3275911 * x); const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))); return y * Math.exp(-x * x); };
  return { chi2, p: erfc(Math.sqrt(chi2 / 2)), better: a > b ? '动态' : '静态' };
}
for (const f of [tmpA, tmpB]) { try { fs.unlinkSync(f); } catch (e) {} }
const MODE_A = process.env.PAYOFF_MODE_A || 'analytic';
const MODE_B = process.env.PAYOFF_MODE_B || 'analytic';
console.log('跑局中（A: p=' + PA + ' q=' + QA + ' mode=' + MODE_A + '）...'); runLab(PA, QA, MODE_A, tmpA);
console.log('跑局中（B: p=' + PB + ' q=' + QB + ' mode=' + MODE_B + '）...'); runLab(PB, QB, MODE_B, tmpB);
const A = load(tmpA), B = load(tmpB);
let a = 0, b = 0, dynGood = 0, stGood = 0, n = 0;
for (const k of Object.keys(A)) {
  if (!(k in B)) continue;
  n++;
  if (A[k] === 'good') dynGood++;
  if (B[k] === 'good') stGood++;
  if (A[k] === 'good' && B[k] !== 'good') a++;
  else if (A[k] !== 'good' && B[k] === 'good') b++;
}
const m = mcnemar(a, b);
console.log('=== payoff 单侧对比（同 seed=' + SEED + '，' + n + ' 局，' + BOTS + ' 档）===');
console.log('A(p=' + PA + ',q=' + QA + ')好人胜率：' + (dynGood / n * 100).toFixed(1) + '%（' + dynGood + '/' + n + '）');
console.log('B(p=' + PB + ',q=' + QB + ')好人胜率：' + (stGood / n * 100).toFixed(1) + '%（' + stGood + '/' + n + '）');
console.log('不一致对（A好胜/B好胜）：' + a + ' : ' + b + ' → χ²=' + m.chi2.toFixed(2) + '，p=' + m.p.toFixed(4) + (m.p < 0.05 ? ' → 显著' : ' → 不显著'));
