'use strict';
/* matrix：配置矩阵扫描（v1.7.6 第二部分预留④）——多 cap×counts 组合，每组合 N 局；多进程收益最大的场景。
 * 用法：
 *   --caps=6,8,13 --games=50        # 每 cap 用 defaultCounts 跑 games 局
 *   --matrix='8:wolf2,seer1,villager5;13:wolf3,seer1,witch1,villager8'   # 显式配置（分号分隔组合）
 * report 按 cap 分组输出胜率（Wilson CI）。 */
const path = require('path');
const { runOneLabGame } = require('../core/room-runner');
const { createRecorder } = require('../core/recorder');
const { summarize } = require('../stats/report');
const { defaultCounts } = require('../core/config');

function parseMatrix(matrix) {
  const combos = [];
  for (const part of String(matrix).split(';')) {
    const [cap, countsStr] = part.split(':');
    const capN = parseInt(cap, 10);
    const counts = {};
    for (const kv of String(countsStr || '').split(',')) {
      const m = kv.match(/^([a-zA-Z]+)(\d+)$/);
      if (m) counts[m[1]] = parseInt(m[2], 10);
    }
    if (!countsStr) return null; // 格式错误
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    if (sum !== capN) throw new Error(`matrix 组合 ${part} 人数不符：counts 总和 ${sum} != cap ${capN}`);
    combos.push({ cap: capN, counts });
  }
  return combos;
}
function planTasks(cfg) {
  const ROOT = path.resolve(__dirname, '..', '..', '..');
  let combos;
  if (cfg.matrix) combos = parseMatrix(cfg.matrix);
  else combos = String(cfg.caps || '8,13').split(',').map(s => { const cap = parseInt(s, 10); return { cap, counts: defaultCounts(cap) }; });
  const gamesPer = cfg.games || 50;
  const seedBase = cfg.seed || 'mx';
  const rec = cfg.out ? createRecorder(path.isAbsolute(cfg.out) ? cfg.out : path.join(ROOT, cfg.out)) : null;
  let ci = -1, gi = gamesPer;
  const sf = cfg.sampleFile ? (path.isAbsolute(cfg.sampleFile) ? cfg.sampleFile : path.join(ROOT, cfg.sampleFile)) : null;
  return {
    total: combos.length * gamesPer, rec, combos, sampleFile: sf,
    next() {
      if (++gi >= gamesPer) { gi = 0; ci++; }
      if (ci >= combos.length) return null;
      const combo = combos[ci];
      const gameId = `mx-${combo.cap}-${gi}`;
      if (rec && rec.has(gameId)) return { skip: true, gameId };
      return { id: gameId, gameId, seed: `${seedBase}-${combo.cap}-${gi}`, overrides: { cap: combo.cap, counts: combo.counts, botLine: Array(Math.max(1, combo.cap - 1)).fill(cfg.bots || 'smart') }, full: !!cfg.out };
    },
  };
}
function report(statsOrRecords, cfg) {
  const s = Array.isArray(statsOrRecords) ? summarize(statsOrRecords) : statsOrRecords.result();
  console.log('\n--- 配置矩阵（按 cap 分组，胜率 95% Wilson CI）---');
  // v1.7.6：byCap key 是 'cap'+数字（createStreamStats 分组前缀），解析出纯 cap 数字
  const caps = Object.keys(s.byCap || {}).map(k => parseInt(String(k).replace(/^cap/, ''), 10)).filter(n => !isNaN(n)).sort((a, b) => a - b);
  if (!caps.length) { console.log('（无分组数据）'); return; }
  for (const cap of caps) {
    const g = s.byCap['cap' + cap] || s.byCap[cap];
    const line = Object.entries(g.camps).map(([c, v]) => `${c} ${(v.pct * 100).toFixed(1)}%[${(v.ci[0] * 100).toFixed(0)}-${(v.ci[1] * 100).toFixed(0)}]`).join(' | ');
    console.log(`  cap ${cap}（${g.valid} 局）: ${line}${g.timeouts ? ' | 超时' + g.timeouts : ''}`);
  }
  console.log(`全局: ${s.valid} 局 | 错误 ${JSON.stringify(s.errors)} | 平均局时 ${(s.avgDurMs / 1000).toFixed(1)}s`);
  if (cfg.out) console.log(`[lab] 已落盘 → ${cfg.out}`);
}
// 单进程按序取任务（planTasks 是游标式，无法随机访问——用 next 循环替代 runPool 索引）
async function run(cfg) {
  const gen = planTasks(cfg);
  const records = [];
  for (let t = gen.next(); t; t = gen.next()) {
    if (t.skip) continue;
    const r = await runOneLabGame(Object.assign({}, cfg, t.overrides || {}, { seed: t.seed, gameId: t.gameId }));
    if (gen.rec && !gen.rec.has(r.gameId)) gen.rec.write(r);
    records.push(r);
  }
  if (gen.rec) gen.rec.close();
  report(records, cfg);
}
module.exports = { run, planTasks, report, streamable: true };
