'use strict';
/* V5 A4 冒烟测试：intentReply 的指向性过滤 + 概率门限 + 回复文本可解析
 * 覆盖：攻击/带票/查杀/跳预言家四类意图，确认不代答他人话题、不丢占位符、不复读。 */
require('../server/ai/bot-brain/index.js'); // 先注册共享 ctx（pick/nameById/byId 等）
const { intentReply, genPhrase } = require('../server/ai/bot-brain/talk.js');

let failures = 0;
function assert(c, m) { if (c) console.log('  ok  ' + m); else { failures++; console.error('  FAIL: ' + m); } }

function mkRoom(text, from) {
  return {
    players: [
      { id: 'bot1', name: '阿青', seat: 1, alive: true, role: 'villager', isBot: true },
      { id: 'p2', name: '阿蓝', seat: 2, alive: true, role: 'seer', isBot: true },
    ],
    messages: text ? [{ ch: 'all', from: from || 'p2', text }] : [],
    dayNum: 2,
  };
}
const me = { id: 'bot1', name: '阿青' };
const pass = () => 0;      // 必过门限
const block = () => 0.99;  // 必被门限拦截

function replyOf(text, myRole, rnd) {
  const room = mkRoom(text, 'p2');
  return intentReply(room, me, myRole || 'villager', room.messages[0], rnd || pass);
}
function resolve(r) {
  const t = genPhrase(r.intent, r.params);
  if (t) return t;
  return Array.isArray(r.fallback) ? r.fallback[0] : r.fallback;
}

// 1. 无意图 / 空输入
assert(replyOf('哈哈哈', 'villager') === null, '闲聊不触发意图回应');
assert(intentReply(mkRoom(null, 'p2'), me, 'villager', null, pass) === null, '空 lastMsg 安全返回 null');
assert(intentReply(mkRoom(null, 'p2'), me, 'villager', { ch: 'all', from: 'p2' }, pass) === null, '无 text 的 lastMsg 安全返回 null');

// 2. attack：只回应点名自己的
const a1 = replyOf('我怀疑阿青是狼', 'villager');
assert(a1 && a1.intent === 'defend_self' && a1.params && a1.params.name === '阿青', '被点名攻击 -> defend_self');
assert(replyOf('我怀疑阿蓝是狼', 'villager') === null, '攻击他人不代答');

// 3. vote：只回应带票到自己
const v1 = replyOf('投阿青', 'villager');
assert(v1 && v1.intent === 'pressure' && v1.params && v1.params.name === '阿蓝', '被带票 -> pressure 指向发言者');
assert(replyOf('投阿蓝', 'villager') === null, '带票他人不代答');

// 4. check：只回应查杀自己；预言家与平民话术不同
const c1 = replyOf('查杀阿青', 'seer');
assert(c1 && c1.intent === 'debate_seer' && c1.params && c1.params.name === '阿蓝', '预言家被查杀 -> debate_seer');
const c2 = replyOf('查杀阿青', 'villager');
assert(c2 && c2.intent === 'defend_self' && c2.params && c2.params.name === '阿青', '平民被查杀 -> defend_self');
assert(replyOf('查杀阿蓝', 'villager') === null, '查杀他人不代答');

// 5. claim_seer：公开跳身份必接
const s1 = replyOf('我是预言家，昨晚查了阿蓝：查杀', 'villager');
assert(s1 && s1.intent === 'debate_seer' && s1.params && s1.params.name === '阿蓝', '他人跳预言家 -> debate_seer');

// 6. 概率门限
assert(replyOf('我怀疑阿青是狼', 'villager', block) === null, '门限未过时不发言');

// 7. 回复文本质量：可解析、无占位符、不过长、不复读
for (const r of [a1, v1, c1, c2, s1]) {
  const txt = resolve(r);
  assert(typeof txt === 'string' && txt.length > 0 && txt.length <= 120, `回复可解析且长度合法 (${r && r.intent})`);
  assert(typeof txt === 'string' && !/\{[a-zA-Z]+\}/.test(txt), `回复无未替换占位符 (${r && r.intent})`);
}
assert(resolve(a1) !== '我怀疑阿青是狼', '回复不是原句复读');

if (failures) { console.error(`\nV5 A4 intent-talk: ${failures} 项失败`); process.exit(1); }
console.log('\nV5 A4 intent-talk 冒烟测试全部通过');
