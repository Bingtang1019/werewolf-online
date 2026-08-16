'use strict';
/* NLU 语料自动预标注（A2-5/NLU Phase 1 辅助）
 * 读取 data/nlu/corpus-clean.jsonl，对 intent 为 null 的行用规则+频道上下文给出候选 intent。
 * 不覆盖已有标注；输出到 data/nlu/corpus-clean.auto.jsonl，供人工抽检后合入。
 * 运行：node tools/nlu/phase1-auto-label.js
 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const input = path.join(root, 'data', 'nlu', 'corpus-clean.jsonl');
const output = path.join(root, 'data', 'nlu', 'corpus-clean.auto.jsonl');

function infer(o) {
  const t = (o.text || '').trim();
  const ch = o.ch || '';
  if (!t) return null;
  if (ch === 'wolf' && /刀|杀|今晚|晚上|投|出/.test(t)) return 'night_plan';
  if (ch === 'lover' && /情侣|恋人|我是你|老公|老婆|爱|殉情/.test(t)) return 'lover';
  if (/我跳|跳预言家|我是预言家|我预言家/.test(t)) return 'claim_seer';
  if (/查杀|金水|查验|验了|查了|昨晚查/.test(t)) return 'check';
  if (/我投|投票|投给|投.*票|票.*投|出.*吧|先出/.test(t)) return 'vote';
  if (/不是狼|我是好人|别投我|冤枉|好人/.test(t)) return 'defend';
  if (/怀疑|像狼|是狼|狼面|踩|带节奏|悍跳/.test(t)) return 'attack';
  if (/怎么|如何|规则|改名|网站|服务器|房间号|刷新|重连/.test(t)) return 'meta';
  if (/哈哈|嘻嘻|嘿嘿|白天好|晚上好|你好|在吗|来了|加油|666|牛|nice|hhh|233/.test(t)) return 'smalltalk';
  return null;
}

const lines = fs.readFileSync(input, 'utf8').trim().split('\n').filter(Boolean);
let labeled = 0, auto = 0, stillNull = 0;
const out = lines.map(line => {
  const o = JSON.parse(line);
  if (!o.intent) {
    const guess = infer(o);
    if (guess) {
      o.intent = guess;
      o.autoLabel = true;
      auto++;
    } else {
      stillNull++;
    }
  } else {
    labeled++;
  }
  return JSON.stringify(o);
}).join('\n') + '\n';

fs.writeFileSync(output, out);
console.log(JSON.stringify({ total: lines.length, alreadyLabeled: labeled, autoLabeled: auto, stillNull }, null, 2));
