// bot-brain 拆分：shared 模块（基础设施 + ctx 注册表）——勿手改，重新运行 tools/split-bot-brain.js

'use strict';
/* v1.6.4（A5-1/A2-5）：统一置信度入口 + 发言语料库（组合式生成）——C1 意图层未来只消费这两处 */
const { confidenceOf } = require('../confidence.js');
const { getVoteModel, getVoteModelV2, modelProb } = require('../model-loader.js');
const { buildRoomVoteState, voteFeatures13 } = require('../vote-state.js'); // 1.8.0（P1）：投票轮级快照——房间级特征构造一次，决策 O(1) 查表（架构革命 ①）
let _getBeliefsRef = null; // 1.7.18：belief-engine 懒预加载（TDZ 修复——getBeliefs 仅供 beliefFeatures25 运行时使用，模块级缓存避免函数内局部 require 的初始化时序问题）
const _belMod = require('../belief-engine.js');
_getBeliefsRef = _belMod.getBeliefs || null; // 1.7.18：getVoteModelV2——v2 独立缓存（12c per-config 回退用） // 1.7.0（B1-4）：vote 模型（fail-open）
const { voteFeatures } = require('../features.js'); // 1.7.0（B1-2）：vote 特征（训练/推理共用）
const { rolloutVote } = require('../rollout.js'); // 1.7.0（B1-5）：rollout 规划层（新 simulate 档）
const { piVote } = require('../vote-pi.js'); // 1.7.17（D0）：π 投票策略网络（VOTE_STRATEGY=pi）
const LEXICON = require('../lexicon.json');
const { decideVote, decideNightKill } = require('../legacy/decide.js'); // 1.7.0（B1-1）：纯行动策略接口
/* 1.7.0（B1-8）：显式可注入 RNG——决策随机全部走“当前 RNG”（createBotDecision 入口设置），杜绝 Math.random 隐性状态 */
const { createRng } = require('../rng.js');
if (!global.rng) global.rng = createRng(parseInt(process.env.SEED || '0', 10) || 12345); // 独立 require（单测）时回退默认种子
let CUR_RNG = null; // 当前决策的显式 RNG（同步执行安全：Node 单线程，决策函数同步，房间间不会交错）
function rng() { return CUR_RNG || global.rng; }
/* v1.7.6：第三方平衡用——好人胜率估值 V(R,S,M)（value 模型 fail-open 0.5；只读公开翻牌量）
 * v1.7.10修复：'..' 路径错误（解析到 Desktop/models，从未加载成功，vGood 恒 fail-open 0.5）；默认模型同步 v2。
 * 注：vGood 目前无消费点（死数据）——第三方真正接入 V 估值属“功能上线”，单独立项 */
const fs = require('fs');
const path = require('path');
let _vModel = null, _vTried = false;
function getValueModelForBot() {
  if (_vTried) return _vModel;
  _vTried = true;
  try { _vModel = JSON.parse(fs.readFileSync(path.join(__dirname, 'models', process.env.MODEL_VALUE_VOTE ? process.env.MODEL_VALUE_VOTE.split(/[\\/]/).pop() : 'value-vote-v2.json'), 'utf8')); } catch (e) { _vModel = null; }
  return _vModel;
}
/* v1.7.7（α3）：狼侧刀神分类器——models/wolf-god-v1.json（wolfTrain/adaboost 训练产物，fail-open） */
let _wolfGodModel = null, _wolfGodTried = false;
function loadWolfGodModel() {
  if (_wolfGodTried) return _wolfGodModel;
  _wolfGodTried = true;
  try {
    const { AdaBoost } = require('../../../wolfTrain/adaboost.js');
    _wolfGodModel = AdaBoost.fromJSON(JSON.parse(fs.readFileSync(path.join(__dirname, 'models', 'wolf-god-v1.json'), 'utf8')));
  } catch (e) { _wolfGodModel = null; }
  return _wolfGodModel;
}
/* v1.7.7（α3）：刀神分类器 world 构造——候选特征（13 维，复用 voteFeatures）+ 角色映射 + 公开自称神职 */
function buildWolfKillWorld(room, bot) {
  const { wolfGodFeatures } = require('../../../wolfTrain/features.js');
  const world = { aliveIds: [], features: new Map(), roles: new Map(), roleClaims: new Map() };
  for (const q of aliveOthers(room, bot)) {
    world.aliveIds.push(q.id);
    world.roles.set(q.id, q.role);
    const f = wolfGodFeatures(room, bot.id, q.id);
    if (f) world.features.set(q.id, f);
  }
  for (const m of room.messages || []) {
    if (m.ch === 'all' && m.from && m.text) {
      const mm = m.text.match(/我是(女巫|预言家|猎人|守卫|摄梦人)/);
      if (mm && !world.roleClaims.has(m.from)) world.roleClaims.set(m.from, mm[1]);
    }
  }
  return world;
}
const wolfKillDecide = require('../../../wolfTrain/kill.js').decideNightKill; // v1.7.7（α3）：刀神决策（区别于 legacy decideNightKill）
/* ================================================================
   bot-brain.js - 人机决策模块（v1.4.0，适配自开源补丁）
   级别（每个 bot 独立，bot.botLevel；未设置时按房间 botMode 映射：
     passive → idle，auto → easy）：
     idle  - 仅挂机（补必要动作，白天弃票）
     easy  - 简单模式（关键词嫌疑度，非贝叶斯）
     smart - 智能模式（贝叶斯推理 + 对跳处理 + 狼队共享 + 数量约束）

   字段/动作映射（补丁假设 → 本项目实际）：
     room.night.seerChecked    → 由调度保证（pendingBotActors 已过滤未行动者）
     room.night.guard          → room.guardLast（连守拒绝目标）
     room.night.killed         → room.night.wolf.kill（被刀者 id）
     room.night.witch.save     → room.witchPots.saveUsed / poisonUsed
     room.lastExecutedId       → room.lastVoteResult.exiled（votes 在下一轮投票前仍保留）
     seer_set/guard_set/witch_set → seer_pick{target} / guard_pick{target} / witch_act{save:bool, poison:id}
  公平性修正：预言家声称的可信度校准仅狼 bot 可用（狼知道谁是真狼）；
   好人 bot 只做“对跳”推理（同目标反结论 → 降可信），不用真相作弊。
================================================================ */

/* ---------- 基础工具（独立模块，逻辑与 game.js 保持一致） ---------- */
function byId(room, id) { return room.players.find(p => p.id === id) || null; }
function effRole(p) { return p.role; } // v1.6.2：pickedRole 从未被赋值（盗贼选牌即替换 role），简化
function isWolfRole(p) { if (!p) return false; const r = effRole(p); return r === 'wolf' || r === 'wolfBeauty'; }/* 简化阵营：狼 / 其他（第三方按“非狼”处理，与原 bot 的 campOf!=='wolf' 一致） */
function campOf(p) { return isWolfRole(p) ? 'wolf' : 'good'; }
/* v1.5.1 阵营认知（对齐引擎 cupidCamp/thirdFaction）：人狼恋情侣 / 丘比特第三方识别。
   引擎规则：情侣一狼一好 → 第三方；情侣全狼/全好 → 随情侣阵营；丘比特自连一律第三方 */
function factionOf(room, p) {
  if (!p || !room) return 'good';
  const r = effRole(p);
  const isW = r === 'wolf' || r === 'wolfBeauty';
  const L = room.lovers;
  if (r === 'cupid') {
    // v1.7.6（丘比特规则补足）：丘比特可得知自己当前阵营——直接读引擎 cupidCamp（首轮=好人、重选=当前阵营、未指定=null→好人）
    const c = room.cupidCamp;
    return c === 'wolf' ? 'wolf' : c === 'third' ? 'third' : 'good';
  }
  if (L && L.includes(p.id)) {
    const partner = byId(room, L.find(id => id !== p.id));
    const pw = partner && (effRole(partner) === 'wolf' || effRole(partner) === 'wolfBeauty');
    if (isW !== !!pw) return 'third'; // 人狼恋 → 第三方
    return isW ? 'wolf' : 'good';
  }
  return isW ? 'wolf' : 'good';
}
/* v1.6.3：恋人成员互知身份（规则内）——返回 partner 信息 { id, isWolf }；人机狼作为恋人之一时据此保护/引导 */
function loverPartner(room, bot) {
  if (!room || !room.lovers || !room.lovers.length || !bot) return null;
  if (!room.lovers.includes(bot.id)) return null;
  const partnerId = room.lovers.find(id => id !== bot.id);
  const p = byId(room, partnerId);
  if (!p) return null;
  return { id: partnerId, isWolf: isWolfRole(p) };
}
/* v1.6.4（A2-4）：目标是否被公开查杀——强证据目标不参与投票波动（“高置信才准”的具象） */
function isCheckedTarget(room, t) {
  if (!room || !t) return false;
  return (room.messages || []).some(m => m.ch === 'all' && m.text && m.text.includes('查杀') && m.text.includes(t.name));
}
function randInt(n) { return rng().int(n); }
function pick(arr) { return arr && arr.length ? arr[randInt(arr.length)] : null; }
function pickId(arr) { const q = pick(arr); return q ? q.id : null; }
function nameById(room, id) { const p = byId(room, id); return p ? p.name : '未知'; }
function shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
function alivePlayers(room) { return room.players.filter(p => p.alive); }
function aliveOthers(room, bot) { return alivePlayers(room).filter(p => p.id !== bot.id); }
function getWolfCount(room) {
  // v1.6.1：狼总数取角色配置 roleCounts（随狼死亡减少会让 calibrateBeliefs 先验不断漂移）
  // v1.6.2：移除 settings.counts 回退（该字段从未存在，v1.6.1 已确认）
  if (room.roleCounts && room.roleCounts.wolf) return room.roleCounts.wolf;
  return 1;
}
/* 从发言中提取“查杀/金水 + 玩家名”的目标 */
function extractTarget(room, text) {
  const m = String(text).match(/查杀\s*(\S+)|金水\s*(\S+)/);
  if (!m) return null;
  const name = m[1] || m[2];
  return room.players.find(p => p.name === name) || room.players.find(p => name.startsWith(p.name) || p.name.startsWith(name)) || null;
}

/* ---------- 记忆 ---------- */
const TALK_FLAVOR = [
  '这局好安静，不会都在潜水吧 🤿',
  '预言家别藏了，出来带队呀',
  '我掐指一算，今天必有狼出局 🔮',
  '投票别磨蹭，再拖要上班迟到了 ⏰',
  '谁投我我就记小本本 📒',
  '女巫药省着点用，后面还有大场面',
  '守卫今晚守谁，给个准话呗',
  '我先表个态：听预言家的',
  '狼人现在肯定在偷笑，笑什么笑 🐺',
  '这氛围，让我想起上次被首刀的时候',
  '昨晚居然平安夜？女巫干活了还是狼空刀了',
  '别都沉默啊，聊一聊才有信息',
];
const TALK_PRESSURE = [
  '我怀疑{name}有问题，大家投票考虑一下他',
  '今天先出{name}吧，验民再看',
  '我跟{name}的票',
  '{name}这发言不像好人，太急了',
  '先别投{name}，听他把话说完',
];
const TALK_DEBATE_SEER = [
  '{name}在悍跳预言家，我才是真的，查验记录都在',
  '{name}查杀的人我验过是金水，他在乱带节奏',
  '对跳的都标狼，大家别被带偏，今晚我验{name}',
];
const TALK_DEBATE_WOLF = [
  '{name}才是狼，狼队急了开始乱咬',
  '我说的是真的，不信今晚验我，明天出结果',
  '{name}带节奏带得飞起，一看就是狼',
];
const TALK_WOLF_NIGHT = [
  '先刀预言家，稳赚不亏',
  '刀{name}吧，他太跳了',
  '我建议刀{name}，发言太像神职',
  '别刀队友啊喂，看清楚再刀',
  '今天白天我悍跳了预言家，你们配合一下',
  '验民比验神难，先刀个神职',
  '谁被女巫救过？想办法再刀一次',
];
const TALK_LAST_PLAIN = [
  '我是平民，别浪费轮次捞我，先出{name}',
  '被刀真惨，大家加油，别让我白死',
  '我是平民，听预言家的，别被带偏',
  '我走啦，遗言就一句：小心{name}',
];

/* v1.6.4（A2-5）：组合式生成——lexicon.json（意图→语料库键值）prefix+core+suffix 各取一段拼接；
 * 占位符 {name}/{result} 运行时替换；残留占位符清除；总长控制 120 字。 */
const EVIDENCE = {
  VOTE_AGAINST: 'vote_against',
  CHAT_BAD: 'chat_bad',
  DEATH: 'death',
  CHAT_GOOD: 'chat_good',
  WITCH_SAVE: 'witch_save',
  SHERIFF: 'sheriff',
  POISON: 'poison'
};

const TRANSFER_5 = {
  aggressive: [
    [0.60, 0.25, 0.10, 0.03, 0.02],
    [0.20, 0.50, 0.20, 0.07, 0.03],
    [0.10, 0.20, 0.40, 0.20, 0.10],
    [0.03, 0.07, 0.20, 0.50, 0.20],
    [0.02, 0.03, 0.10, 0.25, 0.60]
  ],
  balanced: [
    [0.70, 0.20, 0.07, 0.02, 0.01],
    [0.15, 0.60, 0.20, 0.04, 0.01],
    [0.05, 0.15, 0.60, 0.15, 0.05],
    [0.01, 0.04, 0.20, 0.60, 0.15],
    [0.01, 0.02, 0.07, 0.20, 0.70]
  ],
  conservative: [
    [0.80, 0.15, 0.03, 0.01, 0.01],
    [0.10, 0.70, 0.15, 0.04, 0.01],
    [0.02, 0.10, 0.75, 0.10, 0.03],
    [0.01, 0.02, 0.15, 0.70, 0.12],
    [0.01, 0.01, 0.03, 0.15, 0.80]
  ]
};

const LEVEL_MAP = { easy: 'smart', smart: 'simulate', simulate: 'simulate_v2' };

// ---- ctx 注册表 ----
const ctx = {};
function register(name, fn) { ctx[name] = fn; }
// 共享状态对象（跨模块变量访问——其他模块通过 S.xxx 读写）
const S = { _getBeliefsRef, _belMod, LEXICON, CUR_RNG, fs, path, _vModel, _wolfGodModel, wolfKillDecide, confidenceOf, getVoteModel, getVoteModelV2, modelProb, buildRoomVoteState, voteFeatures13, voteFeatures, rolloutVote, piVote, decideVote, decideNightKill, createRng, TALK_FLAVOR, TALK_PRESSURE, TALK_DEBATE_SEER, TALK_DEBATE_WOLF, TALK_WOLF_NIGHT, TALK_LAST_PLAIN, EVIDENCE, TRANSFER_5, LEVEL_MAP };
module.exports = { ctx, register, S };
// 导出 shared 区函数（供 index.js 注册到 ctx）
module.exports.sharedFns = { rng, getValueModelForBot, loadWolfGodModel, buildWolfKillWorld, byId, effRole, isWolfRole, campOf, factionOf, loverPartner, isCheckedTarget, randInt, pick, pickId, nameById, shuffle, alivePlayers, aliveOthers, getWolfCount, extractTarget };
