// bot-brain 拆分：main 模块（决策入口/聚合）
'use strict';
const shared = require('./shared');
const ctx = shared.ctx;
const register = shared.register;
const S = shared.S;
const cupidPick = require('./cupid');

function decisionSimulateV2(room, bot, useRollout) { // 1.7.0（B1-5）：useRollout=true → 叠加 rollout 规划层（新 simulate 档）
  ctx.updateSmartMemory(room, bot);
  ctx.initAttitudes5(room, bot);
  const mem = bot.botMemory;
  const isWolf = ctx.campOf(bot) === 'wolf';
  const wolfStyle = (bot.wolfStyle || 'normal').toLowerCase();

  // 发言证据（去重：避免同一条消息被多次决策反复应用）
  if (!mem.attMsgSeen) mem.attMsgSeen = new Set();
  const recentMsgs = room.messages.slice(-20);
  for (const msg of recentMsgs) {
    if (!msg.text || msg.ch !== 'all' || !msg.from || mem.attMsgSeen.has(msg.id)) continue;
    mem.attMsgSeen.add(msg.id);
    const target = ctx.extractTarget(room, msg.text);
    if (!target) continue;
    if (msg.text.includes('查杀') || msg.text.includes('是狼')) {
      ctx.updateAttitude5(room, bot, target.id, S.EVIDENCE.CHAT_BAD, 1);
    } else if (msg.text.includes('金水') || msg.text.includes('是好人')) {
      ctx.updateAttitude5(room, bot, target.id, S.EVIDENCE.CHAT_GOOD, 1);
    }
  }

  // 放逐投票（项目：votes 保留到下一轮；lastVoteResult.exiled 标记被放逐者）
  if (room.lastVoteResult && room.lastVoteResult.exiled && mem.lastProcessedExile !== room.lastVoteResult.exiled) {
    mem.lastProcessedExile = room.lastVoteResult.exiled;
    const voters = Object.keys(room.votes || {}).filter(k => room.votes[k] === room.lastVoteResult.exiled);
    for (const v of voters) {
      if (v !== bot.id) ctx.updateAttitude5(room, bot, v, S.EVIDENCE.VOTE_AGAINST, 1);
    }
  }

  ctx.processAdditionalEvidence(room, bot);

  // 投票决策（1.7.0 B1-1：纯策略 S.decideVote——阵营分流/跟票/卖狼；态度逻辑已排除（P0③），由 C1 混沌层在决策层之外叠加）
  // 1.7.0（B1-5）：useRollout → rollout 前瞻（信念采样+模拟本轮投票结算，预算内降 worlds）
  if (room.phase === 'sheriff_vote') {
    const world = ctx.buildVoteWorld(room, bot);
    const res = S.decideVote(world, room.candidates || [], ctx.rng());
    return { action: 'vote', data: { target: res.target } };
  }
  if (room.phase === 'vote' || room.phase === 'pk_vote') {
    const state = room.phase === 'pk_vote' ? [...(room.pkTied || [])] : ctx.aliveOthers(room, bot).map(p => p.id);
    const world = ctx.buildVoteWorld(room, bot);
    let resTarget = null;
    // 1.7.17（审计）：LAB_AUDIT_ROLLOUT=2 → 记录好人侧每票的 rollout/S.decideVote 分歧（偏狼归因）；随 room 缓冲由 room-runner 回传
    const auditRollout = (process.env.LAB_AUDIT_ROLLOUT === '2' && ctx.campOf(bot) !== 'wolf') || process.env.LAB_AUDIT_ROLLOUT === '3'; // =3 → 含狼侧（分侧覆盖审计）
    if (auditRollout) { if (!room._rolloutAuditBuf) room._rolloutAuditBuf = []; room._rolloutAuditBuf.push({ day: room.day || 0, bot: bot.id }); }
    // 1.7.17（实验门控）：LAB_WOLF_NO_ROLLOUT=1 → 狼 bot 跳过 rollout（S.decideVote 纯策略）——偏狼归因对照：rollout 模拟好人投票对狼的增益是否偏狼根源
    const wolfNoRollout = process.env.LAB_WOLF_NO_ROLLOUT === '1' && ctx.campOf(bot) === 'wolf';
    // 1.7.17（D0）：VOTE_STRATEGY=pi-snap（默认生产）→ π 快照版（13 维，与 dv 决策等价 300/300 实证——性能 113×）；
    // VOTE_STRATEGY=pi → π 信念版（17 维，实验——60.2%<dv 63.2% 不上线）；未设 → 现有 rollout+S.decideVote 链
    // V5.2（VOTE_STRATEGY=pi-pure / pi-snap-pure）：纯 π 模式——不使用 dv 兜底，直接消费 π 输出。
    //   默认仍混合（π 与 dv 一致处用 π，分歧处用 dv）；纯模式仅用于自博弈/对抗训练评估，生产默认不启用。
    // π 与 dv 一致处用 π（快，0.21ms）；分歧处用 dv（准——BC 分歧处质量低于规则老师）；
    // 混合语义：质量= dv（大样本配对 0/300 不一致）、性能=部分加速；模型缺失 → fail-open 回退现有链
    // （归档：archive/v5-投票判定实验/README.md——rollout 好人侧 -12.4pp 退役、狼侧 +8.5pp 保留）
    const PI_MODES = ['pi', 'pi-snap', 'pi-pure', 'pi-snap-pure'];
    const strat = bot.voteStrategy || process.env.VOTE_STRATEGY || ''; // per-bot 策略池：bot.voteStrategy 覆盖全局 env
    const piMode = PI_MODES.includes(strat) && ctx.campOf(bot) !== 'wolf';
    const piUseSnap = strat === 'pi-snap' || strat === 'pi-snap-pure'; // 默认 pi-snap；'pi'/'pi-pure' 用信念版
    const piPure = strat === 'pi-pure' || strat === 'pi-snap-pure';
    const piRes = piMode ? S.piVote(room, bot.id, state, piUseSnap, ctx.rng(), bot.piModel || undefined) : null;
    if (piMode && piRes) {
      if (piPure) {
        resTarget = piRes.target; // V5.2 纯 π：直接采用 π 决策（允许分歧）
      } else {
        const dvT = S.decideVote(world, state, ctx.rng()).target;
        resTarget = piRes.target === dvT ? piRes.target : dvT; // 一致→π（快）；分歧→dv（准）
      }
      if (auditRollout) { const rec = room._rolloutAuditBuf[room._rolloutAuditBuf.length - 1]; if (rec && rec.bot === bot.id) { rec.pi = piRes.target; rec.piMargin = piRes.margin; rec.dv = piPure ? null : S.decideVote(world, state, ctx.rng()).target; rec.final = resTarget; rec.margin = null; rec.mix = piPure ? 'pi-pure' : (resTarget === piRes.target ? 'pi' : 'dv'); } }
    } else if (useRollout && !wolfNoRollout && !(world.faction === 'third' && process.env.THIRD_NO_ROLLOUT === '1')) {
      const rv = S.rolloutVote(world, state, ctx.rng(), { useValue: (bot.botLevel || 'easy') !== 'easy' }); // 1.8.0（人机三档）：普通/困难→V_wolf 价值前瞻；简单→解析版
      if (process.env.LAB_DEBUG_ROLLOUT === '1') console.log('[rollout-dbg] scores=' + JSON.stringify(Object.fromEntries(Object.entries(world.scores).map(([k, v]) => [k, +v.toFixed(2)]))) + ' rv=' + (rv && rv.target));
      // v1.7.2（4-①）：rollout 得分差距 <ε 时回退 S.decideVote 的跟票目标——低信息局（无查杀/票数接近）
      // 64 世界采样噪声大，rollout 可能与公众票型冲突 → 分票 → 狼渔利；跟票在低信息时是防分票的正确策略
      const dv = S.decideVote(world, state, ctx.rng()).target;
      resTarget = (rv && rv.margin >= 0.05 && rv.target) ? rv.target : dv; // 1.7.4：margin 相对化（0.05×W×scale；卖狼优先：margin=Infinity 恒过）
      if (auditRollout) {
        const rec = room._rolloutAuditBuf[room._rolloutAuditBuf.length - 1];
        if (rec && rec.bot === bot.id) { rec.rv = rv ? rv.target : null; rec.dv = dv; rec.final = resTarget; rec.margin = rv ? rv.margin : null; }
      }
    } else {
      resTarget = S.decideVote(world, state, ctx.rng()).target;
      if (auditRollout) { const rec = room._rolloutAuditBuf[room._rolloutAuditBuf.length - 1]; if (rec && rec.bot === bot.id) { rec.rv = null; rec.dv = resTarget; rec.final = resTarget; rec.margin = null; } }
    }
    let vote = resTarget ? ctx.byId(room, resTarget) : null;
    const lp = ctx.loverPartner(room, bot); // v1.6.3：狼恋人不投恋人（决策层之上）
    if (vote && lp && !lp.isWolf && vote.id === lp.id) vote = null;
    // 第三方（人狼恋狼恋人/丘比特）：不投自己阵营（恋人互知，规则内；v1.6.2）
    if (vote && world.faction === 'third' && ctx.factionOf(room, vote) === 'third') vote = null;
    // v1.6.4（A2-4）：低置信波动（simulate 证据更足通常更稳；被公开查杀目标不波动；卖狼不波动）
    if (vote) {
      const conf = S.confidenceOf(room, bot, vote.id); // 1.7.3（F2）：Platt 派生置信度优先
      if (vote.id !== world.sellTarget && !ctx.isCheckedTarget(room, vote) && conf < 0.55 && ctx.rng().next() < (0.55 - conf)) {
        // 1.7.3（F5）：波动有界（A5-2 定稿）——只允许偏移到候选分数 top3
        const ranked = state.map(id => ({ q: ctx.byId(room, id), s: world.scores[id] || 0.5 })).filter(x => x.q).sort((a, b) => b.s - a.s).slice(0, 3);
        const pool2 = ranked.map(x => x.q).filter(q => q.id !== vote.id && !(lp && !lp.isWolf && q.id === lp.id));
        const other = ctx.pick(pool2);
        if (other) vote = other;
      }
    }
    // v1.7.16：LAB_RANDOM_VOTE——随机策略池（鲁棒性矩阵数据，纯随机投票，生产禁用）
    if (process.env.LAB_RANDOM_VOTE === '1') {
      const pool = state.map(id => ctx.byId(room, id)).filter(q => q && q.alive && q.id !== bot.id && !(lp && !lp.isWolf && q.id === lp.id));
      if (pool.length) vote = ctx.pick(pool);
    }
    return { action: 'vote', data: { target: vote ? vote.id : null } };
  }

  // 夜晚行动（复用 smart，加风格微调）
  if (room.phase === 'night') {
    const smartResult = ctx.decisionSmart(room, bot);
    if (smartResult && smartResult.action === 'wolf_set' && smartResult.data.kill) {
      const target = ctx.byId(room, smartResult.data.kill);
      if (isWolf && wolfStyle === 'charge' && target && ctx.isWolfRole(target)) {
        const goodPool = ctx.aliveOthers(room, bot).filter(p => ctx.campOf(p) !== 'wolf');
        if (goodPool.length) {
          const newTarget = goodPool.sort((a, b) => ctx.wolfProb(room, bot, a.id) - ctx.wolfProb(room, bot, b.id))[0];
          smartResult.data.kill = newTarget.id;
        }
      }
    }
    return smartResult;
  }

  // 白天发言
  if (room.phase === 'discuss') {
    const talk = ctx.botTalk(room, bot, 'smart');
    if (talk) return talk;
    const pool = ctx.shuffle(ctx.aliveOthers(room, bot));
    if (!pool.length) return null;
    let target = null;
    if (!isWolf) {
      target = pool.reduce((a, p) => ctx.simulatedScoreV2(room, bot, p.id) > ctx.simulatedScoreV2(room, bot, a.id) ? p : a, pool[0]);
    } else {
      target = pool.reduce((a, p) => ctx.simulatedScoreV2(room, bot, p.id) < ctx.simulatedScoreV2(room, bot, a.id) ? p : a, pool[0]);
    }
    if (target) return { action: 'chat', data: { ch: 'all', text: `我觉得${target.name}值得关注，大家怎么看？` } };
    return null;
  }

  return ctx.decisionSmart(room, bot);
}


/* 1.7.0（B1-1②）：阶梯平移映射——easy←现smart、smart←现simulate、simulate←新simulate(+rollout) */
const LEVEL_MAP = { easy: 'smart', smart: 'simulate', simulate: 'simulate_v2' };
function createBotDecision(room, bot) {
  S.CUR_RNG = (room && room.rng) || global.rng; // 1.7.0（B1-8）：本决策随机流 = 房间 RNG（同步决策，无需恢复）
  // v1.7.8（β）：favens 模式——恋人/丘比特 bot 走神眷者路由（干预效应测量；conditionOn 抛错→回退普通策略+invalid 计数）
  if (process.env.FAVENS === '1' && room && room.players && bot && room.players.some(q => q.id === bot.id && (q.role === 'cupid' || (room.lovers && room.lovers.includes(bot.id))))) {
    try {
      const f = require('./favens/index.js');
      const d = f.favensDecide(room, bot);
      if (d) return d;
    } catch (e) {
      room.favensInvalid = (room.favensInvalid || 0) + 1; // invalid：剔除胜率统计，汇总上报
    }
  }
  const level = bot.botLevel || (room.settings.botMode === 'passive' ? 'idle' : 'easy');
  const eff = S.LEVEL_MAP[level] || level; // 1.7.0（B1-1②）：阶梯平移——easy←现smart、smart←现simulate、simulate←新simulate(+rollout)
  if (room.phase === 'reveal') {
    const rv = room.reveal;
    if (room.settings.thief && rv.stage === 'thiefPick' && rv.thiefId === bot.id && !rv.thiefPicked) {
      const wolfIdx = room.center.findIndex(k => k === 'wolf' || k === 'wolfBeauty'); // 有狼必选狼
      if (wolfIdx >= 0) return { action: 'thief_pick', data: { idx: wolfIdx } };
      // v1.5.2：无狼时偏向选神职（神职卡 > 平民）
      const GOD_IDX = ['seer', 'witch', 'guard', 'dreamer', 'hunter'].map(k => room.center.findIndex(c => c === k)).filter(i => i >= 0);
      return { action: 'thief_pick', data: { idx: GOD_IDX.length ? GOD_IDX[0] : ctx.randInt(2) } };
    }
    return { action: 'confirm', data: {} };
  }
  if (room.phase === 'lastword') return ctx.botLastWord(room, bot, level === 'idle' ? 'idle' : 'smart'); // 1.7.0：阶梯后 easy/smart/simulate 均按智能遗言
  if (room.phase === 'handover') return { action: 'handover', data: { target: null } }; // 人机警长默认撕毁警徽
  if (room.phase === 'sheriff_campaign') return { action: 'campaign', data: { run: level === 'idle' ? false : ctx.rng().next() < 0.5 } };
  if (room.phase === 'discuss') return (eff === 'simulate_v2' || eff === 'simulate') ? decisionSimulateV2(room, bot, true) : ctx.botTalk(room, bot, level === 'idle' ? 'idle' : 'smart'); // 1.8.0（人机三档）：简单（easy→botTalk 无价值前瞻）；普通（smart→rollout+V_wolf）；困难（simulate→rollout+V_wolf+v3）——普通/困难均启用 rollout 价值前瞻
  if (room.phase === 'night') {
    switch (room.nightStep) {
      case 'cupid': {
        // 1.8.x（神眷者训练）：首夜保持“不连自己”随机；情侣全灭后智能重选
        // （用信念重造人狼恋，不再挂机放弃重选）。
        const d = cupidPick.decideCupidPick(room, bot);
        return d || null;
      }
      case 'lovers': return { action: 'lovers_ok', data: {} };
      default: break;
    }
  }
  // 1.7.0（B1-1②）：阶梯分发——easy←现smart、smart←现simulate、simulate←新simulate(+rollout)
  if (eff === 'simulate_v2') return decisionSimulateV2(room, bot, true); // 新 simulate：态度模型 + rollout 规划层
  if (eff === 'simulate') return decisionSimulateV2(room, bot, false); // 新 smart：旧 simulate（态度模型）
  if (eff === 'smart') return ctx.decisionSmart(room, bot); // 新 easy：旧 smart（贝叶斯）
  if (eff === 'easy') return ctx.decisionEasy(room, bot); // 防御（映射后不达）
  return ctx.decisionIdle(room, bot);
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


module.exports = { decisionSimulateV2, createBotDecision, resetBotPerGame, injectGrudge };