'use strict';
/* =========================================================================
 * wolfTrain/train.js —— α5 训练循环骨架（v1.7.7）
 * 循环：①采集夜刀样本（lab 跑局 + wolf_set 采集钩子落盘；狼败局样本过采样 2×）
 *      ②重训（AdaBoost.fit，全量）
 *      ③验证：3000 局 → p = 狼胜/(狼胜+好胜)（平局单列）
 * 收敛：连续两轮 p ∈ [0.45, 0.55]
 * 依赖：lab 采集（sampleFile + wolf 采集钩子已就位）、evaluate 用 balance --presets
 * ========================================================================= */
const { AdaBoost } = require('./adaboost.js');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function loadSamples(file) {
  const rows = [];
  if (!fs.existsSync(file)) return rows;
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try { rows.push(JSON.parse(line)); } catch (e) {}
  }
  return rows;
}

async function trainLoop({ sampleFile, evalGames = 3000, rounds = 15, labArgs = [] }) {
  const model = new AdaBoost({ rounds: 50 });
  let report = null, lastWolf = 0;
  for (let r = 1; r <= rounds; r++) {
    // ① 采集（外部流程：lab sample --sample-file=<sampleFile> 跑 evalGames；狼败局过采样在样本合并时做）
    const samples = loadSamples(sampleFile);
    if (samples.length < 100) { console.log(`[α5] round ${r}: 样本不足（${samples.length}）`); report = { wolfRate: lastWolf }; continue; }
    // ② 重训：X 为 13 维特征数组，y 为 label；类平衡初始权重（正例=神，负例=民）
    const X = samples.map(s => s.X), y = samples.map(s => s.y);
    const pos = y.filter(v => v === 1).length, neg = y.length - pos;
    const initW = y.map(v => (v === 1 ? 1 / (2 * pos) : 1 / (2 * neg)));
    model.fit(X, y, initW);
    // ③ 验证：3000 局 → p = 狼胜/(狼胜+好胜)
    const out = execFileSync(process.execPath, [
      path.resolve(__dirname, '..', 'test/lab/lab.js'), 'balance',
      '--presets=7', '--no-random=1', '--games=' + evalGames, '--seed=a7r' + r, '--workers=8',
      ...labArgs,
    ], { cwd: path.resolve(__dirname, '..'), env: Object.assign({}, process.env, { BOT_DELAY_MS: '100', PHASE_TIMEOUT: '30', NIGHT_TIMEOUT: '20', CHAT_INTERVAL: '0' }), stdio: 'pipe', encoding: 'utf8', timeout: 300000 });
    const m = out.match(/wolf ([\d.]+)%/);
    const g = out.match(/good ([\d.]+)%/);
    const wolf = m ? parseFloat(m[1]) / 100 : lastWolf;
    const good = g ? parseFloat(g[1]) / 100 : 0;
    report = { wolfRate: wolf, goodRate: good };
    console.log(`round ${r}: wolf ${(wolf * 100).toFixed(1)}% | good ${(good * 100).toFixed(1)}%`);
    if (wolf >= 0.45 && wolf <= 0.55) return { model, report, round: r };
    lastWolf = wolf;
  }
  return { model, report, round: rounds };
}
module.exports = { trainLoop, loadSamples };
