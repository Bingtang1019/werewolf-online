'use strict';
/* NLU Phase 1：应用人工（AI 辅助）标注到剩余 null 行
 * 读取 data/nlu/corpus-clean.auto.jsonl + data/nlu/null-auto.labels.tsv（index→intent）
 * 将 null 行按出现顺序填入 intent，并标记 manualLabel:true。
 * 输出 data/nlu/corpus-clean.annotated.jsonl；不修改输入文件。
 * 运行：node tools/nlu/phase1-apply-null-labels.js
 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const input = path.join(root, 'data', 'nlu', 'corpus-clean.auto.jsonl');
const labelsFile = path.join(root, 'data', 'nlu', 'null-auto.labels.tsv');
const output = path.join(root, 'data', 'nlu', 'corpus-clean.annotated.jsonl');

const labels = new Map();
for (const line of fs.readFileSync(labelsFile, 'utf8').trim().split('\n').filter(Boolean)) {
  const [idx, intent] = line.split('\t');
  labels.set(Number(idx), intent.trim());
}

const lines = fs.readFileSync(input, 'utf8').trim().split('\n').filter(Boolean);
let nullIdx = 0, applied = 0, stillNull = 0, total = 0;
const out = lines.map(line => {
  const o = JSON.parse(line);
  total++;
  if (!o.intent) {
    nullIdx++;
    const intent = labels.get(nullIdx);
    if (intent) {
      o.intent = intent;
      o.manualLabel = true;
      applied++;
    } else {
      stillNull++;
    }
  }
  return JSON.stringify(o);
}).join('\n') + '\n';

fs.writeFileSync(output, out);
console.log(JSON.stringify({ total, applied, stillNull, output }, null, 2));
