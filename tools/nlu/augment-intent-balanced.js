'use strict';
/* tools/nlu/augment-intent-balanced.js —— 面向稀有意图的平衡增强
 * 在保留原句的基础上，用模板补充 claim_seer/check/defend/vote/night_plan/lover 等稀有类，
 * 目标是提升意图分类器的交叉验证泛化能力。
 * 用法：
 *   node tools/nlu/augment-intent-balanced.js \
 *     --input=data/nlu/corpus-clean.annotated.jsonl \
 *     --out=data/nlu/corpus-clean.balanced.jsonl \
 *     --target=45
 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const args = {};
process.argv.slice(2).forEach(a => { const m = a.match(/^--([^=]+)=(.*)$/); if (m) args[m[1]] = m[2]; });

const input = path.resolve(root, args.input || 'data/nlu/corpus-clean.annotated.jsonl');
const outFile = path.resolve(root, args.out || 'data/nlu/corpus-clean.balanced.jsonl');
const target = parseInt(args.target || '45', 10);

const NAME_POOL = ['阿青', '阿紫', '阿黄', '阿蓝', '小江', '跳跳虎', '小熊维尼', '嘉豪', '弘文', '小平', '冰糖', '花园', '凯撒', '月圆之夜', '花栗鼠乃里', '霍梅尼'];
const rows = [];
for (const line of fs.readFileSync(input, 'utf8').trim().split('\n').filter(Boolean)) {
  const o = JSON.parse(line);
  if (o.text && o.intent) rows.push({ text: o.text, intent: o.intent });
}

const templates = {
  claim_seer: [
    '我是预言家',
    '我跳预言家',
    '我是真预言家',
    '跳预',
    '我才是预言家',
    '这局我是预言家，昨晚查了{name}',
    '我是预言家，{name}查杀',
    '我跳预，昨晚验了{name}',
  ],
  check: [
    '查杀{name}',
    '{name}是狼',
    '昨晚查了{name}，查杀',
    '验了{name}，是狼',
    '金水{name}',
    '{name}是好人',
    '昨晚验了{name}，金水',
    '{name}我验过，好人',
  ],
  defend: [
    '我不是狼',
    '我是好人',
    '别投我',
    '冤枉啊',
    '别出我',
    '我真的不是狼',
    '你们投错人了，我是好人',
  ],
  vote: [
    '我投{name}',
    '今天出{name}',
    '大家投{name}',
    '票{name}',
    '这轮出{name}',
    '我建议出{name}',
  ],
  night_plan: [
    '今晚刀{name}',
    '今晚刀谁',
    '夜里毒{name}',
    '晚上守{name}',
    '今晚魅惑{name}',
    '狼队今晚刀{name}',
  ],
  lover: [
    '我是你情侣',
    '我们是情侣',
    '你是我恋人',
    '情侣别投我',
    '我是丘比特连的情侣',
  ],
};

const counts = {};
for (const r of rows) counts[r.intent] = (counts[r.intent] || 0) + 1;
const out = rows.map(r => JSON.stringify(r));
let added = 0;
for (const [intent, tpls] of Object.entries(templates)) {
  let need = target - (counts[intent] || 0);
  let ti = 0;
  while (need > 0) {
    const tpl = tpls[ti % tpls.length];
    const name = NAME_POOL[Math.floor(Math.random() * NAME_POOL.length)];
    const text = tpl.replace('{name}', name);
    out.push(JSON.stringify({ text, intent, aug: true, synthetic: true }));
    added++;
    need--;
    ti++;
  }
}

fs.writeFileSync(outFile, out.join('\n') + '\n');
const newCounts = {};
for (const line of out) { const o = JSON.parse(line); newCounts[o.intent] = (newCounts[o.intent] || 0) + 1; }
console.log(JSON.stringify({ original: rows.length, added, total: out.length, distribution: newCounts, output: outFile }, null, 2));
