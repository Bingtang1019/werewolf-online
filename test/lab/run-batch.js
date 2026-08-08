'use strict';
/* =========================================================================
 * test/lab/run-batch.js —— 统一跑批入口（v1.8.0：worker_threads 并行）
 *
 * 用法示例：
 *   node test/lab/run-batch.js --total 2000 --tag pair-12a-v42 --cap 12 \
 *     --counts 4-4-4 --preset 12a --seed-base pair42
 *   [--parallel 8]         核数覆盖（默认 os.cpus().length 动态取，不硬编码）
 *   [--real]               真实时钟模式（默认虚拟）
 *   [--sample]             启用投票样本采集（输出 <out-dir>/<tag>.samples.jsonl）
 *   [--wall-budget 8000]   单局墙钟预算 ms（虚拟模式兜底，默认 8000）
 *   [--timeout-ms 3600000] 虚拟时间超限（默认 1h）
 *   [--out-dir test/lab/data] 输出目录（默认 test/lab/data）
 *   [--win-mode edge] [--bot-level simulate] [--lover-mode off]
 *
 * 输出：<out-dir>/<tag>.jsonl（GameRecord）· done-<tag>.txt（checkpoint）·
 *       <tag>.samples.jsonl（--sample 时）
 * 退出码：0=全部健康；2=存在超时局；1=致命错误
 * ========================================================================= */
const path = require('path');
const { runPoolParallel } = require('./core/pool');
const { PRESETS } = require('./presets');

const a = process.argv.slice(2);
const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const has = k => a.includes(k);

const total = parseInt(get('--total', '2000'), 10);
const tag = get('--tag', `batch-${Date.now()}`);
const outDir = get('--out-dir', path.join(__dirname, 'data'));
const seedBase = get('--seed-base', null) || null;
const wallBudget = parseInt(get('--wall-budget', '8000'), 10);
const timeoutMs = parseInt(get('--timeout-ms', String(60 * 60 * 1000)), 10);
const parallel = has('--parallel') ? parseInt(get('--parallel', '0'), 10) : 0; // 0 → os.cpus().length

/* preset 优先：--preset 12a 等从 PRESETS 取标准阵容（counts 对象语义，12 人局 = 4狼+1预+1猎+1守+1女巫+4民）；
 * --counts 兼容对象语法（--counts "wolf=4,seer=1,hunter=1,guard=1,witch=1,villager=4"）；
 * 教训固化（v1.8.0）：早期 --counts 4-4-4 数组传入 setCounts 被当角色 key '0/1/2' 丢弃 → 12 人局只剩 1狼1民 → 异常局面 stall。 */
const PRESET_KEYS = { '4p': 0, '6p': 1, '8p': 2, '9a': 3, '9b': 4, '9c': 5, '9d': 6, '12a': 7, '12b': 8, '12c': 9, '12d': 10, '12e': 11, '12f': 12, '12g': 13, '12h': 14, '15p': 15 };
const presetKey = get('--preset', null);
const presetIdx = presetKey != null ? PRESET_KEYS[presetKey] : (presetKey != null ? Number(presetKey) : null);
let cap = parseInt(get('--cap', String(presetIdx != null && PRESETS[presetIdx] ? PRESETS[presetIdx].cap : 12)), 10);
let counts = null;
if (presetIdx != null && PRESETS[presetIdx]) counts = { ...PRESETS[presetIdx].counts }; // 标准阵容（含狼美/丘比特配置）
const countsRaw = get('--counts', '');
if (countsRaw) { // 显式覆盖（对象语法）
  counts = {};
  for (const kv of countsRaw.split(',')) { const [k, v] = kv.split('='); if (k && v != null) counts[k.trim()] = parseInt(v, 10); }
  if (!counts.wolf) { console.error('[lab] --counts 需对象语法（--counts "wolf=4,seer=1,..."）；数组语义已废弃'); process.exit(1); }
}
if (!counts) { console.error('[lab] 必须提供 --preset（标准阵容）或 --counts（对象语法）'); process.exit(1); }

const baseCfg = {
  cap,
  counts,
  winMode: get('--win-mode', presetIdx != null && PRESETS[presetIdx] ? PRESETS[presetIdx].winMode : 'edge'),
  botLevel: get('--bot-level', 'simulate'),
  presetKey,
  loverMode: get('--lover-mode', 'off'),
  timeoutMs,
  wallBudgetMs: wallBudget,
};
// 1.7.17（V5.2 轻量 B）：--variant "0.6,0.8,0.4" 或 "0.6:strict,0.8:loose"（w:followMode）→ 混合变体 botLine（轮转分配）
const variantRaw = get('--variant', '');
if (variantRaw) {
  const parts = variantRaw.split(',').map(x => x.trim()).filter(Boolean);
  const ws = [];
  for (const pt of parts) {
    const [w, mode] = pt.split(':');
    const wv = parseFloat(w);
    if (isNaN(wv) || wv <= 0 || wv >= 1) { console.error('[lab] --variant 格式: "0.6:strict,0.8:loose"（0<w<1，mode=strict/loose/none 可选）'); process.exit(1); }
    ws.push({ w: wv, mode: mode || 'strict' });
  }
  if (ws.length) {
    const line = [];
    for (let i = 0; i < cap - 1; i++) {
      const v = ws[i % ws.length];
      line.push({ level: baseCfg.botLevel, suspicionW: v.w, followMode: v.mode });
    }
    baseCfg.botLine = line;
    console.log(`[lab] 变体池: ${ws.map(v => v.w + ':' + v.mode).join('/')}（${cap - 1} bot 轮转）`);
  }
}
const sampleFile = has('--sample') ? path.join(outDir, `${tag}.samples.jsonl`) : null;

console.log(`[lab] run-batch: total=${total} tag=${tag} cap=${cap} counts=${JSON.stringify(counts)} parallel=${parallel || 'auto'} preset=${presetKey || '-'}`);
console.log(`[lab] outputs → ${path.join(outDir, tag + '.jsonl')}（checkpoint: done-${tag}.txt${sampleFile ? '，样本: ' + path.basename(sampleFile) : ''}）`);

runPoolParallel(total, {
  tag, outDir, baseCfg, seedBase, sampleFile,
  parallel: parallel || undefined, // undefined → runPoolParallel 内部 os.cpus().length
  mode: has('--real') ? 'real' : 'virtual',
  onProgress: (f, t, ms) => {
    const per = ms / Math.max(1, f);
    const left = per * Math.max(0, t - f) / 1000;
    process.stdout.write(`\r[lab] ${f}/${t}（${per.toFixed(0)}ms/局，余 ~${left.toFixed(0)}s）`);
  },
}).then(res => {
  process.stdout.write('\n');
  const timeouts = res.filter(r => r && r.result && r.result.timeout);
  console.log(`[lab] done: ${res.length} 局 → ${path.join(outDir, tag + '.jsonl')}${timeouts.length ? `（⚠ ${timeouts.length} 局超时：${timeouts.map(r => r.result.error && r.result.error.kind).join(',')}）` : ''}`);
  process.exit(timeouts.length ? 2 : 0);
}).catch(e => {
  console.error('[lab] fatal:', e);
  process.exit(1);
});
