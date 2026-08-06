'use strict';
/* 1.7.5 阵营平衡套件：预设配置 × 固定局数 + 随机配置（含丘比特）× 局数
 * 用法：node tools/ai/balance-suite.js [--preset-games=3000] [--rand-games=2000] [--seed=b1] [--dry=10]
 * 统计：各配置好人/狼/第三方胜率 + 汇总；随机配置强制含丘比特且按现有规则校验 */
process.env.BOT_DELAY_MS = '100'; process.env.PHASE_TIMEOUT = '30'; process.env.NIGHT_TIMEOUT = '20'; process.env.CHAT_INTERVAL = '0';
const path = require('path');
const clock = require('../../server/clock.js');
const { runOneLabGame, seedHash } = require('../../test/lab/core/room-runner.js');
clock.setMode('virtual');

const PRESETS = [
  { name: '4人-屠城', cap: 4, winMode: 'city', counts: { wolf: 1, seer: 1, villager: 2 } },
  { name: '6人-屠城', cap: 6, winMode: 'city', counts: { wolf: 2, seer: 1, hunter: 1, villager: 2 } },
  { name: '8人-屠城', cap: 8, winMode: 'city', counts: { wolf: 2, seer: 1, hunter: 1, dreamer: 1, villager: 3 } },
  { name: '9人其一-屠边', cap: 9, winMode: 'edge', counts: { wolf: 3, seer: 1, hunter: 1, witch: 1, villager: 3 } },
  { name: '9人其二-屠边', cap: 9, winMode: 'edge', counts: { wolf: 3, seer: 1, dreamer: 1, witch: 1, villager: 3 } },
  { name: '9人其三-屠边', cap: 9, winMode: 'edge', counts: { wolf: 3, seer: 1, guard: 1, witch: 1, villager: 3 } },
  { name: '9人其四-屠边', cap: 9, winMode: 'edge', counts: { wolf: 2, wolfBeauty: 1, seer: 1, dreamer: 1, witch: 1, villager: 3 } },
  { name: '12人其一-屠边', cap: 12, winMode: 'edge', counts: { wolf: 4, seer: 1, hunter: 1, guard: 1, witch: 1, villager: 4 } },
  { name: '12人其二-屠边', cap: 12, winMode: 'edge', counts: { wolf: 4, seer: 1, dreamer: 1, guard: 1, witch: 1, villager: 4 } },
  { name: '12人其三-屠边', cap: 12, winMode: 'edge', counts: { wolf: 3, wolfBeauty: 1, seer: 1, dreamer: 1, guard: 1, witch: 1, villager: 4 } },
  { name: '12人其四-丘比特', cap: 12, winMode: 'edge', counts: { wolf: 3, wolfBeauty: 1, seer: 1, dreamer: 1, cupid: 1, witch: 1, villager: 4 } },
  { name: '12人其五-丘比特', cap: 12, winMode: 'edge', counts: { wolf: 4, seer: 1, dreamer: 1, cupid: 1, witch: 1, villager: 4 } },
  { name: '12人其六-丘比特', cap: 12, winMode: 'edge', counts: { wolf: 4, seer: 1, cupid: 1, guard: 1, witch: 1, villager: 4 } },
  { name: '12人其七-丘比特', cap: 12, winMode: 'edge', counts: { wolf: 4, seer: 1, cupid: 1, hunter: 1, witch: 1, villager: 4 } },
  { name: '12人其八-丘比特', cap: 12, winMode: 'edge', counts: { wolf: 3, wolfBeauty: 1, seer: 1, cupid: 1, guard: 1, witch: 1, villager: 4 } },
  { name: '15人-丘比特', cap: 15, winMode: 'edge', counts: { wolf: 4, wolfBeauty: 1, seer: 1, cupid: 1, guard: 1, witch: 1, hunter: 1, villager: 5 } },
];
const CUPID_PRESETS = PRESETS.filter(p => p.counts.cupid);

/* 随机配置生成（强制含丘比特，按现有规则校验） */
function randCounts(cap, rnd) {
  for (let t = 0; t < 200; t++) {
    const wolf = 1 + Math.floor(rnd() * Math.min(4, Math.floor(cap / 3)));
    const hasWb = rnd() < 0.3 ? 1 : 0;
    const witch = cap >= 5 && rnd() < 0.8 ? 1 : 0;
    const hunter = cap >= 6 && rnd() < 0.4 ? 1 : 0;
    const guard = cap >= 8 && rnd() < 0.4 ? 1 : 0;
    const dreamer = cap >= 7 && rnd() < 0.4 ? 1 : 0;
    const cupid = 1; // 强制含丘比特
    const c = { wolf, wolfBeauty: hasWb, seer: 1, witch, hunter, guard, dreamer, cupid, villager: 0 };
    const sum = Object.values(c).reduce((a, b) => a + b, 0);
    c.villager = cap - sum;
    if (c.villager < 1 || c.wolf < 1) continue;
    return { counts: c, winMode: rnd() < 0.5 ? 'edge' : 'city' };
  }
  return null;
}

function summarize(recs) {
  const camps = { good: 0, wolf: 0, third: 0, draw: 0 };
  let err = 0, to = 0;
  for (const r of recs) {
    if (r.result.timeout || r.result.error) { if (r.result.error) err++; else to++; continue; }
    if (r.result.winner === 'third') camps.third++;
    else if (r.result.winner === 'good') camps.good++;
    else if (r.result.winner === 'wolf') camps.wolf++;
    else camps.draw++;
  }
  const n = recs.length - err - to;
  return { n, err, to, good: n ? camps.good / n : 0, wolf: n ? camps.wolf / n : 0, third: n ? camps.third / n : 0, draw: n ? camps.draw / n : 0 };
}

const args = {};
process.argv.slice(2).forEach(a => { const m = a.match(/^--([^=]+)=(.*)$/); if (m) args[m[1]] = m[2]; });
const PG = parseInt(args['preset-games'] || '3000', 10);
const RG = parseInt(args['rand-games'] || '2000', 10);
const SEED = args.seed || 'bal175';
const DRY = parseInt(args.dry || '0', 10);
const ONLY = args.only ? args.only.split(',') : null;   // 只跑指定预设名（逗号分隔）
const RAND_N = parseInt(args.rand || '-1', 10);          // 随机配置数（-1=默认 CUPID_PRESETS.length，0=跳过）
const GAMES = parseInt(args.games || '0', 10);           // 覆盖每配置局数（0=用 PG/RG）

async function runCfg(cfg, games, baseSeed, label) {
  const recs = [];
  const step = Math.max(1, Math.floor(games / 20));
  for (let i = 0; i < games; i++) {
    const seed = `${baseSeed}-${i}`;
    const rec = await runOneLabGame({ cap: cfg.cap, counts: cfg.counts, winMode: cfg.winMode, botLevel: 'simulate', seed, gameId: label + '-' + i, scenario: 'bal' });
    recs.push(rec);
    if (step > 0 && (i + 1) % step === 0) process.stderr.write(`\r  ${label} ${i + 1}/${games}`);
  }
  process.stderr.write('\n');
  return recs;
}

async function main() {
  console.log(`[balance-suite] 预设${PRESETS.length}种（含丘比特${CUPID_PRESETS.length}种）×${PG}局 + 随机配置${CUPID_PRESETS.length}种×${RG}局`);
  const n = DRY || 1;
  const totals = { good: 0, wolf: 0, third: 0, draw: 0, n: 0, cupidPreset: { good: 0, wolf: 0, third: 0, n: 0 }, randCupid: { good: 0, wolf: 0, third: 0, n: 0 } };
  const targets = ONLY ? PRESETS.filter(p => ONLY.includes(p.name)) : CUPID_PRESETS;
  // 含丘比特预设（用户要求先看第三方胜率）
  for (const p of targets) {
    const games = DRY ? n : (GAMES || PG);
    const recs = await runCfg(p, games, SEED + '-' + p.name, p.name);
    const s = summarize(recs);
    console.log(`  ${p.name.padEnd(10)} n=${s.n} err=${s.err} to=${s.to} | 好人 ${(s.good * 100).toFixed(1)}% 狼 ${(s.wolf * 100).toFixed(1)}% 第三方 ${(s.third * 100).toFixed(1)}% 平局 ${(s.draw * 100).toFixed(1)}%`);
    totals.cupidPreset.good += s.good * s.n; totals.cupidPreset.wolf += s.wolf * s.n; totals.cupidPreset.third += s.third * s.n; totals.cupidPreset.n += s.n;
    totals.good += s.good * s.n; totals.wolf += s.wolf * s.n; totals.third += s.third * s.n; totals.n += s.n;
  }
  // 随机配置（含丘比特，数量可指定）
  const randN = RAND_N >= 0 ? RAND_N : (ONLY ? 0 : CUPID_PRESETS.length);
  let h = seedHash(SEED + '-rand');
  const rnd = () => { h = (h * 1664525 + 1013904223) >>> 0; return h / 4294967296; };
  for (let k = 0; k < randN; k++) {
    const rc = randCounts(4 + Math.floor(rnd() * 12), rnd);
    if (!rc) { console.log('  随机配置生成失败（校验不通过）'); continue; }
    const games = DRY ? n : (GAMES || RG);
    const cfg = { cap: Object.values(rc.counts).reduce((a, b) => a + b, 0), counts: rc.counts, winMode: rc.winMode };
    const recs = await runCfg(cfg, games, SEED + '-r' + k, '随机' + (k + 1));
    const s = summarize(recs);
    console.log(`  随机${k + 1}（cap${cfg.cap} ${cfg.winMode} ${Object.entries(rc.counts).filter(([k2, v]) => v).map(([k2, v]) => k2 + v).join('+')}）n=${s.n} err=${s.err} | 好人 ${(s.good * 100).toFixed(1)}% 狼 ${(s.wolf * 100).toFixed(1)}% 第三方 ${(s.third * 100).toFixed(1)}%`);
    totals.randCupid.good += s.good * s.n; totals.randCupid.wolf += s.wolf * s.n; totals.randCupid.third += s.third * s.n; totals.randCupid.n += s.n;
    totals.good += s.good * s.n; totals.wolf += s.wolf * s.n; totals.third += s.third * s.n; totals.n += s.n;
  }
  const T = totals.n || 1;
  console.log('\n=== 汇总 ===');
  console.log(`含丘比特预设（${totals.cupidPreset.n}局）：好人 ${(totals.cupidPreset.good / (totals.cupidPreset.n || 1) * 100).toFixed(1)}% 狼 ${(totals.cupidPreset.wolf / (totals.cupidPreset.n || 1) * 100).toFixed(1)}% 第三方 ${(totals.cupidPreset.third / (totals.cupidPreset.n || 1) * 100).toFixed(1)}%`);
  console.log(`随机含丘比特（${totals.randCupid.n}局）：好人 ${(totals.randCupid.good / (totals.randCupid.n || 1) * 100).toFixed(1)}% 狼 ${(totals.randCupid.wolf / (totals.randCupid.n || 1) * 100).toFixed(1)}% 第三方 ${(totals.randCupid.third / (totals.randCupid.n || 1) * 100).toFixed(1)}%`);
  console.log(`合计（${totals.n}局）：好人 ${(totals.good / T * 100).toFixed(1)}% 狼 ${(totals.wolf / T * 100).toFixed(1)}% 第三方 ${(totals.third / T * 100).toFixed(1)}%`);
  process.exit(0);
}
main().catch(e => { console.error('异常:', e.message); process.exit(1); });
