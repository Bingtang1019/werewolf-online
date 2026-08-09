'use strict';
/* =========================================================================
 * nlu-phase1-clean.js — NLU Phase 1 语料清洗分档（2026-08-09）
 * 输入: data/chat-logs/human-chat.jsonl（真人聊天记录，443 条）
 * 输出: data/nlu/corpus-devtest.jsonl   （dev-test 噪声——测试残留/占位消息）
 *        data/nlu/corpus-real.jsonl     （真实语料——保留，意图标注候选）
 *        data/nlu/corpus-template.jsonl （人机模板/机器人句式——保留，模板参考）
 * 规则: ① 占位消息（消息\d+/B的消息/测试等）→ devtest
 *       ② 疑似模板（含"人机·"前缀目标、明显机器人句式）→ template
 *       ③ 其余 → real（真实语料）
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const src = path.join(root, 'data/chat-logs/human-chat.jsonl');
const outDir = path.join(root, 'data/nlu');
fs.mkdirSync(outDir, { recursive: true });

const PLACEHOLDER = /^(消息\d*|B的消息|A的消息|测试|测试消息|哈哈|呵呵|。。+|\.{2,}|.{0,2})$/;
const TEMPLATE_HINTS = /人机·|我是机器人|（.*模板.*）|自动回复/;

const buckets = { devtest: [], real: [], template: [] };
let n = 0;
for (const l of fs.readFileSync(src, 'utf8').split('\n')) {
  if (!l.trim()) continue;
  let r;
  try { r = JSON.parse(l); } catch (e) { continue; }
  n++;
  const t = (r.text || '').trim();
  if (!t) { buckets.devtest.push(r); continue; }
  if (PLACEHOLDER.test(t)) { buckets.devtest.push(r); continue; }
  if (TEMPLATE_HINTS.test(t)) { buckets.template.push(r); continue; }
  buckets.real.push(r);
}
for (const k of Object.keys(buckets)) {
  const f = path.join(outDir, 'corpus-' + k + '.jsonl');
  fs.writeFileSync(f, buckets[k].map(x => JSON.stringify(x)).join('\n') + '\n');
  console.log(k + ':', buckets[k].length, '条 →', f);
}
console.log('总计:', n, '条');
