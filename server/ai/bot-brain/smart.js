// bot-brain 拆分：smart 模块（普通档决策）
'use strict';
const shared = require('./shared');
const ctx = shared.ctx;
const register = shared.register;
const S = shared.S;
const wolfRollout = require('../../../wolfTrain/rollout.js'); // LAB_WOLF_ROLLOUT=1 启用 rollout-lite 夜刀精排

function decisionSmart(room, bot) {
  ctx.updateSmartMemory(room, bot);
  const mem = bot.botMemory;
  if (room.phase === 'night') {
    switch (room.nightStep) {
      case 'dreamer': {
        // v1.5.2：摄梦人保命策略——若认为下一夜会被刀（自己可信预言家/自称神职），梦狼概率最高者（试图带走一个狼）
        const pool = ctx.aliveOthers(room, bot);
        if (!pool.length) return null;
        const dClaims = mem.seerClaims || {};
        const myCred = (dClaims[bot.id] || {}).credibility || 0;
        const atRisk = myCred >= 0.6 || !!((mem.roleClaims || {})[bot.id]);
        if (atRisk) {
          let best = null, bestP = -Infinity;
          for (const p of pool) { const prob = ctx.wolfProb(room, bot, p.id); if (prob > bestP) { bestP = prob; best = p; } }
          return best ? { action: 'dreamer_pick', data: { target: best.id } } : null;
        }
        let lowest = null, lowP = Infinity;
        for (const p of ctx.shuffle(pool)) { const prob = ctx.wolfProb(room, bot, p.id); if (prob < lowP) { lowP = prob; lowest = p; } } // v1.6.2：同分随机（原第二分支被删后保留此行为）
        return lowest ? { action: 'dreamer_pick', data: { target: lowest.id } } : null;
      }
      case 'guard': {
        // v1.6.2：公平化——移除 campOf（真实阵营）过滤，守卫只基于发言声称与信念选目标
        const valid = ctx.shuffle(ctx.alivePlayers(room).filter(q => q.id !== room.guardLast));
        if (!valid.length) return { action: 'guard_pick', data: { target: bot.id } };
        // v1.5.2：优先守可信预言家/自称神职者（屠边保护神职），其次守狼概率最低者
        let target = null;
        const claims = mem.seerClaims || {};
        let bestCred = -Infinity;
        for (const pid of Object.keys(claims)) {
          const p = ctx.byId(room, pid);
          if (!p || !p.alive || p.id === bot.id || p.id === room.guardLast) continue;
          const cred = claims[pid].credibility || 0;
          if (cred > bestCred) { bestCred = cred; target = p; }
        }
        if (!target) {
          for (const pid of Object.keys(mem.roleClaims || {})) {
            const p = ctx.byId(room, pid);
            if (!p || !p.alive || p.id === bot.id || p.id === room.guardLast) continue;
            target = p; break;
          }
        }
        if (!target) {
          let lowest = Infinity;
          for (const p of valid) {
            const prob = ctx.wolfProb(room, bot, p.id);
            if (prob < lowest) { lowest = prob; target = p; }
          }
        }
        if (target) { if (!bot.botMemory.guarded) bot.botMemory.guarded = {}; bot.botMemory.guarded[target.id] = true; } // v1.4.3：记住守人
        return { action: 'guard_pick', data: { target: target.id } };
      }
      case 'wolf': {
        const humans = room.players.some(q => q.alive && ctx.isWolfRole(q) && !q.isBot);
        if (humans) return { action: 'wolf_set', data: { confirm: true } };
        const data = { confirm: true };
        if (!room.night.wolf.kill) {
          // v1.6.2：公平化——狼只避狼队友（campOf），不再避让恋人（factionOf 依赖真实情侣关系，属全知）
          // v1.6.3：狼恋人不刀/不魅惑恋人（恋人互知，规则内）
          const lp = ctx.loverPartner(room, bot);
          const enemies = ctx.aliveOthers(room, bot).filter(q => ctx.campOf(q) !== 'wolf' && (!lp || lp.isWolf || q.id !== lp.id));
          // 优先刀高可信预言家（狼视角真相校准过）
          const claims = mem.seerClaims || {};
          let target = null, bestCred = -Infinity;
          for (const pid of Object.keys(claims)) {
            const p = ctx.byId(room, pid);
            if (!p || !p.alive || ctx.campOf(p) === 'wolf' || (lp && !lp.isWolf && p.id === lp.id)) continue;
            const cred = claims[pid].credibility || 0;
            if (cred > bestCred) { bestCred = cred; target = p; }
          }
          // v1.5.1：其次刀自称神职者（守卫/女巫/猎人穿衣服）
          if (!target) {
            for (const pid of Object.keys(mem.roleClaims || {})) {
              const p = ctx.byId(room, pid);
              if (!p || !p.alive || ctx.campOf(p) === 'wolf' || (lp && !lp.isWolf && p.id === lp.id)) continue;
              target = p; break;
            }
          }
          if (!target) {
            const world = ctx.buildVoteWorld(room, bot);
            if (ctx.factionOf(room, bot) === 'third') {
              // v1.7.6：第三方狼恋人夜刀——永不刀狼（狼队自爆红线）；刀好人神职（价值序），enemies 已排除队友+恋人
              const val = { '女巫': 5, '预言家': 4, '猎人': 3, '守卫': 2, '摄梦人': 1 };
              const claims = world.roleClaims || {};
              const pool = enemies.filter(q => ctx.factionOf(room, q) !== 'third');
              // 1.8.x（终局连锁）：只剩 2 个非神眷者且一神一民时，优先刀自称猎人者，
              // 期望猎人开枪带走最后一个非神眷者，使神眷者在一夜内同时清场获胜。
              const nGod = world.nonThirdGodAlive || 0;
              const nVill = world.nonThirdVillAlive || 0;
              const nWolf = world.nonThirdWolfAlive || 0;
              if ((nGod + nVill + nWolf) === 2 && nGod > 0 && nVill > 0) {
                const hunter = pool.find(q => claims[q.id] === '猎人');
                if (hunter) { target = hunter; }
              }
              let t2 = null, bestV = -1;
              if (!target) {
                for (const q of pool) { const r = claims[q.id]; if (r && (val[r] || 0) > bestV) { bestV = val[r] || 0; t2 = q; } }
                if (!t2 && pool.length) t2 = pool.slice().sort((a, b) => (world.scores[a.id] || 0.5) - (world.scores[b.id] || 0.5))[0];
                target = t2;
              }
            } else {
              // v1.7.7（α3）：刀神分类器优先（fail-open）；enemies 已排除队友+恋人
              // V5.2 A 线：若启用 wolf-win 胜率模型，优先用“刀后狼胜概率”决策；否则回退刀神分类器
              const wm = ctx.loadWolfGodModel();
              let t2 = null;
              const wwin = ctx.loadWolfWinModel();
              if (wwin) t2 = ctx.byId(room, S.wolfWinDecide(ctx.buildWolfKillWorld(room, bot), wwin));
              if (!t2 && wm) t2 = ctx.byId(room, S.wolfKillDecide(ctx.buildWolfKillWorld(room, bot), wm, { killPriority: { '女巫': 5, '预言家': 4, '猎人': 3, '守卫': 2, '摄梦人': 1 } }));
              if (!t2) { const nk = S.decideNightKill(world, enemies.map(p => p.id), ctx.rng()); t2 = nk.target ? ctx.byId(room, nk.target) : null; }
              // LAB_WOLF_ROLLOUT=1：夜刀 rollout 精排（默认关，不影响生产）
              //   LAB_WOLF_ROLLOUT_FULL=1 → 完整刀后世界模拟；否则用 rollout-lite（历史实验）
              if (process.env.LAB_WOLF_ROLLOUT === '1' && enemies.length) {
                const cands = enemies.slice(0, 5).map(p => p.id);
                const simFn = process.env.LAB_WOLF_ROLLOUT_FULL === '1' ? wolfRollout.simulateWolfKillFull : wolfRollout.simulateWolfKillLite;
                const ranked = wolfRollout.rolloutNightKillSync(world, cands, simFn, { n: 8, rng: ctx.rng() });
                if (ranked.length) { const best = ctx.byId(room, ranked[0].pid); if (best) target = best; }
              } else {
                target = t2;
              }
              // LAB_WOLF_EPS：狼刀 ε-探索（自博弈数据采集用，默认关）
              if (process.env.LAB_WOLF_EPS && enemies.length) {
                const eps = parseFloat(process.env.LAB_WOLF_EPS || '0');
                if (eps > 0 && ctx.rng().next() < eps) target = ctx.pick(enemies);
              }
            }
            if (!target) target = lp && !lp.isWolf ? null : ctx.pick(ctx.aliveOthers(room, bot));
          }
          data.kill = target ? target.id : null;
          const beauty = ctx.alivePlayers(room).find(q => ctx.effRole(q) === 'wolfBeauty');
          if (beauty && !room.night.wolf.charm) {
            // v1.4.3 魅惑策略：优先魅惑高可信预言家（放逐可带走神职），其次最可信好人
            let charmTarget = null, bestCred = -Infinity;
            for (const pid of Object.keys(claims)) {
              const cp = ctx.byId(room, pid);
              if (!cp || !cp.alive || ctx.campOf(cp) === 'wolf' || cp.id === (target && target.id) || (lp && !lp.isWolf && cp.id === lp.id)) continue; // v1.6.2：移除 factionOf 全知
              const cred = claims[pid].credibility || 0;
              if (cred > bestCred) { bestCred = cred; charmTarget = cp; }
            }
            if (!charmTarget) {
              const charmPool = ctx.shuffle(ctx.aliveOthers(room, bot).filter(q => ctx.campOf(q) !== 'wolf' && q.id !== (target && target.id) && (!lp || lp.isWolf || q.id !== lp.id))); // v1.6.2：移除 factionOf 全知
              if (charmPool.length) charmTarget = charmPool.sort((a, b) => ctx.wolfProb(room, bot, a.id) - ctx.wolfProb(room, bot, b.id))[0];
            }
            if (charmTarget) data.charm = charmTarget.id;
            if (data.charm) { if (!room.wolfPackMemory) room.wolfPackMemory = {}; room.wolfPackMemory.charmTarget = data.charm; } // v1.5.2：狼队共享魅惑目标（卖狼美人）
          }
        }
        // 1.8.x（神眷者训练）：狼恋人发现狼队已选自己的好恋人时，强制改刀到安全目标（恋人互知，规则内）
        const lp2 = ctx.loverPartner(room, bot);
        if (lp2 && !lp2.isWolf && room.night.wolf.kill === lp2.id) {
          const safe = ctx.aliveOthers(room, bot).filter(q => ctx.campOf(q) !== 'wolf' && q.id !== lp2.id);
          data.kill = safe.length ? ctx.pick(safe).id : null;
        }
        return { action: 'wolf_set', data };
      }
      case 'seer': {
        // v1.4.3：优先查验对跳者（声称过预言家且未查过），其次查狼概率最高
        const pool = ctx.shuffle(ctx.aliveOthers(room, bot).filter(q => !(room.seerHistory || []).some(h => h.target === q.id)));
        if (!pool.length) return null;
        const claimers = pool.filter(q => (mem.seerClaims || {})[q.id] && (mem.seerClaims[q.id].claims || []).length);
        const target = claimers.length
          ? ctx.pick(claimers)
          : pool.reduce((a, p) => (ctx.wolfProb(room, bot, p.id) > ctx.wolfProb(room, bot, a.id) ? p : a), pool[0]);
        return { action: 'seer_pick', data: { target: target.id } };
      }
      case 'witch': {
        const attacked = room.night.wolf.kill;
        // v1.5.1：自己/恋人被刀必救（恋人死=自己殉情）；否则狼概率高不救
        const isLover = (room.lovers || []).includes(bot.id) && (room.lovers || []).includes(attacked);
        const save = !room.witchPots.saveUsed && !!attacked && (isLover || ctx.wolfProb(room, bot, attacked) < 0.4);
        if (save) bot.botMemory.silverWater = attacked; // v1.4.3：记住银水（后续作为好人证据）
        let poison = null;
        if (!save && !room.witchPots.poisonUsed && room.nightNum >= 2) {
          let best = null, bestProb = -Infinity;
          for (const p of ctx.shuffle(ctx.aliveOthers(room, bot))) {
            if (p.id === bot.id) continue; // v1.6.2：公平化——女巫不知第三方，仅排除自己
            const prob = ctx.wolfProb(room, bot, p.id);
            if (prob > bestProb) { bestProb = prob; best = p; }
          }
          poison = best ? best.id : null;
        }
        return { action: 'witch_act', data: { save, poison } };
      }
      case 'hunter': { const t = ctx.pick(ctx.aliveOthers(room, bot)); return { action: 'hunter_shoot', data: { target: t ? t.id : null } }; }
      default: return null;
    }
  }
  if (room.phase === 'sheriff_vote') {
    // 1.7.0（B1-1）：S.decideVote——竞选投票只能投竞选者（state=candidates），阵营分流（好人 argmax / 狼 argmin 排除队友）
    const world = ctx.buildVoteWorld(room, bot);
    const res = S.decideVote(world, room.candidates || [], ctx.rng());
    return { action: 'vote', data: { target: res.target } };
  }
  if (room.phase === 'vote') {
    // 1.7.0（B1-1）：纯策略 S.decideVote（卖狼/跟票/阵营分流）；恋人保护 + A2-4 波动在决策层之上
    const world = ctx.buildVoteWorld(room, bot);
    let target = S.decideVote(world, ctx.aliveOthers(room, bot).map(p => p.id), ctx.rng()).target;
    const lp = ctx.loverPartner(room, bot);
    if (target && lp && !lp.isWolf && target === lp.id) target = null;
    // v1.6.4（A2-4）：低置信波动（smart 信息多通常置信高，波动小；被公开查杀目标不波动；卖狼=明确策略不波动）
    if (target) {
      const conf = S.confidenceOf(room, bot, target); // 1.7.3（F2）：Platt 派生置信度优先
      if (process.env.LAB_NO_CHAOS !== '1' && target !== world.sellTarget && !ctx.isCheckedTarget(room, ctx.byId(room, target)) && conf < 0.55 && ctx.rng().next() < (0.55 - conf)) {
        // 1.7.3（F5）：波动有界（A5-2 定稿）——只允许偏移到分数 top3；C1-5② 狼不因上头投狼队友
        const ranked = ctx.aliveOthers(room, bot).map(q => ({ q, s: world.scores[q.id] || 0.5 })).sort((a, b) => b.s - a.s).slice(0, 3);
        const pool = ranked.map(x => x.q).filter(q => q.id !== target && !(lp && !lp.isWolf && q.id === lp.id) && !(ctx.campOf(bot) === 'wolf' && ctx.campOf(q) === 'wolf'));
        const other = ctx.pick(pool);
        if (other) target = other.id;
      }
    }
    return { action: 'vote', data: { target } };
  }
  if (room.phase === 'pk_vote') {
    const world = ctx.buildVoteWorld(room, bot);
    const res = S.decideVote(world, [...(room.pkTied || [])], ctx.rng());
    const lp = ctx.loverPartner(room, bot);
    const target = res.target && lp && !lp.isWolf && res.target === lp.id ? null : res.target;
    return { action: 'vote', data: { target } };
  }
  if (room.phase === 'hunter_shot') return { action: 'hunter_shoot', data: { target: ctx.smartVoteTarget(room, bot) } };
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

module.exports = { decisionSmart };