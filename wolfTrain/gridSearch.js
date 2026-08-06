'use strict';
/* =========================================================================
 * wolfTrain/gridSearch.js —— S3 社会性参数网格搜索（v1.7.7）
 * 参数化 botTalk 狼分支：claimGod（穿衣服概率）、counterSeer（被查杀对跳概率）
 * selfDestruct（被查杀且票首位时自爆）挂起——对齐点④：game.js/rules.md 尚无自爆机制，需先加规则+引擎。
 * 每组合 3000 局 ≈10s（325 局/s）→ 4×4=16 组合 ≈2.7 分钟/轮，可行。
 * ========================================================================= */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');

function gridCombos() {
  const grid = [];
  for (const claimGod of [0, 0.25, 0.5, 0.75])       // 穿衣服概率（随机自称神职）
    for (const counterSeer of [0, 0.3, 0.6, 0.9])    // 对跳预言家概率（被查杀时）
      grid.push({ claimGod, counterSeer });
  return grid;
}

function evalCombo(combo, games = 3000, config = '') {
  const env = Object.assign({}, process.env, {
    BOT_DELAY_MS: '100', PHASE_TIMEOUT: '30', NIGHT_TIMEOUT: '20', CHAT_INTERVAL: '0',
    WOLF_CLAIM_GOD: String(combo.claimGod),   // botTalk 狼分支穿衣服概率
    WOLF_COUNTER_SEER: String(combo.counterSeer), // botTalk 狼分支对跳概率
  });
  const args = config
    ? [path.join(ROOT, 'test/lab/lab.js'), 'matrix', '--matrix=' + config, '--games=' + games, '--seed=gs', '--workers=8']
    : [path.join(ROOT, 'test/lab/lab.js'), 'balance', '--presets=7', '--no-random=1', '--games=' + games, '--seed=gs', '--workers=8'];
  const out = execFileSync(process.execPath, args, { cwd: ROOT, env, stdio: 'pipe', encoding: 'utf8', timeout: 120000 });
  const m = out.match(/wolf ([\.\d]+)%/);
  return m ? parseFloat(m[1]) / 100 : null;
}

async function gridSearch({ games = 3000, config = '' } = {}) {
  const results = [];
  for (const combo of gridCombos()) {
    const wolfRate = evalCombo(combo, games, config);
    results.push({ ...combo, wolfRate });
    console.log(`[S3] claimGod=${combo.claimGod} counterSeer=${combo.counterSeer} → wolf ${(wolfRate * 100).toFixed(1)}%`);
  }
  results.sort((a, b) => Math.abs(b.wolfRate - 0.5) - Math.abs(a.wolfRate - 0.5)); // 最失衡在前（找 50% 最近）
  console.log('最接近 50%：', JSON.stringify(results[0]));
  return results;
}
module.exports = { gridSearch, gridCombos, evalCombo };
