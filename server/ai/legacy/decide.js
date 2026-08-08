'use strict';
/* =========================================================================
 * 纯行动策略接口（1.7.0，B1-1）——感知/规划分离的第一刀
 * decideVote / decideNightKill：信念 + 公开状态 → 候选排序（纯函数，零副作用）。
 *   - 输入 world 只含公开信息 + bot 自己信念（B1-7 纪律①②：绝不读真实身份）
 *   - 输出候选排序；调用方（bot-brain / rollout）在外层叠加：恋人保护、A2-4 波动、
 *     C1 混沌层"有界覆盖"（态度/情绪一律不在这里——态度排除干净，P0③）
 *   - 阵营分流（P0① 规格）：好人 argmax P(wolf)（投最像狼的）；狼 argmin P(wolf)
 *     （投最不像狼的=混淆视线的活人）且排除狼队友；night-kill 同样 argmin 且排除队友
 *     （防自刀穿帮：别刀出 P(wolf) 最高的队友，P2）
 *   - 跟票集中（防分票，v1.5.2 策略）在 decideVote 内：嫌疑前二且已有人投 → 跟票
 * world 结构（由调用方构造，本模块不碰 room）：
 *   { faction: 'wolf'|'good'|'third', teammates: [id], scores: {id: 分数(高=越像狼)},
 *     votes: {voterId: targetId}, sellTarget: id|null }
 * state：候选 id 数组（顺序稳定，调用方保证不包含自己/已出局）
 * ========================================================================= */

/* 平局打破：同分（无证据）时用注入 rng 打乱，避免稳定排序固定刀/投“座位最小”者（v1.6.4 行为回归） */
function shuffleArr(arr, rng) {
  // 1.7.3（P1-2）：rng 必须由调用方注入——Math.random 兑底是确定性泄漏点（B1-7 P0②）。
  // 缺 rng 是调用方 bug，让它在测试里炸出来。
  if (!rng) throw new Error('decideVote/decideNightKill requires injected rng（确定性纪律 B1-7 P0②）');
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/* 纯投票策略：返回 { ranked: [{id, score}...]（降序）, target: id|null } */
function decideVote(world, state, rng) {
  if (!state || !state.length) return { ranked: [], target: null };
  const isWolf = world.faction === 'wolf';
  const teammates = world.teammates || [];
  const sc = world.scores || {};
  const scoreOf = id => (sc[id] === undefined ? 0.5 : sc[id]); // 0 分合法（无嫌疑），不能用 || 兜底
  // 卖狼美人（v1.5.2 策略）：狼队投狼美人（队友）放逐带走魅惑目标——明确策略，在“排除队友”之前命中
  if (world.sellTarget && state.includes(world.sellTarget)) {
    return { ranked: state.map(id => ({ id, score: scoreOf(id) })).sort((a, b) => b.score - a.score), target: world.sellTarget };
  }
  const pool = shuffleArr(state.filter(id => !(isWolf && teammates.includes(id))), rng); // 平局随机打破（无证据时避免固定投座位最小者）
  if (!pool.length) return { ranked: [], target: null };
  const score = id => {
  const s = scoreOf(id);
  if (isWolf) return -s; // 狼：投最不像狼的（混淆视线）
  return s; // 好人：投最像狼的
};
// v1.7.6：第三方 kingmaker——谁强打谁（优势方高价值成员），维持好狼互耗、自己活到最后。
//   狼恋人红线：白天绝不能投狼（狼队视角“自己人投自己人”=当场自爆）→ 伪装跟随狼队共识或弃票；
//   好人恋人/丘比特：投优势方——好人优势投自称高价值神职者（借口“像狼”），狼优势投狼方。
if (world.faction === 'third') {
  const goodAlive = (world.godAlive || 0) + (world.villAlive || 0);
  const wolfAlive = world.wolfAlive || 0;
  const goodAdv = goodAlive >= wolfAlive;
  if (world.isWolfLover) {
    // 狼恋人：跟当前票型最高者（狼队共识目标，通常为好人），若非自己阵营；无票型则弃票
    const counts = {};
    for (const k of Object.keys(world.votes || {})) { const t = world.votes[k]; if (t && pool.includes(t)) counts[t] = (counts[t] || 0) + 1; }
    let best = null, bestN = 0;
    for (const k of Object.keys(counts)) if (counts[k] > bestN) { bestN = counts[k]; best = k; }
    return { ranked: pool.map(id => ({ id, score: scoreOf(id) })).sort((a, b) => b.score - a.score), target: best };
  }
  if (goodAdv) {
    // 好人优势 → 投自称高价值神职者（女巫>预言家>猎人>守卫>摄梦人），无则投最像好人者（P(wolf)低）
    const claims = world.roleClaims || {};
    const val = { '女巫': 5, '预言家': 4, '猎人': 3, '守卫': 2, '摄梦人': 1 };
    let best = null, bestV = -1;
    for (const id of pool) { const r = claims[id]; if (r && (val[r] || 0) > bestV) { bestV = val[r] || 0; best = id; } }
    if (best) return { ranked: pool.map(id => ({ id, score: scoreOf(id) })).sort((a, b) => b.score - a.score), target: best };
    const sorted = pool.map(id => ({ id, score: -scoreOf(id) })).sort((a, b) => b.score - a.score);
    return { ranked: sorted, target: sorted.length ? sorted[0].id : null };
  }
  // 狼优势 → 投狼方（P(wolf) 高）——丘比特/好人恋人可以投狼（借口“像狼”，不暴露）
  const sorted = pool.map(id => ({ id, score: scoreOf(id) })).sort((a, b) => b.score - a.score);
  return { ranked: sorted, target: sorted.length ? sorted[0].id : null };
}
  // 跟票集中（防分票）：嫌疑前二且已有人投 → 跟票（1.7.17（V5.2 轻量 B）：FOLLOW_MODE 变体——strict 默认 / loose 前二独立 / none 最高嫌疑）
  const votes = world.votes || {};
  const counts = {};
  for (const k of Object.keys(votes)) { const t = votes[k]; if (t && pool.includes(t)) counts[t] = (counts[t] || 0) + 1; }
  const sorted = pool.map(id => ({ id, score: score(id) })).sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, 2);
  const followMode = world.followMode || process.env.FOLLOW_MODE || 'strict';
  let target = null;
  if (followMode === 'strict') {
    for (const p of top) if (counts[p.id]) { target = p.id; break; }
  } else if (followMode === 'loose') {
    target = top.length ? top[0].id : null; // 前二独立（不看票型）
  } else {
    target = sorted.length ? sorted[0].id : null; // 最高嫌疑（无跟票）
  }
  if (!target) target = sorted.length ? sorted[0].id : null;
  return { ranked: sorted, target };
}

/* 纯狼刀策略（night-kill 间接方案）：argmin P(wolf) 排除队友（刀最像好人的活人） */
function decideNightKill(world, state, rng) {
  if (world.faction !== 'wolf') return { ranked: [], target: null };
  const teammates = world.teammates || [];
  const pool = shuffleArr(state.filter(id => !teammates.includes(id)), rng); // 平局随机打破（无证据时避免固定刀座位最小者）
  if (!pool.length) return { ranked: [], target: null };
  const sc = world.scores || {};
  const scoreOf = id => (sc[id] === undefined ? 0.5 : sc[id]);
  const ranked = pool.map(id => ({ id, score: scoreOf(id) })).sort((a, b) => a.score - b.score); // 升序：P(wolf) 最低 = 最像好人
  return { ranked, target: ranked.length ? ranked[0].id : null };
}

module.exports = { decideVote, decideNightKill };
