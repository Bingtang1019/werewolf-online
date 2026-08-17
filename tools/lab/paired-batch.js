'use strict';
/* tools/lab/paired-batch.js —— 同 seed 配对评估（McNemar）
 * 用法：node tools/lab/paired-batch.js <A.jsonl> <B.jsonl>
 * 要求两份记录有相同 gameId（run-batch 用同一 --seed-base 时满足）。
 */
const fs = require('fs');
const path = require('path');
const { mcnemar } = require('../../test/lab/stats/mcnemar');

function load(file) {
  const p = path.resolve(file);
  const recs = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const map = new Map();
  for (const r of recs) {
    if (r.gameId && r.result && r.result.winner) map.set(r.gameId, r.result.winner);
  }
  return map;
}

const [fa, fb] = process.argv.slice(2);
if (!fa || !fb) { console.error('用法: node tools/lab/paired-batch.js <A.jsonl> <B.jsonl>'); process.exit(1); }
const A = load(fa), B = load(fb);
let aWin = 0, bWin = 0, tie = 0, missing = 0;
for (const [id, wA] of A) {
  const wB = B.get(id);
  if (!wB) { missing++; continue; }
  if (wA === wB) tie++;
  else if (wA === 'good') aWin++; // A 好=赢，B 狼=赢（约定比较好人胜率）
  else bWin++;
}
const n = aWin + bWin;
const m = n ? mcnemar(aWin, bWin) : null;
console.log(`配对局: ${A.size} A / ${B.size} B / 共同 ${A.size - missing} / 缺失 ${missing}`);
console.log(`A 胜 ${aWin} / B 胜 ${bWin} / 平 ${tie}`);
if (m) console.log(`McNemar χ²=${m.chi2.toFixed(3)} p=${m.p.toFixed(4)} better=${m.better}`);
