'use strict';
/* v1.6.4（A5-1/A2-5）：统一置信度入口 + 发言语料库（组合式生成）——C1 意图层未来只消费这两处 */
const { confidenceOf } = require('./server/ai/confidence.js');
const { getVoteModel, modelProb } = require('./server/ai/model-loader.js'); // 1.7.0（B1-4）：vote 模型（fail-open）
const { voteFeatures } = require('./server/ai/features.js'); // 1.7.0（B1-2）：vote 特征（训练/推理共用）
const { rolloutVote } = require('./server/ai/rollout.js'); // 1.7.0（B1-5）：rollout 规划层（新 simulate 档）
const LEXICON = require('./server/ai/lexicon.json');
const { decideVote, decideNightKill } = require('./server/ai/legacy/decide.js'); // 1.7.0（B1-1）：纯行动策略接口
/* 1.7.0（B1-8）：显式可注入 RNG——决策随机全部走“当前 RNG”（createBotDecision 入口设置），杜绝 Math.random 隐性状态 */
const { createRng } = require('./server/ai/rng.js');
if (!global.rng) global.rng = createRng(parseInt(process.env.SEED || '0', 10) || 12345); // 独立 require（单测）时回退默认种子
let CUR_RNG = null; // 当前决策的显式 RNG（同步执行安全：Node 单线程，决策函数同步，房间间不会交错）
function rng() { return CUR_RNG || global.rng; }
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
    if (!L || !L[0]) return 'third';
    if (L.includes(p.id)) return 'third'; // 自连一律第三方
    const a = byId(room, L[0]), b = byId(room, L[1]);
    if (!a || !b) return 'third';
    const wa = effRole(a) === 'wolf' || effRole(a) === 'wolfBeauty';
    const wb = effRole(b) === 'wolf' || effRole(b) === 'wolfBeauty';
    if (wa && wb) return 'wolf';
    if (!wa && !wb) return 'good';
    return 'third';
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
function ensureMemory(bot) {
  if (!bot.botMemory) bot.botMemory = {};
  const mem = bot.botMemory;
  if (!mem.suspicion) mem.suspicion = {};
  if (!mem.roleClaims) mem.roleClaims = {}; // v1.5.1：神职声称（守卫/女巫/猎人）
  if (!mem.claims) mem.claims = {};
  if (!mem.seen) mem.seen = new Set();
  return mem;
}

/* ================= IDLE（仅挂机；等价原 passive） ================= */
function decisionIdle(room, bot) {
  if (room.phase === 'night') {
    switch (room.nightStep) {
      case 'guard': {
        const valid = alivePlayers(room).filter(q => q.id !== room.guardLast);
        if (room.guardLast === bot.id) return { action: 'guard_pick', data: { target: pickId(valid) } };
        return { action: 'guard_pick', data: { target: bot.id } }; // 挂机守自己
      }
      case 'wolf': {
        const humans = room.players.some(q => q.alive && isWolfRole(q) && !q.isBot);
        if (humans) return { action: 'wolf_set', data: { confirm: true } }; // 有人类狼：只确认，不覆盖
        const data = { confirm: true };
        const lp = loverPartner(room, bot); // v1.6.3：狼恋人——不刀恋人（人狼恋，恋人互知）
        const safe = aliveOthers(room, bot).filter(q => campOf(q) !== 'wolf' && (!lp || lp.isWolf || q.id !== lp.id));
        if (!room.night.wolf.kill) data.kill = pickId(safe) || (lp && !lp.isWolf ? null : pickId(aliveOthers(room, bot)));
        return { action: 'wolf_set', data };
      }
      case 'seer': { const t = pickId(aliveOthers(room, bot)); return t ? { action: 'seer_pick', data: { target: t } } : null; }
      case 'witch': {
        const attacked = room.night.wolf.kill;
        const save = !room.witchPots.saveUsed && !!attacked && attacked === bot.id; // 仅被刀自救
        return { action: 'witch_act', data: { save, poison: null } };
      }
      case 'hunter': return { action: 'hunter_shoot', data: { target: null } }; // 挂机弃枪
      default: return null;
    }
  }
  if (room.phase === 'sheriff_vote') return { action: 'vote', data: { target: null } };
  if (room.phase === 'vote' || room.phase === 'pk_vote') return { action: 'vote', data: { target: null } };
  if (room.phase === 'hunter_shot') return { action: 'hunter_shoot', data: { target: null } };
  return null;
}

/* ================= EASY（简单模式：关键词嫌疑度，非贝叶斯） ================= */
function updateEasyMemory(room, bot) {
  const mem = ensureMemory(bot);
  const isWolf = isWolfRole(bot);
  for (const msg of room.messages) {
    if (mem.seen.has(msg.id)) continue;
    mem.seen.add(msg.id);
    if (msg.ch !== 'all' || !msg.text || !msg.from) continue;
    const from = byId(room, msg.from);
    if (!from || from.id === bot.id) continue;
    const text = msg.text;
    const target = extractTarget(room, text);
    if (text.includes('查杀') || text.includes('是狼')) {
      if (isWolf) {
        if (target && target.id === bot.id) mem.suspicion[from.id] = (mem.suspicion[from.id] || 0) + 20; // 有人查自己：记仇
        else if (target) mem.claims[from.id] = 'seer';
      } else if (target) {
        mem.suspicion[target.id] = (mem.suspicion[target.id] || 0) + 50;
        mem.claims[from.id] = 'seer';
      }
    }
    if (text.includes('金水') || text.includes('是好人')) {
      if (target) {
        if (!isWolf) mem.suspicion[target.id] = Math.max(0, (mem.suspicion[target.id] || 0) - 30);
        else mem.suspicion[target.id] = (mem.suspicion[target.id] || 0) - 10;
        mem.claims[from.id] = 'seer';
      }
    }
  }
}
function suspicionTarget(room, bot) {
  const sellId = sellWolfBeauty(room, bot); // v1.5.2：卖狼美人优先
  if (sellId) return sellId;
  const pool = shuffle(aliveOthers(room, bot));
  const score = p => (bot.botMemory.suspicion[p.id] || 0);
  return concentratedPick(room, pool, score); // v1.5.2：投票集中
}
function decisionEasy(room, bot) {
  updateEasyMemory(room, bot);
  const mem = bot.botMemory;
  if (room.phase === 'night') {
    switch (room.nightStep) {
      case 'guard': {
        // v1.6.2：公平化——移除“读真实预言家身份”的全知（人机不得用服务器真相作弊），改为守自己/随机
        const valid = alivePlayers(room).filter(q => q.id !== room.guardLast);
        let target = bot;
        if (target.id === room.guardLast) { const t2 = byId(room, pickId(valid)); if (t2) target = t2; }
        if (!bot.botMemory.guarded) bot.botMemory.guarded = {};
        bot.botMemory.guarded[target.id] = true; // v1.4.3：记住守人
        return { action: 'guard_pick', data: { target: target.id } };
      }
      case 'wolf': {
        const humans = room.players.some(q => q.alive && isWolfRole(q) && !q.isBot);
        if (humans) return { action: 'wolf_set', data: { confirm: true } };
        const data = { confirm: true };
        const lp = loverPartner(room, bot); // v1.6.3：狼恋人不刀恋人
        if (!room.night.wolf.kill) {
          const claimedSeer = aliveOthers(room, bot).find(q => mem.claims[q.id] === 'seer' && (!lp || lp.isWolf || q.id !== lp.id));
          let target = claimedSeer;
          if (!target) {
            // 1.7.0（B1-1）：间接方案——decideNightKill 刀“最像好人”的非队友（argmin P(wolf)）；恋人保护在决策层之上
            const nk = decideNightKill(buildVoteWorld(room, bot), aliveOthers(room, bot).map(p => p.id), rng());
            target = nk.target ? byId(room, nk.target) : null;
            if (target && lp && !lp.isWolf && target.id === lp.id) target = null;
          }
          data.kill = target ? target.id : null;
          const beauty = alivePlayers(room).find(q => effRole(q) === 'wolfBeauty');
          if (beauty && !room.night.wolf.charm) {
            const charmPool = aliveOthers(room, bot).filter(q => campOf(q) !== 'wolf' && q.id !== data.kill && (!lp || lp.isWolf || q.id !== lp.id)); // v1.6.3：狼恋人不魅惑恋人
            const charm = pick(charmPool);
            if (charm) data.charm = charm.id;
            if (data.charm) { if (!room.wolfPackMemory) room.wolfPackMemory = {}; room.wolfPackMemory.charmTarget = data.charm; } // v1.5.2：狼队共享魅惑目标（卖狼美人）
          }
        }
        return { action: 'wolf_set', data };
      }
      case 'seer': {
        const pool = aliveOthers(room, bot).filter(q => !(room.seerHistory || []).some(h => h.target === q.id));
        const t = pick(pool) || pick(aliveOthers(room, bot));
        return t ? { action: 'seer_pick', data: { target: t.id } } : null;
      }
      case 'dreamer': { const t = pickId(aliveOthers(room, bot)); return t ? { action: 'dreamer_pick', data: { target: t } } : null; } // 简单：随机梦人
      case 'witch': {
        const attacked = room.night.wolf.kill;
        const save = !room.witchPots.saveUsed && !!attacked; // 简单：无脑救被刀者
        if (save && attacked && !bot.botMemory.silverWater) bot.botMemory.silverWater = attacked; // v1.4.3：记住银水
        let poison = null;
        if (!save && !room.witchPots.poisonUsed && room.nightNum >= 2) {
          const t = pick(aliveOthers(room, bot));
          if (t) poison = t.id;
        }
        return { action: 'witch_act', data: { save, poison } };
      }
      case 'hunter': { const t = pick(aliveOthers(room, bot)); return { action: 'hunter_shoot', data: { target: t ? t.id : null } }; }
      default: return null;
    }
  }
  if (room.phase === 'sheriff_vote') {
    const world = buildVoteWorld(room, bot); // 1.7.0（B1-1）：decideVote（阵营分流 + 跟票集中）
    const res = decideVote(world, room.candidates || [], rng());
    const lp = loverPartner(room, bot); // v1.6.3：狼恋人不投恋人（决策层之上）
    const target = res.target && lp && !lp.isWolf && res.target === lp.id ? null : res.target;
    return { action: 'vote', data: { target } };
  }
  if (room.phase === 'vote') {
    const world = buildVoteWorld(room, bot); // 1.7.0（B1-1）：纯策略 decideVote（含卖狼/跟票/阵营分流）
    const res = decideVote(world, aliveOthers(room, bot).map(p => p.id), rng());
    let t = res.target ? byId(room, res.target) : null;
    const lp = loverPartner(room, bot); // v1.6.3：狼恋人不投恋人
    if (t && lp && !lp.isWolf && t.id === lp.id) t = null;
    // v1.6.4（A2-4）：不确定性表达——置信度低时小概率偏离最优（随机/跟风），高置信才准；被公开查杀/卖狼目标不波动
    if (t) {
      const conf = confidenceOf(bot, t.id);
      if (t.id !== world.sellTarget && !isCheckedTarget(room, t) && conf < 0.6 && rng().next() < (0.6 - conf)) {
        const pool = aliveOthers(room, bot).filter(q => q.id !== t.id && !(lp && !lp.isWolf && q.id === lp.id));
        const other = pick(pool) || t;
        t = other;
      }
    }
    return { action: 'vote', data: { target: t ? t.id : null } };
  }
  if (room.phase === 'pk_vote') {
    const world = buildVoteWorld(room, bot); // 1.7.0（B1-1）
    const res = decideVote(world, [...(room.pkTied || [])], rng());
    const lp = loverPartner(room, bot);
    const target = res.target && lp && !lp.isWolf && res.target === lp.id ? null : res.target;
    return { action: 'vote', data: { target } };
  }
  if (room.phase === 'hunter_shot') {
    // v1.6.2：easy 猎人按关键词嫌疑选枪（原为纯随机）
    const pool = shuffle(aliveOthers(room, bot));
    const t = pool.reduce((a, p) => (bot.botMemory.suspicion[p.id] || 0) > (bot.botMemory.suspicion[a.id] || 0) ? p : a, pool[0]);
    return { action: 'hunter_shoot', data: { target: t ? t.id : null } };
  }
  return null;
}

/* ================= SMART（贝叶斯推理） ================= */
function initBeliefs(room, bot) {
  ensureMemory(bot); // 防御：任何路径进入都必须有记忆对象
  if (!bot.botMemory.beliefs) {
    const wolfCount = getWolfCount(room);
    const aliveCount = alivePlayers(room).length || 1;
    const prior = wolfCount / aliveCount;
    bot.botMemory.beliefs = {};
    for (const p of room.players) bot.botMemory.beliefs[p.id] = { wolf: prior, good: 1 - prior };
  }
}
function updateBelief(room, bot, targetId, evidence) {
  if (!bot.botMemory.beliefs) initBeliefs(room, bot);
  const b = bot.botMemory.beliefs[targetId];
  if (!b) return;
  const LR = { check_wolf: 19, check_good: 0.05, killed_by_wolf: 0.1, voted_out_wolf: 1.2, voted_out_good: 0.8, silver_water: 0.05, guard_protected: 0.7 }[evidence] || 1;
  const odds = (b.wolf / Math.max(b.good, 0.01)) * LR;
  b.wolf = odds / (1 + odds);
  b.good = 1 - b.wolf;
}
function calibrateBeliefs(room, bot) {
  const wolfCount = getWolfCount(room);
  const alive = alivePlayers(room);
  let sum = 0;
  for (const p of alive) if (bot.botMemory.beliefs[p.id]) sum += bot.botMemory.beliefs[p.id].wolf;
  if (sum <= 0) return;
  const factor = wolfCount / sum;
  for (const p of alive) {
    const b = bot.botMemory.beliefs[p.id];
    if (!b) continue; // 防御：beliefs 可能缺该玩家（手动构造的测试记忆/异常路径）
    b.wolf = Math.min(0.99, Math.max(0.01, b.wolf * factor));
    b.good = 1 - b.wolf;
  }
}
/* 提取“我(跳)预言家 + 查杀/金水”的声称；可信度仅狼 bot 用真相校准（公平性） */
function updateSeerClaims(room, bot) {
  if (!bot.botMemory.seerClaims) bot.botMemory.seerClaims = {};
  if (!bot.botMemory.msgSeen) bot.botMemory.msgSeen = new Set();
  for (const msg of room.messages) {
    if (bot.botMemory.msgSeen.has(msg.id)) continue;
    bot.botMemory.msgSeen.add(msg.id);
    if (!msg.text || msg.ch !== 'all' || !msg.from) continue;
    if (!msg.text.includes('预言家')) continue;
    const claimer = byId(room, msg.from);
    if (!claimer) continue;
    const claim = bot.botMemory.seerClaims[claimer.id] || { credibility: 0.5, claims: [] };
    const target = extractTarget(room, msg.text);
    const result = msg.text.includes('查杀') ? 'wolf' : (msg.text.includes('金水') ? 'good' : null);
    if (target && result) claim.claims.push({ target: target.id, result });
    bot.botMemory.seerClaims[claimer.id] = claim;
  }
  if (campOf(bot) === 'wolf') {
    const wolfIds = new Set(room.players.filter(p => isWolfRole(p)).map(p => p.id));
    for (const pid of Object.keys(bot.botMemory.seerClaims)) {
      const claim = bot.botMemory.seerClaims[pid];
      if (!claim.claims.length) continue;
      let consistent = 0;
      for (const c of claim.claims) {
        const isActuallyWolf = wolfIds.has(c.target);
        if (isActuallyWolf === (c.result === 'wolf')) consistent++;
      }
      claim.credibility = 0.3 + 0.7 * (consistent / claim.claims.length);
    }
  }
}
function updateSmartMemory(room, bot) {
  ensureMemory(bot);
  initBeliefs(room, bot);
  updateSeerClaims(room, bot);
  // v1.5.1：神职声称提取（守卫/女巫/猎人穿衣服 → 狼刀优先级）
  if (!bot.botMemory.roleMsgSeen) bot.botMemory.roleMsgSeen = new Set(); // 独立去重（与 seerClaims 的 msgSeen 分开）
  for (const msg of room.messages) {
    if (!msg.text || msg.ch !== 'all' || !msg.from || bot.botMemory.roleMsgSeen.has(msg.id)) continue;
    bot.botMemory.roleMsgSeen.add(msg.id);
    const rm = msg.text.match(/我是(守卫|女巫|猎人|摄梦人)/);
    if (rm) bot.botMemory.roleClaims[msg.from] = rm[1];
  }
  const myRole = effRole(bot);
  const knowTruth = campOf(bot) === 'wolf';
  // 1. 自己亲眼查验
  if (myRole === 'seer' && Array.isArray(room.seerHistory)) {
    for (const h of room.seerHistory) updateBelief(room, bot, h.target, h.result === 'wolf' ? 'check_wolf' : 'check_good');
  }
  // 2. 参考预言家声称（狼：真相校准可信度；好人：对跳推理，不用真相）
  const claims = bot.botMemory.seerClaims || {};
  const myClaim = claims[bot.id];
  for (const pid of Object.keys(claims)) {
    const claim = claims[pid];
    if (pid === bot.id || !claim.claims.length) continue;
    if (knowTruth) {
      if (!claim.credibility || claim.credibility <= 0.6) continue;
    } else {
      // 好人视角：单声称者默认 0.5；出现对跳（多个声称者）时全存疑 0.35，避免被悍跳误导（v1.4.3）
      const claimerCount = Object.keys(claims).filter(pid => pid !== bot.id && claims[pid].claims.length).length;
      let cred = claimerCount > 1 ? 0.35 : 0.5;
      if (myClaim && myClaim.claims.length && claim.claims.length) {
        const mine = myClaim.claims[0], theirs = claim.claims[0];
        if (mine.target === theirs.target && mine.result !== theirs.result) cred = 0.2; // 对跳同一目标且结论相反
        else if (mine.target === theirs.target) cred = 0.7;
      }
      if (cred <= 0.4) continue;
    }
    for (const c of claim.claims) updateBelief(room, bot, c.target, c.result === 'wolf' ? 'check_wolf' : 'check_good');
  }
  // 3. 死亡信息（仅狼刀死亡作为证据；放逐/毒杀/殉情不计入）
  if (!bot.botMemory.recordedDead) bot.botMemory.recordedDead = new Set();
  for (const d of room.players) {
    if (d.alive || bot.botMemory.recordedDead.has(d.id)) continue;
    bot.botMemory.recordedDead.add(d.id);
    if (d.deadBy === 'wolf') updateBelief(room, bot, d.id, 'killed_by_wolf');
  }
  // 4. 放逐结果（上一轮 votes 在下一轮投票开始前仍保留，配合 lastVoteResult）
  if (room.lastVoteResult && room.lastVoteResult.exiled && bot.botMemory.lastExiled !== room.lastVoteResult.exiled) {
    bot.botMemory.lastExiled = room.lastVoteResult.exiled;
    const executed = byId(room, room.lastVoteResult.exiled);
    if (executed && !executed.alive) {
      const voters = Object.keys(room.votes || {}).filter(k => room.votes[k] === executed.id && k !== bot.id);
      const wasWolf = isWolfRole(executed);
      for (const v of voters) updateBelief(room, bot, v, wasWolf ? 'voted_out_wolf' : 'voted_out_good');
    }
  }
  // 4.5 女巫银水（v1.4.3）：救过的人持续视为好人证据（LR 0.05，强于他人查杀）；守卫守人同理弱证据
  if (myRole === 'witch' && bot.botMemory.silverWater) updateBelief(room, bot, bot.botMemory.silverWater, 'silver_water');
  if (myRole === 'guard' && bot.botMemory.guarded) {
    for (const pid of Object.keys(bot.botMemory.guarded)) updateBelief(room, bot, pid, 'guard_protected');
  }
  // 5. 狼队共享（多狼 bot 信念取平均，写回每个狼 bot）
  if (knowTruth) {
    if (!room.wolfPackMemory) room.wolfPackMemory = {};
    const wolfBots = room.players.filter(p => p.alive && p.isBot && isWolfRole(p));
    if (wolfBots.length > 1) {
      const shared = {};
      for (const pid of Object.keys(bot.botMemory.beliefs)) {
        let total = 0, n = 0;
        for (const wb of wolfBots) {
          if (!wb.botMemory) wb.botMemory = {}; // 狼队友可能尚未初始化记忆（N8 修复）
          if (!wb.botMemory.beliefs) initBeliefs(room, wb);
          if (wb.botMemory.beliefs[pid]) { total += wb.botMemory.beliefs[pid].wolf; n++; }
        }
        if (n) shared[pid] = total / n;
      }
      for (const wb of wolfBots) {
        if (!wb.botMemory) wb.botMemory = {};
        if (!wb.botMemory.beliefs) initBeliefs(room, wb);
        for (const pid of Object.keys(shared)) {
          wb.botMemory.beliefs[pid] = wb.botMemory.beliefs[pid] || { wolf: 0, good: 1 }; // 防御：beliefs 可能缺该玩家（如手动构造的测试记忆）
          wb.botMemory.beliefs[pid].wolf = shared[pid];
          wb.botMemory.beliefs[pid].good = 1 - shared[pid];
        }
      }
    }
  }
  // 6. 狼数约束校准
  calibrateBeliefs(room, bot);
}
function wolfProb(room, bot, playerId) {
  if (!bot.botMemory || !bot.botMemory.beliefs) return 0.5;
  const b = bot.botMemory.beliefs[playerId];
  return b ? b.wolf : 0.5;
}
/* v1.5.2：投票集中——优先投"嫌疑排名前二且已有人投"的目标，防分票 */
function concentratedPick(room, pool, score) {
  if (!pool.length) return null;
  const votes = room.votes || {};
  const counts = {};
  for (const k of Object.keys(votes)) { const t = votes[k]; if (t) counts[t] = (counts[t] || 0) + 1; }
  const sorted = pool.slice().sort((a, b) => score(b) - score(a));
  const top = sorted.slice(0, 2);
  for (const p of top) if (counts[p.id]) return p; // 有人投它 → 跟票集中
  return sorted[0] || null;
}
/* v1.5.2：卖狼美人——狼美人魅惑高价值目标（可信预言家/自称神职）且狼数充足时，狼队投狼美人放逐带走目标 */
function sellWolfBeauty(room, bot) {
  if (factionOf(room, bot) !== 'wolf') return null; // v1.6.1：第三方狼美人（人狼恋）不进入卖狼逻辑
  const pack = room.wolfPackMemory || {};
  if (!pack.charmTarget) return null;
  const lp = loverPartner(room, bot); // v1.6.3：狼恋人不卖狼美人——魅惑目标是恋人时卖狼会带走恋人
  if (lp && !lp.isWolf && pack.charmTarget === lp.id) return null;
  const wb = room.players.find(p => p.alive && p.isBot && effRole(p) === 'wolfBeauty' && campOf(p) === 'wolf');
  if (!wb || wb.id === bot.id) return null;
  const target = byId(room, pack.charmTarget);
  if (!target || !target.alive) return null;
  const claims = bot.botMemory.seerClaims || {};
  const cred = claims[target.id] ? (claims[target.id].credibility || 0) : 0;
  if (cred < 0.6 && !((bot.botMemory.roleClaims || {})[target.id])) return null; // 魅惑目标非高价值不卖
  const wolfCount = room.players.filter(p => p.alive && campOf(p) === 'wolf').length;
  if (wolfCount < 2) return null; // 狼少不卖
  return wb.id;
}
/* 1.7.0（B1-1）：构造纯策略 world——只含公开信息 + bot 自己信念（B1-7 纪律①②：绝不读真实身份）；三档共用，B1-5 rollout 同源 */
function buildVoteWorld(room, bot) {
  const b = bot.botMemory || {};
  const beliefs = b.beliefs || {};
  const suspicion = b.suspicion || {};
  const model = getVoteModel(); // 1.7.0（B1-4）：fail-open——模型缺失/损坏回退纯信念；仅好人侧注入（狼侧用模型会反向增强）
  const useModel = !!model && factionOf(room, bot) === 'good';
  const scores = {};
  for (const p of room.players) {
    if (p.id === bot.id || !p.alive) continue;
    let s = beliefs[p.id] ? beliefs[p.id].wolf : Math.min(1, (suspicion[p.id] || 0) / 100); // smart/simulate 用信念，easy 用关键词嫌疑（归一化到 0..1）
    // 1.7.0（B1-4）：每轮投票前动态似然——模型 P(wolf) 混合（0.6 信念 + 0.4 模型；不改 beliefs 防累积饱和）
    if (useModel) {
      const f = voteFeatures(room, bot.id, p.id);
      if (f) {
        const mp = modelProb(model, f);
        if (mp != null) s = 0.6 * s + 0.4 * mp;
      }
    }
    scores[p.id] = s;
  }
  return {
    faction: factionOf(room, bot),
    teammates: room.players.filter(p => p.alive && isWolfRole(p)).map(p => p.id),
    scores,
    votes: room.votes || {},
    sellTarget: sellWolfBeauty(room, bot),
    allVoters: room.players.filter(p => p.alive && !p.leftGame).map(p => p.id), // 1.7.0（B1-5）：rollout 模拟投票者
    me: bot.id,
  };
}
function smartVoteTarget(room, bot) {
  const myFaction = factionOf(room, bot);
  const sellId = sellWolfBeauty(room, bot); // v1.5.2：卖狼美人优先
  if (sellId) return sellId;
  let pool = shuffle(aliveOthers(room, bot)); // 同分时随机，避免固定偏向某座位
  // v1.6.2：公平化——狼不避让恋人（不知情侣关系）；仅第三方自己（恋人互知）不投自己阵营
  if (myFaction === 'third') pool = pool.filter(p => factionOf(room, p) !== 'third');
  if (!pool.length) return null;
  const isWolf = factionOf(room, bot) === 'wolf'; // v1.6.1：第三方（人狼恋狼恋人）不再被误判为狼队
  const lp = loverPartner(room, bot); // v1.6.3：狼恋人不投恋人（恋人互知，规则内）
  if (isWolf && lp && !lp.isWolf) pool = pool.filter(p => p.id !== lp.id);
  if (!pool.length) return null;
  const t = concentratedPick(room, pool, p => (isWolf ? -wolfProb(room, bot, p.id) : wolfProb(room, bot, p.id)));
  return t ? t.id : null;
}
function decisionSmart(room, bot) {
  updateSmartMemory(room, bot);
  const mem = bot.botMemory;
  if (room.phase === 'night') {
    switch (room.nightStep) {
      case 'dreamer': {
        // v1.5.2：摄梦人保命策略——若认为下一夜会被刀（自己可信预言家/自称神职），梦狼概率最高者（试图带走一个狼）
        const pool = aliveOthers(room, bot);
        if (!pool.length) return null;
        const dClaims = mem.seerClaims || {};
        const myCred = (dClaims[bot.id] || {}).credibility || 0;
        const atRisk = myCred >= 0.6 || !!((mem.roleClaims || {})[bot.id]);
        if (atRisk) {
          let best = null, bestP = -Infinity;
          for (const p of pool) { const prob = wolfProb(room, bot, p.id); if (prob > bestP) { bestP = prob; best = p; } }
          return best ? { action: 'dreamer_pick', data: { target: best.id } } : null;
        }
        let lowest = null, lowP = Infinity;
        for (const p of shuffle(pool)) { const prob = wolfProb(room, bot, p.id); if (prob < lowP) { lowP = prob; lowest = p; } } // v1.6.2：同分随机（原第二分支被删后保留此行为）
        return lowest ? { action: 'dreamer_pick', data: { target: lowest.id } } : null;
      }
      case 'guard': {
        // v1.6.2：公平化——移除 campOf（真实阵营）过滤，守卫只基于发言声称与信念选目标
        const valid = shuffle(alivePlayers(room).filter(q => q.id !== room.guardLast));
        if (!valid.length) return { action: 'guard_pick', data: { target: bot.id } };
        // v1.5.2：优先守可信预言家/自称神职者（屠边保护神职），其次守狼概率最低者
        let target = null;
        const claims = mem.seerClaims || {};
        let bestCred = -Infinity;
        for (const pid of Object.keys(claims)) {
          const p = byId(room, pid);
          if (!p || !p.alive || p.id === bot.id || p.id === room.guardLast) continue;
          const cred = claims[pid].credibility || 0;
          if (cred > bestCred) { bestCred = cred; target = p; }
        }
        if (!target) {
          for (const pid of Object.keys(mem.roleClaims || {})) {
            const p = byId(room, pid);
            if (!p || !p.alive || p.id === bot.id || p.id === room.guardLast) continue;
            target = p; break;
          }
        }
        if (!target) {
          let lowest = Infinity;
          for (const p of valid) {
            const prob = wolfProb(room, bot, p.id);
            if (prob < lowest) { lowest = prob; target = p; }
          }
        }
        if (target) { if (!bot.botMemory.guarded) bot.botMemory.guarded = {}; bot.botMemory.guarded[target.id] = true; } // v1.4.3：记住守人
        return { action: 'guard_pick', data: { target: target.id } };
      }
      case 'wolf': {
        const humans = room.players.some(q => q.alive && isWolfRole(q) && !q.isBot);
        if (humans) return { action: 'wolf_set', data: { confirm: true } };
        const data = { confirm: true };
        if (!room.night.wolf.kill) {
          // v1.6.2：公平化——狼只避狼队友（campOf），不再避让恋人（factionOf 依赖真实情侣关系，属全知）
          // v1.6.3：狼恋人不刀/不魅惑恋人（恋人互知，规则内）
          const lp = loverPartner(room, bot);
          const enemies = aliveOthers(room, bot).filter(q => campOf(q) !== 'wolf' && (!lp || lp.isWolf || q.id !== lp.id));
          // 优先刀高可信预言家（狼视角真相校准过）
          const claims = mem.seerClaims || {};
          let target = null, bestCred = -Infinity;
          for (const pid of Object.keys(claims)) {
            const p = byId(room, pid);
            if (!p || !p.alive || campOf(p) === 'wolf' || (lp && !lp.isWolf && p.id === lp.id)) continue;
            const cred = claims[pid].credibility || 0;
            if (cred > bestCred) { bestCred = cred; target = p; }
          }
          // v1.5.1：其次刀自称神职者（守卫/女巫/猎人穿衣服）
          if (!target) {
            for (const pid of Object.keys(mem.roleClaims || {})) {
              const p = byId(room, pid);
              if (!p || !p.alive || campOf(p) === 'wolf' || (lp && !lp.isWolf && p.id === lp.id)) continue;
              target = p; break;
            }
          }
          if (!target) {
            // 1.7.0（B1-1）：间接方案——decideNightKill 刀“最像好人”的非队友（enemies 已排除队友+恋人，走纯接口）；兜底保留恋人保护
            const nk = decideNightKill(buildVoteWorld(room, bot), enemies.map(p => p.id), rng());
            target = nk.target ? byId(room, nk.target) : null;
            if (!target) target = lp && !lp.isWolf ? null : pick(aliveOthers(room, bot));
          }
          data.kill = target ? target.id : null;
          const beauty = alivePlayers(room).find(q => effRole(q) === 'wolfBeauty');
          if (beauty && !room.night.wolf.charm) {
            // v1.4.3 魅惑策略：优先魅惑高可信预言家（放逐可带走神职），其次最可信好人
            let charmTarget = null, bestCred = -Infinity;
            for (const pid of Object.keys(claims)) {
              const cp = byId(room, pid);
              if (!cp || !cp.alive || campOf(cp) === 'wolf' || cp.id === (target && target.id) || (lp && !lp.isWolf && cp.id === lp.id)) continue; // v1.6.2：移除 factionOf 全知
              const cred = claims[pid].credibility || 0;
              if (cred > bestCred) { bestCred = cred; charmTarget = cp; }
            }
            if (!charmTarget) {
              const charmPool = shuffle(aliveOthers(room, bot).filter(q => campOf(q) !== 'wolf' && q.id !== (target && target.id) && (!lp || lp.isWolf || q.id !== lp.id))); // v1.6.2：移除 factionOf 全知
              if (charmPool.length) charmTarget = charmPool.sort((a, b) => wolfProb(room, bot, a.id) - wolfProb(room, bot, b.id))[0];
            }
            if (charmTarget) data.charm = charmTarget.id;
            if (data.charm) { if (!room.wolfPackMemory) room.wolfPackMemory = {}; room.wolfPackMemory.charmTarget = data.charm; } // v1.5.2：狼队共享魅惑目标（卖狼美人）
          }
        }
        return { action: 'wolf_set', data };
      }
      case 'seer': {
        // v1.4.3：优先查验对跳者（声称过预言家且未查过），其次查狼概率最高
        const pool = shuffle(aliveOthers(room, bot).filter(q => !(room.seerHistory || []).some(h => h.target === q.id)));
        if (!pool.length) return null;
        const claimers = pool.filter(q => (mem.seerClaims || {})[q.id] && (mem.seerClaims[q.id].claims || []).length);
        const target = claimers.length
          ? pick(claimers)
          : pool.reduce((a, p) => (wolfProb(room, bot, p.id) > wolfProb(room, bot, a.id) ? p : a), pool[0]);
        return { action: 'seer_pick', data: { target: target.id } };
      }
      case 'witch': {
        const attacked = room.night.wolf.kill;
        // v1.5.1：自己/恋人被刀必救（恋人死=自己殉情）；否则狼概率高不救
        const isLover = (room.lovers || []).includes(bot.id) && (room.lovers || []).includes(attacked);
        const save = !room.witchPots.saveUsed && !!attacked && (isLover || wolfProb(room, bot, attacked) < 0.4);
        if (save) bot.botMemory.silverWater = attacked; // v1.4.3：记住银水（后续作为好人证据）
        let poison = null;
        if (!save && !room.witchPots.poisonUsed && room.nightNum >= 2) {
          let best = null, bestProb = -Infinity;
          for (const p of shuffle(aliveOthers(room, bot))) {
            if (p.id === bot.id) continue; // v1.6.2：公平化——女巫不知第三方，仅排除自己
            const prob = wolfProb(room, bot, p.id);
            if (prob > bestProb) { bestProb = prob; best = p; }
          }
          poison = best ? best.id : null;
        }
        return { action: 'witch_act', data: { save, poison } };
      }
      case 'hunter': { const t = pick(aliveOthers(room, bot)); return { action: 'hunter_shoot', data: { target: t ? t.id : null } }; }
      default: return null;
    }
  }
  if (room.phase === 'sheriff_vote') {
    // 1.7.0（B1-1）：decideVote——竞选投票只能投竞选者（state=candidates），阵营分流（好人 argmax / 狼 argmin 排除队友）
    const world = buildVoteWorld(room, bot);
    const res = decideVote(world, room.candidates || [], rng());
    return { action: 'vote', data: { target: res.target } };
  }
  if (room.phase === 'vote') {
    // 1.7.0（B1-1）：纯策略 decideVote（卖狼/跟票/阵营分流）；恋人保护 + A2-4 波动在决策层之上
    const world = buildVoteWorld(room, bot);
    let target = decideVote(world, aliveOthers(room, bot).map(p => p.id), rng()).target;
    const lp = loverPartner(room, bot);
    if (target && lp && !lp.isWolf && target === lp.id) target = null;
    // v1.6.4（A2-4）：低置信波动（smart 信息多通常置信高，波动小；被公开查杀目标不波动；卖狼=明确策略不波动）
    if (target) {
      const conf = confidenceOf(bot, target);
      if (target !== world.sellTarget && !isCheckedTarget(room, byId(room, target)) && conf < 0.55 && rng().next() < (0.55 - conf)) {
        const pool = aliveOthers(room, bot).filter(q => q.id !== target && !(lp && !lp.isWolf && q.id === lp.id));
        const other = pick(pool);
        if (other) target = other.id;
      }
    }
    return { action: 'vote', data: { target } };
  }
  if (room.phase === 'pk_vote') {
    const world = buildVoteWorld(room, bot);
    const res = decideVote(world, [...(room.pkTied || [])], rng());
    const lp = loverPartner(room, bot);
    const target = res.target && lp && !lp.isWolf && res.target === lp.id ? null : res.target;
    return { action: 'vote', data: { target } };
  }
  if (room.phase === 'hunter_shot') return { action: 'hunter_shoot', data: { target: smartVoteTarget(room, bot) } };
  return null;
}

/* ================= 统一入口 =================
 * 公共层：信息量恒定的决策（盗贼选牌/遗言/警徽/竞选/丘比特/情侣/摄梦），三档一致；
 * 智力决策点（狼刀/查验/守卫/女巫/投票）按级别分发。 */

/* ---------- 发言模拟（v1.4.3）：白天每人最多一条，走 chat 通道；null=不发言（仍会被标记已调度） ---------- */
/* ---------- 发言语料库（v1.4.4：辩论/穿衣服/气氛） ---------- */
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
function genPhrase(intent, params) {
  const tpl = LEXICON.intents[intent];
  if (!tpl) return null;
  const parts = [pick(tpl.prefixes || ['']), pick(tpl.cores || ['']), pick(tpl.suffixes || [''])]
    .map(s => (s === '' ? null : s)).filter(Boolean);
  if (!parts.length) return null;
  let text = parts.join('，');
  if (params) for (const k of Object.keys(params)) text = text.split('{' + k + '}').join(String(params[k]));
  text = text.replace(/\{[a-zA-Z]+\}/g, ''); // 清除未替换占位符
  return text.length > 120 ? text.slice(0, 120) : text;
}

function talkedCount(room, bot) {
  const bt = room.botTalked && room.botTalked.day === room.dayNum ? room.botTalked.ids : null;
  return bt ? (bt[bot.id] || 0) : 0;
}
/* 是否被他人查杀（claims 里有人声称查杀自己） */
function isCheckedWolf(room, bot, mem) {
  const claims = mem.seerClaims || {};
  for (const pid of Object.keys(claims)) {
    if (pid === bot.id) continue;
    for (const c of (claims[pid].claims || [])) if (c.result === 'wolf' && c.target === bot.id) return true;
  }
  return false;
}
/* 对跳者：声称过预言家的其他玩家 */
function counterClaimers(room, bot, mem) {
  const claims = mem.seerClaims || {};
  return Object.keys(claims).filter(pid => pid !== bot.id && (claims[pid].claims || []).length)
    .map(id => byId(room, id)).filter(Boolean);
}
/* 施压目标：smart 用狼概率，easy 用关键词嫌疑 */
function pressureTarget(room, bot, level, threshold) {
  const mem = bot.botMemory || {};
  if (level === 'smart') {
    const t = smartVoteTarget(room, bot);
    return t && wolfProb(room, bot, t) > threshold ? t : null;
  }
  const top = Object.keys(mem.suspicion || {}).map(id => ({ id, s: mem.suspicion[id] }))
    .filter(x => x.s > 30).sort((a, b) => b.s - a.s)[0];
  return top ? byId(room, top.id) : null;
}

/* 白天发言：每人每天至多 2 条（0=主发言，1=次发言：回应/辩论/气氛） */
function botTalk(room, bot, level) {
  if (level === 'idle') return null;
  const mem = ensureMemory(bot);
  if (level === 'smart') updateSmartMemory(room, bot); // 发言前先刷新推理（含狼队共享/对跳存疑）
  else updateEasyMemory(room, bot);
  const myRole = effRole(bot);
  const isWolf = campOf(bot) === 'wolf';
  const lp = loverPartner(room, bot); // v1.6.3：狼恋人保护/辩护
  const count = talkedCount(room, bot);
  const chat = text => text ? { action: 'chat', data: { ch: 'all', text } } : null;

  /* ===== 主发言（第 1 条） ===== */
  if (count === 0) {
    // 预言家：报真实查验（v1.6.4（A2-3）：easy 档预言家也补报查验，不再“p 都不放一个”）
    if (myRole === 'seer' && (level === 'smart' || level === 'easy')) {
      const h = (room.seerHistory || []).filter(x => x.night >= 1);
      if (h.length) {
        const last = h[h.length - 1];
        const nm = nameById(room, last.target);
        if (nm !== '未知') return chat(pick([
          '我是预言家，昨晚查验了' + nm + '：' + (last.result === 'wolf' ? '查杀' : '金水'),
          '我跳预言家，昨夜看的是' + nm + '：' + (last.result === 'wolf' ? '查杀' : '金水'),
          '真预言家在这，' + nm + '是我昨晚的查验：' + (last.result === 'wolf' ? '查杀' : '金水'),
        ]));
      }
      return null;
    }
    // v1.6.3：狼恋人为恋人辩护（恋人互知，规则内）——减少全场的怀疑；1.7.0（B1-1②）阶梯后移至悍跳之前：
    // 狼 smart 主发言的悍跳块末尾 return null，辩护块原在悍跳后不可达（v1.6.3 easy 档无悍跳能走到）
    if (isWolf && lp && !lp.isWolf) {
      const loverChecked = Object.keys(mem.seerClaims || {}).some(pid => pid !== bot.id && (mem.seerClaims[pid].claims || []).some(c => c.result === 'wolf' && c.target === lp.id));
      const loverSusp = (mem.suspicion || {})[lp.id] > 30 || Object.keys(mem.seerClaims || {}).some(pid => pid !== bot.id && (mem.seerClaims[pid].claims || []).some(c => c.target === lp.id));
      if (loverChecked && level === 'smart') {
        return chat(pick([
          '别信查杀' + nameById(room, lp.id) + '的话，我了解' + nameById(room, lp.id) + '，不是狼',
          nameById(room, lp.id) + '是好人，查杀他的人才是狼，你们品品',
        ]));
      }
      if (loverSusp && rng().next() < 0.6) {
        return chat(pick([
          '先别怀疑' + nameById(room, lp.id) + '，他今天的发言没什么问题',
          '我保' + nameById(room, lp.id) + '，不是狼，出他浪费轮次',
        ]));
      }
    }
    // 狼：悍跳预言家（每队只跳一次），查杀最可信好人施压
    if (level === 'smart' && isWolf) {
      if (!room.wolfPackMemory) room.wolfPackMemory = {};
      if (!room.wolfPackMemory.talkedClaim) {
        const pool = shuffle(aliveOthers(room, bot).filter(q => campOf(q) !== 'wolf' && (!lp || lp.isWolf || q.id !== lp.id))); // v1.6.3：狼恋人不悍跳查杀恋人
        if (pool.length) {
          const t = pool.sort((a, b) => wolfProb(room, bot, a.id) - wolfProb(room, bot, b.id))[0];
          room.wolfPackMemory.talkedClaim = true;
          return chat(genPhrase('wolf_fake_seer', { name: t.name }) || '我是预言家，昨晚查验了' + t.name + '：查杀'); // v1.6.4（A2-5）：组合式生成
        }
      }
      // v1.5.2：狼美人魅惑高价值目标时威胁自曝（配合卖狼美人）
      if (myRole === 'wolfBeauty') {
        const pack = room.wolfPackMemory || {};
        const ct = pack.charmTarget ? byId(room, pack.charmTarget) : null;
        if (ct && ct.alive && rng().next() < 0.6) return chat('我是狼美人，魅惑了' + ct.name + '，投我他就得死 💘');
      }
      return null;
    }
    // 女巫：报银水（只报一次）
    if (level === 'smart' && myRole === 'witch' && mem.silverWater && !mem.silverReported) {
      mem.silverReported = true;
      const nm = nameById(room, mem.silverWater);
      return nm === '未知' ? null : chat(pick([
        '我是女巫，昨晚用解药救下' + nm + '，他是我银水',
        '银水是' + nm + '，大家别动他，我女巫',
        '我女巫，昨晚救了' + nm + '，解药已经没了',
      ]));
    }
    // 守卫：报守人（模糊不暴露细节）
    if (level === 'smart' && myRole === 'guard' && mem.guarded) {
      return chat(pick([
        '我是守卫，昨晚守了人，具体是谁不说，免得狼来刀',
        '我守卫，昨晚守的自己，狼今晚可以试试',
        '守卫在此，我守人不说细节，狼别来刀神职',
      ]));
    }
    // v1.5.2：猎人/摄梦人/丘比特亮身份（概率）
    if (level === 'smart' && myRole === 'hunter') {
      if (rng().next() < 0.7) return chat(pick([
        '我是猎人，枪已上膛，谁跳得最凶我带走谁 🔫',
        '猎人牌，别逼我带人',
      ]));
    }
    if (level === 'smart' && myRole === 'dreamer') {
      if (rng().next() < 0.6) return chat(pick([
        '我是摄梦人，梦里的狼别想跑 😴',
        '摄梦人在此，今夜梦谁看表现',
      ]));
    }
    if (level === 'smart' && myRole === 'cupid') {
      if (rng().next() < 0.5) return chat(pick([
        '我是丘比特，情侣是谁我就不说了 💘',
        '丘比特在此，别乱投我，情侣是好人组合',
      ]));
    }
    // v1.6.3：狼恋人为恋人辩护（恋人互知，规则内）——减少全场的怀疑
    if (isWolf && lp && !lp.isWolf) {
      const loverChecked = Object.keys(mem.seerClaims || {}).some(pid => pid !== bot.id && (mem.seerClaims[pid].claims || []).some(c => c.result === 'wolf' && c.target === lp.id));
      const loverSusp = (mem.suspicion || {})[lp.id] > 30 || Object.keys(mem.seerClaims || {}).some(pid => pid !== bot.id && (mem.seerClaims[pid].claims || []).some(c => c.target === lp.id));
      if (loverChecked && level === 'smart') {
        return chat(pick([
          '别信查杀' + nameById(room, lp.id) + '的话，我了解' + nameById(room, lp.id) + '，不是狼',
          nameById(room, lp.id) + '是好人，查杀他的人才是狼，你们品品',
        ]));
      }
      if (loverSusp && rng().next() < 0.6) {
        return chat(pick([
          '先别怀疑' + nameById(room, lp.id) + '，他今天的发言没什么问题',
          '我保' + nameById(room, lp.id) + '，不是狼，出他浪费轮次',
        ]));
      }
    }
    // v1.6.4（A2-3）：平民/无实权角色也不沉默——表态/质疑（easy 低概率、smart 中概率；有嫌疑对象优先）
    if ((level === 'smart' && rng().next() < 0.5) || (level === 'easy' && rng().next() < 0.25)) {
      const pool = aliveOthers(room, bot).filter(q => (mem.suspicion || {})[q.id] > 0);
      if (pool.length) {
        const suspect = pick(pool);
        return chat(genPhrase('accusation', { name: suspect.name }) || '我觉得' + suspect.name + '值得关注');
      }
      const anyone = pick(aliveOthers(room, bot));
      return chat(genPhrase('flavor_action', { name: anyone ? anyone.name : '' }) || pick(TALK_FLAVOR));
    }
    // 施压：有高嫌疑对象时表态（狼恋人不施压恋人；v1.6.4（A2-5）组合式生成）
    const pt = pressureTarget(room, bot, level, level === 'smart' ? 0.5 : 0);
    if (pt && !(lp && !lp.isWolf && pt.id === lp.id)) return chat(genPhrase('pressure', { name: pt.name }) || pick(TALK_PRESSURE).split('{name}').join(pt.name));
    // 气氛：无实质话题时随机闲聊（smart 概率高，easy 低；v1.6.4（A2-5）组合式生成）
    if ((level === 'smart' && rng().next() < 0.6) || (level === 'easy' && rng().next() < 0.3)) {
      return chat(genPhrase('flavor') || pick(TALK_FLAVOR));
    }
    return null;
  }

  /* ===== 次发言（第 2 条：回应/辩论/气氛） ===== */
  const checked = isCheckedWolf(room, bot, mem);
  const claimers = counterClaimers(room, bot, mem);
  // 1. 被查杀 → 穿衣服自证 / 反跳
  if (checked) {
    if (myRole === 'seer') return chat('我才是真预言家，查杀我的人才是狼，我的查验记录都在');
    if (myRole === 'guard') return chat('我是守卫，你查杀我就是在自爆，投我你们亏一个神职');
    if (myRole === 'witch') return chat('我是女巫，解药还在，投我等于帮狼赢');
    if (isWolf) return chat('我是守卫，你查杀我说明你就是狼，狼队急了乱咬人');
    if (myRole === 'hunter') return chat('我是猎人，枪已上膛，投我你们亏一个神职 🔫'); // v1.5.2
    if (myRole === 'dreamer') return chat('我是摄梦人，投我我就带走一个，你们想清楚'); // v1.5.2
    const cc = claimers.length ? claimers[0].name : '查杀我的人';
    return chat('我是平民，投我不亏但浪费轮次，建议先出' + cc);
  }
  // v1.6.4（A2-3）：被投票/被怀疑 → 开口辩解（easy/smart 都开口；上一轮票型 totals 里有自己）
  const lv = room.lastVoteResult;
  const wasVoted = lv && lv.totals && lv.totals[bot.id];
  if (wasVoted && rng().next() < 0.8) {
    return chat(genPhrase('defend_self', { name: nameById(room, bot.id) }) || '我是好人，别投我，浪费轮次');
  }
  // 2. 对跳辩论（有对跳者时）
  if (level === 'smart' && claimers.length) {
    if (myRole === 'seer') return chat(pick(TALK_DEBATE_SEER).split('{name}').join(claimers[0].name));
    if (isWolf) {
      const cc = (claimers.find(c => !(lp && !lp.isWolf && c.id === lp.id)) || claimers[0]); // v1.6.3：狼恋人不踩恋人
      return chat(pick(TALK_DEBATE_WOLF).split('{name}').join(cc.name));
    }
  }
  // 3. 施压跟票（v1.6.3：狼恋人不施压恋人；v1.6.4（A2-5）组合式生成）
  const pt2 = pressureTarget(room, bot, level, 0.45);
  if (pt2 && !(lp && !lp.isWolf && pt2.id === lp.id)) return chat(genPhrase('pressure', { name: pt2.name }) || '今天先出' + pt2.name + '吧，别磨叽了');
  // 4. 气氛插科打诨（小概率；v1.6.4（A2-5）组合式生成）
  if (rng().next() < 0.4) return chat(genPhrase('flavor') || pick(TALK_FLAVOR));
  return null;
}

/* 遗言（lastword 阶段）：smart 有信息量，easy 简短，idle 沉默 */
function botLastWord(room, bot, level) {
  if (level === 'idle') return { action: 'skip', data: {} };
  const mem = ensureMemory(bot);
  const myRole = effRole(bot);
  const isWolf = campOf(bot) === 'wolf';
  if (level === 'smart') {
    const last = (room.seerHistory || []).filter(x => x.night >= 1).slice(-1)[0];
    if (myRole === 'seer' && last) {
      const nm = nameById(room, last.target);
      if (nm !== '未知') return { action: 'post', data: { text: '我是预言家，昨夜查了' + nm + '：' + (last.result === 'wolf' ? '查杀' : '金水') + '，大家务必出他' } };
    }
    if (myRole === 'guard' && mem.guarded) return { action: 'post', data: { text: '我是守卫，守人记录在我脑子里，按我之前的判断走' } };
    if (myRole === 'witch') return { action: 'post', data: { text: '我是女巫，解药已经用了，毒药还在，你们加油' } };
    if (myRole === 'hunter') return { action: 'post', data: { text: '我是猎人，下一枪指哪打哪，狼自己掂量' } };
    if (isWolf) {
      const lp = loverPartner(room, bot); // v1.6.3：狼恋人遗言为恋人辩护
      if (lp && !lp.isWolf && rng().next() < 0.6) return { action: 'post', data: { text: '我走了，最后说一句：' + nameById(room, lp.id) + '不是狼，别让他被冤枉' } };
      return { action: 'post', data: { text: pick(['我是平民，被刀真惨，大家加油', '我是平民，别捞我，先出跳得最凶的']) } };
    }
    const sus = pressureTarget(room, bot, 'smart', 0.4);
    const nm = sus ? sus.name : '跳得最凶的';
    if (rng().next() < 0.7) return { action: 'post', data: { text: genPhrase('lastword_good', { name: nm }) || pick(TALK_LAST_PLAIN).split('{name}').join(nm) } }; // v1.6.4（A2-5）
  } else if (level === 'easy' && rng().next() < 0.5) {
    return { action: 'post', data: { text: pick(['我是平民，大家加油', '别捞我，不亏']) } };
  }
  return { action: 'skip', data: {} };
}

/* 狼人夜晚狼频道发言：每狼每晚至多一条（配合出刀，营造狼队互动）
 * v1.6.3：狼恋人在狼频道引导——不刀恋人（狼队已选恋人时劝阻改刀） */
function botWolfChat(room, bot) {
  const level = bot.botLevel || (room.settings.botMode === 'passive' ? 'idle' : 'easy');
  if (level === 'idle') return null;
  const mem = ensureMemory(bot);
  if (mem.wolfChatNight === room.nightNum) return null;
  mem.wolfChatNight = room.nightNum;
  if (level === 'smart') updateSmartMemory(room, bot);
  const lp = loverPartner(room, bot); // v1.6.3
  const target = smartVoteTarget(room, bot);
  let text;
  // 狼队当前刀目标已是恋人 → 紧急劝阻并建议改刀
  if (lp && !lp.isWolf && room.night.wolf.kill === lp.id) {
    const other = aliveOthers(room, bot).find(q => q.id !== lp.id && campOf(q) !== 'wolf');
    text = other
      ? '先别刀' + nameById(room, lp.id) + '，留着他钓大鱼，今晚刀' + other.name + '吧'
      : '先别刀' + nameById(room, lp.id) + '，我感觉他不是神职，刀别人更赚';
    return { action: 'chat', data: { ch: 'wolf', text } };
  }
  const t2 = (target && lp && !lp.isWolf && target === lp.id) ? null : target; // 引导目标避免恋人
  if (level === 'smart' && rng().next() < 0.7) {
    const claims = bot.botMemory.seerClaims || {};
    let best = null, bestCred = -Infinity;
    for (const pid of Object.keys(claims)) {
      const p = byId(room, pid);
      if (!p || !p.alive || campOf(p) === 'wolf' || (lp && !lp.isWolf && p.id === lp.id)) continue;
      const cred = claims[pid].credibility || 0;
      if (cred > bestCred) { bestCred = cred; best = p; }
    }
    text = best ? '今晚刀' + best.name + '，他跳预言家太像真的了' : (t2 ? genPhrase('wolf_night_talk', { name: nameById(room, t2) }) || '刀' + nameById(room, t2) + '吧，发言太像神职' : '先刀预言家，稳赚不亏');
  } else {
    text = genPhrase('wolf_night_talk', { name: t2 ? nameById(room, t2) : '预言家' }) || pick(TALK_WOLF_NIGHT).split('{name}').join(t2 ? nameById(room, t2) : '预言家');
  }
  return { action: 'chat', data: { ch: 'wolf', text } };
}


/* =================================================================
   SIMULATE 档位（v1.5.0）- 5状态马尔可夫态度模型 + 多证据源 + Sigmoid校准
   适配说明（开源补丁 → 本项目）：
   - room.sheriffVotes 不存在 → 警长票证据从 lastVoteResult.kind==='sheriff' + room.votes 提取
   - room.lastWitchPoison 不存在 → 毒药证据从死亡事实（deadBy==='poison'）提取
   - 被狼刀死亡（deadBy==='wolf'）接入 DEATH 证据
   - 发言证据提取加 attMsgSeen 去重（补丁未去重：多次决策会把同一条消息反复应用）
   ================================================================= */
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

function getStyleKey(bot) {
  const s = (bot.botStyle || 'balanced').toLowerCase();
  return TRANSFER_5[s] ? s : 'balanced';
}

function normalize(arr) {
  const sum = arr.reduce((a, b) => a + b, 0);
  if (sum === 0) arr.fill(0.2);
  else for (let i = 0; i < arr.length; i++) arr[i] /= sum;
}

function vectorMatrixMul(vector, matrix) {
  const result = new Array(5).fill(0);
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      result[j] += vector[i] * matrix[i][j];
    }
  }
  return result;
}

function targetDistFromEvidence(ev) {
  const raw = [];
  for (let i = 0; i < 5; i++) raw.push(Math.exp(ev * (i - 2)));
  normalize(raw);
  return raw;
}

function getLearningRate(bot) {
  const style = getStyleKey(bot);
  switch (style) {
    case 'conservative': return 0.15;
    case 'aggressive': return 0.35;
    default: return 0.25;
  }
}

function getDynamicMatrix(styleKey, nightNum) {
  const base = TRANSFER_5[styleKey];
  if (nightNum < 3) return base.map(r => r.slice());
  const f = Math.min(0.4, (nightNum - 2) * 0.1);
  const mat = base.map(r => r.slice());
  for (let i = 0; i < 5; i++) {
    const oldDiag = mat[i][i];
    const newDiag = Math.min(0.95, oldDiag + f);
    const factor = (1 - newDiag) / (1 - oldDiag);
    mat[i][i] = newDiag;
    for (let j = 0; j < 5; j++) if (j !== i) mat[i][j] *= factor;
  }
  return mat;
}

function initAttitudes5(room, bot) {
  if (bot.botMemory.attitudes) return;
  const att = {};
  const initialDist = [0.05, 0.15, 0.60, 0.15, 0.05];
  for (const p of room.players) {
    if (p.id !== bot.id) att[p.id] = { dist: initialDist.slice() };
  }
  bot.botMemory.attitudes = att;
}

function updateAttitude5(room, bot, targetId, evidenceType, strength) {
  const att = bot.botMemory.attitudes[targetId];
  if (!att) return;
  const P = getDynamicMatrix(getStyleKey(bot), room.nightNum);
  const evolved = vectorMatrixMul(att.dist, P);
  let ev = 0;
  switch (evidenceType) {
    case EVIDENCE.VOTE_AGAINST: ev = -1.5; break;
    case EVIDENCE.CHAT_BAD: ev = -1.0; break;
    case EVIDENCE.DEATH: ev = 0.5; break;
    case EVIDENCE.CHAT_GOOD: ev = 1.0; break;
    case EVIDENCE.WITCH_SAVE: ev = 0.8; break;
    case EVIDENCE.SHERIFF: ev = 0.6; break;
    case EVIDENCE.POISON: ev = -0.8; break;
    default: ev = 0.0;
  }
  ev *= strength;
  const target = targetDistFromEvidence(ev);
  const lambda = getLearningRate(bot);
  for (let i = 0; i < 5; i++) {
    att.dist[i] = (1 - lambda) * evolved[i] + lambda * target[i];
  }
  normalize(att.dist);
}

function distToSuspectScore(dist) {
  return dist[0] * 1.0 + dist[1] * 0.75 + dist[2] * 0.5 + dist[3] * 0.25 + dist[4] * 0.0;
}

function predictAttitude5(room, bot, targetId, steps) {
  const att = bot.botMemory.attitudes[targetId];
  if (!att) return 0.5;
  let dist = att.dist.slice();
  const P = getDynamicMatrix(getStyleKey(bot), room.nightNum);
  for (let i = 0; i < steps; i++) dist = vectorMatrixMul(dist, P);
  return distToSuspectScore(dist);
}

function sigmoidMap(value) {
  const s = 1 / (1 + Math.exp(-8 * (value - 0.5)));
  return 0.3 + 0.4 * s;
}

function simulatedScoreV2(room, bot, targetId) {
  const bayes = wolfProb(room, bot, targetId);
  const predicted = predictAttitude5(room, bot, targetId, 2);
  const mappedBayes = sigmoidMap(bayes);
  const mappedPredicted = sigmoidMap(predicted);
  const styleKey = getStyleKey(bot);
  const aggressiveness = styleKey === 'aggressive' ? 0.8 : styleKey === 'conservative' ? 0.3 : 0.5;
  return mappedBayes * aggressiveness + mappedPredicted * (1 - aggressiveness);
}

function processAdditionalEvidence(room, bot) {
  const mem = bot.botMemory;
  // 死亡证据（项目：deadBy 字段区分死因；去重）
  if (!mem.attDead) mem.attDead = {};
  for (const p of room.players) {
    if (p.alive || mem.attDead[p.id]) continue;
    mem.attDead[p.id] = true;
    if (p.deadBy === 'wolf') updateAttitude5(room, bot, p.id, EVIDENCE.DEATH, 1);
    else if (p.deadBy === 'poison') updateAttitude5(room, bot, p.id, EVIDENCE.POISON, 1);
  }
  // 警长票（项目：sheriff_vote 的 votes 保留到下一轮，lastVoteResult.kind==='sheriff' 标记）
  if (room.lastVoteResult && room.lastVoteResult.kind === 'sheriff' && mem.lastSheriffRound !== room.dayNum) {
    mem.lastSheriffRound = room.dayNum;
    for (const k of Object.keys(room.votes || {})) {
      const t = room.votes[k];
      if (!t || k === bot.id || t === bot.id) continue;
      updateAttitude5(room, bot, t, EVIDENCE.SHERIFF, 1);
    }
  }
}

function decisionSimulateV2(room, bot, useRollout) { // 1.7.0（B1-5）：useRollout=true → 叠加 rollout 规划层（新 simulate 档）
  updateSmartMemory(room, bot);
  initAttitudes5(room, bot);
  const mem = bot.botMemory;
  const isWolf = campOf(bot) === 'wolf';
  const wolfStyle = (bot.wolfStyle || 'normal').toLowerCase();

  // 发言证据（去重：避免同一条消息被多次决策反复应用）
  if (!mem.attMsgSeen) mem.attMsgSeen = new Set();
  const recentMsgs = room.messages.slice(-20);
  for (const msg of recentMsgs) {
    if (!msg.text || msg.ch !== 'all' || !msg.from || mem.attMsgSeen.has(msg.id)) continue;
    mem.attMsgSeen.add(msg.id);
    const target = extractTarget(room, msg.text);
    if (!target) continue;
    if (msg.text.includes('查杀') || msg.text.includes('是狼')) {
      updateAttitude5(room, bot, target.id, EVIDENCE.CHAT_BAD, 1);
    } else if (msg.text.includes('金水') || msg.text.includes('是好人')) {
      updateAttitude5(room, bot, target.id, EVIDENCE.CHAT_GOOD, 1);
    }
  }

  // 放逐投票（项目：votes 保留到下一轮；lastVoteResult.exiled 标记被放逐者）
  if (room.lastVoteResult && room.lastVoteResult.exiled && mem.lastProcessedExile !== room.lastVoteResult.exiled) {
    mem.lastProcessedExile = room.lastVoteResult.exiled;
    const voters = Object.keys(room.votes || {}).filter(k => room.votes[k] === room.lastVoteResult.exiled);
    for (const v of voters) {
      if (v !== bot.id) updateAttitude5(room, bot, v, EVIDENCE.VOTE_AGAINST, 1);
    }
  }

  processAdditionalEvidence(room, bot);

  // 投票决策（1.7.0 B1-1：纯策略 decideVote——阵营分流/跟票/卖狼；态度逻辑已排除（P0③），由 C1 混沌层在决策层之外叠加）
  // 1.7.0（B1-5）：useRollout → rollout 前瞻（信念采样+模拟本轮投票结算，预算内降 worlds）
  if (room.phase === 'sheriff_vote') {
    const world = buildVoteWorld(room, bot);
    const res = decideVote(world, room.candidates || [], rng());
    return { action: 'vote', data: { target: res.target } };
  }
  if (room.phase === 'vote' || room.phase === 'pk_vote') {
    const state = room.phase === 'pk_vote' ? [...(room.pkTied || [])] : aliveOthers(room, bot).map(p => p.id);
    const world = buildVoteWorld(room, bot);
    let resTarget = null;
    if (useRollout) {
      const rv = rolloutVote(world, state, rng());
      if (process.env.LAB_DEBUG_ROLLOUT === '1') console.log('[rollout-dbg] scores=' + JSON.stringify(Object.fromEntries(Object.entries(world.scores).map(([k, v]) => [k, +v.toFixed(2)]))) + ' rv=' + rv);
      resTarget = rv || decideVote(world, state, rng()).target;
    } else {
      resTarget = decideVote(world, state, rng()).target;
    }
    let vote = resTarget ? byId(room, resTarget) : null;
    const lp = loverPartner(room, bot); // v1.6.3：狼恋人不投恋人（决策层之上）
    if (vote && lp && !lp.isWolf && vote.id === lp.id) vote = null;
    // 第三方（人狼恋狼恋人/丘比特）：不投自己阵营（恋人互知，规则内；v1.6.2）
    if (vote && world.faction === 'third' && factionOf(room, vote) === 'third') vote = null;
    // v1.6.4（A2-4）：低置信波动（simulate 证据更足通常更稳；被公开查杀目标不波动；卖狼不波动）
    if (vote) {
      const conf = confidenceOf(bot, vote.id);
      if (vote.id !== world.sellTarget && !isCheckedTarget(room, vote) && conf < 0.55 && rng().next() < (0.55 - conf)) {
        const pool2 = state.map(id => byId(room, id)).filter(Boolean).filter(q => q.id !== vote.id && !(lp && !lp.isWolf && q.id === lp.id));
        const other = pick(pool2);
        if (other) vote = other;
      }
    }
    return { action: 'vote', data: { target: vote ? vote.id : null } };
  }

  // 夜晚行动（复用 smart，加风格微调）
  if (room.phase === 'night') {
    const smartResult = decisionSmart(room, bot);
    if (smartResult && smartResult.action === 'wolf_set' && smartResult.data.kill) {
      const target = byId(room, smartResult.data.kill);
      if (isWolf && wolfStyle === 'charge' && target && isWolfRole(target)) {
        const goodPool = aliveOthers(room, bot).filter(p => campOf(p) !== 'wolf');
        if (goodPool.length) {
          const newTarget = goodPool.sort((a, b) => wolfProb(room, bot, a.id) - wolfProb(room, bot, b.id))[0];
          smartResult.data.kill = newTarget.id;
        }
      }
    }
    return smartResult;
  }

  // 白天发言
  if (room.phase === 'discuss') {
    const talk = botTalk(room, bot, 'smart');
    if (talk) return talk;
    const pool = shuffle(aliveOthers(room, bot));
    if (!pool.length) return null;
    let target = null;
    if (!isWolf) {
      target = pool.reduce((a, p) => simulatedScoreV2(room, bot, p.id) > simulatedScoreV2(room, bot, a.id) ? p : a, pool[0]);
    } else {
      target = pool.reduce((a, p) => simulatedScoreV2(room, bot, p.id) < simulatedScoreV2(room, bot, a.id) ? p : a, pool[0]);
    }
    if (target) return { action: 'chat', data: { ch: 'all', text: `我觉得${target.name}值得关注，大家怎么看？` } };
    return null;
  }

  return decisionSmart(room, bot);
}


/* 1.7.0（B1-1②）：阶梯平移映射——easy←现smart、smart←现simulate、simulate←新simulate(+rollout) */
const LEVEL_MAP = { easy: 'smart', smart: 'simulate', simulate: 'simulate_v2' };
function createBotDecision(room, bot) {
  CUR_RNG = (room && room.rng) || global.rng; // 1.7.0（B1-8）：本决策随机流 = 房间 RNG（同步决策，无需恢复）
  const level = bot.botLevel || (room.settings.botMode === 'passive' ? 'idle' : 'easy');
  const eff = LEVEL_MAP[level] || level; // 1.7.0（B1-1②）：阶梯平移——easy←现smart、smart←现simulate、simulate←新simulate(+rollout)
  if (room.phase === 'reveal') {
    const rv = room.reveal;
    if (room.settings.thief && rv.stage === 'thiefPick' && rv.thiefId === bot.id && !rv.thiefPicked) {
      const wolfIdx = room.center.findIndex(k => k === 'wolf' || k === 'wolfBeauty'); // 有狼必选狼
      if (wolfIdx >= 0) return { action: 'thief_pick', data: { idx: wolfIdx } };
      // v1.5.2：无狼时偏向选神职（神职卡 > 平民）
      const GOD_IDX = ['seer', 'witch', 'guard', 'dreamer', 'hunter'].map(k => room.center.findIndex(c => c === k)).filter(i => i >= 0);
      return { action: 'thief_pick', data: { idx: GOD_IDX.length ? GOD_IDX[0] : randInt(2) } };
    }
    return { action: 'confirm', data: {} };
  }
  if (room.phase === 'lastword') return botLastWord(room, bot, level === 'idle' ? 'idle' : 'smart'); // 1.7.0：阶梯后 easy/smart/simulate 均按智能遗言
  if (room.phase === 'handover') return { action: 'handover', data: { target: null } }; // 人机警长默认撕毁警徽
  if (room.phase === 'sheriff_campaign') return { action: 'campaign', data: { run: level === 'idle' ? false : rng().next() < 0.5 } };
  if (room.phase === 'discuss') return eff === 'simulate_v2' || eff === 'simulate' ? decisionSimulateV2(room, bot, eff === 'simulate_v2') : botTalk(room, bot, level === 'idle' ? 'idle' : 'smart'); // 1.7.0：阶梯后发言——新simulate 走态度+rollout，其余走组合式发言（含新easy=现smart）
  if (room.phase === 'night') {
    switch (room.nightStep) {
      case 'cupid': {
        if (room.nightNum === 1) {
          const a = pick(alivePlayers(room));
          const b = pick(alivePlayers(room).filter(q => q.id !== (a && a.id)));
          return (a && b) ? { action: 'cupid_pick', data: { ids: [a.id, b.id] } } : null;
        }
        return { action: 'cupid_pick', data: { ids: null } }; // 挂机：放弃重选
      }
      case 'lovers': return { action: 'lovers_ok', data: {} };
      default: break;
    }
  }
  // 1.7.0（B1-1②）：阶梯分发——easy←现smart、smart←现simulate、simulate←新simulate(+rollout)
  if (eff === 'simulate_v2') return decisionSimulateV2(room, bot, true); // 新 simulate：态度模型 + rollout 规划层
  if (eff === 'simulate') return decisionSimulateV2(room, bot, false); // 新 smart：旧 simulate（态度模型）
  if (eff === 'smart') return decisionSmart(room, bot); // 新 easy：旧 smart（贝叶斯）
  if (eff === 'easy') return decisionEasy(room, bot); // 防御（映射后不达）
  return decisionIdle(room, bot);
}/* =================================================================
   v1.5.6：跨局记忆治理——"印象"保留（suspicion 恩怨），"事实"重置
   rematch/startGame 共用；避免上一局的悍跳标记/魅惑目标/银水泄漏进新局
================================================================= */
function resetBotPerGame(bot) {
  if (!bot || !bot.botMemory) return;
  const m = bot.botMemory;
  m.beliefs = undefined; m.seerClaims = undefined; m.claims = undefined; m.roleClaims = undefined;
  m.silverWater = undefined; m.guarded = undefined; m.attitudes = undefined;
  m.lastExiled = undefined; m.lastSheriffRound = undefined; m.lastProcessedExile = undefined;
  m.silverReported = undefined; m.wolfChatNight = undefined;
  m.seen = undefined; m.msgSeen = undefined; m.attMsgSeen = undefined; m.recordedDead = undefined;
  m.attDead = undefined; m.roleMsgSeen = undefined;
  // suspicion（关键词好恶）刻意保留：跨局"恩怨"的载体
}
/* 上一局是狼 → 本局初始 +15 嫌疑（显式建模"真人记得上局谁是狼"） */
function injectGrudge(bot, wolfIds) {
  if (!bot || !bot.botMemory || !Array.isArray(wolfIds)) return;
  const g = bot.botMemory.suspicion = bot.botMemory.suspicion || {};
  for (const wid of wolfIds) if (wid !== bot.id) g[wid] = (g[wid] || 0) + 15;
}

module.exports = { createBotDecision, botWolfChat, factionOf, loverPartner, resetBotPerGame, injectGrudge };
