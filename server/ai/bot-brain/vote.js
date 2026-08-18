// bot-brain 拆分：vote 模块（投票/查验/表态）
'use strict';
const shared = require('./shared');
const ctx = shared.ctx;
const register = shared.register;
const S = shared.S;

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
  if (ctx.factionOf(room, bot) !== 'wolf') return null; // v1.6.1：第三方狼美人（人狼恋）不进入卖狼逻辑
  const pack = room.wolfPackMemory || {};
  if (!pack.charmTarget) return null;
  const lp = ctx.loverPartner(room, bot); // v1.6.3：狼恋人不卖狼美人——魅惑目标是恋人时卖狼会带走恋人
  if (lp && !lp.isWolf && pack.charmTarget === lp.id) return null;
  const wb = room.players.find(p => p.alive && p.isBot && ctx.effRole(p) === 'wolfBeauty' && ctx.campOf(p) === 'wolf');
  if (!wb || wb.id === bot.id) return null;
  const target = ctx.byId(room, pack.charmTarget);
  if (!target || !target.alive) return null;
  const claims = bot.botMemory.seerClaims || {};
  const cred = claims[target.id] ? (claims[target.id].credibility || 0) : 0;
  if (cred < 0.6 && !((bot.botMemory.roleClaims || {})[target.id])) return null; // 魅惑目标非高价值不卖
  const wolfCount = room.players.filter(p => p.alive && ctx.campOf(p) === 'wolf').length;
  if (wolfCount < 2) return null; // 狼少不卖
  return wb.id;
}
/* 1.7.0（B1-1）：构造纯策略 world——只含公开信息 + bot 自己信念（B1-7 纪律①②：绝不读真实身份）；三档共用，B1-5 rollout 同源 */
/* 1.7.16：adaboost 校准层（isotonic）——漂移修复（排序保留、校准桶修正），fail-open（表缺失→原 mp）
 * 表：models/adaboost-vote-v1-iso.json（PAVA 保序阶梯，完整精度；查询=二分"最后一个 pMin≤p"右连续 + 间隙线性插值） */
let _voteIso = null, _voteIsoTried = false;
function isoVote(p) {
  // v1.7.16：LAB_NO_ISO——v1 原始池（漂移态 adaboost，鲁棒性矩阵用；生产不设）
  if (process.env.LAB_NO_ISO === '1') return null;
  try {
    if (!_voteIsoTried) {
      _voteIsoTried = true;
      const raw = JSON.parse(S.fs.readFileSync(S.path.join(__dirname, 'models', 'adaboost-vote-v1-iso.json'), 'utf8'));
      if (raw && Array.isArray(raw.table) && raw.table.length) S._voteIso = raw.table;
    }
    if (!S._voteIso || !S._voteIso.length || typeof p !== 'number' || !isFinite(p)) return null;
    const table = S._voteIso;
    let lo = 0, hi = table.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (table[mid].pMin <= p) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    if (ans < 0) return table[0].cal;
    if (p <= table[ans].pMax) return table[ans].cal;
    if (ans + 1 < table.length) { const a = table[ans], b = table[ans + 1]; return a.cal + (p - a.pMax) / (b.pMin - a.pMax) * (b.cal - a.cal); }
    return table[ans].cal;
  } catch (e) { return null; }
}
/* 1.7.18（vote-v3）：25 维特征——13 快照 + 12 信念（与 tools/ai/build-vote-v3-samples.js extractV3Features 同源，A-2 纪律）
 * 索引：13=bel_posterior 14=bel_cred_cand 15=bel_cred_voter 16=bel_vote_share 17=death_infer 18=check_verified
 *       19=claim_suspect 20=vote_lead_order 21=follow_strength 22=seer_check 23=wolf_kill_survivor 24=cred_derived
 * 无引擎时返回中性特征（fail-open——v3 模型退化但不崩） */
function beliefFeatures25(room, botId, candId) {
  const base = (process.env.LAB_VS !== '0' && room._vs) ? S.voteFeatures13(room._vs.base, botId, candId) : S.voteFeatures(room, botId, candId); // 1.8.0（P1）：房间级快照优先（LAB_VS=0 回退原实现——配对验证）
  if (!base) return null;
  const eng = room._beliefEngine;
  const getBeliefs = S._getBeliefsRef; // 1.7.18：模块顶部预加载（TDZ 修复——const 声明必须在函数顶部，函数内先使用后声明会触发 TDZ）
  // 1.7.18：每票每 bot 预计算一次证据索引（beliefFeatures25 每票每候选调用——kills/claims/messages 全扫 × 11 候选 = O(候选×证据)；预计算后每候选 O(1) 查表，提速 ~10×，特征值不变 A-2 安全）
  let idx = room._belFeatIdx || {}; // 1.8.0：let（构建后需更新引用——原 const 导致 Assignment to constant）
  const idxKey = room.day + ':' + botId + ':' + (room._voteCastCount || 0);
  if (idx.key !== idxKey) {
    const deathInfer = {}, claimSuspect = {}, seerCheck = {}, tot = room.votes || {};
    for (const k of eng.kills || []) {
      const victim = eng.nodes[k.victim];
      if (victim && victim.votesMade) for (const vm of victim.votesMade) deathInfer[vm.target] = (deathInfer[vm.target] || 0) + 1;
    }
    for (const c of eng.claims || []) if (c.type === 'check_wolf') claimSuspect[c.target] = (claimSuspect[c.target] || 0) + 1;
    for (const m of room.messages || []) {
      if (m.ch === 'all' && m.from !== botId && m.text && m.text.includes('查杀')) {
        for (const p of room.players) if (p.alive && m.text.includes(p.name)) { seerCheck[p.id] = 1; break; }
      }
    }
    const sorted = Object.entries(tot).sort((a, b) => b[1] - a[1]);
    const leadId = sorted.length ? sorted[0][0] : null;
    room._belFeatIdx = { key: idxKey, deathInfer, claimSuspect, seerCheck, leadId, totKey: Object.keys(tot).length };
    idx = room._belFeatIdx; // 1.8.0：构建后更新局部引用（原代码遗漏——idx 仍指向空对象 → deathInfer undefined 崩溃）
  }
  const belKey = room.day + ':' + botId + ':' + (room._voteCastCount || 0);
  if (!room._belCache || room._belCache.key !== belKey) {
    room._belCache = { key: belKey, bel: getBeliefs(eng) };
  }
  const bel = room._belCache.bel;
  if (!eng) return base.concat([0.5, 0.5, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const p = bel.posterior[candId] != null ? bel.posterior[candId] : 0.5;
  const cc = bel.credibility[candId] != null ? bel.credibility[candId] : 0.5;
  const cv = bel.credibility[botId] != null ? bel.credibility[botId] : 0.5;
  // 1.7.18：vote_share 语义修复——room.votes 是 {投票者: 目标} 映射，旧公式取 room.votes[candId]（候选投给了谁）→ 目标 id 字符串 → NaN → null 脏值；正确语义 = 候选被投票数/当前总票数
  let share = 0;
  if (room.votes && Object.keys(room.votes).length) {
    let vc = 0;
    for (const t of Object.values(room.votes)) if (t === candId) vc++;
    share = vc / Object.keys(room.votes).length;
  }
  const deathInferV = Math.min(1, (idx.deathInfer[candId] || 0) / 3);
  const claimSuspectV = Math.min(1, (idx.claimSuspect[candId] || 0) / 2);
  const voteLeadOrder = idx.leadId === candId ? 1 : 0;
  let followStrength = 0;
  const follows = bel.follows[botId] || {};
  if (follows[candId]) followStrength = Math.min(1, follows[candId] / 3);
  const seerCheckV = idx.seerCheck[candId] || 0;
  const credDerived = Math.abs(cc - 0.5) * 2;
  return base.concat([p, cc, cv, share, deathInferV, 0, claimSuspectV, voteLeadOrder, followStrength, seerCheckV, 0, credDerived]);
}
function dynamicWb(bot, pid, mp, auc) {
  const b = bot.botMemory && bot.botMemory.beliefs && bot.botMemory.beliefs[pid];
  const alpha = (b && b.ev) || 0; // 信念证据量（0 = 无证据，纯先验）
  let beta = 0.5; // 模型信度下限（无模型分时中性）
  if (mp != null && isFinite(mp)) {
    const ca = auc || 0.7; // per-config 校准 AUC（v3 模型 configs[key].local.testAUC）
    beta = Math.min(1, Math.abs(2 * mp - 1) * ca); // 模型确定性 × 配置校准
  }
  const k = parseFloat(process.env.LAB_DYN_K || '1'); // 模型信度缩放（可调）
  return alpha / (alpha + k * beta); // 最优线性组合形态：各按信度反比加权
}
function buildVoteWorld(room, bot) {
  const b = bot.botMemory || {};
  const beliefs = b.beliefs || {};
  const suspicion = b.suspicion || {};
  const modelBase = S.getVoteModel(); // 1.7.0（B1-4）：fail-open——模型缺失/损坏回退纯信念；仅好人侧注入（狼侧用模型会反向增强）
  // 1.8.0（人机三档）：投票感知按 bot 等级路由——简单/普通（easy/smart）→ v2（13 维）；困难（simulate）→ v3（25 维干净版）
  const _cfgKey = room.presetKey || (room.cap ? room.cap + 'p' : null);
  const _isHard = (bot.botLevel || 'easy') === 'simulate';
  const model = _isHard
    ? ((process.env.VOTE_MODEL_MODE || 'adaboost') === 'v3' && _cfgKey === '12c' ? S.getVoteModelV2() || modelBase : modelBase) // 困难档：v3 主 + 12c per-config 回退 v2（配对劣化特例；默认 adaboost 重训模型）
    : (S.getVoteModel() || S.getVoteModelV2() || modelBase); // 简单/普通档：默认用主模型（adaboost 重训），v2 回退
  const _vsEnabled = process.env.LAB_VS !== '0'; // 1.8.0（P1）：LAB_VS=0 禁用房间级快照（配对验证对照——原实现）
  const _vsKey = room.day + ':' + (room.phase || '') + ':' + (room._voteCastCount || 0) + ':' + (room.messages ? room.messages.length : 0); // 1.8.0（P1）：快照失效键 day+phase+voteCastCount+messages.length——messages 投票轮内动态追加（talkCount 等发言派生字段随新发言重建）；票型实时读 room.votes
  if (_vsEnabled) {
    if (!room._vs || room._vs.key !== _vsKey) {
      const _vsBase = S.buildRoomVoteState(room);
      room._vs = { key: _vsKey, base: _vsBase };
    }
  }
  const cfgAuc = (() => { // 1.7.18：per-config 校准 AUC（动态权重 β 信号源——v3 模型 configs[key].local.testAUC；无则 0.7 中性）
    try {
      const mk = room.presetKey || (room.cap ? room.cap + 'p' : null);
      if (model && model.schema === 'adaboost-vote@3' && mk && model.configs && model.configs[mk]) return model.configs[mk].local.testAUC || 0.7;
      if (model && model.schema === 'adaboost-vote@3' && model.global) return model.global.testAUC || 0.7;
    } catch (e) {}
    return 0.7;
  })();
  if (process.env.LAB_AUDIT_VOTE === '1') global._voteAuditSeq = (global._voteAuditSeq || 0) + 1; // 1.7.15：审计——每次投票决策一个时刻 id
  const useModel = (process.env.VOTE_MODEL_MODE || 'adaboost') !== 'heuristic' && !!model && ctx.factionOf(room, bot) === 'good'; // 默认 adaboost 重训模型（VOTE_MODEL_MODE=v2/v3 可回退）
  // 1.8.0（NLU 端到端实验）：LAB_USE_BELIEF_ENGINE=1 时把中央信念引擎后验直接混入嫌疑分（默认关）
  const engBeliefs = process.env.LAB_USE_BELIEF_ENGINE === '1' && room._beliefEngine ? S._getBeliefsRef(room._beliefEngine) : null;
  const scores = {};
  let wbCur = null; // 1.7.18+：候选循环内 wb 的审计快照（LAB_AUDIT_VOTE=1 埋点用）
  for (const p of room.players) {
    if (p.id === bot.id || !p.alive) continue;
    let s = beliefs[p.id] ? beliefs[p.id].wolf : Math.min(1, (suspicion[p.id] || 0) / 100); // smart/simulate 用信念，easy 用关键词嫌疑（归一化到 0..1）
    if (engBeliefs) {
      const ep = engBeliefs.posterior[p.id] != null ? engBeliefs.posterior[p.id] : 0.5;
      s = 0.5 * s + 0.5 * ep; // 实验：中央信念与 botMemory 信念各半
    }
    // 1.7.0（B1-4）：每轮投票前动态似然——模型 P(wolf) 混合（0.6 信念 + 0.4 模型；不改 beliefs 防累积饱和）
    let f = null, mp = null;
    if (useModel) {
      f = model.schema === 'adaboost-vote@3' || model.schema === 'vote-mlp@1' ? beliefFeatures25(room, bot.id, p.id) : (_vsEnabled ? S.voteFeatures13(room._vs.base, bot.id, p.id) : S.voteFeatures(room, bot.id, p.id)); // 1.8.0（P1）：v1/v2 走房间级快照（LAB_VS=0 回退原实现——配对验证）；1.7.18+：v4（MLP）与 v3 同用 25 维
      if (f && process.env.LAB_VS_DBG === '1' && _vsEnabled) {
        const _fa = S.voteFeatures(room, bot.id, p.id);
        if (_fa && f.length === _fa.length) {
          for (let _i = 0; _i < f.length; _i++) { if (Math.abs(f[_i] - _fa[_i]) > 1e-9) { console.log('VS_DBG day=' + room.day + ' phase=' + (room.phase || '') + ' bot=' + bot.id + ' cand=' + p.id + ' idx=' + _i + ' 快照=' + f[_i] + ' 原=' + _fa[_i]); break; } }
        } else console.log('VS_DBG 长度不同 bot=' + bot.id + ' cand=' + p.id);
      }
      if (f) {
        mp = S.modelProb(model, f, room.presetKey || (room.cap ? room.cap + 'p' : null)); // 1.7.16：v2 configKey 路由（local/cap/global；用 room 而非 world——world 在函数末尾构造，投票循环内不可引用）
        if (mp != null) {
          if (model.schema === 'adaboost-vote@2' || model.schema === 'adaboost-vote@3') mp = 1 / (1 + Math.exp(-mp)); // v2/v3：raw score → 单调 sigmoid（仅排序消费，未校准——禁止概率阈值/置信度下游）
          else if (model.schema === 'vote-mlp@1') { /* v4：概率输出（sigmoid 内建）——直接消费 */ }
          else { const mi = isoVote(mp); if (mi != null) mp = mi; } // v1：Platt 概率 + iso 过渡校准
          // 1.7.18：动态权重（数学方法——最优线性组合形态：各按信度反比加权）
// 信念信度 α = 证据量 ev（查验/票型/死亡/发言 7 类证据源的贝叶斯更新次数）
// 模型信度 β = |2·mp−1| × AUC_config（per-config 校准：4p 0.916 / 12a 0.727 / global 0.742）
// wb(p) = α/(α + k·β)——证据少→模型主导；模型不确定(mp≈0.5)→信念主导；配置 AUC 高→模型更重
// 固定档保留（BOT_SUSPICION_W env 覆盖 + LAB_DYN_W=0 禁用动态回固定档）：
//   v3→0.4（扫描最优）/ adaboost→按人数：≤12 用 0.35，13+ 用 0.3（2026-08-17 扫描 + 500 局确认）
const _modeForW = process.env.VOTE_MODEL_MODE || 'adaboost';
const _defW = process.env.BOT_SUSPICION_W || (_modeForW === 'v3' ? '0.4' : ((room.playerCap || room.cap || 0) >= 13 ? '0.3' : '0.35'));
const dynW = process.env.LAB_DYN_W === '1' && bot.suspicionW == null && !process.env.BOT_SUSPICION_W; // 1.7.18+：动态权重实验门控（二十二节重验：静态 0.4 优于动态 +6.2pp——生产默认静态；LAB_DYN_W=1 启用动态实验）
const wb = dynW ? dynamicWb(bot, p.id, mp, cfgAuc) : (bot.suspicionW != null ? bot.suspicionW : parseFloat(_defW)); // 默认 adaboost→0.35/0.3（按人数）
          wbCur = wb; // 1.7.18+：审计用（候选循环内记录，LAB_AUDIT_VOTE=1 时写入埋点）
          s = wb * s + (1 - wb) * mp;
        }
      }
    }
    // 1.7.16：感知层审计钩子（LAB_AUDIT_VOTE=1）——记录排序分数 s（heuristic/adaboost 通用）、
    // 模型输出 mp（仅 adaboost，校准用）、特征 f、目标真相；离线分析，生产零影响
    if (process.env.LAB_AUDIT_VOTE === '1') {
      if (!global._voteAudit) { global._voteAudit = []; }
      // 1.7.17（vote-v3）：信念特征埋点——决策时刻信念状态（bel_posterior/credibility/vote_share），
      // 与 S.voteFeatures 13 维并列（A-2 同源：训练/推理消费同一 belief-engine 事件流）
      let belF = null;
      const wbAudit = wbCur; // 1.7.18+：动态权重审计（候选循环内记录）
      if (room._beliefEngine) {
        try {
          const getBeliefs = S._getBeliefsRef;
          const bel = getBeliefs(room._beliefEngine);
          const vv = room.votes || {};
          const tot = {}; for (const k of Object.keys(vv)) { const t = vv[k]; if (t) tot[t] = (tot[t] || 0) + 1; }
          belF = [
            bel.posterior[p.id] != null ? bel.posterior[p.id] : 0.5,
            bel.credibility[p.id] != null ? bel.credibility[p.id] : 0.5,
            bel.credibility[bot.id] != null ? bel.credibility[bot.id] : 0.5,
            (tot[p.id] || 0) / Math.max(1, Object.keys(tot).length),
          ];
        } catch (e) { belF = null; }
      }
      // 1.7.18（vote-v3 A-2 修复）：在线采集 25 维特征（beliefFeatures25 独立于模型——任何模式都存，训练/推理同源）
      // 消除"重放训练 vs 在线推理"生态错配（v3 偏狼根因：离线 0.85/上线 32.4% 背离）
      const fAudit = (beliefFeatures25(room, bot.id, p.id) || f);
      global._voteAudit.push({ v: global._voteAuditSeq, f: fAudit, belF, wb: wbAudit, mp, s, tIsWolf: ctx.campOf(p) === 'wolf', useModel, schema: model ? model.schema : null });
    }
    scores[p.id] = s;
  }
  // 1.7.4：动态 payoff 公开量——wolfAlive/godAlive/villAlive = roleCounts − 已翻牌死亡（死后全翻牌，公开精确；只统计死者不碰活人隐藏身份）
  const rc = room.roleCounts || {};
  const wolfInit = (rc.wolf || 0) + (rc.wolfBeauty || 0);
  const godInit = (rc.seer || 0) + (rc.witch || 0) + (rc.hunter || 0) + (rc.guard || 0) + (rc.dreamer || 0);
  const villInit = rc.villager || 0;
  const eff2 = p => (p.role === 'thief' && p.pickedRole) ? p.pickedRole : p.role;
  const deadWolf = room.players.filter(q => !q.alive && (eff2(q) === 'wolf' || eff2(q) === 'wolfBeauty')).length;
  const deadGod = room.players.filter(q => !q.alive && ['seer', 'witch', 'hunter', 'guard', 'dreamer'].includes(eff2(q))).length;
  const deadVill = room.players.filter(q => !q.alive && eff2(q) === 'villager').length;
  const wolfAlive = Math.max(0, wolfInit - deadWolf);
  const godAlive = Math.max(0, godInit - deadGod);
  const villAlive = Math.max(0, villInit - deadVill);
  // v1.7.6：第三方策略公开量——自称神职者（信息战/神职优先目标）、狼恋人标记（投狼=自爆红线）、第三方存活数
  const roleClaims = {};
  for (const m of room.messages) {
    if (m.ch === 'all' && m.from && m.text) {
      const mm = m.text.match(/我是(女巫|预言家|猎人|守卫|摄梦人)/);
      if (mm && !roleClaims[m.from]) roleClaims[m.from] = mm[1];
    }
  }
  const myFaction = ctx.factionOf(room, bot);
  const thirdAlive = myFaction === 'third' ? (() => {
    let n = 0;
    if (room.lovers) for (const id of room.lovers) { const q = ctx.byId(room, id); if (q && q.alive) n++; }
    const cup = room.players.find(q => ctx.effRole(q) === 'cupid');
    if (cup && cup.alive && (!room.lovers || !room.lovers.includes(cup.id))) n++;
    return n;
  })() : 0;
  // v1.7.6：第三方平衡用——好人胜率估值 V(R,S,M)（value 模型，fail-open 0.5）
  let vGood = 0.5;
  try {
    const vm = ctx.getValueModelForBot();
    if (vm) {
      const sig = x => 1 / (1 + Math.exp(-x));
      const R = Math.max(1, wolfAlive), S = Math.max(1, godAlive), M = Math.max(1, villAlive), N = R + S + M;
      vGood = sig(vm.w[0] + vm.w[1] * R + vm.w[2] * S + vm.w[3] * M + vm.w[4] * N + vm.w[5] * R * S + vm.w[6] * R * M + vm.w[7] * S * M);
    }
  } catch (e) {}
  return {
    faction: ctx.factionOf(room, bot),
    teammates: room.players.filter(p => p.alive && ctx.isWolfRole(p)).map(p => p.id),
    scores,
    votes: room.votes || {},
    sellTarget: sellWolfBeauty(room, bot),
    allVoters: room.players.filter(p => p.alive && !p.leftGame).map(p => p.id), // 1.7.0（B1-5）：rollout 模拟投票者
    me: bot.id,
    followMode: bot.followMode || process.env.FOLLOW_MODE || 'strict', // 1.7.17（D2 前置）：per-bot 跟票变体（strict/loose/none）
    configKey: room.presetKey || (room.cap ? room.cap + 'p' : null), // v1.7.14：cap 级 fallback（生产真人局无 preset → '12p' 等路由到 cap 聚合 local）；A-2 双轨：lab（presetKey 存在）未知 key 抛错，生产（无 preset）cap fallback + 未训 cap 显式降级解析版（可用性优先，注释写明非静默）
    hasPreset: !!room.presetKey, // v1.7.14：A-2 双轨判定（lab preset 标签 / 生产 cap fallback）
    vGood, // 1.7.6：第三方平衡用（好人胜率估值）
    roleClaims, // 1.7.6：公开自称神职者（{id: 角色}）——第三方神职优先目标
    isWolfLover: myFaction === 'third' && ctx.isWolfRole(bot), // 1.7.6：第三方狼恋人（投狼/刀狼=狼队自爆红线）
    thirdAlive, // 1.7.6：第三方存活数（bot 视角：情侣+丘比特）
    // 1.7.4（动态 payoff）：公开量 + 曲率参数（env 可配，lab 参数纪律：每版记录）
    //   默认 p=1,q=0：进度侧保留（配对 34:9，p=0.0003 显著，好人+6.3pp）；容错侧回退（28:26，p=0.89 不显著）
    wolfAlive, godAlive, villAlive,
    wolfInit, godInit, villInit,
    payoffP: parseFloat(process.env.PAYOFF_P || '1'),
    payoffQ: parseFloat(process.env.PAYOFF_Q || '0'),
    // V4.2 信息特征（world 层——与训练侧 rebuildEventStatesV5 同源；仅 VALUE_MODEL=v4 的 info 模型消费）
    //   checkedWolves/checkedCount：room.seerHistory（随对局追加，投票时刻=已发生查验，同源）
    //   seerAlive：room.players 预言家存活；lastExileWasWolf：room.lastExiledId（上次放逐结算记录，投票时刻=上一轮）
    info: {
      checkedWolves: (room.seerHistory || []).filter(h => h.result === 'wolf').length,
      checkedCount: (room.seerHistory || []).length,
      seerAlive: (() => { const q = room.players.find(p => ['seer', '预言家'].includes(p.roleKey || p.role)); return q && q.alive ? 1 : 0; })(),
      lastExileWasWolf: (() => { const id = room.lastExiledId; const q = room.players.find(p => p.id === id); return q ? (ctx.campOf(q) === 'wolf' ? 1 : 0) : 0; })(),
    },
  };
}
function smartVoteTarget(room, bot) {
  const myFaction = ctx.factionOf(room, bot);
  const sellId = sellWolfBeauty(room, bot); // v1.5.2：卖狼美人优先
  if (sellId) return sellId;
  let pool = ctx.shuffle(ctx.aliveOthers(room, bot)); // 同分时随机，避免固定偏向某座位
  // v1.6.2：公平化——狼不避让恋人（不知情侣关系）；仅第三方自己（恋人互知）不投自己阵营
  if (myFaction === 'third') pool = pool.filter(p => ctx.factionOf(room, p) !== 'third');
  if (!pool.length) return null;
  const isWolf = ctx.factionOf(room, bot) === 'wolf'; // v1.6.1：第三方（人狼恋狼恋人）不再被误判为狼队
  const lp = ctx.loverPartner(room, bot); // v1.6.3：狼恋人不投恋人（恋人互知，规则内）
  if (isWolf && lp && !lp.isWolf) pool = pool.filter(p => p.id !== lp.id);
  if (!pool.length) return null;
  // v1.7.11（⑤）：第三方平衡接入 vGood（value-v2 好人胜率估值）——好人劣势（vGood<0.5）帮好人（投狼概率最高）、
  // 好人优势（vGood>0.5）帮狼（投好人概率最高）；概率软化（T=0.15）避免 0.5 附近硬切抖动。此前 vGood 死数据未接入（1.7.6 功能未上线）
  let scoreFn = p => (isWolf ? -wolfProb(room, bot, p.id) : wolfProb(room, bot, p.id));
  // v1.7.11（⑤）：第三方平衡——vGood 接入默认关闭（THIRD_BALANCE=1 启用）。
  // 实测（确定性版，无 RNG 分叉）：启用后局四 wolf 52.9→45.8（Δ−7.13pp，CI[-8.4,-5.8]）——帮弱者力度>帮强者，过度利好好人，
  // 生产落带被破坏（局四翻 FAIL）。T/bias 回调无效（v2 sigmoid 输出双峰，中间区无决策）。
  // 待平衡回调（改 vGood 计算分布或帮好人力度限制）后再默认启用。
  if (myFaction === 'third' && process.env.THIRD_BALANCE === '1') {
    const vGood = thirdBalanceV(room);
    const T = parseFloat(process.env.THIRD_BALANCE_T || '0.15');
    const bias = parseFloat(process.env.THIRD_BALANCE_BIAS || '0'); // >0 → pHelpGood 增大 → 更帮好人（狼更弱）
    const pHelpGood = 1 / (1 + Math.exp((vGood - 0.5 - bias) / T));
    // 确定性权重混合（不消耗 RNG，配对干净）
    scoreFn = p => (2 * pHelpGood - 1) * wolfProb(room, bot, p.id);
  }
  const t = concentratedPick(room, pool, scoreFn);
  return t ? t.id : null;
}
/* v1.7.11（⑤）：第三方平衡——好人胜率估值 V(R,S,M)（value-v2 模型，fail-open 0.5）——1.7.6 死数据正式接入 */
function thirdBalanceV(room) {
  try {
    const vm = ctx.getValueModelForBot();
    if (!vm) return 0.5;
    const alive = room.players.filter(p => p.alive && !p.leftGame);
    let R = 0, S = 0, M = 0;
    for (const q of alive) {
      const rr = ctx.effRole(q);
      if (rr === 'wolf' || rr === 'wolfBeauty') R++;
      else if (rr === 'seer' || rr === 'witch' || rr === 'hunter' || rr === 'guard' || rr === 'dreamer') S++;
      else if (rr === 'villager') M++;
    }
    const sig = x => 1 / (1 + Math.exp(-x));
    const R2 = Math.max(1, R), S2 = Math.max(1, S), M2 = Math.max(1, M), N = R2 + S2 + M2;
    return sig(vm.w[0] + vm.w[1] * R2 + vm.w[2] * S2 + vm.w[3] * M2 + vm.w[4] * N + vm.w[5] * R2 * S2 + vm.w[6] * R2 * M2 + vm.w[7] * S2 * M2);
  } catch (e) { return 0.5; }
}

module.exports = { wolfProb, concentratedPick, sellWolfBeauty, isoVote, beliefFeatures25, dynamicWb, buildVoteWorld, smartVoteTarget, thirdBalanceV };