'use strict';
/* favens/wolfLover.js —— 狼恋人（β 核心模块）
 * 夜间刀人 = wolf-god-v1 底座（复用 α3）+ 红线过滤（恋人 + 第三方成员）→ 次优；空候选兜底随机
 * 白天投票 = 红线（永不投狼[自爆] + 不投恋人）+ 跟票（伪装狼队共识）
 * 魅惑（狼美）保护：魅惑目标 ≠ 恋人/第三方成员
 * 继承 WOLF_CLAIM_GOD（穿衣服——与普通狼同一 botTalk 分支，自动继承，不另写一套）
 * 前提检查（v1.7.8）：wolf-god-v1 在狼美局训练（无丘比特），13 维特征无角色计数——
 *   丘比特自称不匹配神职正则 → P(神) 低 → 不被优先刀（合理）；模型不"数"身份 → 无"误判角色计数"。
 *   局四有摄梦人（训练无）——"自称神职→神"语义跨角色成立，β1 后验证摄梦人识别率。 */
const fs = require('fs');
const path = require('path');
const { AdaBoost } = require('../wolfTrain/adaboost.js');
const { wolfGodFeatures } = require('./features.js');

const GOD_PRIORITY = { '女巫': 5, '预言家': 4, '猎人': 3, '守卫': 2, '摄梦人': 1 };
let _wg = null, _wgTried = false;
function loadWolfGod() {
  if (_wgTried) return _wg;
  _wgTried = true;
  try { _wg = AdaBoost.fromJSON(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'models', 'wolf-god-v1.json'), 'utf8'))); }
  catch (e) { _wg = null; }
  return _wg;
}
function isWolf(q) { return q && (q.role === 'wolf' || q.role === 'wolfBeauty'); }
function claimsMap(room) {
  const m = new Map();
  for (const msg of room.messages || []) {
    if (msg.ch === 'all' && msg.from && msg.text) {
      const mm = msg.text.match(/我是(女巫|预言家|猎人|守卫|摄梦人)/);
      if (mm && !m.has(msg.from)) m.set(msg.from, mm[1]);
    }
  }
  return m;
}
/* 第三方成员（狼恋人视角的"自己人"）：丘比特（cupidCamp=third）+ 人狼恋的另一半
 * 人狼恋时狼恋人知道丘比特是第三方、知道恋人是好人——红线圈内。 */
function isThirdMember(room, q) {
  if (!q) return false;
  if (q.role === 'cupid') return room.cupidCamp === 'third';
  if (room.lovers && room.lovers.includes(q.id)) {
    const partnerId = room.lovers.find(id => id !== q.id);
    const p = room.players.find(x => x.id === partnerId);
    return p && (isWolf(p) !== isWolf(q)); // 人狼恋：双方身份不同
  }
  return false;
}
function loverIdOf(room, bot) {
  return room.lovers && room.lovers.includes(bot.id) ? room.lovers.find(id => id !== bot.id) : null;
}

/* 夜间刀人：刀神底座 + 红线过滤（恋人 + 第三方成员）→ 次优
 * v1.7.9（c1 实验）：FAVENS_WOLF_NIGHT_REDLINE=0 → 红线 off（狼恋人可刀恋人/第三方，含魅惑池同步放开）
 *   判读：off 利好狼 → 红线在保护好人（保留）；off 利好好人 → 红线实现有问题（刀恋人=殉情自爆本应利好狼） */
function decideNightKill(room, bot) {
  const model = loadWolfGod();
  const loverId = loverIdOf(room, bot);
  const cands = room.players.filter(q => q.alive && q.id !== bot.id && !isWolf(q));
  const redline = process.env.FAVENS_WOLF_NIGHT_REDLINE !== '0';
  const safe = redline ? cands.filter(q => q.id !== loverId && !isThirdMember(room, q)) : cands.slice();
  let pick = null;
  const claims = claimsMap(room);
  if (model) {
    let best = null, bestScore = -Infinity;
    for (const q of safe) {
      const f = wolfGodFeatures(room, bot.id, q.id);
      if (!f) continue;
      const pGod = model.predict(f);
      const claim = claims.get(q.id);
      const boost = claim && GOD_PRIORITY[claim] ? GOD_PRIORITY[claim] : (claim ? 1 : 0);
      const score = pGod + 0.5 * boost;
      if (score > bestScore) { bestScore = score; best = q; }
    }
    pick = best;
  }
  if (!pick) {
    let t = null, bestV = -1;
    for (const q of safe) { const r = claims.get(q.id); if (r && (GOD_PRIORITY[r] || 0) > bestV) { bestV = GOD_PRIORITY[r] || 0; t = q; } }
    pick = t || (safe.length ? safe[room.rng ? room.rng.int(safe.length) : Math.floor(Math.random() * safe.length)] : null);
  }
  const data = { kill: pick ? pick.id : null, confirm: true };
  // v1.7.9（c1 验证钩子，env 门控，生产零影响）：统计狼恋人刀恋人/第三方频率
  if (process.env.FAVENS_WOLF_TRACE === '1') {
    const g = global.__wlTrace = global.__wlTrace || { total: 0, loverKill: 0, thirdKill: 0, nullKill: 0 };
    g.total++;
    if (!pick) g.nullKill++;
    if (pick && pick.id === loverId) g.loverKill++;
    if (pick && isThirdMember(room, pick)) g.thirdKill++;
  }
  // 狼美魅惑保护：魅惑目标 ≠ 恋人/第三方成员（且 ≠ 刀目标）
  if (bot.role === 'wolfBeauty') {
    const charmPool = safe.filter(q => q.id !== (pick && pick.id));
    if (charmPool.length) {
      const c = room.rng ? room.rng.int(charmPool.length) : Math.floor(Math.random() * charmPool.length);
      data.charm = charmPool[c].id;
    }
  }
  return { action: 'wolf_set', data };
}

/* 白天投票：红线（永不投狼=自爆 + 不投恋人）+ 跟票（狼队共识目标，伪装跟随）
 * v1.7.8 参数化：FAVENS_WOLF_VOTE_ABSTAIN=1 → 狼恋人弃票（控 favens 狼侧偏移，β1 归因） */
/* 白天投票：红线（永不投狼=自爆 + 不投恋人）+ 跟票（狼队共识目标，伪装跟随）
 * v1.7.8 参数化：FAVENS_WOLF_VOTE_ABSTAIN=1 → 全弃票；FAVENS_WOLF_VOTE_PROB=p → 跟票概率（其余弃票） */
function decideVote(room, bot) {
  if (process.env.FAVENS_WOLF_VOTE_ABSTAIN === '1') return { action: 'vote', data: { target: null } };
  const prob = process.env.FAVENS_WOLF_VOTE_PROB != null ? Math.min(1, Math.max(0, parseFloat(process.env.FAVENS_WOLF_VOTE_PROB))) : 1;
  if (room.rng && room.rng.next() > prob) return { action: 'vote', data: { target: null } };
  const loverId = loverIdOf(room, bot);
  const counts = {};
  for (const k of Object.keys(room.votes || {})) {
    const t = room.votes[k];
    const q = room.players.find(x => x.id === t);
    if (t && t !== loverId && q && !isWolf(q) && !isThirdMember(room, q)) counts[t] = (counts[t] || 0) + 1;
  }
  let best = null, n = 0;
  for (const k of Object.keys(counts)) if (counts[k] > n) { n = counts[k]; best = k; }
  return { action: 'vote', data: { target: best } }; // 票型最高且非狼非恋人；无则弃票
}
/* v2（M1/M2）策略：保丘比特——投票避开丘比特（维持狼恋人免疫期=丘比特存活期）；其余复用 v1 跟票 */
function decideVoteV2(room, bot) {
  const d = decideVote(room, bot);
  const cupid = room.players.find(q => q.role === 'cupid' && q.alive);
  if (cupid && d && d.data && d.data.target === cupid.id) return { action: 'vote', data: { target: null } }; // 弃票避险（保免疫）
  return d;
}
module.exports = { decideNightKill, decideVote, decideVoteV2, isThirdMember };
