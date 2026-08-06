'use strict';
/* 第三方（人狼恋）格局分析工具（v1.7.6）
 * 输入：lab records（JSONL，balance --cupid-only --out 落盘）
 * 输出：每配置人狼恋发生率、人狼恋局/非人狼恋局胜负、第三方胜率
 * 用法：node tools/ai/third-party-stats.js data/balance-cupid-3000.jsonl
 * 依据：record.players[].camp === '第三方' 即人狼恋发生（endInfo.roles 含第三方丘比特/情侣成员） */
const fs = require('fs');
const file = process.argv[2];
if (!file) { console.error('用法: node tools/ai/third-party-stats.js <records.jsonl>'); process.exit(1); }
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const byName = {};
for (const l of lines) { let r; try { r = JSON.parse(l); } catch (e) { continue; } const n = r.config.name || '?'; (byName[n] = byName[n] || []).push(r); }
const isLover = r => (r.players || []).some(p => p.camp === '第三方');
function analyze(recs) {
  const o = { n: recs.length, lover: 0, loverWin: { good: 0, wolf: 0, third: 0 }, normalWin: { good: 0, wolf: 0, third: 0, draw: 0 } };
  for (const r of recs) { const isL = isLover(r); if (isL) { o.lover++; o.loverWin[r.result.winner] = (o.loverWin[r.result.winner] || 0) + 1; } else o.normalWin[r.result.winner] = (o.normalWin[r.result.winner] || 0) + 1; }
  return o;
}
console.log('=== 第三方（人狼恋）格局分析 ===');
let Tn = 0, Tlover = 0, Tthird = 0;
for (const name of Object.keys(byName)) {
  const a = analyze(byName[name]);
  Tn += a.n; Tlover += a.lover; Tthird += a.thirdWin;
  console.log(`\n${name}（${a.n}局）`);
  console.log(`  人狼恋发生率: ${(a.loverPct = a.lover / a.n * 100).toFixed(1)}% (${a.lover}/${a.n}) | 第三方胜率: ${(a.thirdWin / a.n * 100).toFixed(2)}%`);
  if (a.lover) console.log(`  人狼恋局胜负: 好人 ${(a.loverWin.good / a.lover * 100).toFixed(1)}% | 狼人 ${(a.loverWin.wolf / a.lover * 100).toFixed(1)}% | 第三方 ${(a.loverWin.third / a.lover * 100).toFixed(1)}%`);
  const nn = a.n - a.lover;
  if (nn) console.log(`  非人狼恋局胜负: 好人 ${(a.normalWin.good / nn * 100).toFixed(1)}% | 狼人 ${(a.normalWin.wolf / nn * 100).toFixed(1)}% | 平局 ${(a.normalWin.draw / nn * 100).toFixed(1)}%`);
}
console.log(`\n=== 全局汇总（${Tn}局）===`);
console.log(`人狼恋发生率: ${(Tlover / Tn * 100).toFixed(1)}% | 第三方总胜率: ${(Tthird / Tn * 100).toFixed(2)}%`);
const all = Object.values(byName).flat();
const w = w => all.filter(r => r.result.winner === w).length;
console.log(`全局阵营胜率: 好人 ${(w('good') / Tn * 100).toFixed(1)}% | 狼人 ${(w('wolf') / Tn * 100).toFixed(1)}% | 第三方 0% | 平局 ${(w('draw') / Tn * 100).toFixed(1)}%`);
