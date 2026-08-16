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
  const role = o.role || '';
  if (!t) return null;
  // 频道强信号
  if (ch === 'wolf' && /刀|杀|今晚|晚上|投|出|查/.test(t)) return 'night_plan';
  if (ch === 'lover' && /情侣|恋人|我是你|老公|老婆|爱|殉情|你是我/.test(t)) return 'lover';
  // 身份/查验
  if (/我跳|跳预言家|我是预言家|我预言家|我是女巫|我是猎人|我是守卫|我是摄梦人|我是丘比特/.test(t)) return 'claim_seer';
  if (/查杀|金水|查验|验了|查了|昨晚查|发金水|发查杀/.test(t)) return 'check';
  // 投票/行动
  if (/我投|投票|投给|投.*票|票.*投|出.*吧|先出|投谁|投他|投我/.test(t)) return 'vote';
  // 辩护/站边
  if (/不是狼|我是好人|别投我|冤枉|好人|别出我|我不是/.test(t)) return 'defend';
  // 攻击/怀疑
  if (/怀疑|像狼|是狼|狼面|踩|带节奏|悍跳|铁狼|狼人/.test(t)) return 'attack';
  // 元讨论
  if (/怎么|如何|为什么|规则|网站|服务器|房间号|刷新|重连|密码|改名|网址|浏览器|后台|代码/.test(t)) return 'meta';
  // 闲聊
  if (/哈哈|嘻嘻|嘿嘿|白天好|晚上好|你好|在吗|来了|加油|666|牛|nice|hhh|233|哦|嗯|啊|笑死|离谱|真的假的|我靠/.test(t)) return 'smalltalk';
  // 狼频道里非明确行动但带信息
  if (ch === 'wolf' && role === 'wolf') return 'night_plan';
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
