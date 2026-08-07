'use strict';
/* pair-v4v31.js —— V4.2 vs V3.1 lab 配对终裁（16 配置同局对照）
 * 用法: node tools/ai/pair-v4v31.js --tag=8p --preset=2 --games=500
 * 输出: data/pool/pair2-{tag}-{v4|v3}-0-{g}.jsonl（段格式，配对统一读段）
 * 判定：Δwolf（v4−v3.1）+ 配对 CI + McNemar + 一致率（v4 生效验证）
 * 说明：每配置 v4 批单段（500 局 ~90s），外层 120s 硬限内可完成；v3 批同段格式
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); if (i >= 0) return args[i + 1]; const p = args.find(a => a.startsWith(k + '=')); return p ? p.slice(k.length + 1) : d; };
const tag = get('--tag'), preset = parseInt(get('--preset'), 10), games = parseInt(get('--games', '1000'));
const split = 1, only = get('--only', '');
const V4_MODEL = 'models/value-hicvn-v42.json';
const env = (mode, mv) => ({ ...process.env, PAYOFF_MODE: 'value', VOTE_MODEL_MODE: 'v2', VALUE_MODEL: mode, ...(mv ? { MODEL_VALUE_VOTE_V4: mv } : {}) });

function runSegment(suffix, mode, mv, s0, s1) {
  const out = path.join(ROOT, `data/pool/pair2-${tag}-${suffix}-${s0}-${s1}.jsonl`);
  if (fs.existsSync(out) && fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).length >= (s1 - s0) * 100 * 0.9) return out;
  execFileSync(process.execPath, ['test/lab/lab.js', 'pool', `--preset=${preset}`, '--bots=simulate', `--seed-groups=${s1 - s0}`, '--per-group=100', `--seed-base=pair2-${tag}`, `--out=${out}`, '--workers=14'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 118000, maxBuffer: 2 * 1024 * 1024, env: env(mode, mv) });
  return out;
}
function loadSegs(suffix) {
  const segs = fs.readdirSync(path.join(ROOT, 'data/pool')).filter(f => f.startsWith(`pair2-${tag}-${suffix}-`));
  const m = new Map();
  for (const f of segs) {
    for (const l of fs.readFileSync(path.join(ROOT, 'data/pool', f), 'utf8').trim().split('\n').filter(Boolean)) {
      const r = JSON.parse(l); if (r.seed) m.set(r.seed, r.result ? r.result.winner : null);
    }
  }
  return m;
}
// v4 批 + v3 批（同段格式，逐段推进；断点：已有段跳过）
const groups = Math.ceil(games / 100);
if (only !== 'v3') {
  for (let k = 0; k < split; k++) {
    const s0 = Math.floor(groups * k / split), s1 = Math.floor(groups * (k + 1) / split);
    if (s1 > s0) runSegment('v4', 'v4', V4_MODEL, s0, s1);
  }
}
if (only !== 'v4') {
  for (let k = 0; k < split; k++) {
    const s0 = Math.floor(groups * k / split), s1 = Math.floor(groups * (k + 1) / split);
    if (s1 > s0) runSegment('v3', 'v3', null, s0, s1);
  }
}
// 配对统计
const A = loadSegs('v4'), B = loadSegs('v3');
let n = 0, same = 0, wolfA = 0, wolfB = 0, ab = 0, ba = 0;
for (const [s, w] of A) { if (!B.has(s)) continue; n++; if (w === 'wolf') wolfA++; if (B.get(s) === 'wolf') wolfB++; if (w === B.get(s)) same++; else if (w === 'wolf' && B.get(s) === 'good') ab++; else if (w === 'good' && B.get(s) === 'wolf') ba++; }
if (n < 10) { console.log(`${tag}: 配对样本不足 n=${n}（A=${A.size} B=${B.size}）——段可能未跑完`); process.exit(2); }
const pA = wolfA / n, pB = wolfB / n, d = pA - pB, se = Math.sqrt(pA * (1 - pA) / n + pB * (1 - pB) / n);
const lo = (d - 1.96 * se) * 100, hi = (d + 1.96 * se) * 100;
const sig = hi < 0 ? '显著偏狼' : (lo > 0 ? '显著偏好人' : '无显著差异');
console.log(`${tag}: v4=${(pA * 100).toFixed(1)}% v3.1=${(pB * 100).toFixed(1)}% Δ=${(d * 100).toFixed(2)}pp[${lo.toFixed(1)},${hi.toFixed(1)}] McNemar=${ab}/${ba} 一致=${(same / n * 100).toFixed(0)}% ${same < n ? '✓v4生效' : '⚠v4未生效'} | ${sig} (n=${n})`);
