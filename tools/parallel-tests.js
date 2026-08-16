'use strict';
/* ============================================================================
 * tools/parallel-tests.js —— 全量测试并行执行器（v1.7.9，架构创新）
 * 背景：selfcheck --tests 原串行 46 测试 ≈352s（慢测试仅 ~15 个，其余 <2s）。
 *      并行改造 = 进程级隔离 + 资源冲突分组 + 超时/重试 + 输出收集。
 * 架构：
 *   1. 进程级隔离（与 test/lab mpool 同哲学）：每测试独立 node 进程。
 *      已验证：46 测试端口互斥（8123–8511 无一重复）→ 无端口冲突；无跨进程共享态。
 *   2. 资源冲突分组：check-snapshot.js 是唯一写项目内文件的测试（data/rooms.json，
 *      其他测试 spawn server.js 时顶层 loadSnapshot() 会读它）→ 独占串行（最后跑）；
 *      其余 45 个并行。并行前预清理 rooms.json 残留，保证并行期所有测试走
 *      "无快照"分支（与串行时字母序在 snapshot 之前的测试语义一致）。
 *   3. worker 池 + 任务队列：--workers=N（默认 min(8, cpus-2)，16 核留余量防 CPU 争抢
 *      把慢测试拖过 240s 超时）。
 *   4. 超时 + 单次重试：240s 墙钟超时杀进程；失败重试 1 次（区分 flaky 与真失败，
 *      重试通过标注）；重试仍失败才算 FAIL。
 *   5. 输出收集：失败时 dump 完整 stdout/stderr（原串行版只报文件名，排查靠运气）。
 * 用法：node tools/parallel-tests.js [--workers=8] [--json=out.json]
 * 接入：tools/selfcheck.js --tests 分支调用（替换原串行 for 循环）。
 * ============================================================================ */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '..');
const testDir = path.join(root, 'test');

const args = {};
process.argv.slice(2).forEach(a => { const m = a.match(/^--([^=]+)=(.*)$/); if (m) args[m[1]] = m[2]; });
const WORKERS = Math.max(1, Math.min(16, parseInt(args.workers || '', 10) || Math.max(2, os.cpus().length - 2)));
const TIMEOUT_MS = 240000;
const SNAPSHOT_TEST = 'check-snapshot.js'; // 写 data/rooms.json → 独占串行
const SNAP = path.join(root, 'data', 'rooms.json');

const tests = fs.readdirSync(testDir).filter(f => f.endsWith('.js') && f !== '_harness-dom.js');
const parallel = tests.filter(t => t !== SNAPSHOT_TEST).sort(); // 字母序与原 readdirSync 一致
const serial = [SNAPSHOT_TEST];

/* ---- 预清理快照残留：保证并行期"无快照"分支（loadSnapshot 不触发）---- */
for (const suf of ['', '.tmp', '.bak']) { try { fs.unlinkSync(SNAP + suf); } catch (e) {} }

/* ---- worker 池 ---- */
function runOne(name) {
  return new Promise((resolve) => {
    const file = path.join(testDir, name);
    const t0 = Date.now();
    const child = spawn(process.execPath, [file], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, TIMEOUT_MS);
    child.stdout.on('data', d => { out += d; if (out.length > 200000) out = out.slice(-100000); });
    child.stderr.on('data', d => { err += d; if (err.length > 200000) err = err.slice(-100000); });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      resolve({ name, code: code === null ? -1 : code, signal: sig, ms: Date.now() - t0, out, err });
    });
    child.on('error', e => { clearTimeout(timer); resolve({ name, code: -2, signal: null, ms: Date.now() - t0, out, err: err + '\nspawn 失败: ' + e.message }); });
  });
}
async function runPool(names, workers) {
  const results = new Map();
  const queue = names.slice();
  const pool = new Set();
  let next = 0;
  const start = async () => {
    while (pool.size < workers && next < queue.length) {
      const name = queue[next++];
      pool.add(name);
      runOne(name).then(r => {
        pool.delete(name);
        results.set(r.name, r);
        start(); // 补位
      });
    }
  };
  await start();
  while (results.size < names.length) await new Promise(r => setTimeout(r, 100));
  return names.map(n => results.get(n));
}

/* ---- 执行：45 并行 → snapshot 串行（最后，独占快照文件）---- */
(async () => {
  const tAll = Date.now();
  const done = [];
  const par = await runPool(parallel, WORKERS);
  for (const r of par) {
    let final = r;
    if (r.code !== 0) { // 单次重试（区分 flaky）
      const r2 = await runOne(r.name);
      r2.retried = true;
      final = r2;
    }
    done.push(final);
  }
  const snapResult = await runOne(serial[0]);
  done.push(snapResult);
  const wall = (Date.now() - tAll) / 1000;

  /* ---- 汇总 ---- */
  let pass = 0, fail = 0, retriedPass = 0;
  const failures = [];
  console.log(`\n[8] 全量自动化测试（并行 v1.7.9，workers=${WORKERS}，${tests.length} 测试）`);
  for (const r of done) {
    const ok = r.code === 0;
    if (ok) { pass++; if (r.retried) retriedPass++; console.log(`    PASS ${r.name} (${r.ms}ms${r.retried ? '，重试后通过' : ''})`); }
    else {
      fail++;
      failures.push(r);
      console.log(`    ✗ FAIL ${r.name} (${r.ms}ms${r.retried ? '，重试后仍失败' : ''}${r.code === -1 ? '，超时被杀' : ''}${r.code === -2 ? '，spawn 失败' : ''})`);
      console.log('       --- stdout 尾部 ---');
      console.log('       ' + (r.out.split('\n').filter(Boolean).slice(-8).join('\n       ') || '(空)'));
      console.log('       --- stderr 尾部 ---');
      console.log('       ' + (r.err.split('\n').filter(Boolean).slice(-8).join('\n       ') || '(空)'));
    }
  }
  console.log(`    测试 ${pass}/${tests.length} 通过` + (retriedPass ? `（含重试通过 ${retriedPass}）` : ''));
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(done.map(r => ({ name: r.name, code: r.code, ms: r.ms, retried: !!r.retried, outTail: r.out.slice(-2000), errTail: r.err.slice(-2000) })), null, 1));
  process.exit(fail > 0 ? 1 : 0);
})();
