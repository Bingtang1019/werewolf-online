'use strict';
/* pool：固定 seed 池配对实验（v1.7.9，β 方法论·交付物①）
 * =========================================================================
 * seed 池定义（本实验的"样本空间"，全项目统一引用，跨变体必须复用同一池）：
 *   seedBase  = 'favens-pool'                 （变体间必须相同——配对的前提）
 *   groups    = 100                            （seed 组数，组级配对 t 检验的观测数）
 *   perGroup  = 100                            （每组局数 → n = 100×100 = 10000/变体）
 *   seed 串   = `${seedBase}-${s}-${g}`        （s∈[0,groups)，g∈[0,perGroup)）
 *   RNG       = FNV-1a(seed 串) → 全局 RNG → 房间 RNG（room-runner.js seedHash）
 * 配对原理：同 seed 串 → 同 RNG 流 → 变体共享同一局"底稿"，策略差异只在干预点分叉。
 *   配对后 Δ 的方差只剩"干预翻盘率"，seed 间方差被完全配对掉（区别于独立采样）。
 * 变体差异只能通过 process.env / botLine 注入（claimGod/favens 开关均为 env），
 *   不改变 seed 派生 → 同串必然同 RNG 流（已在 room-runner 层面保证）。
 * 验收口径：Δ 的配对 95% CI（stats/pool-report.js 输出），不再报单点。
 * 用法（示例，变体间仅改 env）：
 *   WOLF_CLAIM_GOD=0.1 node test/lab/lab.js pool --preset=10 --out=test/lab/data/pool/beta0a.jsonl --workers=14
 *   WOLF_CLAIM_GOD=0.1 FAVENS=1 node test/lab/lab.js pool --preset=10 --out=test/lab/data/pool/favens-full.jsonl --workers=14
 * 配对分析：node test/lab/stats/pool-report.js <A.jsonl> <B.jsonl> --groups=100
 * ========================================================================= */
const path = require('path');
const { runOneLabGame } = require('../core/room-runner');
const { createRecorder } = require('../core/recorder');
const { createStreamStats } = require('../stats/report');
const { PRESETS } = require('../presets');
const ROOT = path.resolve(__dirname, '..', '..', '..');

function planTasks(cfg) {
  const groups = cfg.seedGroups || 100;
  const perGroup = cfg.perGroup || 100;
  const seedBase = cfg.seedBase || 'favens-pool';
  const presetIdx = cfg.preset != null ? Number(cfg.preset) : 10; // 默认局四（十二人局四·丘比特，β 测量配置）
  const p = PRESETS[presetIdx];
  if (!p) throw new Error(`pool: preset ${presetIdx} 不存在（0..${PRESETS.length - 1}）`);
  // v3（v1.7.12）：presetKey 自动路由——已训 9 配置用精确标签，未训配置用 cap 级聚合标签（rollout payoff 路由键，A-2 保证命中）
  const PRESET_TAG = { 0: '4p', 1: '6p', 2: '8p', 3: '9a', 4: '9b', 5: '9c', 6: '9d', 7: '12a', 8: '12b', 9: '12c', 10: '12d', 11: '12e', 12: '12f', 13: '12g', 14: '12h', 15: '15p' }; // v4.2：16 预设全标签（此前 9 标签导致 9b/9c/12c/12e-12h 的 presetKey 落 cap 级，V4.2 训练漏 7 配置）
  const rec = cfg.out ? createRecorder(path.isAbsolute(cfg.out) ? cfg.out : path.join(ROOT, cfg.out)) : null;
  const total = groups * perGroup; // n 由池规格决定（勿传 --games，smoke 预设默认 10 会干扰）
  const tasks = [];
  for (let s = 0; s < groups; s++) {
    for (let g = 0; g < perGroup; g++) {
      const gameId = `pool-${s}-${g}`;
      const seed = `${seedBase}-${s}-${g}`;
      tasks.push({
        id: gameId, gameId, seed,
        overrides: {
          cap: p.cap, counts: p.counts, winMode: p.winMode,
          botLine: Array(Math.max(1, p.cap - 1)).fill(cfg.bots || 'smart'),
          name: p.name,
          ...(cfg.loverMode ? { loverMode: cfg.loverMode } : {}), // v2（M1）：恋人机制模式透传
          ...(cfg.presetKey ? { presetKey: cfg.presetKey } : { presetKey: PRESET_TAG[presetIdx] || p.cap + 'p' }), // v3：配置标识（自动路由：已训→精确标签，未训→cap 级）
          ...(cfg.loverTest ? { loverTest: cfg.loverTest } : {}), // A/B 注入（M3.5）：'cupid-dead-n1' / 'cupid-immortal'
          ...(cfg.loverLocked ? { loverLocked: cfg.loverLocked } : {}), // A/B 注入（M3.5）：解绑禁用（G3 对照）
        },
        full: !!cfg.fullEvents, // 默认摘要记录（无 events），配对只需 seed + winner
      });
    }
  }
  let i = -1;
  return {
    total: tasks.length, rec, groups, perGroup, seedBase, presetIdx,
    next() {
      if (++i >= tasks.length) return null;
      const t = tasks[i];
      if (rec && rec.has(t.gameId)) return { skip: true, gameId: t.gameId }; // checkpoint 续跑
      return t;
    },
  };
}
function report(statsOrRecords, cfg) {
  const s = Array.isArray(statsOrRecords) ? require('../stats/report').summarize(statsOrRecords) : statsOrRecords.result();
  const fmt = (g) => {
    const camps = Object.entries(g.camps || {}).map(([c, v]) => `${c} ${(v.pct * 100).toFixed(2)}%[${(v.ci[0] * 100).toFixed(1)}-${(v.ci[1] * 100).toFixed(1)}]`).join(' | ');
    return `${g.valid} 局: ${camps}${g.timeouts ? ' | 超时' + g.timeouts : ''}`;
  };
  console.log(`\n=== seed 池（${cfg.seedBase || 'favens-pool'}，${cfg.seedGroups || 100}×${cfg.perGroup || 100}）单变体摘要 ===`);
  if (s.byCap && Object.keys(s.byCap).length) for (const [k, g] of Object.entries(s.byCap)) console.log(`  ${k}: ${fmt(g)}`);
  console.log('全局: ' + fmt(s));
  if (cfg.out) console.log(`[lab] 已落盘 → ${cfg.out}`);
}
async function run(cfg) {
  const gen = planTasks(cfg);
  const st = createStreamStats();
  const gameTimeout = cfg.gameTimeout != null ? Number(cfg.gameTimeout) : 60000; // v4.2：单进程路径单局墙钟保护（--game-timeout=ms；多进程路径由 mpool 的 taskTimeoutMs + SIGKILL 承担）
  for (let t = gen.next(); t; t = gen.next()) {
    if (t.skip) continue;
    const r = await withTimeout(runOneLabGame(Object.assign({}, cfg, t.overrides || {}, { seed: t.seed, gameId: t.gameId })), gameTimeout)
      .catch((e) => ({ gameId: t.gameId, seed: t.seed, winner: null, timeout: true, error: String((e && e.message) || e), timeouts: 1 }));
    // 超时/异常局不写盘——保持 checkpoint 未完成状态，重跑自动重试（写盘会被 rec.has 判为已完成）
    if (!r.timeout && gen.rec && !gen.rec.has(r.gameId)) gen.rec.write(r);
    st.add(r);
  }
  if (gen.rec) await gen.rec.close(); // v1.7.9：flush 后再 report/exit
  report(st, cfg);
}
/** 单局墙钟超时保护（--game-timeout=ms；超时局记 timeout 且不落盘，checkpoint 保持未完成） */
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`game timeout after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}
module.exports = { run, planTasks, report, streamable: true };
