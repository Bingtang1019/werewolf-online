'use strict';
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
function effRole(p) { return (p.role === 'thief' && p.pickedRole) ? p.pickedRole : p.role; }
function isWolfRole(p) { if (!p) return false; const r = effRole(p); return r === 'wolf' || r === 'wolfBeauty'; }
/* 简化阵营：狼 / 其他（第三方按“非狼”处理，与原 bot 的 campOf!=='wolf' 一致） */
function campOf(p) { return isWolfRole(p) ? 'wolf' : 'good'; }
function randInt(n) { return Math.floor(Math.random() * n); }
function pick(arr) { return arr && arr.length ? arr[randInt(arr.length)] : null; }
function pickId(arr) { const q = pick(arr); return q ? q.id : null; }
function nameById(room, id) { const p = byId(room, id); return p ? p.name : '未知'; }
function shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
function alivePlayers(room) { return room.players.filter(p => p.alive); }
function aliveOthers(room, bot) { return alivePlayers(room).filter(p => p.id !== bot.id); }
function getWolfCount(room) {
  if (room.settings && room.settings.counts && room.settings.counts.wolf) return room.settings.counts.wolf;
  return room.players.filter(p => isWolfRole(p)).length || 1;
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
        if (!room.night.wolf.kill) data.kill = pickId(aliveOthers(room, bot)); // 全员人机时补狼刀
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
  const sorted = shuffle(aliveOthers(room, bot)).sort((a, b) => (bot.botMemory.suspicion[b.id] || 0) - (bot.botMemory.suspicion[a.id] || 0)); // 同分时已随机打乱，避免固定偏向
  return sorted[0] || null;
}
function decisionEasy(room, bot) {
  updateEasyMemory(room, bot);
  const mem = bot.botMemory;
  if (room.phase === 'night') {
    switch (room.nightStep) {
      case 'guard': {
        const valid = alivePlayers(room).filter(q => q.id !== room.guardLast);
        const seer = alivePlayers(room).find(q => effRole(q) === 'seer' && q.id !== bot.id);
        let target = (seer && seer.id !== room.guardLast) ? seer : bot;
        if (target.id === room.guardLast) { const t2 = byId(room, pickId(valid)); if (t2) target = t2; }
        if (!bot.botMemory.guarded) bot.botMemory.guarded = {};
        bot.botMemory.guarded[target.id] = true; // v1.4.3：记住守人
        return { action: 'guard_pick', data: { target: target.id } };
      }
      case 'wolf': {
        const humans = room.players.some(q => q.alive && isWolfRole(q) && !q.isBot);
        if (humans) return { action: 'wolf_set', data: { confirm: true } };
        const data = { confirm: true };
        if (!room.night.wolf.kill) {
          const claimedSeer = aliveOthers(room, bot).find(q => mem.claims[q.id] === 'seer');
          let target = claimedSeer;
          if (!target) target = pick(aliveOthers(room, bot).filter(q => campOf(q) !== 'wolf')) || pick(aliveOthers(room, bot));
          data.kill = target ? target.id : null;
          const beauty = alivePlayers(room).find(q => effRole(q) === 'wolfBeauty');
          if (beauty && !room.night.wolf.charm) {
            const charmPool = aliveOthers(room, bot).filter(q => campOf(q) !== 'wolf' && q.id !== data.kill);
            const charm = pick(charmPool);
            if (charm) data.charm = charm.id;
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
    let target = null, best = -Infinity;
    for (const c of room.candidates || []) {
      if ((mem.suspicion[c] || 0) > best) { best = mem.suspicion[c] || 0; target = c; }
    }
    return { action: 'vote', data: { target } };
  }
  if (room.phase === 'vote') {
    const t = suspicionTarget(room, bot);
    return { action: 'vote', data: { target: t ? t.id : null } };
  }
  if (room.phase === 'pk_vote') {
    const sorted = [...(room.pkTied || []).map(id => byId(room, id)).filter(Boolean)]
      .sort((a, b) => (mem.suspicion[b.id] || 0) - (mem.suspicion[a.id] || 0));
    const t = sorted[0];
    return { action: 'vote', data: { target: t ? t.id : null } };
  }
  if (room.phase === 'hunter_shot') { const t = pick(aliveOthers(room, bot)); return { action: 'hunter_shoot', data: { target: t ? t.id : null } }; }
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
function smartVoteTarget(room, bot) {
  const pool = shuffle(aliveOthers(room, bot)); // 同分时随机，避免固定偏向某座位
  if (!pool.length) return null;
  const isWolf = campOf(bot) === 'wolf';
  let best = null, bestScore = -Infinity;
  for (const p of pool) {
    const score = isWolf ? -wolfProb(room, bot, p.id) : wolfProb(room, bot, p.id);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best ? best.id : null;
}
function decisionSmart(room, bot) {
  updateSmartMemory(room, bot);
  const mem = bot.botMemory;
  if (room.phase === 'night') {
    switch (room.nightStep) {
      case 'guard': {
        const valid = shuffle(alivePlayers(room).filter(q => q.id !== room.guardLast && campOf(q) !== 'wolf'));
        if (!valid.length) return { action: 'guard_pick', data: { target: bot.id } };
        let target = null, lowest = Infinity;
        for (const p of valid) {
          const prob = wolfProb(room, bot, p.id);
          if (prob < lowest) { lowest = prob; target = p; }
        }
        if (target) { if (!bot.botMemory.guarded) bot.botMemory.guarded = {}; bot.botMemory.guarded[target.id] = true; } // v1.4.3：记住守人
        return { action: 'guard_pick', data: { target: target.id } };
      }
      case 'wolf': {
        const humans = room.players.some(q => q.alive && isWolfRole(q) && !q.isBot);
        if (humans) return { action: 'wolf_set', data: { confirm: true } };
        const data = { confirm: true };
        if (!room.night.wolf.kill) {
          // 优先刀高可信预言家（狼视角真相校准过）
          const claims = mem.seerClaims || {};
          let target = null, bestCred = -Infinity;
          for (const pid of Object.keys(claims)) {
            const p = byId(room, pid);
            if (!p || !p.alive || campOf(p) === 'wolf') continue;
            const cred = claims[pid].credibility || 0;
            if (cred > bestCred) { bestCred = cred; target = p; }
          }
          if (!target) {
            const goodPool = aliveOthers(room, bot).filter(q => campOf(q) !== 'wolf');
            if (goodPool.length) target = shuffle(goodPool).sort((a, b) => wolfProb(room, bot, a.id) - wolfProb(room, bot, b.id))[0]; // 同分已打乱：无证据时随机刀
            else target = pick(aliveOthers(room, bot));
          }
          data.kill = target ? target.id : null;
          const beauty = alivePlayers(room).find(q => effRole(q) === 'wolfBeauty');
          if (beauty && !room.night.wolf.charm) {
            // v1.4.3 魅惑策略：优先魅惑高可信预言家（放逐可带走神职），其次最可信好人
            let charmTarget = null, bestCred = -Infinity;
            for (const pid of Object.keys(claims)) {
              const cp = byId(room, pid);
              if (!cp || !cp.alive || campOf(cp) === 'wolf' || cp.id === (target && target.id)) continue;
              const cred = claims[pid].credibility || 0;
              if (cred > bestCred) { bestCred = cred; charmTarget = cp; }
            }
            if (!charmTarget) {
              const charmPool = shuffle(aliveOthers(room, bot).filter(q => campOf(q) !== 'wolf' && q.id !== (target && target.id)));
              if (charmPool.length) charmTarget = charmPool.sort((a, b) => wolfProb(room, bot, a.id) - wolfProb(room, bot, b.id))[0];
            }
            if (charmTarget) data.charm = charmTarget.id;
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
      case 'dreamer': {
        // 智能：梦“狼概率最低”的非狼玩家（保护最可信的好人）；摄梦人自己不能梦自己
        const pool = shuffle(alivePlayers(room).filter(q => q.id !== bot.id && campOf(q) !== 'wolf'));
        if (!pool.length) return { action: 'dreamer_pick', data: { target: bot.id } }; // 服务端会拒绝，等待超时跳过
        let target = null, lowest = Infinity;
        for (const p of pool) {
          const prob = wolfProb(room, bot, p.id);
          if (prob < lowest) { lowest = prob; target = p; }
        }
        return { action: 'dreamer_pick', data: { target: target.id } };
      }
      case 'witch': {
        const attacked = room.night.wolf.kill;
        const save = !room.witchPots.saveUsed && !!attacked && wolfProb(room, bot, attacked) < 0.4; // 狼概率高不救
        if (save) bot.botMemory.silverWater = attacked; // v1.4.3：记住银水（后续作为好人证据）
        let poison = null;
        if (!save && !room.witchPots.poisonUsed && room.nightNum >= 2) {
          let best = null, bestProb = -Infinity;
          for (const p of shuffle(aliveOthers(room, bot))) {
            if (p.id === bot.id) continue;
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
  if (room.phase === 'sheriff_vote' || room.phase === 'vote') {
    return { action: 'vote', data: { target: smartVoteTarget(room, bot) } };
  }
  if (room.phase === 'pk_vote') {
    const pool = [...(room.pkTied || []).map(id => byId(room, id)).filter(Boolean)];
    if (!pool.length) return { action: 'vote', data: { target: null } };
    const isWolf = campOf(bot) === 'wolf';
    const sorted = [...pool].sort((a, b) => {
      const pa = wolfProb(room, bot, a.id), pb = wolfProb(room, bot, b.id);
      return isWolf ? pa - pb : pb - pa;
    });
    return { action: 'vote', data: { target: sorted[0].id } };
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
  const count = talkedCount(room, bot);
  const chat = text => text ? { action: 'chat', data: { ch: 'all', text } } : null;

  /* ===== 主发言（第 1 条） ===== */
  if (count === 0) {
    // 预言家：报真实查验
    if (level === 'smart' && myRole === 'seer') {
      const h = (room.seerHistory || []).filter(x => x.night >= 1);
      if (h.length) {
        const last = h[h.length - 1];
        const nm = nameById(room, last.target);
        if (nm !== '未知') return chat('我是预言家，昨晚查验了' + nm + '：' + (last.result === 'wolf' ? '查杀' : '金水'));
      }
      return null;
    }
    // 狼：悍跳预言家（每队只跳一次），查杀最可信好人施压
    if (level === 'smart' && isWolf) {
      if (!room.wolfPackMemory) room.wolfPackMemory = {};
      if (!room.wolfPackMemory.talkedClaim) {
        const pool = shuffle(aliveOthers(room, bot).filter(q => campOf(q) !== 'wolf'));
        if (pool.length) {
          const t = pool.sort((a, b) => wolfProb(room, bot, a.id) - wolfProb(room, bot, b.id))[0];
          room.wolfPackMemory.talkedClaim = true;
          return chat('我是预言家，昨晚查验了' + t.name + '：查杀');
        }
      }
      return null;
    }
    // 女巫：报银水（只报一次）
    if (level === 'smart' && myRole === 'witch' && mem.silverWater && !mem.silverReported) {
      mem.silverReported = true;
      const nm = nameById(room, mem.silverWater);
      return nm === '未知' ? null : chat('我是女巫，昨晚用解药救下' + nm + '，他是我银水');
    }
    // 守卫：报守人（模糊不暴露细节）
    if (level === 'smart' && myRole === 'guard' && mem.guarded) {
      return chat('我是守卫，昨晚守了人，具体是谁不说，免得狼来刀');
    }
    // 施压：有高嫌疑对象时表态
    const pt = pressureTarget(room, bot, level, level === 'smart' ? 0.5 : 0);
    if (pt) return chat(pick(TALK_PRESSURE).split('{name}').join(pt.name));
    // 气氛：无实质话题时随机闲聊（smart 概率高，easy 低）
    if ((level === 'smart' && Math.random() < 0.6) || (level === 'easy' && Math.random() < 0.3)) {
      return chat(pick(TALK_FLAVOR));
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
    const cc = claimers.length ? claimers[0].name : '查杀我的人';
    return chat('我是平民，投我不亏但浪费轮次，建议先出' + cc);
  }
  // 2. 对跳辩论（有对跳者时）
  if (level === 'smart' && claimers.length) {
    if (myRole === 'seer') return chat(pick(TALK_DEBATE_SEER).split('{name}').join(claimers[0].name));
    if (isWolf) return chat(pick(TALK_DEBATE_WOLF).split('{name}').join(claimers[0].name));
  }
  // 3. 施压跟票
  const pt2 = pressureTarget(room, bot, level, 0.45);
  if (pt2) return chat('今天先出' + pt2.name + '吧，别磨叽了');
  // 4. 气氛插科打诨（小概率）
  if (Math.random() < 0.4) return chat(pick(TALK_FLAVOR));
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
    if (isWolf) return { action: 'post', data: { text: pick(['我是平民，被刀真惨，大家加油', '我是平民，别捞我，先出跳得最凶的']) } };
    const sus = pressureTarget(room, bot, 'smart', 0.4);
    const nm = sus ? sus.name : '跳得最凶的';
    if (Math.random() < 0.7) return { action: 'post', data: { text: pick(TALK_LAST_PLAIN).split('{name}').join(nm) } };
  } else if (level === 'easy' && Math.random() < 0.5) {
    return { action: 'post', data: { text: pick(['我是平民，大家加油', '别捞我，不亏']) } };
  }
  return { action: 'skip', data: {} };
}

/* 狼人夜晚狼频道发言：每狼每晚至多一条（配合出刀，营造狼队互动） */
function botWolfChat(room, bot) {
  const level = bot.botLevel || (room.settings.botMode === 'passive' ? 'idle' : 'easy');
  if (level === 'idle') return null;
  const mem = ensureMemory(bot);
  if (mem.wolfChatNight === room.nightNum) return null;
  mem.wolfChatNight = room.nightNum;
  if (level === 'smart') updateSmartMemory(room, bot);
  const target = smartVoteTarget(room, bot);
  let text;
  if (level === 'smart' && Math.random() < 0.7) {
    const claims = bot.botMemory.seerClaims || {};
    let best = null, bestCred = -Infinity;
    for (const pid of Object.keys(claims)) {
      const p = byId(room, pid);
      if (!p || !p.alive || campOf(p) === 'wolf') continue;
      const cred = claims[pid].credibility || 0;
      if (cred > bestCred) { bestCred = cred; best = p; }
    }
    text = best ? '今晚刀' + best.name + '，他跳预言家太像真的了' : (target ? '刀' + nameById(room, target) + '吧，发言太像神职' : '先刀预言家，稳赚不亏');
  } else {
    text = pick(TALK_WOLF_NIGHT).split('{name}').join(target ? nameById(room, target) : '预言家');
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
const ATT_STATE = {
  SUSPECT_EXTREME: 0,
  SUSPECT_SOME: 1,
  NEUTRAL: 2,
  TRUST_SOME: 3,
  TRUST_EXTREME: 4
};

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

function decisionSimulateV2(room, bot) {
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

  // 投票决策
  if (room.phase === 'vote' || room.phase === 'sheriff_vote' || room.phase === 'pk_vote') {
    let pool = room.phase === 'pk_vote'
      ? [...(room.pkTied || []).map(id => byId(room, id)).filter(Boolean)]
      : shuffle(aliveOthers(room, bot));
    if (!pool.length) return { action: 'vote', data: { target: null } };
    let best = null, bestScore = -Infinity;
    for (const p of pool) {
      let score = simulatedScoreV2(room, bot, p.id);
      if (isWolf) {
        if (wolfStyle === 'charge') {
          score = -score;
        } else if (wolfStyle === 'shark') {
          if (isWolfRole(p)) score -= 0.3;
        }
      }
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return { action: 'vote', data: { target: best ? best.id : null } };
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


function createBotDecision(room, bot) {
  const level = bot.botLevel || (room.settings.botMode === 'passive' ? 'idle' : 'easy');
  if (room.phase === 'reveal') {
    const rv = room.reveal;
    if (room.settings.thief && rv.stage === 'thiefPick' && rv.thiefId === bot.id && !rv.thiefPicked) {
      const wolfIdx = room.center.findIndex(k => k === 'wolf' || k === 'wolfBeauty'); // 有狼必选狼
      return { action: 'thief_pick', data: { idx: wolfIdx >= 0 ? wolfIdx : randInt(2) } };
    }
    return { action: 'confirm', data: {} };
  }
  if (room.phase === 'lastword') return level === 'simulate' ? botLastWord(room, bot, 'smart') : botLastWord(room, bot, level); // v1.4.4：遗言（smart 有信息量）
  if (room.phase === 'handover') return { action: 'handover', data: { target: null } }; // 人机警长默认撕毁警徽
  if (room.phase === 'sheriff_campaign') return { action: 'campaign', data: { run: level === 'idle' ? false : Math.random() < 0.5 } };
  if (room.phase === 'discuss') return level === 'simulate' ? decisionSimulateV2(room, bot) : botTalk(room, bot, level); // v1.4.3：白天发言模拟（simulate 走态度模型）
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
  if (level === 'simulate') return decisionSimulateV2(room, bot); // v1.5.0：态度模型档位
  if (level === 'smart') return decisionSmart(room, bot);
  if (level === 'easy') return decisionEasy(room, bot);
  return decisionIdle(room, bot);
}

module.exports = { createBotDecision, botWolfChat };
