'use strict';
/* tools/nlu/generate-intent-corpus-v5.js —— V5 A1 语料扩充（规则生成版，非 LLM）
 * 以真实标注为锚点，用姓名替换 + 意图模板生成 5000 级语料，先跑通 A1 通路；
 * 后续可用 LLM 替换生成层。输出 data/nlu/corpus-v5-5000.jsonl。 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const input = path.join(root, 'data/nlu/corpus-clean.annotated.jsonl');
const outFile = path.join(root, 'data/nlu/corpus-v5-5000.jsonl');
const TARGET = 5000;
const NAMES = ['阿青', '阿紫', '阿黄', '阿蓝', '冰糖', '花园', '小江', '跳跳虎', '小熊维尼', '嘉豪', '小平', '月圆之夜', '凯撒', '霍梅尼'];

const TEMPLATES = {
  attack: ['我觉得{name}是狼', '我怀疑{name}', '{name}像狼', '别信{name}', '{name}很可疑', '投{name}没毛病', '{name}是狼人', '大家都别信{name}'],
  defend: ['我觉得{name}是好人', '我保{name}', '{name}不是狼', '别投{name}', '{name}我信', '先别出{name}', '{name}是金水', '我替{name}担保'],
  check: ['我查杀{name}', '我验了{name}是狼', '{name}是金水', '昨晚查验{name}', '我金水{name}', '{name}被查验是狼', '{name}是狼人没错', '我晚上验了{name}'],
  claim_seer: ['我是预言家', '我跳预言家', '我是真预言家', '昨晚我验人了', '我是预言家，{name}是金水', '我跳预言家验了{name}', '我真预言家，{name}查杀', '我是真预言家，别听悍跳', '预言家跳出来', '我验了{name}是金水', '我查杀{name}，信我', '真预言家在这'],
  claim_god: ['我是守卫', '我是女巫', '我是猎人', '我是摄梦人', '我是女巫，药还在', '我是守卫，昨晚守了人', '女巫在这', '守卫在这'],
  vote: ['投{name}', '出{name}', '今天放逐{name}', '我投{name}', '{name}出局', '票{name}', '这轮出{name}', '大家投{name}'],
  smalltalk: ['哈哈哈', '晚上见', '签到', '我来了', '你们聊', '好困', '来了来了', '别急别急'],
  meta: ['规则是什么', '怎么改房间', '网站不错', '这能玩吗', '这房间怎么玩', '怎么邀请朋友', '这规则有问题', '怎么开始游戏', '房间号怎么用', '邀请链接怎么发', '这个网站怎么玩', '规则在哪里看', '怎么退出房间'],
  night_plan: ['今晚刀{name}', '今晚验{name}', '今晚守{name}', '今晚毒{name}', '夜里刀{name}', '今晚查{name}'],
  lover: ['我是丘比特', '情侣是我连的', '我指定了情侣', '丘比特在此', '情侣信息别乱说', '我是丘比特，情侣别暴露'],
};

const rows = [];
for (const line of fs.readFileSync(input, 'utf8').trim().split('\n').filter(Boolean)) {
  const o = JSON.parse(line);
  if (o.text && o.intent) rows.push(o);
}

const out = [];
const used = new Set();
function add(text, intent, source) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || used.has(t)) return;
  used.add(t);
  out.push(JSON.stringify({ text: t, intent, source: source || 'gen' }));
}

// 锚点：保留原句
for (const r of rows) add(r.text, r.intent, 'anchor');

// 变体：姓名替换 + 前缀
const PREFIX = ['我觉得', '我认为', '好像', '真的', '我怀疑', '感觉'];
for (const r of rows) {
  for (let i = 0; i < 6 && out.length < TARGET; i++) {
    const repl = {};
    for (const n of NAMES) if (r.text.includes(n)) repl[n] = NAMES[(NAMES.indexOf(n) + i + 1) % NAMES.length];
    let text = r.text;
    for (const [a, b] of Object.entries(repl)) text = text.split(a).join(b);
    if (i % 2 === 0) text = PREFIX[i % PREFIX.length] + text;
    add(text, r.intent, 'variant');
  }
}

// 意图模板生成
const INTENT_ORDER = Object.keys(TEMPLATES);
let gi = 0, guard = 0;
while (out.length < TARGET && guard++ < 6000) {
  const it = INTENT_ORDER[gi++ % INTENT_ORDER.length];
  for (const tpl of TEMPLATES[it]) {
    for (const name of NAMES) {
      if (out.length >= TARGET) break;
      let text = tpl.split('{name}').join(name);
      if (guard % 3 === 0) text = PREFIX[guard % PREFIX.length] + text;
      if (guard % 5 === 0) text = text + '吧';
      add(text, it, 'template');
    }
  }
}

fs.writeFileSync(outFile, out.join('\n') + '\n');
const counts = {};
for (const l of out) { const o = JSON.parse(l); counts[o.intent] = (counts[o.intent] || 0) + 1; }
console.log(JSON.stringify({ total: out.length, output: outFile, counts }, null, 2));
