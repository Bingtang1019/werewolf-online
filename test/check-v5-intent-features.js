'use strict';
/* V5 A2 冒烟测试：intent-features / voteFeaturesV5 维度与值域 */
const { INTENT_FEATURE_NAMES, V5_FEATURE_NAMES, intentFeatures, voteFeaturesV5, intentOf } = require('../server/ai/intent-features.js');

let failures = 0;
function assert(c, m) { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } }

function mkRoom() {
  const players = [
    { id: 'bot1', name: '阿青', seat: 1, alive: true, role: 'villager', isBot: true },
    { id: 'cand1', name: '阿紫', seat: 2, alive: true, role: 'wolf', isBot: true },
    { id: 'cand2', name: '阿黄', seat: 3, alive: true, role: 'villager', isBot: true },
  ];
  const messages = [
    { ch: 'all', from: 'cand1', text: '我是预言家，查杀阿黄' },
    { ch: 'all', from: 'cand2', text: '我觉得阿紫是狼，投阿紫' },
    { ch: 'all', from: 'bot1', text: '我保阿黄，阿黄不是狼' },
  ];
  return {
    players, messages,
    votes: { cand2: 'cand1' },
    lastVoteResult: { totals: { cand1: 1 } },
    actionLog: [{ action: 'vote', actor: 1, data: { target: 'cand1' } }],
  };
}

const room = mkRoom();
const feats = voteFeaturesV5(room, 'bot1', 'cand1');
assert(Array.isArray(feats) && feats.length === V5_FEATURE_NAMES.length, `voteFeaturesV5 维度 = ${V5_FEATURE_NAMES.length}`);
assert(feats.every(x => typeof x === 'number' && isFinite(x)), 'voteFeaturesV5 全部为有限数值');
assert(feats.every(x => x >= 0 && x <= 1), 'voteFeaturesV5 全部在 0..1 值域');

const ifeats = intentFeatures(room, 'bot1', 'cand1');
assert(Array.isArray(ifeats) && ifeats.length === INTENT_FEATURE_NAMES.length, `intentFeatures 维度 = ${INTENT_FEATURE_NAMES.length}`);
assert(intentOf('今晚刀阿紫吧') === 'night_plan' || intentOf('今晚刀阿紫吧') === 'vote', 'intentOf 规则回退可识别夜晚计划/投票');
assert(intentOf('我是预言家，查杀阿黄') === 'claim_seer', 'intentOf 可识别跳预言家');

if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
console.log('\nV5 意图特征冒烟测试全部通过 ✔');
