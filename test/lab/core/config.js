'use strict';
/* 配置：默认值 < preset < CLI 三级合并 + 校验 */
const PRESETS = {
  smoke:    { games: 10,  cap: 8,  parallel: 4, workers: 1, winMode: 'edge' },
  baseline: { games: 500, cap: 13, parallel: 8, workers: 1, winMode: 'edge' },
  sample:   { games: 2000, cap: 13, parallel: 8, workers: 1, winMode: 'edge' },
  paired:   { games: 400, cap: 13, parallel: 1, workers: 1, winMode: 'edge' },
  deterministic: { games: 20, cap: 8, parallel: 1, workers: 1, winMode: 'edge' },
};
/* 狼数阶梯：13 人局 = 3 狼 10 好（与 B1-3 验收先验对齐） */
function defaultCounts(cap) {
  const wolf = cap >= 14 ? 4 : cap >= 9 ? 3 : cap >= 5 ? 2 : 1;
  const witch = cap >= 5 ? 1 : 0;
  return { wolf, seer: 1, witch, hunter: 0, dreamer: 0, guard: 0, wolfBeauty: 0, cupid: 0, villager: cap - wolf - 1 - witch };
}
/** --counts=wolf2,seer1,villager6 解析 */
function parseCounts(str) {
  const counts = {};
  for (const kv of String(str).split(',')) {
    const m = kv.match(/^([a-zA-Z]+)(\d+)$/);
    if (!m) throw new Error(`--counts 格式错误: ${kv}（应为 wolf2,seer1,...）`);
    counts[m[1]] = parseInt(m[2], 10);
  }
  return counts;
}
function toCamel(k) { return k.replace(/-([a-z])/g, (m, c) => c.toUpperCase()); }
function buildConfig(scenario, argv) {
  const cfg = Object.assign({}, PRESETS[scenario] || PRESETS.smoke, { scenario });
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const k = m[1], v = m[2];
    if (k === 'counts') cfg.counts = parseCounts(v);
    else if (/^\d+$/.test(v)) cfg[toCamel(k)] = parseInt(v, 10);
    else if (v === 'true') cfg[toCamel(k)] = true;
    else if (v === 'false') cfg[toCamel(k)] = false;
    else cfg[toCamel(k)] = v;
  }
  if (!cfg.counts) cfg.counts = defaultCounts(cfg.cap);
  if (!cfg.botLine) cfg.botLine = Array(Math.max(1, cfg.cap - 1)).fill('smart'); // 默认全 smart（paired 等 scenario 自行覆盖）
  if (cfg.bots) cfg.botLine = Array(Math.max(1, cfg.cap - 1)).fill(cfg.bots); // --bots=<level> 快捷：全 bot 用同一档（baseline/sample/deterministic）
  // 校验
  if (cfg.cap < 4 || cfg.cap > 18) throw new Error(`cap 越界: ${cfg.cap}`);
  if (cfg.parallel > 16) throw new Error('parallel 上限 16');
  if (cfg.games < 1) throw new Error('games 必须 ≥1');
  if (!(cfg.workers === 'auto' || (Number.isInteger(cfg.workers) && cfg.workers >= 1 && cfg.workers <= 64))) throw new Error('workers 必须为 auto 或 1~64 整数');
  const sum = Object.values(cfg.counts).reduce((a, b) => a + b, 0);
  if (sum !== cfg.cap) throw new Error(`counts 总和 ${sum} != cap ${cfg.cap}`);
  if (cfg.botLine.length !== cfg.cap - 1) throw new Error(`botLine 长度 ${cfg.botLine.length} != cap-1 ${cfg.cap - 1}`);
  return cfg;
}
module.exports = { buildConfig, PRESETS, defaultCounts, parseCounts };
