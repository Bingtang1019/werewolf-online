// bot-brain 拆分：talk 模块（发言生成）
'use strict';
const shared = require('./shared');
const ctx = shared.ctx;
const register = shared.register;
const S = shared.S;

function genPhrase(intent, params) {
  const tpl = S.LEXICON.intents[intent];
  if (!tpl) return null;
  const parts = [ctx.pick(tpl.prefixes || ['']), ctx.pick(tpl.cores || ['']), ctx.pick(tpl.suffixes || [''])]
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
    .map(id => ctx.byId(room, id)).filter(Boolean);
}
/* 施压目标：smart 用狼概率，easy 用关键词嫌疑 */
function pressureTarget(room, bot, level, threshold) {
  const mem = bot.botMemory || {};
  if (level === 'smart') {
    const t = ctx.smartVoteTarget(room, bot);
    return t && ctx.wolfProb(room, bot, t) > threshold ? t : null;
  }
  const top = Object.keys(mem.suspicion || {}).map(id => ({ id, s: mem.suspicion[id] }))
    .filter(x => x.s > 30).sort((a, b) => b.s - a.s)[0];
  return top ? ctx.byId(room, top.id) : null;
}

/* C1-2 犹豫：信念越散（suspicion 分布越均匀）越容易说“我再想想/不好说” */
function beliefEntropy(room, bot, mem) {
  const scores = ctx.aliveOthers(room, bot).map(p => Math.max(0, (mem.suspicion || {})[p.id] || 0));
  const total = scores.reduce((a, b) => a + b, 0);
  if (total <= 0 || scores.length <= 1) return 1;
  const ps = scores.map(s => s / total);
  let e = 0;
  for (const p of ps) if (p > 0) e -= p * Math.log(p);
  return e / Math.log(scores.length);
}

/* 白天发言：每人每天至多 2 条（0=主发言，1=次发言：回应/辩论/气氛） */
function botTalk(room, bot, level) {
  if (level === 'idle') return null;
  const mem = ctx.ensureMemory(bot);
  if (level === 'smart') ctx.updateSmartMemory(room, bot); // 发言前先刷新推理（含狼队共享/对跳存疑）
  else ctx.updateEasyMemory(room, bot);
  const myRole = ctx.effRole(bot);
  const isWolf = ctx.campOf(bot) === 'wolf';
  const lp = ctx.loverPartner(room, bot); // v1.6.3：狼恋人保护/辩护
  const count = talkedCount(room, bot);
  const chat = (text, claim) => text ? { action: 'chat', data: { ch: 'all', text, claim: claim || null } } : null; // 1.7.17（V5.1）：结构化声明（查杀/金水/跳身份）随发言标记

  /* ===== 主发言（第 1 条） ===== */
  if (count === 0) {
    // 预言家：报真实查验（v1.6.4（A2-3）：easy 档预言家也补报查验，不再“p 都不放一个”）
    if (myRole === 'seer' && (level === 'smart' || level === 'easy')) {
      const h = (room.seerHistory || []).filter(x => x.night >= 1);
      if (h.length) {
        const last = h[h.length - 1];
        const nm = ctx.nameById(room, last.target);
        if (nm !== '未知') return chat(ctx.pick([
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
        return chat(ctx.pick([
          '别信查杀' + ctx.nameById(room, lp.id) + '的话，我了解' + ctx.nameById(room, lp.id) + '，不是狼',
          ctx.nameById(room, lp.id) + '是好人，查杀他的人才是狼，你们品品',
        ]));
      }
      if (loverSusp && ctx.rng().next() < 0.6) {
        return chat(ctx.pick([
          '先别怀疑' + ctx.nameById(room, lp.id) + '，他今天的发言没什么问题',
          '我保' + ctx.nameById(room, lp.id) + '，不是狼，出他浪费轮次',
        ]));
      }
    }
    // 狼：悍跳预言家（每队只跳一次），查杀最可信好人施压
    if (level === 'smart' && isWolf) {
      if (!room.wolfPackMemory) room.wolfPackMemory = {};
      if (!room.wolfPackMemory.talkedClaim) {
        const pool = ctx.shuffle(ctx.aliveOthers(room, bot).filter(q => ctx.campOf(q) !== 'wolf' && (!lp || lp.isWolf || q.id !== lp.id))); // v1.6.3：狼恋人不悍跳查杀恋人
        if (pool.length) {
          const t = pool.sort((a, b) => ctx.wolfProb(room, bot, a.id) - ctx.wolfProb(room, bot, b.id))[0];
          room.wolfPackMemory.talkedClaim = true;
          return chat(genPhrase('wolf_fake_seer', { name: t.name }) || '我是预言家，昨晚查验了' + t.name + '：查杀', { type: 'check_wolf', target: t.id }); // v1.6.4（A2-5）：组合式生成；V5.1：结构化声明（狼悍跳=假查杀）
        }
      }
      // v1.7.7（S3）：穿衣服概率——默认0（生产安全：六人局已平衡52.4%，穿衣服0.25会打崩）；
      // 仅平衡/α/β 测试时经 env 显式开启（狼美局实测 0.25 → 狼49.6%；favens 的 wolfLover 复用同一分支继承该参数）
      const claimGodP = process.env.WOLF_CLAIM_GOD != null ? parseFloat(process.env.WOLF_CLAIM_GOD) : 0; // v1.7.7（S3）：默认0（生产安全——按配置显式开启，见上方注释）
      if (isWolf && ctx.rng().next() < claimGodP) {
        return chat(ctx.pick(['我是守卫，昨晚守了自己', '我是女巫，药还没用，别急着出我', '我是猎人，开枪前一换一，别惹我']));
      }
      // v1.5.2：狼美人魅惑高价值目标时威胁自曝（配合卖狼美人）
      if (myRole === 'wolfBeauty') {
        const pack = room.wolfPackMemory || {};
        const ct = pack.charmTarget ? ctx.byId(room, pack.charmTarget) : null;
        if (ct && ct.alive && ctx.rng().next() < 0.6) return chat('我是狼美人，魅惑了' + ct.name + '，投我他就得死 💘');
      }
      return null;
    }
    // 女巫：报银水（只报一次）
    if (level === 'smart' && myRole === 'witch' && mem.silverWater && !mem.silverReported) {
      mem.silverReported = true;
      const nm = ctx.nameById(room, mem.silverWater);
      return nm === '未知' ? null : chat(ctx.pick([
        '我是女巫，昨晚用解药救下' + nm + '，他是我银水',
        '银水是' + nm + '，大家别动他，我女巫',
        '我女巫，昨晚救了' + nm + '，解药已经没了',
      ]));
    }
    // 守卫：报守人（模糊不暴露细节）
    if (level === 'smart' && myRole === 'guard' && mem.guarded) {
      return chat(ctx.pick([
        '我是守卫，昨晚守了人，具体是谁不说，免得狼来刀',
        '我守卫，昨晚守的自己，狼今晚可以试试',
        '守卫在此，我守人不说细节，狼别来刀神职',
      ]));
    }
    // v1.5.2：猎人/摄梦人/丘比特亮身份（概率）
    if (level === 'smart' && myRole === 'hunter') {
      if (ctx.rng().next() < 0.7) return chat(ctx.pick([
        '我是猎人，枪已上膛，谁跳得最凶我带走谁 🔫',
        '猎人牌，别逼我带人',
      ]));
    }
    if (level === 'smart' && myRole === 'dreamer') {
      if (ctx.rng().next() < 0.6) return chat(ctx.pick([
        '我是摄梦人，梦里的狼别想跑 😴',
        '摄梦人在此，今夜梦谁看表现',
      ]));
    }
    if (level === 'smart' && myRole === 'cupid') {
      if (ctx.factionOf(room, bot) === 'third') {
        // v1.7.6（P3）：第三方丘比特信息战——带节奏指向自称高价值神职者（不暴露第三方）；不亮“我是丘比特”
        const claims = {};
        for (const m of room.messages) if (m.ch === 'all' && m.from && m.text) { const mm = m.text.match(/我是(女巫|预言家|猎人|守卫|摄梦人)/); if (mm && !claims[m.from]) claims[m.from] = mm[1]; }
        const val = { '女巫': 5, '预言家': 4, '猎人': 3, '守卫': 2, '摄梦人': 1 };
        let t2 = null, bestV = -1;
        for (const id of Object.keys(claims)) { const p = ctx.byId(room, id); if (p && p.alive && (val[claims[id]] || 0) > bestV) { bestV = val[claims[id]] || 0; t2 = p; } }
        if (t2) return chat(ctx.pick(['我觉得' + t2.name + '发言很怪，像狼', '今天先出' + t2.name + '吧，它嫌疑最大']));
        const counts = {};
        for (const k of Object.keys(room.votes || {})) { const tv = room.votes[k]; if (tv) counts[tv] = (counts[tv] || 0) + 1; }
        let lead = null, leadN = 0;
        for (const k of Object.keys(counts)) if (counts[k] > leadN) { leadN = counts[k]; lead = k; }
        if (lead) { const p2 = ctx.byId(room, lead); if (p2) return chat(ctx.pick(['' + p2.name + '的票有点多了，大家都跟？', '先别急着出' + p2.name + '，再听听'])); }
        return chat(ctx.pick(['我今天没头绪，先看投票', '今晚的线索不多，明天再盘']));
      }
      if (ctx.rng().next() < 0.5) return chat(ctx.pick([
        '我是丘比特，情侣是谁我就不说了 💘',
        '丘比特在此，别乱投我，情侣是好人组合',
      ]));
    }
    // v1.6.3：狼恋人为恋人辩护（恋人互知，规则内）——减少全场的怀疑
    if (isWolf && lp && !lp.isWolf) {
      const loverChecked = Object.keys(mem.seerClaims || {}).some(pid => pid !== bot.id && (mem.seerClaims[pid].claims || []).some(c => c.result === 'wolf' && c.target === lp.id));
      const loverSusp = (mem.suspicion || {})[lp.id] > 30 || Object.keys(mem.seerClaims || {}).some(pid => pid !== bot.id && (mem.seerClaims[pid].claims || []).some(c => c.target === lp.id));
      if (loverChecked && level === 'smart') {
        return chat(ctx.pick([
          '别信查杀' + ctx.nameById(room, lp.id) + '的话，我了解' + ctx.nameById(room, lp.id) + '，不是狼',
          ctx.nameById(room, lp.id) + '是好人，查杀他的人才是狼，你们品品',
        ]));
      }
      if (loverSusp && ctx.rng().next() < 0.6) {
        return chat(ctx.pick([
          '先别怀疑' + ctx.nameById(room, lp.id) + '，他今天的发言没什么问题',
          '我保' + ctx.nameById(room, lp.id) + '，不是狼，出他浪费轮次',
        ]));
      }
    }
    // C1-2：犹豫（信念熵高时，先不急着站边）
    if (ctx.rng().next() < 0.2 && beliefEntropy(room, bot, mem) > 0.8) {
      return chat(ctx.pick(['我再想想…', '不好说，信息太少了', '先听你们聊，我理理思路']));
    }
    // v1.6.4（A2-3）：平民/无实权角色也不沉默——表态/质疑（easy 低概率、smart 中概率；有嫌疑对象优先）
    if ((level === 'smart' && ctx.rng().next() < 0.5) || (level === 'easy' && ctx.rng().next() < 0.25)) {
      const pool = ctx.aliveOthers(room, bot).filter(q => (mem.suspicion || {})[q.id] > 0);
      if (pool.length) {
        const suspect = ctx.pick(pool);
        return chat(genPhrase('accusation', { name: suspect.name }) || '我觉得' + suspect.name + '值得关注');
      }
      const anyone = ctx.pick(ctx.aliveOthers(room, bot));
      return chat(genPhrase('flavor_action', { name: anyone ? anyone.name : '' }) || ctx.pick(S.TALK_FLAVOR));
    }
    // 施压：有高嫌疑对象时表态（狼恋人不施压恋人；v1.6.4（A2-5）组合式生成）
    const pt = pressureTarget(room, bot, level, level === 'smart' ? 0.5 : 0);
    if (pt && !(lp && !lp.isWolf && pt.id === lp.id)) return chat(genPhrase('pressure', { name: pt.name }) || ctx.pick(S.TALK_PRESSURE).split('{name}').join(pt.name));
    // 气氛：无实质话题时随机闲聊（smart 概率高，easy 低；v1.6.4（A2-5）组合式生成）
    if ((level === 'smart' && ctx.rng().next() < 0.6) || (level === 'easy' && ctx.rng().next() < 0.3)) {
      return chat(genPhrase('flavor') || ctx.pick(S.TALK_FLAVOR));
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
  if (wasVoted && ctx.rng().next() < 0.8) {
    return chat(genPhrase('defend_self', { name: ctx.nameById(room, bot.id) }) || '我是好人，别投我，浪费轮次');
  }
  // 2. 对跳辩论（有对跳者时）
  if (level === 'smart' && claimers.length) {
    if (myRole === 'seer') return chat(ctx.pick(S.TALK_DEBATE_SEER).split('{name}').join(claimers[0].name));
    if (isWolf) {
      // v1.7.7（S3）：对跳概率参数（WOLF_COUNTER_SEER，默认1=现状必跳；网格搜索设0.3/0.6/0.9）
      const counterSeerP = process.env.WOLF_COUNTER_SEER != null ? Math.min(1, Math.max(0, parseFloat(process.env.WOLF_COUNTER_SEER))) : 1;
      if (ctx.rng().next() < counterSeerP) {
        const cc = (claimers.find(c => !(lp && !lp.isWolf && c.id === lp.id)) || claimers[0]); // v1.6.3：狼恋人不踩恋人
        return chat(ctx.pick(S.TALK_DEBATE_WOLF).split('{name}').join(cc.name));
      }
    }
  }
  // 3. 施压跟票（v1.6.3：狼恋人不施压恋人；v1.6.4（A2-5）组合式生成）
  const pt2 = pressureTarget(room, bot, level, 0.45);
  if (pt2 && !(lp && !lp.isWolf && pt2.id === lp.id)) return chat(genPhrase('pressure', { name: pt2.name }) || '今天先出' + pt2.name + '吧，别磨叽了');
  // 4. 气氛插科打诨（小概率；v1.6.4（A2-5）组合式生成）
  if (ctx.rng().next() < 0.4) return chat(genPhrase('flavor') || ctx.pick(S.TALK_FLAVOR));
  return null;
}

/* 遗言（lastword 阶段）：smart 有信息量，easy 简短，idle 沉默 */
function botLastWord(room, bot, level) {
  if (level === 'idle') return { action: 'skip', data: {} };
  const mem = ctx.ensureMemory(bot);
  const myRole = ctx.effRole(bot);
  const isWolf = ctx.campOf(bot) === 'wolf';
  if (level === 'smart') {
    const last = (room.seerHistory || []).filter(x => x.night >= 1).slice(-1)[0];
    if (myRole === 'seer' && last) {
      const nm = ctx.nameById(room, last.target);
      if (nm !== '未知') return { action: 'post', data: { text: '我是预言家，昨夜查了' + nm + '：' + (last.result === 'wolf' ? '查杀' : '金水') + '，大家务必出他', claim: { type: last.result === 'wolf' ? 'check_wolf' : 'check_good', target: last.target, night: last.night } } }; // V5.1：结构化声明（真实查验结果）
    }
    if (myRole === 'guard' && mem.guarded) return { action: 'post', data: { text: '我是守卫，守人记录在我脑子里，按我之前的判断走' } };
    if (myRole === 'witch') return { action: 'post', data: { text: '我是女巫，解药已经用了，毒药还在，你们加油' } };
    if (myRole === 'hunter') return { action: 'post', data: { text: '我是猎人，下一枪指哪打哪，狼自己掂量' } };
    if (isWolf) {
      const lp = ctx.loverPartner(room, bot); // v1.6.3：狼恋人遗言为恋人辩护
      if (lp && !lp.isWolf && ctx.rng().next() < 0.6) return { action: 'post', data: { text: '我走了，最后说一句：' + ctx.nameById(room, lp.id) + '不是狼，别让他被冤枉' } };
      return { action: 'post', data: { text: ctx.pick(['我是平民，被刀真惨，大家加油', '我是平民，别捞我，先出跳得最凶的']) } };
    }
    const sus = pressureTarget(room, bot, 'smart', 0.4);
    const nm = sus ? sus.name : '跳得最凶的';
    if (ctx.rng().next() < 0.7) return { action: 'post', data: { text: genPhrase('lastword_good', { name: nm }) || ctx.pick(S.TALK_LAST_PLAIN).split('{name}').join(nm) } }; // v1.6.4（A2-5）
  } else if (level === 'easy' && ctx.rng().next() < 0.5) {
    return { action: 'post', data: { text: ctx.pick(['我是平民，大家加油', '别捞我，不亏']) } };
  }
  return { action: 'skip', data: {} };
}

/* 狼人夜晚狼频道发言：每狼每晚至多一条（配合出刀，营造狼队互动）
 * v1.6.3：狼恋人在狼频道引导——不刀恋人（狼队已选恋人时劝阻改刀） */
function botWolfChat(room, bot) {
  const level = bot.botLevel || (room.settings.botMode === 'passive' ? 'idle' : 'easy');
  if (level === 'idle') return null;
  const mem = ctx.ensureMemory(bot);
  if (mem.wolfChatNight === room.nightNum) return null;
  mem.wolfChatNight = room.nightNum;
  if (level === 'smart') ctx.updateSmartMemory(room, bot);
  const lp = ctx.loverPartner(room, bot); // v1.6.3
  const target = ctx.smartVoteTarget(room, bot);
  let text;
  // 狼队当前刀目标已是恋人 → 紧急劝阻并建议改刀
  if (lp && !lp.isWolf && room.night.wolf.kill === lp.id) {
    const other = ctx.aliveOthers(room, bot).find(q => q.id !== lp.id && ctx.campOf(q) !== 'wolf');
    text = other
      ? '先别刀' + ctx.nameById(room, lp.id) + '，留着他钓大鱼，今晚刀' + other.name + '吧'
      : '先别刀' + ctx.nameById(room, lp.id) + '，我感觉他不是神职，刀别人更赚';
    return { action: 'chat', data: { ch: 'wolf', text } };
  }
  const t2 = (target && lp && !lp.isWolf && target === lp.id) ? null : target; // 引导目标避免恋人
  if (level === 'smart' && ctx.rng().next() < 0.7) {
    const claims = bot.botMemory.seerClaims || {};
    let best = null, bestCred = -Infinity;
    for (const pid of Object.keys(claims)) {
      const p = ctx.byId(room, pid);
      if (!p || !p.alive || ctx.campOf(p) === 'wolf' || (lp && !lp.isWolf && p.id === lp.id)) continue;
      const cred = claims[pid].credibility || 0;
      if (cred > bestCred) { bestCred = cred; best = p; }
    }
    text = best ? '今晚刀' + best.name + '，他跳预言家太像真的了' : (t2 ? genPhrase('wolf_night_talk', { name: ctx.nameById(room, t2) }) || '刀' + ctx.nameById(room, t2) + '吧，发言太像神职' : '先刀预言家，稳赚不亏');
  } else {
    text = genPhrase('wolf_night_talk', { name: t2 ? ctx.nameById(room, t2) : '预言家' }) || ctx.pick(S.TALK_WOLF_NIGHT).split('{name}').join(t2 ? ctx.nameById(room, t2) : '预言家');
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


module.exports = { genPhrase, talkedCount, isCheckedWolf, counterClaimers, pressureTarget, botTalk, botLastWord, botWolfChat };