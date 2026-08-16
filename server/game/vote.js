// 自动生成（game.js 拆分——vote 模块，勿手改，重新运行 tools/split-game.js）

const shared = require('./shared');
const ctx = shared.ctx;
const { register } = shared;
const { loverCore } = shared;

function startVote(room) {
  if (checkGameEnd(room)) return; // v1.6.4（A2-1）
  room.phase = 'vote';
  room.votes = {};
  ctx.bump(room);
  ctx.schedulePhase(room, 'vote', () => resolveExileVote(room)); // 超时未投视为弃票
}
function computeVotes(room, useSheriffWeight) {
  const totals = {};
  for (const p of room.players) {
    if (!p.alive) continue;
    if (!room.votes.hasOwnProperty(p.id)) continue;
    const v = room.votes[p.id];
    if (!v) continue;
    const w = (useSheriffWeight && p.id === room.sheriff) ? 1.5 : 1;
    totals[v] = (totals[v] || 0) + w;
  }
  const entries = Object.entries(totals);
  if (!entries.length) return { tie: false, winner: null, totals: {}, max: 0 };
  const max = Math.max(...entries.map(e => e[1]));
  const top = entries.filter(e => Math.abs(e[1] - max) < 1e-9).map(e => e[0]);
  if (top.length > 1) return { tie: true, tied: top, totals, max };
  return { tie: false, winner: top[0], totals, max };
}
function allAliveVoted(room) { return room.players.filter(p => p.alive).every(p => room.votes.hasOwnProperty(p.id)); }

function resolveExileVote(room) {
  if (room.loverMode === 'v2' && room.loverV2 && room.loverV2.protectBy) { // v2 付费护短：结算公告“X在保护恋人”（狼队获知身份，优先刀）
    const pb = ctx.byId(room, room.loverV2.protectBy);
    ctx.pushEvent(room, 'lover_protect', { by: pb ? pb.id : null, name: pb ? pb.name : '' });
    ctx.sysMsg(room, 'all', (pb ? pb.name : '某人') + ' 在保护恋人（护短公开）');
    room.loverV2.protectBy = null;
  }
  const res = computeVotes(room, true);
  // 1.7.17（D1 数据源）：vote 明细事件——每票 voter→target（投票结算处发射，块 2 lastExiledId 的同源数据；
  // 投票预测器训练数据源：P(vote_i = j | 投票者视角)；records-v5 重采后含本事件）
  const voteDetail = [];
  for (const p of room.players) {
    if (!p.alive || !room.votes.hasOwnProperty(p.id)) continue;
    const v = room.votes[p.id];
    if (!v) continue;
    voteDetail.push({ voter: p.id, target: v });
  }
  if (voteDetail.length) ctx.pushEvent(room, 'vote', { votes: voteDetail, totals: res.totals });
  room.lastVoteResult = {
    kind: 'vote', totals: res.totals, max: res.max,
    result: res.tie ? 'tie' : (res.winner ? 'exile' : 'none'),
    exiled: res.winner, tied: res.tied || null,
  };
  ctx.pushEvent(room, 'exile', { exiled: res.winner, result: res.tie ? 'tie' : (res.winner ? 'exile' : 'none'), tied: res.tied || null, role: res.winner ? (ctx.byId(room, res.winner) || {}).role || '' : '' }); // v1.6.0（V5.1：放逐身份公开）
  if (res.tie) {
    if (room.settings.tieRule === 'pk') {
      room.pkTied = res.tied.filter(id => ctx.byId(room, id).alive);
      room.phase = 'pk_speech';
      ctx.bump(room);
      ctx.schedulePhase(room, 'pk_speech', () => beginPkVote(room)); // 超时自动进入 PK 投票
      return;
    }
    // 平票无人出局
    ctx.beginNight(room);
    return;
  }
  if (!res.winner) { ctx.beginNight(room); return; }
  exilePlayer(room, res.winner);
}
function exilePlayer(room, id) {
  const q = ctx.byId(room, id);
  if (room.loverTest && room.loverTest.includes('immortal') && q.role === 'cupid') {
    q.deadBy = null;
    // 修复（M3.5）：豁免 = 放逐无效，视为无人出局直接入夜。
    // 此前直接 return → 无新定时器 + phase 停驻 'vote' → lab 虚拟时钟卡死兜底 → stall 数分钟/局
    ctx.pushEvent(room, 'exile_immune', { id: id, name: q.name }); // 对冲 resolveExileVote 已推送的 exile 事件
    ctx.sysMsg(room, 'all', q.name + ' 被投票放逐但豁免（测试注入）');
    room.votes = {};
    if (checkWin(room)) { ctx.bump(room); return; }
    ctx.beginNight(room);
    return;
  }
  q.alive = false; q.deadBy = 'exile';
  room.lastExiledId = id; // v4.2：票型信息特征（lastExileWasWolf——推理端与训练端 exile 事件同源）
  room.dayDeaths = [id];
  room.exileDeaths = [id];
  ctx.startLastWord(room, [id], 'exile');
}
function afterExile(room) {
  const deaths = [];
  const die = (pid, by) => { const q = ctx.byId(room, pid); if (q && q.alive && !deaths.includes(pid)) { if (room.loverTest && room.loverTest.includes('immortal') && q.role === 'cupid') return; q.alive = false; q.deadBy = by; deaths.push(pid); } };
  // 被放逐者本身也计入死亡列表，用于触发情侣殉情
  const exileAndCharm = room.exileDeaths.slice();
  for (const id of room.exileDeaths) {
    const q = ctx.byId(room, id);
    if (ctx.effRole(q) === 'wolfBeauty' && room.charmTarget && room.charmTarget !== id) {
      die(room.charmTarget, 'charm');
      exileAndCharm.push(room.charmTarget);
    }
  }
  ctx.applyLoverChain(room, exileAndCharm, die);
  loverCore.trackCupidDeath(room, exileAndCharm); // v2 时序记录（丘比特被票死）
  room.dayDeaths = room.dayDeaths.concat(deaths);
  // v1.6.2：放逐死亡批次入事件流（放逐者 + 魅惑带走 + 殉情；猎人枪杀批次由 resolveShot 推送）
  const exileDead = [...new Set(exileAndCharm.concat(deaths))];
  if (exileDead.length) ctx.pushEvent(room, 'deaths', { deaths: exileDead.map(id => { const q = ctx.byId(room, id); return { id, name: q ? q.name : '', by: q ? q.deadBy : '', role: q ? q.role : '' }; }) });
  // 猎人被放逐 → 先结算开枪，再判胜负（枪杀可能改变战局，与夜晚猎人同规则）
  const hunter = room.exileDeaths.find(id => { const q = ctx.byId(room, id); return ctx.effRole(q) === 'hunter'; });
  if (hunter) {
    room.phase = 'hunter_shot';
    room.shooter = hunter;
    room.shotContext = 'exile';
    ctx.scheduleHunterShotTimer(room); // 被放逐猎人 30 秒未开枪 → 弃枪（N1 修复）
    ctx.bump(room);
    ctx.maybeRunBots(room); // 被放逐猎人若是人机 →自动决定是否开枪
    return;
  }
  if (checkWin(room)) { ctx.bump(room); return; }
  ctx.beginNight(room);
}

/* 警长竞选 */
function resolveSheriffVote(room) {
  const res = computeVotes(room, false);
  room.lastVoteResult = {
    kind: 'sheriff', totals: res.totals, max: res.max,
    result: res.tie ? 'tie' : (res.winner ? 'elected' : 'none'),
    exiled: res.winner, tied: res.tied || null,
  };
  // 1.7.4：警长竞选平票同样适用 PK 规则（rules.md 三.3）——平票者 PK 再投，得票最多者当选；再平票无人当选
  if (res.tie && res.tied && res.tied.length) { room.pkTied = res.tied; beginSheriffPkVote(room); return; }
  if (res.winner && !res.tie) room.sheriff = res.winner;
  ctx.startDiscuss(room);
}
function beginSheriffPkVote(room) {
  if (checkGameEnd(room)) return; // v1.6.4（A2-1）
  room.phase = 'pk_vote';
  room.pkIsSheriff = true; // 1.7.4：警长 PK——当选而非放逐
  room.votes = {};
  ctx.bump(room);
  ctx.schedulePhase(room, 'pk_vote', () => resolvePkVote(room)); // 超时未投视为弃票
}

/* ---------------------------- 胜负判定 ---------------------------- */
/* v1.6.4（A2-1）：终局幂等兜底——checkWin 幂等（ended 直接返回）；阶段推进入口统一调用，
 * 覆盖“结算后无人可行动”的挂起场景（死亡链为同步递归，兜底点放入口/递归出口均安全）。 */
function checkGameEnd(room) {
  if (room.phase === 'ended') return true;
  return !!checkWin(room);
}
function thirdFaction(room) {
  const ids = [];
  const cupid = ctx.rolePlayer(room, 'cupid');
  // 第三方阵营 = 情侣两人 + 丘比特（若丘比特不在情侣中）
  // 情侣 = [丘比特, 狼] 时，丘比特阵营为第三方，成员即情侣两人
  if (cupid && ctx.cupidCamp(room) === 'third') {
    if (room.lovers && room.lovers[0]) ids.push(room.lovers[0], room.lovers[1]);
    if (!room.lovers || !room.lovers.includes(cupid.id)) ids.push(cupid.id);
  }
  return ids;
}
function checkWin(room) {
  if (room.phase === 'ended') return room.winner || null; // v1.6.4（A2-1）：幂等——终局后重复调用直接返回
  const alive = room.players.filter(p => p.alive && !p.leftGame);
  const endRoles = () => room.players.map(p => ({ id: p.id, name: p.name, role: ctx.roleText(room, p), camp: ctx.campText(room, p), alive: p.alive, seat: p.seat }));
  // v1.6.4（A2-1）：全员阵亡（无活人）→ 平局结束——此前 return null 导致“全死了还能继续”（真实反馈）
  if (!alive.length) {
    room.winner = 'draw';
    room.endInfo = { winner: 'draw', text: '全员阵亡（平局）', roles: endRoles() };
    room.phase = 'ended';
    ctx.bump(room);
    return room.winner;
  }
  // 第三方：场上仅剩第三方成员（丘比特/情侣已死仍计入名单）→ 第三方胜
  const third = thirdFaction(room);
  if (third.length && alive.every(p => third.includes(p.id))) {
    room.winner = 'third';
    room.endInfo = { winner: 'third', text: '第三方阵营获胜（丘比特阵营）', roles: endRoles() };
    room.phase = 'ended';
    ctx.bump(room);
    return room.winner;
  }
  const isThird = id => third.includes(id);
  // 狼人阵营 / 好人阵营（均剔除第三方成员；第三方默认输，除非活到最后）
  const goodCamp = alive.filter(p => ctx.campOf(room, p) === 'good' && !isThird(p.id));
  const wolfCamp = alive.filter(p => ctx.campOf(room, p) === 'wolf' && !isThird(p.id));
  // 狼人胜
  if (room.settings.winMode === 'city') {
    if (goodCamp.length === 0) { // 屠城：好人阵营全灭即胜，无需消灭第三方
      room.winner = 'wolf';
      room.endInfo = { winner: 'wolf', text: '狼人阵营获胜（屠城）', roles: endRoles() };
      room.phase = 'ended';
      ctx.bump(room);
      return room.winner;
    }
  } else {
    // 屠边：好人阵营的神职或平民全灭（第三方不计）
    // 注意：若本局配置中本就没有某类职业（如 4 人局狼1+民3 无神职），
    // 该类别恒为 0 不应触发“全灭”——只按配置中存在的类别判定，否则狼人首刀即误判狼胜。
    const GOD_KEYS = ['seer', 'witch', 'hunter', 'dreamer', 'guard'];
    // 本局是否“配置了”神职/平民：按实际发出去的牌判定（盗贼玩法中可能被作废的身份卡不计入），
    // 否则无神职/无民（或神职卡被作废）的局会因该类别恒为 0 而首刀即误判狼胜。
    const hasRole = p => !!p.role; // 新模型下无人持有“盗贼”牌（盗贼选定后即转换身份），无需特判（死逻辑清理）
    const cfgGods = room.players.some(p => hasRole(p) && GOD_KEYS.includes(ctx.effRole(p)));
    const cfgCivs = room.players.some(p => hasRole(p) && ctx.effRole(p) === 'villager');
    const gods = goodCamp.filter(p => ctx.typeOf(room, p) === 'god');
    const civs = goodCamp.filter(p => ctx.typeOf(room, p) === 'civil');
    if ((gods.length === 0 && cfgGods > 0) || (civs.length === 0 && cfgCivs > 0)) {
      room.winner = 'wolf';
      room.endInfo = { winner: 'wolf', text: '狼人阵营获胜（屠边）', roles: endRoles() };
      room.phase = 'ended';
      ctx.bump(room);
      return room.winner;
    }
  }
  // 好人胜：狼人阵营（剔除第三方）全灭即胜
  if (wolfCamp.length === 0) {
    room.winner = 'good';
    room.endInfo = { winner: 'good', text: '好人阵营获胜', roles: endRoles() };
    room.phase = 'ended';
    ctx.bump(room);
    return room.winner;
  }
  return null;
}

/* ---------------------------- 白天动作 ---------------------------- */
function dayAction(room, p, action, data) {
  if (action === 'lover_unbind') { // v2（M1）：白天任一恋人宣言解绑（丘比特死后解锁，一次性；公告=身份公开代价）
    const r2 = loverCore.unbind(room, p.id);
    if (!r2.ok) return { error: r2.msg };
    ctx.pushEvent(room, 'lover_unbind', { by: r2.by, byId: r2.byId });
    ctx.sysMsg(room, 'all', r2.by + ' 解除了情侣关系（恋人身份公开）');
    return { ok: true };
  }
  switch (room.phase) {
    case 'morning':
      return { error: '等待房主继续' };
    case 'lastword': {
      if (!room.lastWorders.includes(p.id) || room.lastWordDone[p.id]) return { error: '现在不需要你发言' };
      if (action === 'post') {
        const text = (data.text || '').trim();
        if (!text) return { error: '请输入遗言内容' };
        ctx.addMessage(room, p, 'all', text, '遗言', data.claim || null); // D1：结构化声明透传
        if (data.claim) ctx.pushEvent(room, 'claim', { from: p.id, type: data.claim.type, target: data.claim.target || null, night: data.claim.night != null ? data.claim.night : room.nightNum }); // V5.1：声明事件
        p.lastWordUsed = true;
        room.lastWordDone[p.id] = true;
        ctx.bump(room);
        if (room.lastWorders.every(id => room.lastWordDone[id])) ctx.afterLastWord(room);
        return { ok: true };
      }
      if (action === 'skip') { p.lastWordUsed = true; room.lastWordDone[p.id] = true; ctx.bump(room); if (room.lastWorders.every(id => room.lastWordDone[id])) ctx.afterLastWord(room); return { ok: true }; }
      return { error: '未知操作' };
    }
    case 'handover': {
      if (action !== 'handover') return { error: '未知操作' };
      if (room.handoverFrom !== p.id) return { error: '只有警长本人可以移交警徽' };
      const target = data.target || null;
      if (target) {
        const t = ctx.byId(room, target);
        if (!t || !t.alive) return { error: '玩家不存在或已出局' };
        room.sheriff = t.id;
        ctx.addMessage(room, p, 'all', `警徽移交给了 ${t.name}`, '系统');
      } else {
        room.sheriff = null;
        ctx.addMessage(room, p, 'all', '警长撕毁了警徽', '系统');
      }
      room.handoverFrom = null;
      ctx.bump(room);
      ctx.startDaySteps(room);
      return { ok: true };
    }
    case 'sheriff_campaign': {
      if (action !== 'campaign') return { error: '未知操作' };
      if (room.campaignDecided[p.id]) return { error: '你已做出选择' };
      room.campaignDecided[p.id] = true;
      if (data.run) room.candidates.push(p.id);
      ctx.bump(room);
      if (room.players.filter(q => q.alive).every(q => room.campaignDecided[q.id])) beginSheriffVote(room);
      return { ok: true };
    }
    case 'sheriff_vote': {
      if (action !== 'vote') return { error: '未知操作' };
      if (!p.alive) return { error: '你已出局，无法投票' }; // 规则（rules.md 三.10）：已出局玩家不得投票
      if (room.votes.hasOwnProperty(p.id)) return { error: '你已投票' };
      const target = data.target || null;
      if (target && !room.candidates.includes(target)) return { error: '只能投给竞选者' };
      room.votes[p.id] = target;
      ctx.bump(room);
      if (allAliveVoted(room)) resolveSheriffVote(room);
      return { ok: true };
    }
    case 'discuss': {
      if (action !== 'startVote') return { error: '未知操作' };
      if (p.id !== room.host) return { error: '只有房主可以结束发言进入投票' };
      startVote(room);
      return { ok: true };
    }
    case 'vote': {
      if (action !== 'vote') return { error: '未知操作' };
      if (!p.alive) return { error: '你已出局，无法投票' }; // 规则（rules.md 三.10）：已出局玩家不得投票
      if (room.votes.hasOwnProperty(p.id)) return { error: '你已投票（平票前不能改票）' };
      if (room.loverMode === 'v2' && data && data.protectPartner) loverCore.markProtect(room, p.id); // v2：护短标记（结算公告）
      const target = data.target || null;
      if (target) { const t = ctx.byId(room, target); if (!t || !t.alive) return { error: '玩家不存在或已出局' }; }
      room.votes[p.id] = target;
      // 1.7.17（D1 数据源）：逐票事件——每票落定时刻快照（排除本次票——决策时刻语义，训练/推理特征对齐；结算快照会泄漏后续票）
      if (room.phase === 'vote') {
        const snap = [];
        for (const q of room.players) {
          if (!q.alive || !room.votes.hasOwnProperty(q.id)) continue;
          if (q.id === p.id) continue; // 1.7.17：排除本次票（voteFeatures A-2 排除自己，两边一致）
          const v = room.votes[q.id];
          if (!v) continue;
          snap.push({ voter: q.id, target: v });
        }
        ctx.pushEvent(room, 'vote_cast', { voter: p.id, target, votes: snap });
      }
      ctx.bump(room);
      if (allAliveVoted(room)) resolveExileVote(room);
      return { ok: true };
    }
    case 'pk_speech': {
      if (action !== 'startVote') return { error: '未知操作' };
      if (p.id !== room.host) return { error: '只有房主可以开始 PK 投票' };
      beginPkVote(room);
      return { ok: true };
    }
    case 'pk_vote': {
      if (action !== 'vote') return { error: '未知操作' };
      if (!p.alive) return { error: '你已出局，无法投票' }; // 规则（rules.md 三.10）：已出局玩家不得投票
      if (room.votes.hasOwnProperty(p.id)) return { error: '你已投票' };
      const target = data.target || null;
      if (target && !room.pkTied.includes(target)) return { error: '只能投给 PK 玩家' };
      room.votes[p.id] = target;
      ctx.bump(room);
      if (allAliveVoted(room)) resolvePkVote(room);
      return { ok: true };
    }
    case 'hunter_shot': {
      if (action !== 'hunter_shoot') return { error: '未知操作' };
      if (room.shooter !== p.id) return { error: '现在不需要你操作' };
      const target = data.target || null;
      if (target) {
        const t = ctx.byId(room, target);
        if (!t || !t.alive) return { error: '玩家不存在或已出局' };
        if (t.id === p.id) return { error: '不能枪杀自己' };
      }
      room.shooter = null;
      ctx.resolveShot(room, target);
      return { ok: true };
    }
    case 'ended': {
      if (action === 'rematch' && p.id === room.host) { ctx.rematch(room); return { ok: true }; }
      return { error: '未知操作' };
    }
  }
  return { error: '未知操作' };
}
function beginSheriffVote(room) {
  if (checkGameEnd(room)) return; // v1.6.4（A2-1）
  if (!room.candidates.length) {
    room.lastVoteResult = { kind: 'sheriff', totals: {}, max: 0, result: 'none', exiled: null, tied: null };
    ctx.startDiscuss(room);
    return;
  }
  room.phase = 'sheriff_vote';
  room.votes = {};
  ctx.bump(room);
  ctx.schedulePhase(room, 'sheriff_vote', () => resolveSheriffVote(room)); // 超时未投视为弃票
}
function beginPkVote(room) {
  if (checkGameEnd(room)) return; // v1.6.4（A2-1）
  room.phase = 'pk_vote';
  room.votes = {};
  ctx.bump(room);
  ctx.schedulePhase(room, 'pk_vote', () => resolvePkVote(room));
}
function resolvePkVote(room) {
  const res = computeVotes(room, true);
  if (room.pkIsSheriff) { // 1.7.4：警长 PK——得票最多当选，再平票无人当选
    room.pkIsSheriff = null;
    room.lastVoteResult = {
      kind: 'sheriff_pk', totals: res.totals, max: res.max,
      result: res.tie ? 'tie' : (res.winner ? 'elected' : 'none'),
      exiled: res.winner, tied: res.tied || null,
    };
    if (res.winner && !res.tie) room.sheriff = res.winner;
    ctx.startDiscuss(room);
    return;
  }
  room.lastVoteResult = {
    kind: 'pk', totals: res.totals, max: res.max,
    result: res.tie ? 'tie' : (res.winner ? 'exile' : 'none'),
    exiled: res.winner, tied: res.tied || null,
  };
  if (res.winner && !res.tie) exilePlayer(room, res.winner);
  else ctx.beginNight(room);
}

/* ---------------------------- 消息 ---------------------------- */

register("startVote", startVote);
register("computeVotes", computeVotes);
register("allAliveVoted", allAliveVoted);
register("resolveExileVote", resolveExileVote);
register("exilePlayer", exilePlayer);
register("afterExile", afterExile);
register("resolveSheriffVote", resolveSheriffVote);
register("beginSheriffPkVote", beginSheriffPkVote);
register("checkGameEnd", checkGameEnd);
register("thirdFaction", thirdFaction);
register("checkWin", checkWin);
register("dayAction", dayAction);
register("beginSheriffVote", beginSheriffVote);
register("beginPkVote", beginPkVote);
register("resolvePkVote", resolvePkVote);

module.exports = {};
