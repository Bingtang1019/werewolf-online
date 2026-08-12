// bot-brain 拆分：memory 模块（记忆/信念/低级决策）
'use strict';
const shared = require('./shared');
const ctx = shared.ctx;
const register = shared.register;
const S = shared.S;

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
        const valid = ctx.alivePlayers(room).filter(q => q.id !== room.guardLast);
        if (room.guardLast === bot.id) return { action: 'guard_pick', data: { target: ctx.pickId(valid) } };
        return { action: 'guard_pick', data: { target: bot.id } }; // 挂机守自己
      }
      case 'wolf': {
        const humans = room.players.some(q => q.alive && ctx.isWolfRole(q) && !q.isBot);
        if (humans) return { action: 'wolf_set', data: { confirm: true } }; // 有人类狼：只确认，不覆盖
        const data = { confirm: true };
        const lp = ctx.loverPartner(room, bot); // v1.6.3：狼恋人——不刀恋人（人狼恋，恋人互知）
        const safe = ctx.aliveOthers(room, bot).filter(q => ctx.campOf(q) !== 'wolf' && (!lp || lp.isWolf || q.id !== lp.id));
        if (!room.night.wolf.kill) data.kill = ctx.pickId(safe) || (lp && !lp.isWolf ? null : ctx.pickId(ctx.aliveOthers(room, bot)));
        return { action: 'wolf_set', data };
      }
      case 'seer': { const t = ctx.pickId(ctx.aliveOthers(room, bot)); return t ? { action: 'seer_pick', data: { target: t } } : null; }
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
  const isWolf = ctx.isWolfRole(bot);
  for (const msg of room.messages) {
    if (mem.seen.has(msg.id)) continue;
    mem.seen.add(msg.id);
    if (msg.ch !== 'all' || !msg.text || !msg.from) continue;
    const from = ctx.byId(room, msg.from);
    if (!from || from.id === bot.id) continue;
    const text = msg.text;
    const target = ctx.extractTarget(room, text);
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
  const sellId = ctx.sellWolfBeauty(room, bot); // v1.5.2：卖狼美人优先
  if (sellId) return sellId;
  const pool = ctx.shuffle(ctx.aliveOthers(room, bot));
  const score = p => (bot.botMemory.suspicion[p.id] || 0);
  return ctx.concentratedPick(room, pool, score); // v1.5.2：投票集中
}
function decisionEasy(room, bot) {
  updateEasyMemory(room, bot);
  const mem = bot.botMemory;
  if (room.phase === 'night') {
    switch (room.nightStep) {
      case 'guard': {
        // v1.6.2：公平化——移除“读真实预言家身份”的全知（人机不得用服务器真相作弊），改为守自己/随机
        const valid = ctx.alivePlayers(room).filter(q => q.id !== room.guardLast);
        let target = bot;
        if (target.id === room.guardLast) { const t2 = ctx.byId(room, ctx.pickId(valid)); if (t2) target = t2; }
        if (!bot.botMemory.guarded) bot.botMemory.guarded = {};
        bot.botMemory.guarded[target.id] = true; // v1.4.3：记住守人
        return { action: 'guard_pick', data: { target: target.id } };
      }
      case 'wolf': {
        const humans = room.players.some(q => q.alive && ctx.isWolfRole(q) && !q.isBot);
        if (humans) return { action: 'wolf_set', data: { confirm: true } };
        const data = { confirm: true };
        const lp = ctx.loverPartner(room, bot); // v1.6.3：狼恋人不刀恋人
        if (!room.night.wolf.kill) {
          const claimedSeer = ctx.aliveOthers(room, bot).find(q => mem.claims[q.id] === 'seer' && (!lp || lp.isWolf || q.id !== lp.id));
          let target = claimedSeer;
          if (!target) {
            // v1.7.6：第三方狼恋人夜刀——永不刀狼（狼队频道执行=自爆）；刀好人神职（价值序：女巫>预言家>猎人>守卫>摄梦人），伪装正常狼人
            const world = ctx.buildVoteWorld(room, bot);
            if (ctx.factionOf(room, bot) === 'third') {
              const val = { '女巫': 5, '预言家': 4, '猎人': 3, '守卫': 2, '摄梦人': 1 };
              const claims = world.roleClaims || {};
              const pool = ctx.aliveOthers(room, bot).filter(q => ctx.campOf(q) !== 'wolf' && ctx.factionOf(room, q) !== 'third' && (!lp || lp.isWolf || q.id !== lp.id));
              let t2 = null, bestV = -1;
              for (const q of pool) { const r = claims[q.id]; if (r && (val[r] || 0) > bestV) { bestV = val[r] || 0; t2 = q; } }
              if (!t2 && pool.length) t2 = pool.slice().sort((a, b) => (world.scores[a.id] || 0.5) - (world.scores[b.id] || 0.5))[0];
              target = t2;
            } else {
              // v1.7.7（α3）：刀神分类器优先（fail-open：模型缺失回退 argmin）；普通狼（非第三方）走此分支
              const wm = ctx.loadWolfGodModel();
              let t2 = null;
              if (wm) t2 = ctx.byId(room, S.wolfKillDecide(ctx.buildWolfKillWorld(room, bot), wm, { killPriority: { '女巫': 5, '预言家': 4, '猎人': 3, '守卫': 2, '摄梦人': 1 } }));
              if (!t2) { const nk = S.decideNightKill(world, ctx.aliveOthers(room, bot).map(p => p.id), ctx.rng()); t2 = nk.target ? ctx.byId(room, nk.target) : null; }
              target = t2;
            }
            if (target && lp && !lp.isWolf && target.id === lp.id) target = null;
          }
          data.kill = target ? target.id : null;
          const beauty = ctx.alivePlayers(room).find(q => ctx.effRole(q) === 'wolfBeauty');
          if (beauty && !room.night.wolf.charm) {
            const charmPool = ctx.aliveOthers(room, bot).filter(q => ctx.campOf(q) !== 'wolf' && q.id !== data.kill && (!lp || lp.isWolf || q.id !== lp.id)); // v1.6.3：狼恋人不魅惑恋人
            const charm = ctx.pick(charmPool);
            if (charm) data.charm = charm.id;
            if (data.charm) { if (!room.wolfPackMemory) room.wolfPackMemory = {}; room.wolfPackMemory.charmTarget = data.charm; } // v1.5.2：狼队共享魅惑目标（卖狼美人）
          }
        }
        return { action: 'wolf_set', data };
      }
      case 'seer': {
        const pool = ctx.aliveOthers(room, bot).filter(q => !(room.seerHistory || []).some(h => h.target === q.id));
        const t = ctx.pick(pool) || ctx.pick(ctx.aliveOthers(room, bot));
        return t ? { action: 'seer_pick', data: { target: t.id } } : null;
      }
      case 'dreamer': { const t = ctx.pickId(ctx.aliveOthers(room, bot)); return t ? { action: 'dreamer_pick', data: { target: t } } : null; } // 简单：随机梦人
      case 'witch': {
        const attacked = room.night.wolf.kill;
        const save = !room.witchPots.saveUsed && !!attacked; // 简单：无脑救被刀者
        if (save && attacked && !bot.botMemory.silverWater) bot.botMemory.silverWater = attacked; // v1.4.3：记住银水
        let poison = null;
        if (!save && !room.witchPots.poisonUsed && room.nightNum >= 2) {
          const t = ctx.pick(ctx.aliveOthers(room, bot));
          if (t) poison = t.id;
        }
        return { action: 'witch_act', data: { save, poison } };
      }
      case 'hunter': { const t = ctx.pick(ctx.aliveOthers(room, bot)); return { action: 'hunter_shoot', data: { target: t ? t.id : null } }; }
      default: return null;
    }
  }
  if (room.phase === 'sheriff_vote') {
    const world = ctx.buildVoteWorld(room, bot); // 1.7.0（B1-1）：S.decideVote（阵营分流 + 跟票集中）
    const res = S.decideVote(world, room.candidates || [], ctx.rng());
    const lp = ctx.loverPartner(room, bot); // v1.6.3：狼恋人不投恋人（决策层之上）
    const target = res.target && lp && !lp.isWolf && res.target === lp.id ? null : res.target;
    return { action: 'vote', data: { target } };
  }
  if (room.phase === 'vote') {
    const world = ctx.buildVoteWorld(room, bot); // 1.7.0（B1-1）：纯策略 S.decideVote（含卖狼/跟票/阵营分流）
    const res = S.decideVote(world, ctx.aliveOthers(room, bot).map(p => p.id), ctx.rng());
    let t = res.target ? ctx.byId(room, res.target) : null;
    const lp = ctx.loverPartner(room, bot); // v1.6.3：狼恋人不投恋人
    if (t && lp && !lp.isWolf && t.id === lp.id) t = null;
    // v1.7.2（B-1）：第三方（人狼恋狼恋人/丘比特）不投自己阵营（恋人互知，规则内；与 simulate 档统一）
    if (t && world.faction === 'third' && ctx.factionOf(room, t) === 'third') t = null;
    // v1.6.4（A2-4）：不确定性表达——置信度低时小概率偏离最优（随机/跟风），高置信才准；被公开查杀/卖狼目标不波动
    if (t) {
      const conf = S.confidenceOf(room, bot, t.id); // 1.7.3（F2）：Platt 派生置信度优先
      if (t.id !== world.sellTarget && !ctx.isCheckedTarget(room, t) && conf < 0.6 && ctx.rng().next() < (0.6 - conf)) {
        // 1.7.3（F5）：波动有界（A5-2 定稿）——只允许偏移到分数 top3，避免“上头投 rank 12”
        const ranked = ctx.aliveOthers(room, bot).map(q => ({ q, s: world.scores[q.id] || 0.5 })).sort((a, b) => b.s - a.s).slice(0, 3);
        const pool = ranked.map(x => x.q).filter(q => q.id !== t.id && !(lp && !lp.isWolf && q.id === lp.id));
        const other = ctx.pick(pool) || t;
        t = other;
      }
    }
    return { action: 'vote', data: { target: t ? t.id : null } };
  }
  if (room.phase === 'pk_vote') {
    const world = ctx.buildVoteWorld(room, bot); // 1.7.0（B1-1）
    const res = S.decideVote(world, [...(room.pkTied || [])], ctx.rng());
    const lp = ctx.loverPartner(room, bot);
    let target = res.target && lp && !lp.isWolf && res.target === lp.id ? null : res.target;
    // v1.7.2（B-1）：第三方不投自己阵营（与 vote 分支统一）
    if (target && world.faction === 'third' && ctx.factionOf(room, ctx.byId(room, target)) === 'third') target = null;
    return { action: 'vote', data: { target } };
  }
  if (room.phase === 'hunter_shot') {
    // v1.6.2：easy 猎人按关键词嫌疑选枪（原为纯随机）
    const pool = ctx.shuffle(ctx.aliveOthers(room, bot));
    const t = pool.reduce((a, p) => (bot.botMemory.suspicion[p.id] || 0) > (bot.botMemory.suspicion[a.id] || 0) ? p : a, pool[0]);
    return { action: 'hunter_shoot', data: { target: t ? t.id : null } };
  }
  return null;
}

/* ================= SMART（贝叶斯推理） ================= */
function initBeliefs(room, bot) {
  ensureMemory(bot); // 防御：任何路径进入都必须有记忆对象
  if (!bot.botMemory.beliefs) {
    const wolfCount = ctx.getWolfCount(room);
    const aliveCount = ctx.alivePlayers(room).length || 1;
    const prior = wolfCount / aliveCount;
    bot.botMemory.beliefs = {};
    for (const p of room.players) bot.botMemory.beliefs[p.id] = { wolf: prior, good: 1 - prior, ev: 0 }; // 1.7.18：ev=证据量（动态权重用——每次 updateBelief +1）
  }
}
function updateBelief(room, bot, targetId, evidence) {
  if (!bot.botMemory.beliefs) initBeliefs(room, bot);
  const b = bot.botMemory.beliefs[targetId];
  if (!b) return;
  // v1.7.2（A-1）+ v1.7.3（F1）：放逐票型反推的完整故事——
  // ①方向：投票方向统计（200 局）：放逐狼 → 投票者中狼 5.5%（贝叶斯 LR≈0.20）→ 投狼者嫌疑应降；
  //   放逐好人 → 投票者中狼 30.7%（贝叶斯 LR≈1.48）→ 投好人者嫌疑应升。狼不投狼队友（除卖狼）实锤。
  // ②强度（战略防御，非最优贝叶斯）：实现取 0.7（方向温和版）与 1.0（中性）——1.48 被故意放弃：
  //   放逐好人后给“投他者”升嫌疑会引发好人自相残杀级联（放逐一个好→投他的一圈好人嫌疑升→下轮被放逐→
  //   更多人嫌疑升；狼受益）。实测：仅 1.4→1.0 就让好人胜率翻倍（24%→48%，commit 0a15a97）。
  // ③分层：信念层温和/中性化，判别责任交给模型层（特征 votes_against/prev_votes 不受 LR 中性化影响）。
  //   若未来改回 1.4，必须重跑 ① 的统计与 ② 的对照，否则平衡一夜回解放前。
  const LR = { check_wolf: 19, check_good: 0.05, killed_by_wolf: 0.1, voted_out_wolf: 0.7, voted_out_good: 1.0, silver_water: 0.05, guard_protected: 0.7 }[evidence] || 1;
  const odds = (b.wolf / Math.max(b.good, 0.01)) * LR;
  b.wolf = odds / (1 + odds);
  b.good = 1 - b.wolf;
  b.ev = (b.ev || 0) + 1; // 1.7.18：证据量累积（动态权重信号）
}
function calibrateBeliefs(room, bot) {
  const wolfCount = ctx.getWolfCount(room);
  const alive = ctx.alivePlayers(room);
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
    const claimer = ctx.byId(room, msg.from);
    if (!claimer) continue;
    const claim = bot.botMemory.seerClaims[claimer.id] || { credibility: 0.5, claims: [] };
    const target = ctx.extractTarget(room, msg.text);
    const result = msg.text.includes('查杀') ? 'wolf' : (msg.text.includes('金水') ? 'good' : null);
    if (target && result) claim.claims.push({ target: target.id, result });
    bot.botMemory.seerClaims[claimer.id] = claim;
  }
  if (ctx.campOf(bot) === 'wolf') {
    const wolfIds = new Set(room.players.filter(p => ctx.isWolfRole(p)).map(p => p.id));
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
  const myRole = ctx.effRole(bot);
  const knowTruth = ctx.campOf(bot) === 'wolf';
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
    const executed = ctx.byId(room, room.lastVoteResult.exiled);
    if (executed && !executed.alive) {
      const voters = Object.keys(room.votes || {}).filter(k => room.votes[k] === executed.id && k !== bot.id);
      const wasWolf = ctx.isWolfRole(executed);
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
    const wolfBots = room.players.filter(p => p.alive && p.isBot && ctx.isWolfRole(p));
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

module.exports = { ensureMemory, decisionIdle, updateEasyMemory, suspicionTarget, decisionEasy, initBeliefs, updateBelief, calibrateBeliefs, updateSeerClaims, updateSmartMemory };