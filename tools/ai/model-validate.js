'use strict';
/* v1.7.2（5）：B1-4 真正验收——配对检验：同 seed 逐局「带模型 vs LAB_NO_MODEL」→ McNemar。
 * 护栏门槛（分层 AUC）管"模型是不是假的"；配对检验管"模型有没有用"，两个都要。
 * 运行：node tools/ai/model-validate.js [games] [seed] [bots]  （默认 simulate=上线档位；v1.7.3：原写死 smart=新 easy，不具代表性） */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const GAMES = parseInt(process.argv[2] || '100', 10);
const SEED = process.argv[3] || 'mv';
const BOTS = process.argv[4] || 'simulate'; // v1.7.3：默认上线档位（simulate）
const tmpA = root + '/data/_mv-model.jsonl';
const tmpB = root + '/data/_mv-nomodel.jsonl';
for (const f of [tmpA, tmpB]) { try { fs.unlinkSync(f); } catch (e) {} }
function runLab(model) {
  const env = Object.assign({}, process.env, model ? {} : { LAB_NO_MODEL: '1' });
  execFileSync(process.execPath,
    [root + '/test/lab/lab.js', 'baseline', '--games=' + GAMES, '--cap=13', '--bots=' + BOTS, '--seed=' + SEED, '--out=' + (model ? tmpA : tmpB)],
    { cwd: root, env, stdio: 'pipe', timeout: 600000 });
}
function load(f) {
  const out = {};
  for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
    try { const r = JSON.parse(line); out[r.gameId] = r.result.winner; } catch (e) {}
  }
  return out;
}
(async () => {
  console.log('跑局中（带模型）...'); runLab(true);
  console.log('跑局中（无模型）...'); runLab(false);
  const A = load(tmpA), B = load(tmpB);
  let aWin = 0, bWin = 0, ab = 0, ba = 0, paired = 0;
  for (const gid of Object.keys(A)) {
    if (B[gid] == null) continue;
    paired++;
    if (A[gid] === 'good') aWin++;
    if (B[gid] === 'good') bWin++;
    if (A[gid] === 'good' && B[gid] === 'wolf') ab++;
    else if (A[gid] === 'wolf' && B[gid] === 'good') ba++;
  }
  const chi = ab + ba ? (Math.abs(ab - ba) - 1) ** 2 / (ab + ba) : 0;
  // erfc 近似（与 stats/mcnemar 一致）
  const erfc = x => { const t = 1 / (1 + 0.3275911 * x); const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))); return y * Math.exp(-x * x); };
  const p = erfc(Math.sqrt(chi / 2));
  console.log('\n=== 模型配对验收（同 seed=' + SEED + '，' + paired + ' 局配对）===');
  console.log('带模型好人胜率：' + (aWin / paired * 100).toFixed(1) + '%（' + aWin + '/' + paired + '）');
  console.log('无模型好人胜率：' + (bWin / paired * 100).toFixed(1) + '%（' + bWin + '/' + paired + '）');
  console.log('不一致对（模型好胜/无模型好胜）：' + ab + ' : ' + ba + ' → χ²=' + chi.toFixed(2) + '，p=' + p.toFixed(4) + (p < 0.05 ? ' → 显著，模型有效 ✓' : ' → 不显著'));
  for (const f of [tmpA, tmpB]) { try { fs.unlinkSync(f); } catch (e) {} }
  process.exit(0);
})().catch(e => { console.error('异常:', e.message); process.exit(1); });
