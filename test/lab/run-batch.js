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

const a = process.argv.slice(2);
const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const has = k => a.includes(k);

const total = parseInt(get('--total', '2000'), 10);
const tag = get('--tag', `batch-${Date.now()}`);
const outDir = get('--out-dir', path.join(__dirname, 'data'));
const cap = parseInt(get('--cap', '12'), 10);
const counts = (get('--counts', '4-4-4') || '4-4-4').split('-').map(Number);
const seedBase = get('--seed-base', null) || null;
const wallBudget = parseInt(get('--wall-budget', '8000'), 10);
const timeoutMs = parseInt(get('--timeout-ms', String(60 * 60 * 1000)), 10);
const parallel = has('--parallel') ? parseInt(get('--parallel', '0'), 10) : 0; // 0 → os.cpus().length

const baseCfg = {
  cap,
  counts,
  winMode: get('--win-mode', 'edge'),
  botLevel: get('--bot-level', 'simulate'),
  presetKey: get('--preset', null),
  loverMode: get('--lover-mode', 'off'),
  timeoutMs,
  wallBudgetMs: wallBudget,
};
const sampleFile = has('--sample') ? path.join(outDir, `${tag}.samples.jsonl`) : null;

console.log(`[lab] run-batch: total=${total} tag=${tag} cap=${cap} counts=${counts.join('-')} parallel=${parallel || 'auto'}`);
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
