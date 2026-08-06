'use strict';
/* balance：平衡预测（v1.7.6）——预设配置 + 随机配置的比例预测。
 * 规则：预设配置（PRESETS 全部或选中）每种跑 N 局；随机配置（人数/职业/胜利规则按现有规则随机，数量=预设种类数）每种跑 ceil(2/3·N) 局（比例 3:2）。
 * 用法：
 *   node test/lab/lab.js balance --games=3000 --workers=8            # 全部预设 + 随机（各 2/3N）
 *   node test/lab/lab.js balance --games=3000 --cupid-only=1         # 只含丘比特预设 + 随机（随机必须含丘比特）
 *   node test/lab/lab.js balance --games=3000 --presets=0,1,2        # 指定预设索引
 * report：每配置胜率（含第三方）+ 汇总（预设侧/随机侧/全局）。 */
const path = require('path');
const fs = require('fs');
const { runOneLabGame } = require('../core/room-runner');
const { createRecorder } = require('../core/recorder');
const { createStreamStats } = require('../stats/report');
const { PRESETS } = require('../presets');
const { createRng } = require('../../../server/ai/rng.js');
// v1.7.6：随机配置固化清单（data/random-presets-v2.json）——每轮复用同一份，消除“每轮随机配置不同”的混杂
const ROOT = path.resolve(__dirname, '..', '..', '..');
let RANDOM_PRESETS = null;
try { RANDOM_PRESETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'random-presets-v2.json'), 'utf8')).random; } catch (e) { RANDOM_PRESETS = null; }

/* 随机配置生成器（按现有规则随机）：人数 4-18，狼≥1、预言家1、丘比特可选（--cupid-only 强制含）、
 * 神职池（女巫/猎人/守卫/摄梦人）随机、狼美人可选、平民补足（≥1）、胜利规则（屠城/屠边）随机。 */
function randomConfig(seed, opts = {}) {
  const r = createRng((typeof seed === 'string' ? (function(s){ let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; })(seed) : (seed >>> 0)) || 1);
  const pick = arr => arr[Math.floor(r.next() * arr.length)];
  const cap = 4 + Math.floor(r.next() * 15); // 4..18
  let wolf = Math.max(1, Math.round(cap * (r.next() < 0.5 ? 0.25 : 0.33)));
  const cupid = (opts.cupidOnly || r.next() < 0.4) ? 1 : 0; // 含丘比特（本次要求/随机概率）
  const seer = 1;
  const gods = [];
  if (r.next() < 0.7) gods.push('witch');
  if (r.next() < 0.5) gods.push('hunter');
  if (r.next() < 0.4) gods.push('guard');
  if (r.next() < 0.3) gods.push('dreamer');
  const wolfBeauty = r.next() < 0.4 ? 1 : 0;
  // 平民不足时收缩（优先削狼美人/狼，保神职与平民≥1）
  let wb = wolfBeauty;
  let villager = cap - (wolf + seer + cupid + gods.length + wb);
  while (villager < 1 && wb) { wb = 0; villager = cap - (wolf + seer + cupid + gods.length); }
  while (villager < 1 && wolf > 1) { wolf--; villager = cap - (wolf + seer + cupid + gods.length + wb); }
  if (villager < 1) villager = 1; // 极端兜底（人数过小）
  const counts = { wolf, seer, villager };
  if (cupid) counts.cupid = 1;
  if (wb) counts.wolfBeauty = 1;
  for (const g of gods) counts[g] = 1;
  const winMode = r.next() < 0.5 ? 'city' : 'edge';
  return { name: `随机${cap}人局`, cap, counts, winMode, cupid: cupid > 0, random: true };
}

function planTasks(cfg) {
  const ROOT = path.resolve(__dirname, '..', '..', '..');
  const N = cfg.games || 3000;
  const usePresets = cfg.cupidOnly ? PRESETS.filter(p => p.cupid) : (cfg.presets ? PRESETS.filter((_, i) => String(cfg.presets).split(',').map(Number).includes(i)) : PRESETS);
  const RAND_N = Math.ceil(N * 2 / 3); // 随机配置每类 2/3N（比例 3:2）
  const randCount = cfg.random || usePresets.length; // 随机配置种类数 = 预设种类数
  const rec = cfg.out ? createRecorder(path.isAbsolute(cfg.out) ? cfg.out : path.join(ROOT, cfg.out)) : null;
  const seedBase = cfg.seed || 'bl';
  const tasks = [];
  const noRandom = !!cfg.noRandom || !!cfg['no-random']; // v1.7.6：只跑预设配置（不做随机）
  for (let si = 0; si < usePresets.length; si++) {
    const p = usePresets[si];
    for (let g = 0; g < N; g++) {
      const gameId = `bl-${si}-${g}`;
      tasks.push({ id: gameId, gameId, seed: `${seedBase}-p${si}-${g}`, overrides: { cap: p.cap, counts: p.counts, winMode: p.winMode, botLine: Array(Math.max(1, p.cap - 1)).fill(cfg.bots || 'smart'), name: p.name }, full: !!cfg.out });
    }
  }
  for (let rci = 0; rci < randCount && !cfg.noRandom && !cfg['no-random']; rci++) { // v1.7.6：--no-random 跳过随机配置（只跑预设）
    const rc = (RANDOM_PRESETS && RANDOM_PRESETS[rci]) ? Object.assign({}, RANDOM_PRESETS[rci], { random: true }) : randomConfig(`${seedBase}-r${rci}`, { cupidOnly: !!cfg.cupidOnly }); // v1.7.6：固化清单优先，回退随机生成
    for (let g = 0; g < RAND_N; g++) {
      const gameId = `bl-r${rci}-${g}`;
      tasks.push({ id: gameId, gameId, seed: `${seedBase}-r${rci}-${g}`, overrides: { cap: rc.cap, counts: rc.counts, winMode: rc.winMode, botLine: Array(Math.max(1, rc.cap - 1)).fill(cfg.bots || 'smart'), name: rc.name, random: true }, full: !!cfg.out });
    }
  }
  const sf = cfg.sampleFile ? (path.isAbsolute(cfg.sampleFile) ? cfg.sampleFile : path.join(ROOT, cfg.sampleFile)) : null;
  let i = -1;
  return {
    total: tasks.length, rec, sampleFile: sf, N, RAND_N, usePresets, randCount, tasks,
    next() {
      if (++i >= tasks.length) return null;
      const t = tasks[i];
      if (rec && rec.has(t.gameId)) return { skip: true, gameId: t.gameId };
      return t;
    },
  };
}
function report(statsOrRecords, cfg) {
  const s = Array.isArray(statsOrRecords) ? require('../stats/report').summarize(statsOrRecords) : statsOrRecords.result();
  const fmt = (g) => {
    const camps = Object.entries(g.camps || {}).map(([c, v]) => `${c} ${(v.pct * 100).toFixed(1)}%[${(v.ci[0] * 100).toFixed(0)}-${(v.ci[1] * 100).toFixed(0)}]`).join(' | ');
    return `${g.valid} 局: ${camps}${g.timeouts ? ' | 超时' + g.timeouts : ''}`;
  };
  console.log('\n=== 平衡预测（预设 + 随机 3:2）===');
  if (s.byCap && Object.keys(s.byCap).length) {
    console.log('（流式按 cap 分组）');
    for (const [cap, g] of Object.entries(s.byCap)) console.log(`  cap ${cap}: ${fmt(g)}`);
  }
  console.log('全局: ' + fmt(s));
  if (cfg.out) console.log(`[lab] 已落盘 → ${cfg.out}`);
}
async function run(cfg) {
  const gen = planTasks(cfg);
  const st = createStreamStats();
  for (let t = gen.next(); t; t = gen.next()) {
    if (t.skip) continue;
    const r = await runOneLabGame(Object.assign({}, cfg, t.overrides || {}, { seed: t.seed, gameId: t.gameId }));
    if (gen.rec && !gen.rec.has(r.gameId)) gen.rec.write(r);
    st.add(r);
  }
  if (gen.rec) gen.rec.close();
  report(st, cfg);
}
module.exports = { run, planTasks, report, streamable: true, randomConfig };
