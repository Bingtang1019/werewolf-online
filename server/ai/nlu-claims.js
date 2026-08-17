'use strict';
/* server/ai/nlu-claims.js —— NLU 声明抽取（V5.1c/1.8.0）
 * 先用字符 bigram 朴素贝叶斯意图分类器判断意图，再结合玩家名抽取结构化 claim。
 * fail-open：模型缺失时回退规则版。
 */
const { classify } = require('./nlu-intent.js');

function extractClaims(room, fromId, text) {
  if (!room || !fromId || !text) return [];
  const intent = classify(text);
  const claims = [];
  const players = room.players || [];
  const seen = new Set();
  const has = re => re.test(text);
  const add = (type, target) => {
    const k = type + ':' + (target || '');
    if (seen.has(k)) return;
    seen.add(k);
    claims.push({ type, target: target || null });
  };

  // 身份声明
  if (intent === 'claim_seer' || has(/我是预言家|我跳预言家|跳预/)) add('claim_seer', null);
  if (intent === 'claim_god' || has(/我是(女巫|猎人|守卫|摄梦人)/)) add('claim_god', null);
  // 查验/攻击/自辩
  for (const p of players) {
    if (!p.name || !p.id || p.id === fromId) continue;
    if (!text.includes(p.name)) continue;
    if (intent === 'check' || has(/查杀/)) {
      if (has(/查杀/) && text.includes(p.name)) add('check_wolf', p.id);
      if (has(/金水/) && text.includes(p.name)) add('check_good', p.id);
    }
    if (intent === 'attack' || has(/是狼|像狼|狼面|怀疑|踩|铁狼|带节奏/)) {
      if (has(/是狼|像狼|狼面|怀疑|踩|铁狼|带节奏/) && text.includes(p.name)) add('attack', p.id);
    }
  }
  if (intent === 'defend' || has(/我不是狼|我是好人|别投我|冤枉|别出我|我不是/)) add('defend', fromId);
  return claims;
}

module.exports = { extractClaims };
