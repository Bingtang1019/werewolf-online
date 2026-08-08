// server/ai/belief-engine.js —— V5.1a 证据图 + 规则式贝叶斯更新（信念引擎第一版）
// 设计决策（archive/v5-投票判定实验/README.md 第九节 + 工作清单）：
//   - 规则式贝叶斯（可解释、零训练成本、权重手调）→ V5.2 学习式信念整合替代
//   - 增量更新（事件驱动，每事件只更新受影响节点）
//   - 证据权重：客观事实 1.0 / 声明 0.3 × 声明者可信度（可调参数）
// 用法：
//   const eng = createBeliefEngine(players, counts);
//   for (const e of events) applyEvent(eng, e);
//   const bel = getBeliefs(eng);  // { posterior: {id: P(狼)}, credibility: {id: 0..1}, follows: {id: {other: 强度} } }
//
// 1.7.17（V5.1）：信念状态取代特征快照的第一步——死亡因果/查验验证/票型时序三证据源

const W = {
  deathFact: 1.0,      // 客观：死因（wolf/poison/exile 确定性）
  deathInfer: 0.7,     // 客观推断：被刀者=狼威胁 → 其声明/投票目标权重提升
  killMute: 1.2,       // 灭口验证：被刀者的查杀声明高权重（狼灭口 = 查杀可信）
  checkFact: 1.0,      // 客观：放逐者身份验证查杀/金水
  voteFlow: 0.5,       // 客观：票型（A 投 B → B 嫌疑+，按 A 可信度加权）——组合信号（校准审计：单独反、组合正）
  voteRatio: 0.6,      // 票型相对领先（组合信号——与死亡/声明交叉后产生净正向）
  leadWeight: 0.3,     // 带节奏者识别：先投票者权重（二阶信念）
  claim: 0.3,          // 声明：跳身份/报查验（低权重 × 声明者可信度）
  clip: [0.05, 0.95],  // 后验压缩
};

// 1.7.17（校准审计结论）：权重组合是调优问题——单独证据方向可反（票型），组合后净正向（AUC 0.6151）。
// 校准 FAIL（绝对后验过冲）的修正不在权重层，在输出层：π 特征用 rank 归一化（存活内排名→[0,1]），
// 消除绝对过冲、保留排序信息（getBeliefs 提供 raw + rank 两种形态）

function createBeliefEngine(players, counts) {
  const alive = new Set(players.map(p => p.id));
  const engine = {
    players: players.map(p => ({ ...p })),
    counts: { ...counts },
    nodes: {},
    alive,
    claims: [],        // { from, type: 'check_wolf'|'check_good'|'claim_seer'|'claim_god', target, night }
    kills: [],         // { victim, night, saved }
    exiles: [],        // { exiled, night, result }
    follow: {},        // { voterId: { targetId: strength } } 二阶信念（谁在跟谁）
    voteOrder: {},     // { night: [ [voter, target]... ] } 逐票时序
  };
  for (const p of players) {
    engine.nodes[p.id] = {
      id: p.id,
      posterior: priorFor(counts),          // 初始 P(狼) = 狼数/存活
      credibility: 0.5,                     // 声明可信度（中性起点，验证积累）
      claims: [],                           // 该玩家发出的声明
      claimsAbout: [],                      // 关于该玩家的声明
      votesMade: [],                        // 该玩家投过的 {target, night, lead}
      votesReceived: {},                    // { night: count }
    };
  }
  return engine;
}

function priorFor(counts) {
  const wolves = counts.wolf || 4;
  const total = (counts.wolf || 0) + (counts.seer || 0) + (counts.witch || 0) + (counts.guard || 0) + (counts.hunter || 0) + (counts.villager || 0) + (counts.wolfBeauty || 0) + (counts.cupid || 0);
  return total > 0 ? wolves / total : 0.33;
}

// log-odds 增量更新（贝叶斯）：posterior = sigmoid(logit + weight × evidence)
function updatePosterior(engine, id, deltaLogit) {
  const n = engine.nodes[id];
  if (!n) return;
  const logit = Math.log(Math.max(1e-6, n.posterior) / Math.max(1e-6, 1 - n.posterior));
  n.posterior = Math.max(W.clip[0], Math.min(W.clip[1], 1 / (1 + Math.exp(-(logit + deltaLogit)))));
}

// 可信度更新（验证积累）：被验证（查杀命中/金水命中）→ +；被证伪 → -
function updateCredibility(engine, id, delta) {
  const n = engine.nodes[id];
  if (!n) return;
  n.credibility = Math.max(0.05, Math.min(0.95, n.credibility + delta));
}

// ---- 证据源 1：死亡因果链 ----
function onDeath(engine, deadId, by, role, night) {
  engine.alive.delete(deadId);
  const n = engine.nodes[deadId];
  if (!n) return;
  const isWolfDead = String(role || '').toLowerCase().includes('wolf');
  if (by === 'wolf') {
    // 被刀者非狼（确定性，客观 1.0）——后验清零；死亡身份公开（游戏规则）
    n.posterior = isWolfDead ? 0.999 : 0.001;
    // 灭口验证（1.2）：被刀者=狼灭口的威胁 → 其查杀声明高权重（狼灭口 = 查杀可信）
    for (const c of n.claims) {
      if (c.type === 'check_wolf') updatePosterior(engine, c.target, W.killMute);
    }
    // 被刀者的投票目标权重提升（客观推断 0.7）
    for (const v of n.votesMade) {
      updatePosterior(engine, v.target, W.deathInfer * 0.35);
    }
  } else if (by === 'exile') {
    // 放逐死（身份公开）：狼/好人确定
    n.posterior = isWolfDead ? 0.999 : 0.001;
  } else {
    // 毒/枪（身份公开）
    n.posterior = isWolfDead ? 0.999 : 0.001;
  }
}

// ---- 证据源 2：查验验证（身份公开后验证声明）----
function onExile(engine, exiledId, role, night) {
  const exiled = engine.nodes[exiledId];
  if (!exiled) return;
  engine.alive.delete(exiledId);
  const isWolf = String(role || '').toLowerCase().includes('wolf');
  if (!role) {
    // 事件未带身份（旧数据）——退化为中性
    exiled.posterior = 0.5;
    return;
  }
  exiled.posterior = isWolf ? 0.999 : 0.001;
  // 客观 1.0：放逐者身份验证——谁查杀过它、谁保过它
  for (const c of exiled.claimsAbout) {
    if (c.type === 'check_wolf') {
      // 查杀者：被查杀者是狼 → 可信度 +；是好人 → 可信度 -（假查杀）
      updateCredibility(engine, c.from, isWolf ? 0.15 : -0.25);
    }
    if (c.type === 'check_good') {
      updateCredibility(engine, c.from, !isWolf ? 0.15 : -0.25);
    }
  }
  // 狼被放逐 → 其声明是谎言（污蔑）→ 目标嫌疑降；好人被放逐 → 其查杀更可信
  for (const c of exiled.claims) {
    if (c.type === 'check_wolf') {
      updatePosterior(engine, c.target, isWolf ? -0.4 : 0.25);
    }
    if (c.type === 'check_good') {
      updatePosterior(engine, c.target, isWolf ? 0.3 : -0.2);
    }
  }
}

// ---- 证据源 3：票型时序（vote_cast 逐票 + 结算对数比）----
function onVote(engine, voterId, targetId, night) {
  const voter = engine.nodes[voterId];
  if (!voter || !targetId) return;
  // 记录投票
  voter.votesMade.push({ target: targetId, night });
  // 带节奏者识别（二阶信念）：投票顺序——前面已有票的候选继续被投 = 跟票；新开票 = 带节奏
  const order = engine.voteOrder[night] || (engine.voteOrder[night] = []);
  const already = order.filter(([v, t]) => t === targetId).length;
  const isLead = already === 0; // 首个投该目标 = 带节奏
  order.push([voterId, targetId]);
  // 票型证据（客观 0.5 × 投票者可信度）：A 投 B → B 嫌疑+（组合信号——与死亡/声明交叉后净正向）
  const weight = W.voteFlow * (0.5 + (voter.credibility - 0.5) * 0.6);
  updatePosterior(engine, targetId, isLead ? weight : weight * 0.6);
  // 二阶信念：跟票者与先投者关系（谁在跟谁）
  if (!isLead && already > 0) {
    const leadVoter = order.find(([v, t]) => t === targetId && v !== voterId);
    if (leadVoter) {
      const leadId = leadVoter[0];
      engine.follow[voterId] = engine.follow[voterId] || {};
      engine.follow[voterId][leadId] = (engine.follow[voterId][leadId] || 0) + 1;
    }
  }
}

// 投票结算（exile 事件前）——相对领先更新：第一名 vs 第二名的差距（组合信号）
function onVoteSettle(engine, night) {
  const order = engine.voteOrder[night];
  if (!order || !order.length) return;
  const votes = {};
  for (const [v, t] of order) votes[t] = (votes[t] || 0) + 1;
  const nVoters = order.length;
  if (nVoters < 2) return;
  // 排序得票
  const sorted = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  const top = sorted[0], second = sorted[1];
  const lead = top[1] - (second ? second[1] : 0); // 领先票数
  if (lead <= 0) return;
  // 第一名嫌疑+（相对领先）；次高票轻微+（组合信号——与死亡/声明交叉）
  const deltaTop = W.voteRatio * Math.min(2, lead);
  updatePosterior(engine, top[0], deltaTop);
  for (const [t, cnt] of sorted.slice(1)) {
    if (cnt >= 2) updatePosterior(engine, t, 0.1);
  }
}

// ---- 声明证据（低权重 × 可信度）----
function onClaim(engine, fromId, type, targetId) {
  const from = engine.nodes[fromId];
  if (!from) return;
  const claim = { from: fromId, type, target: targetId, night: engine.currentNight || 0 };
  from.claims.push(claim);
  if (targetId && engine.nodes[targetId]) engine.nodes[targetId].claimsAbout.push(claim);
  engine.claims.push(claim);
  // 声明更新（0.3 × 可信度）
  const w = W.claim * (0.4 + from.credibility * 1.2); // 0.3 × (0.4 + cred×1.2)：cred=0.5 → 0.3；cred=0.9 → 0.45
  if (type === 'check_wolf') updatePosterior(engine, targetId, w);
  else if (type === 'check_good') updatePosterior(engine, targetId, -w);
  else if (type === 'claim_seer') updatePosterior(engine, fromId, -0.1); // 跳预言家本身轻微降嫌疑（但会引来刀）
  else if (type === 'claim_god') updatePosterior(engine, fromId, -0.05);
}

// ---- 事件分发（增量更新入口）----
function applyEvent(engine, ev) {
  engine.currentNight = ev.night != null ? ev.night : engine.currentNight;
  switch (ev.t) {
    case 'deaths': {
      for (const d of ev.data?.deaths || []) onDeath(engine, d.id, d.by, d.role, ev.night);
      break;
    }
    case 'exile': {
      // 结算前先做票型对数比（本夜票型证据）
      onVoteSettle(engine, ev.night);
      onExile(engine, ev.data?.exiled || ev.target, ev.data?.role || '', ev.night);
      break;
    }
    case 'wolf_kill': {
      const k = ev.data?.kill || ev.target;
      if (k) { engine.kills.push({ victim: k, night: ev.night, saved: ev.data?.saved === true }); }
      break;
    }
    case 'vote_cast': {
      onVote(engine, ev.data?.voter, ev.data?.target, ev.night);
      break;
    }
    // 声明事件（speech 解析的后续版本——1.8.0 NLU 结构化声明接入点；当前规则版由 vote_cast/查验传播近似）
    case 'claim': {
      onClaim(engine, ev.data?.from, ev.data?.type, ev.data?.target);
      break;
    }
    default: break;
  }
}

// ---- 输出：信念状态张量（raw 后验 + rank 归一化——校准修正）----
function getBeliefs(engine) {
  const posterior = {}, credibility = {}, follows = {};
  const aliveIds = [...engine.alive];
  for (const [id, n] of Object.entries(engine.nodes)) {
    posterior[id] = n.posterior;
    credibility[id] = n.credibility;
  }
  for (const [v, tgt] of Object.entries(engine.follow)) {
    follows[v] = { ...tgt };
  }
  // rank 归一化（存活玩家内排名 → [0,1]）：消除绝对过冲，保留排序信息（校准审计结论）
  const ranks = {};
  const aliveSorted = aliveIds.filter(id => posterior[id] != null).sort((a, b) => posterior[b] - posterior[a]);
  const m = Math.max(1, aliveSorted.length - 1);
  aliveSorted.forEach((id, i) => { ranks[id] = m > 0 ? 1 - i / m : 0.5; });
  return { posterior, credibility, follows, ranks };
}

module.exports = { createBeliefEngine, applyEvent, getBeliefs, W };
