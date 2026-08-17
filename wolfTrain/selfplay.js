'use strict';
/* wolfTrain/selfplay.js —— 狼侧自博弈训练循环（V5.2 A 线）
 * 每代：
 *   1) 用当前 wolf-god 模型 + LAB_WOLF_EPS 采夜刀样本（好人侧冻结，不改任何好人策略）
 *   2) 训练下一代 wolf-god
 *   3) 用下一代模型跑 baseline 评估
 * 用法：
 *   node wolfTrain/selfplay.js --games=300 --cap=12 --counts="wolf=3,seer=1,witch=1,villager=7" \
 *     --eps=0.3 --iters=2 --rounds=150 --eval-games=300 --base-model=models/wolf-god-v1.json
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { summarize } = require('../test/lab/stats/report.js');

const root = path.resolve(__dirname, '..');
function get(k, d) { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; }

const games = parseInt(get('games', '300'), 10);
const cap = parseInt(get('cap', '12'), 10);
const counts = get('counts', 'wolf=3,seer=1,witch=1,villager=7');
const eps = parseFloat(get('eps', '0.3'));
const iters = parseInt(get('iters', '1'), 10);
const rounds = parseInt(get('rounds', '150'), 10);
const evalGames = parseInt(get('eval-games', '300'), 10);
const baseModel = get('base-model', path.join(root, 'models', 'wolf-god-v1.json'));
const outPrefix = get('out-prefix', path.join(root, 'models', 'wolf-god-sp'));
const dataPrefix = get('data-prefix', path.join(root, 'data', 'wolf-sp'));

function runNode(args, env) {
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) { console.error('[selfplay] 子命令失败: node ' + args.join(' ')); process.exit(r.status || 1); }
}

for (let it = 0; it < iters; it++) {
  const curModel = it === 0 ? baseModel : `${outPrefix}-${it}.json`;
  const nextModel = `${outPrefix}-${it + 1}.json`;
  const sampleFile = `${dataPrefix}-${it}.jsonl`;
  const recordFile = `${dataPrefix}-records-${it}.jsonl`;
  const evalFile = `${dataPrefix}-eval-${it}.jsonl`;
  console.log(`\n=== 第 ${it + 1}/${iters} 代 ===`);
  console.log(`[selfplay] 采集（eps=${eps}, model=${curModel}）...`);
  runNode(['test/lab/lab.js', 'sample', `--games=${games}`, `--cap=${cap}`, `--counts=${counts}`, '--parallel=8', '--workers=4', `--sample-file=${sampleFile}`, `--out=${recordFile}`], { LAB_WOLF_EPS: String(eps), WOLF_GOD_MODEL: curModel });
  console.log(`[selfplay] 训练 ${nextModel} ...`);
  runNode(['tools/ai/train-wolf-god.js', `--samples=${sampleFile}`, `--out=${nextModel}`, `--rounds=${rounds}`], {});
  console.log(`[selfplay] 评估 ${nextModel} ...`);
  runNode(['test/lab/lab.js', 'baseline', `--games=${evalGames}`, `--cap=${cap}`, `--counts=${counts}`, `--out=${evalFile}`], { WOLF_GOD_MODEL: nextModel });
  const recs = fs.readFileSync(evalFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const s = summarize(recs);
  const good = s.camps.good, wolf = s.camps.wolf;
  console.log(`[selfplay] 第 ${it + 1} 代结果: good ${good ? (good.pct * 100).toFixed(1) + '%' : 'n/a'} / wolf ${wolf ? (wolf.pct * 100).toFixed(1) + '%' : 'n/a'}`);
}
console.log('\n[selfplay] 完成');
