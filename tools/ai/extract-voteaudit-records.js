'use strict';
/* tools/ai/extract-voteaudit-records.js —— 从 GameRecord 的 voteAudit 字段提取训练样本
 * 输入：lab 落盘 records（含 voteAudit: [{gameId, f[25], tIsWolf, ...}]）
 * 输出：data/vote-v3-online/<tag>.jsonl（{gameId, f[25], tIsWolf}）
 * 用法：node tools/ai/extract-voteaudit-records.js --records=data/human-chat-v3-nlu-audit300.jsonl --tag=12a --out=data/vote-v3-online/12a.jsonl
 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const get = (k, d) => { const eq = process.argv.find(a => a.startsWith('--' + k + '=')); return eq ? eq.slice(k.length + 3) : d; };
const recordsFile = path.resolve(root, get('records', ''));
const tag = get('tag', '12a');
const outFile = path.resolve(root, get('out', path.join('data', 'vote-v3-online', tag + '.jsonl')));
if (!fs.existsSync(recordsFile)) { console.error('records 不存在: ' + recordsFile); process.exit(1); }
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const lines = fs.readFileSync(recordsFile, 'utf8').split('\n').filter(Boolean);
let total = 0, kept = 0, skipped = 0;
const out = fs.createWriteStream(outFile);
for (const l of lines) {
  const r = JSON.parse(l);
  const audits = r.voteAudit || [];
  for (const a of audits) {
    total++;
    if (!Array.isArray(a.f) || a.f.length !== 25) { skipped++; continue; }
    out.write(JSON.stringify({ gameId: r.gameId || 'unk', f: a.f, tIsWolf: a.tIsWolf ? 1 : 0 }) + '\n');
    kept++;
  }
}
out.end(() => {
  console.log(JSON.stringify({ records: lines.length, auditRows: total, kept, skipped, output: outFile }, null, 2));
});
