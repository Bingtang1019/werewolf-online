'use strict';
/* =========================================================================
 * V5 A2：意图特征（规则优先，NLU 分类器增强）——供 v3v3/π 意图版训练与推理使用。
 * 不改变现有 FEATURE_NAMES，避免旧模型 fail-open；新模型训练时显式叠加这些特征。
 * 只读公开信息（all 频道发言），不读真实身份（B1-7 纪律）。
 * ========================================================================= */
const { classify } = require('./nlu-intent.js'); // fail-open：模型缺失返回 null
const { voteFeatures, FEATURE_NAMES } = require('./features.js'); // V5 A2：与 base 特征拼接

const INTENT_FEATURE_NAMES = [
  'attack_against_cand',   // 他人对候选的攻击意图次数（怀疑/踩/投 + 名字）
  'defend_cand',           // 他人为候选辩护意图次数
  'cand_claim_seer',       // 候选自称预言家意图次数
  'cand_claim_god',        // 候选自称神职意图次数
  'cand_attack',           // 候选主动攻击他人意图次数
  'vote_pressure_cand',    // 公开“投票/放逐候选”表态次数
  'check_mention_cand',    // 候选被查杀/金水/查验提及次数
  'smalltalk_density',     // 候选闲聊意图占比
];

function ruleIntent(text) {
  const t = String(text || '');
  if (/查杀|金水|查验|验了/.test(t)) return 'check';
  if (/我是预言家|我跳预言家|跳预/.test(t)) return 'claim_seer';
  if (/我是(守卫|女巫|猎人|摄梦人)/.test(t)) return 'claim_god';
  if (/投|票|放逐|出他|出票/.test(t)) return 'vote';
  if (/怀疑|别信|像狼|狼人|踩/.test(t)) return 'attack';
  if (/保|好人|别投|我信/.test(t)) return 'defend';
  if (/哈哈|哈哈哈|晚上见|睡觉|签到/.test(t)) return 'smalltalk';
  return null;
}

function intentOf(text) {
  const c = classify(text);
  return c || ruleIntent(text) || null;
}

function intentFeatures(room, botId, candId) {
  const bot = room.players.find(p => p.id === botId);
  const cand = room.players.find(p => p.id === candId);
  if (!bot || !cand) return null;
  const msgs = (room.messages || []).filter(m => m.ch === 'all' && m.from && m.text);
  let attackAgainst = 0, defend = 0, candClaimSeer = 0, candClaimGod = 0, candAttack = 0, votePressure = 0, checkMention = 0, smalltalk = 0;
  let candMsgs = 0;
  for (const m of msgs) {
    const it = intentOf(m.text);
    const mentionsCand = m.text.indexOf(cand.name) !== -1;
    if (m.from === candId) {
      candMsgs++;
      if (it === 'claim_seer') candClaimSeer++;
      else if (it === 'claim_god') candClaimGod++;
      else if (it === 'attack') candAttack++;
      else if (it === 'smalltalk') smalltalk++;
    } else if (m.from !== botId) {
      if (it === 'attack' && mentionsCand) attackAgainst++;
      if (it === 'defend' && mentionsCand) defend++;
      if (it === 'vote' && mentionsCand) votePressure++;
      if (it === 'check' && mentionsCand) checkMention++;
    }
  }
  const talkN = Math.max(1, candMsgs || 1);
  return [
    Math.min(attackAgainst, 4) / 4,
    Math.min(defend, 4) / 4,
    Math.min(candClaimSeer, 2) / 2,
    Math.min(candClaimGod, 2) / 2,
    Math.min(candAttack, 4) / 4,
    Math.min(votePressure, 4) / 4,
    Math.min(checkMention, 4) / 4,
    Math.min(smalltalk, talkN) / talkN,
  ];
}

const V5_FEATURE_NAMES = FEATURE_NAMES.concat(INTENT_FEATURE_NAMES);
function voteFeaturesV5(room, botId, candId) {
  const base = voteFeatures(room, botId, candId);
  const extra = intentFeatures(room, botId, candId);
  if (!base || !extra) return null;
  return base.concat(extra);
}

module.exports = { INTENT_FEATURE_NAMES, V5_FEATURE_NAMES, intentFeatures, voteFeaturesV5, intentOf, ruleIntent };
