'use strict';
/* server/ai/nlu-claims.js —— 轻量 NLU 声明抽取（V5.1c/1.8.0）
 * 从真人聊天文本中抽取结构化 claim 事件，喂给 belief-engine。
 * 规则版先落地；后续可替换为标注语料训练的意图分类器。
 */
function extractClaims(room, fromId, text) {
  if (!room || !fromId || !text) return [];
  const claims = [];
  const has = re => re.test(text);
  // 身份声明
  if (has(/我是预言家|我跳预言家|跳预/)) claims.push({ type: 'claim_seer', target: null });
  if (has(/我是(女巫|猎人|守卫|摄梦人)/)) claims.push({ type: 'claim_god', target: null });
  // 对玩家名字的查验/攻击/自辩
  const players = room.players || [];
  const seen = new Set();
  for (const p of players) {
    if (!p.name || !p.id || p.id === fromId) continue;
    if (!text.includes(p.name)) continue;
    const key = p.id;
    if (has(/查杀/) && text.includes(p.name) && !seen.has('cw:' + key)) {
      claims.push({ type: 'check_wolf', target: p.id }); seen.add('cw:' + key);
    }
    if (has(/金水/) && text.includes(p.name) && !seen.has('cg:' + key)) {
      claims.push({ type: 'check_good', target: p.id }); seen.add('cg:' + key);
    }
    if (has(/是狼|像狼|狼面|怀疑|踩|铁狼|带节奏/) && text.includes(p.name) && !seen.has('at:' + key)) {
      claims.push({ type: 'attack', target: p.id }); seen.add('at:' + key);
    }
  }
  if (has(/我不是狼|我是好人|别投我|冤枉|别出我|我不是/) && !seen.has('df')) {
    claims.push({ type: 'defend', target: fromId }); seen.add('df');
  }
  return claims;
}

module.exports = { extractClaims };
