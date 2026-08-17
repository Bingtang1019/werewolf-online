'use strict';
/* =========================================================================
 * wolfTrain/rollout.js —— 夜刀候选 × 模拟"刀后 1 白天投票结算"（v1.7.7 α4，对齐点③）
 * simFn(world, pid) → 'wolf' | 'good' | null（复用现有 1 轮投票模拟的狼胜判定）
 * 调用顺序：decideNightKill 先出候选池（top-3 置信度）→ rollout 精排 → 选胜率最高。
 * 成本：3 候选 × n 模拟/夜刀；n=60 时 ≈180 局等效/夜刀（325 局/s 下 +0.6s/夜刀，可接受）。
 * ========================================================================= */
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

async function rolloutNightKill(world, candidates, simFn, { n = 30, rng = null } = {}) {
  const out = [];
  for (const pid of candidates) {
    let wolfWins = 0, draws = 0;
    for (let k = 0; k < n; k++) {
      const end = await simFn(world, pid, rng);
      if (end === 'wolf') wolfWins++;
      else if (end === null || end === undefined) draws++;
    }
    out.push({ pid, winRate: wolfWins / (n - draws || 1), draws });
  }
  return out.sort((a, b) => b.winRate - a.winRate);
}

/* rollout-lite 同步版：用同步 simFn 精排候选（LAB_WOLF_ROLLOUT=1 启用） */
function rolloutNightKillSync(world, candidates, simFn, { n = 16, rng = null } = {}) {
  const out = [];
  for (const pid of candidates) {
    let wolfWins = 0, draws = 0;
    for (let k = 0; k < n; k++) {
      const end = simFn(world, pid, rng);
      if (end === 'wolf') wolfWins++;
      else if (end === null || end === undefined) draws++;
    }
    out.push({ pid, winRate: wolfWins / (n - draws || 1), draws });
  }
  return out.sort((a, b) => b.winRate - a.winRate);
}

/* 轻量 simFn：按狼 bot 当前信念判断“杀掉该候选是否利好狼”。
 * 候选被相信是狼 → 杀掉狼对狼不利 → good；候选被相信是好人 → 杀掉好人对狼有利 → wolf。 */
function simulateWolfKillLite(world, pid) {
  const pWolf = (world.scores && world.scores[pid] != null) ? world.scores[pid] : 0.5;
  return pWolf >= 0.5 ? 'good' : 'wolf';
}

/* 完整 simFn：刀后世界模拟（LAB_WOLF_ROLLOUT_FULL=1 启用）。
 * 1) 从 world.allVoters 移除被刀候选 pid；
 * 2) 按狼 bot 信念分数采样剩余玩家身份（狼队友强制为狼）；
 * 3) 模拟下一个白天的投票：好人投最高嫌疑（跟票集中），狼投最低嫌疑非队友；
 * 4) 若白天被放逐者是好人对狼有利 → 'wolf'；放逐狼 → 'good'；无人投票/平局无法裁决 → null。
 * 纯函数：绝不修改传入 world；随机性由调用方注入 rng（确定性纪律）。 */
function simulateWolfKillFull(world, pid, rng) {
  if (!rng) throw new Error('simulateWolfKillFull requires injected rng（确定性纪律 B1-7 P0②）');
  const alive = (world.allVoters || []).filter(id => id !== pid);
  if (alive.length < 2) return null;
  const teammates = world.teammates || [];
  const sc = world.scores || {};
  const scoreOf = id => (sc[id] == null ? 0.5 : sc[id]);
  // 采样剩余玩家身份：狼队友已知为狼；其余按 P(wolf) 伯努利。
  const wolfSet = new Set();
  for (const id of alive) {
    if (teammates.includes(id)) { wolfSet.add(id); continue; }
    if (rng.next() < clamp(scoreOf(id), 0.05, 0.95)) wolfSet.add(id);
  }
  // 刀到狼队友：狼队主动减员，直接判不利（无需再看白天）。
  if (teammates.includes(pid)) return 'good';
  // 模拟白天投票：全部存活者按随机顺序发言/投票（rng 注入保证确定性），
  // 好人投最高嫌疑、狼投最低嫌疑非队友；跟票集中与 decideVote 语义一致。
  const voters = alive.slice();
  for (let i = voters.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = voters[i]; voters[i] = voters[j]; voters[j] = t;
  }
  const counts = {};
  for (const voter of voters) {
    if (wolfSet.has(voter)) {
      // 狼：投最低嫌疑的非队友（混淆视线，与 decideVote 狼分支一致）。
      let best = null, bestS = Infinity;
      for (const c of alive) {
        if (teammates.includes(c)) continue;
        const s = scoreOf(c);
        if (s < bestS) { bestS = s; best = c; }
      }
      if (best) counts[best] = (counts[best] || 0) + 1;
      continue;
    }
    // 好人：投最高嫌疑；已有票的最高嫌疑候选优先（跟票集中，与 decideVote 一致）。
    let lead = null, leadN = 0;
    for (const k of Object.keys(counts)) if (counts[k] > leadN) { leadN = counts[k]; lead = k; }
    let best = null, bestS = -Infinity;
    for (const c of alive) { const s = scoreOf(c); if (s > bestS) { bestS = s; best = c; } }
    const top = [];
    for (const c of alive) if (Math.abs(scoreOf(c) - bestS) < 1e-9) top.push(c);
    let pick = null;
    if (lead && top.includes(lead)) pick = lead;
    else if (top.length) pick = top[rng.int(top.length)];
    if (pick) counts[pick] = (counts[pick] || 0) + 1;
  }
  const keys = Object.keys(counts);
  if (!keys.length) return null;
  let maxN = 0;
  for (const k of keys) if (counts[k] > maxN) maxN = counts[k];
  const tied = keys.filter(k => counts[k] === maxN);
  const exiled = tied.length === 1 ? tied[0] : tied[rng.int(tied.length)];
  return wolfSet.has(exiled) ? 'good' : 'wolf';
}

module.exports = { rolloutNightKill, rolloutNightKillSync, simulateWolfKillLite, simulateWolfKillFull };
