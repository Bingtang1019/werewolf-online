'use strict';
/* =========================================================================
 * nlu-phase1-clean2.js — NLU Phase 1 第二轮清洗（2026-08-09）
 * 输入: data/nlu/corpus-real.jsonl（首轮 real 310 条）
 * 输出: data/nlu/corpus-clean.jsonl（去噪去重后的标注候选 + 意图种子）
 * 规则: ① 测试残留（并发测试/SSE 推送测试/推送测试等）→ 移出
 *       ② 去重（text+role+ch 完全相同）→ 保留 1 条 + 计数
 *       ③ 极短无信息（≤1 字）→ 移出
 *       ④ 输出: {text, role, ch, day, seat, dupCount, bucket}
 * 标注: 意图种子由人工在 corpus-clean.jsonl 上标注（intent 字段）
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const src = path.join(root, 'data/nlu/corpus-real.jsonl');
const out = path.join(root, 'data/nlu/corpus-clean.jsonl');

const TEST_NOISE = /并发测试|推送测试|SSE|测试\d*$|^测试/;
const seen = new Map();
const rows = [];
for (const l of fs.readFileSync(src, 'utf8').split('\n')) {
  if (!l.trim()) continue;
  const r = JSON.parse(l);
  const t = (r.text || '').trim();
  if (!t || t.length <= 1) continue;
  if (TEST_NOISE.test(t)) continue;
  const key = t + '|' + (r.role || '') + '|' + (r.ch || '');
  if (seen.has(key)) { seen.get(key).dupCount++; continue; }
  const row = { text: t, role: r.role || null, ch: r.ch || 'all', day: r.day ?? null, seat: r.seat ?? null, dupCount: 1, intent: null };
  seen.set(key, row);
  rows.push(row);
}
fs.writeFileSync(out, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
console.log('去噪去重后:', rows.length, '条 →', out);
const byRole = {};
for (const r of rows) byRole[r.role || 'null'] = (byRole[r.role || 'null'] || 0) + 1;
console.log('角色分布:', JSON.stringify(byRole));
// 意图种子标注（规则预标注——人工校验后用）
const intentRules = [
  { re: /跳.*预言家|我是预言家/, intent: 'claim_seer' },
  { re: /查杀|查了|验了.*狼/, intent: 'check' },
  { re: /我投|投谁|投他|票/, intent: 'vote' },
  { re: /刀|杀|今晚/, intent: 'night_plan' },
  { re: /你是.*?狼|你.*?是狼|怀疑|感觉.*狼/, intent: 'attack' },
  { re: /不是我|我不是|别投我|我是好人|平民/, intent: 'defend' },
  { re: /情侣|恋人/, intent: 'lover' },
  { re: /你好|大家好|早上好|在吗|哈哈|666/, intent: 'smalltalk' }
];
const stats = {};
for (const r of rows) {
  for (const ir of intentRules) {
    if (ir.re.test(r.text)) { r.intent = ir.intent; stats[ir.intent] = (stats[ir.intent] || 0) + 1; break; }
  }
}
console.log('规则预标注分布:', JSON.stringify(stats));
console.log('未标注:', rows.filter(r => !r.intent).length, '条（人工标注候选）');
fs.writeFileSync(out, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
// 未标注样本展示（人工标注接口）
console.log('\n=== 未标注样本（前 25 条，人工标注候选）===');
rows.filter(r => !r.intent).slice(0, 25).forEach((r, i) => console.log(i + 1 + ':', '[' + (r.role || '?') + '|' + (r.ch || 'all') + '|d' + (r.day ?? '?') + ']', r.text.slice(0, 50)));
