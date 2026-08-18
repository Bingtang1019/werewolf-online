'use strict';
/* tools/nlu/augment-corpus.js —— 基于已有标注语料的轻量增强
 * 只做安全的替换：把“人机·阿X/小X”等机器人名替换为其他名字，生成变体。
 * 输出：data/nlu/corpus-clean.aug.jsonl（原句 + 变体，intent 保留）
 * 用法：node tools/nlu/augment-corpus.js [--variants=3] [--out=data/nlu/corpus-clean.aug.jsonl]
 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const get = (k, d) => { const eq = process.argv.find(a => a.startsWith('--' + k + '=')); return eq ? eq.slice(k.length + 3) : d; };
const input = path.join(root, get('input', 'data/nlu/corpus-clean.annotated.jsonl'));
const outFile = path.resolve(root, get('out', 'data/nlu/corpus-clean.aug.jsonl'));
const variants = parseInt(get('variants', '3'), 10);

const NAME_POOL = ['冰糖', '花园', '阿青', '阿紫', '阿黄', '阿蓝', '小江', '跳跳虎', '小熊维尼', '霍梅尼', '嘉豪', '董志敏', '弘文', '小平', '酒酿西红柿', '花栗鼠乃里', '谢特', '月圆之夜', '凯撒'];
const lines = fs.readFileSync(input, 'utf8').trim().split('\n').filter(Boolean);
const out = [];
let augmented = 0;
for (const line of lines) {
  const o = JSON.parse(line);
  out.push(JSON.stringify(o));
  const names = NAME_POOL.filter(n => o.text.includes(n));
  if (!names.length) continue;
  const others = NAME_POOL.filter(n => !names.includes(n));
  if (!others.length) continue;
  for (let v = 0; v < variants && others.length; v++) {
    const repl = {};
    names.forEach((n, i) => { repl[n] = others[(v + i) % others.length]; });
    let text = o.text;
    for (const [from, to] of Object.entries(repl)) text = text.split(from).join(to);
    const copy = { ...o, text, aug: true };
    out.push(JSON.stringify(copy));
    augmented++;
  }
}
fs.writeFileSync(outFile, out.join('\n') + '\n');
console.log(JSON.stringify({ original: lines.length, augmented, total: out.length, output: outFile }, null, 2));
