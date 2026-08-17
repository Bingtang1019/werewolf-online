'use strict';
/* tools/lab/summarize-batch.js —— 汇总 run-batch / lab 落盘 GameRecord 的胜率
 * 用法：node tools/lab/summarize-batch.js <file.jsonl> [file2.jsonl ...]
 */
const fs = require('fs');
const path = require('path');
const { summarize } = require('../../test/lab/stats/report.js');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('用法: node tools/lab/summarize-batch.js <file.jsonl> [file2.jsonl ...]');
  process.exit(1);
}
for (const f of files) {
  const p = path.resolve(f);
  if (!fs.existsSync(p)) { console.error('文件不存在: ' + p); process.exit(1); }
  const recs = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const s = summarize(recs);
  console.log('\n' + p);
  for (const [c, v] of Object.entries(s.camps)) {
    console.log(`${c.padEnd(6)} ${(v.pct * 100).toFixed(1)}% (${v.wins}/${v.n})  [${(v.ci[0] * 100).toFixed(1)}%, ${(v.ci[1] * 100).toFixed(1)}%]`);
  }
  console.log(`超时 ${s.timeouts} | 错误 ${JSON.stringify(s.errors)} | 平均局时 ${(s.avgDurMs / 1000).toFixed(1)}s`);
}
