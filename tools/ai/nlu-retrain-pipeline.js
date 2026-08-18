'use strict';
/* tools/ai/nlu-retrain-pipeline.js —— NLU 自动化重训流水线（C 目标）
 * 步骤：采集（human-chat + LAB_AUDIT_VOTE=1）→ 抽取 voteaudit → 重训 v3 → 端到端评估（on/off）
 * 用法：
 *   node tools/ai/nlu-retrain-pipeline.js \
 *     --games=300 --cap=12 --counts=wolf3,seer1,witch1,villager7 --fake-seer=1 \
 *     --tag=12a --out-model=models/adaboost-vote-v3-nlu-auto.json \
 *     --eval-games=200 --blend=0.5
 */
const { spawnSync } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const get = (k, d) => { const eq = process.argv.find(a => a.startsWith('--' + k + '=')); return eq ? eq.slice(k.length + 3) : d; };

const games = parseInt(get('games', '300'), 10);
const cap = parseInt(get('cap', '12'), 10);
const counts = get('counts', 'wolf3,seer1,witch1,villager7');
const fakeSeer = get('fake-seer', '1') === '1';
const tag = get('tag', '12a');
const outModel = path.resolve(root, get('out-model', 'models/adaboost-vote-v3-nlu-auto.json'));
const evalGames = parseInt(get('eval-games', '200'), 10);
const blend = parseFloat(get('blend', '0.5'));
const prefix = get('prefix', path.join(root, 'data', 'nlu-pipeline'));

const auditRecords = `${prefix}-audit.jsonl`;
const trainData = path.join(root, 'data', 'vote-v3-online', tag + '.jsonl');

function runNode(args, env) {
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) { console.error('[nlu-pipeline] 失败: node ' + args.join(' ')); process.exit(r.status || 1); }
}

console.log('\n=== C: NLU 自动重训流水线 ===');
console.log(`[1/4] 采集 ${games} 局（fake-seer=${fakeSeer}）...`);
runNode(['test/lab/lab.js', 'human-chat', `--games=${games}`, `--cap=${cap}`, `--counts=${counts}`, '--parallel=8', `--nlu=1`, `--fake-seer=${fakeSeer ? '1' : '0'}`, `--out=${auditRecords}`], { VOTE_MODEL_MODE: 'v3', LAB_AUDIT_VOTE: '1' });

console.log(`[2/4] 抽取 voteaudit -> ${trainData} ...`);
runNode(['tools/ai/extract-voteaudit-records.js', `--records=${auditRecords}`, `--tag=${tag}`, `--out=${trainData}`], {});

console.log(`[3/4] 重训 v3 -> ${outModel} ...`);
runNode(['tools/ai/train-vote-v3.js', `--tags=${tag}`, '--dir=data/vote-v3-online', `--out=${outModel}`, '--tmax=200', '--shrinkage=0.7'], {});

console.log(`[4/4] 评估（blend=${blend}）...`);
const evalEnv = { VOTE_MODEL_MODE: 'v3', V3_MODEL_PATH: outModel, LAB_V3_BLEND: String(blend) };
runNode(['test/lab/lab.js', 'human-chat', `--games=${evalGames}`, `--cap=${cap}`, `--counts=${counts}`, '--parallel=8', '--nlu=1', `--fake-seer=${fakeSeer ? '1' : '0'}`, `--out=${prefix}-eval-on.jsonl`], evalEnv);
runNode(['test/lab/lab.js', 'human-chat', `--games=${evalGames}`, `--cap=${cap}`, `--counts=${counts}`, '--parallel=8', '--nlu=0', '--fake-seer=0', `--out=${prefix}-eval-off.jsonl`], evalEnv);
console.log('\n=== C 完成 ===');
