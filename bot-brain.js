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
        const target = (seer && seer.id !== room.guardLast) ? seer : bot;
        if (target.id === room.guardLast) return { action: 'guard_pick', data: { target: pickId(valid) } };
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
  const LR = { check_wolf: 19, check_good: 0.05, killed_by_wolf: 0.1, voted_out_wolf: 1.2, voted_out_good: 0.8 }[evidence] || 1;
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
      let cred = 0.5;
      if (myClaim && myClaim.claims.length) {
        const mine = myClaim.claims[0], theirs = claim.claims[0];
        if (mine.target === theirs.target && mine.result !== theirs.result) cred = 0.2; // 对跳同一目标且结论相反
        else if (mine.target === theirs.target) cred = 0.7;
      }
      if (cred <= 0.3) continue;
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
            const charmPool = aliveOthers(room, bot).filter(q => campOf(q) !== 'wolf' && q.id !== data.kill);
            const charm = pick(charmPool);
            if (charm) data.charm = charm.id;
          }
        }
        return { action: 'wolf_set', data };
      }
      case 'seer': {
        const pool = shuffle(aliveOthers(room, bot).filter(q => !(room.seerHistory || []).some(h => h.target === q.id)));
        if (!pool.length) return null;
        let target = null, best = -Infinity;
        for (const p of pool) {
          const prob = wolfProb(room, bot, p.id);
          if (prob > best) { best = prob; target = p; }
        }
        return target ? { action: 'seer_pick', data: { target: target.id } } : null;
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
  if (room.phase === 'lastword') return { action: 'skip', data: {} };
  if (room.phase === 'handover') return { action: 'handover', data: { target: null } }; // 人机警长默认撕毁警徽
  if (room.phase === 'sheriff_campaign') return { action: 'campaign', data: { run: level === 'idle' ? false : Math.random() < 0.5 } };
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
  if (level === 'smart') return decisionSmart(room, bot);
  if (level === 'easy') return decisionEasy(room, bot);
  return decisionIdle(room, bot);
}

module.exports = { createBotDecision };
