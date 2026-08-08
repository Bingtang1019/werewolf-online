'use strict';
/* 1.7.18：voteaudit（在线 25 维）→ train 格式转换器——v3 重训数据源（A-2 同源修复）
 * 输入：test/lab/data/v3og-{tag}.voteaudit.jsonl（LAB_AUDIT_VOTE=1 + --audit 产出，含 gameId）
 * 输出：data/vote-v3-online/{tag}.jsonl（{gameId, f[25], tIsWolf}——与 build-vote-v3-samples 输出同格式）
 * 用法：node tools/ai/conv-voteaudit.js [--tags=12a,9a] [--dir=test/lab/data] [--out=data/vote-v3-online]
 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const get = (k, d) => { const eq = process.argv.find(a => a.startsWith(k + '=')); return eq ? eq.slice(k.length + 1) : d; };
const TAGS = (get('--tags', '4p,6p,8p,9a,9b,9c,9d,12a,12b,12c,12d,12e,12f,12g,12h,15p')).split(',');
const DIR = path.resolve(root, get('--dir', 'data/batch'));
const OUT = path.resolve(root, get('--out', 'data/vote-v3-online'));
fs.mkdirSync(OUT, { recursive: true });
for (const tag of TAGS) {
  const src = path.join(DIR, get('--src-prefix', 'v3og-') + tag + '.voteaudit.jsonl');
  if (!fs.existsSync(src)) { console.log('跳过 ' + tag + '（无源）'); continue; }
  const lines = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean);
  let kept = 0, skipped = 0;
  const out = fs.createWriteStream(path.join(OUT, tag + '.jsonl'));
  for (const l of lines) {
    let s; try { s = JSON.parse(l); } catch (e) { skipped++; continue; }
    if (!Array.isArray(s.f) || s.f.length !== 25) { skipped++; continue; }
    out.write(JSON.stringify({ gameId: s.gameId || 'unk', f: s.f, tIsWolf: s.tIsWolf ? 1 : 0 }) + '\n');
    kept++;
  }
  out.end();
  console.log(tag + ': ' + kept + ' 保留 / ' + skipped + ' 跳过');
}
console.log('完成 → ' + OUT);
