'use strict';
/* =========================================================================
 * build-vote-v3-samples.js —— vote-v3 训练样本生成（1.7.17）
 *  - 输入：vv3-*.jsonl（run-batch 采集，含 vote_cast/claim/role + rolloutAudit dv 标签）
 *  - 重放：信念引擎增量（方向修复版）→ 每票时刻提取 25 维特征（13 快照 + 12 信念/因果/时序）
 *  - 输出：data/vote-v3/{tag}.jsonl（{gameId, f[25], tIsWolf, dvTarget}）
 * 用法：node tools/ai/build-vote-v3-samples.js [--dir=test/lab/data] [--tags=12a,9a] [--out=data/vote-v3]
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const { voteFeatures } = require(path.join(root, 'server/ai/features.js'));
const { createBeliefEngine, applyEvent, getBeliefs } = require(path.join(root, 'server/ai/belief-engine.js'));

const args = process.argv.slice(2);
const get = (k, d) => { const eq = args.find(a => a.startsWith(k + '=')); if (eq) return eq.slice(k.length + 1); const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const inDir = path.resolve(root, get('--dir', 'data/batch'));
const outDir = path.resolve(root, get('--out', 'data/vote-v3'));
const tagsArg = get('--tags', 'all');
const TAGS = ['4p', '6p', '8p', '9a', '9b', '9c', '9d', '12a', '12b', '12c', '12d', '12e', '12f', '12g', '12h', '15p'];
fs.mkdirSync(outDir, { recursive: true });

const FEAT_NAMES = ['seat_norm', 'ring_dist', 'talk_count', 'checked_wolf', 'checked_good', 'votes_against', 'prev_votes', 'claims_seer', 'claims_god', 'accused_count', 'counter_seer', 'vote_lead', 'bot_prev_same',
  'bel_posterior', 'bel_cred_cand', 'bel_cred_voter', 'bel_vote_share', 'death_infer', 'check_verified', 'claim_suspect', 'vote_lead_order', 'follow_strength', 'seer_check', 'wolf_kill_survivor', 'cred_derived'];
// 1.7.17 数据源限制：records 事件流无发言文本（speech 只有 counts）——
// 文本类特征（checked_wolf/checked_good/claims_seer/claims_god/accused_count/counter_seer/bot_prev_same）
// 在重放中恒为 0（标注：需 NLU/消息落盘后补全——V5.1c）
// 可用特征：位置 2 + talk_count（speech 重建）+ 票型 3（votes_against/vote_lead/prev_votes）+ 信念 12 = 19 维
const TEXT_FEATURES = [3, 4, 8, 9, 10, 11, 12]; // 索引：checked_wolf, checked_good, claims_seer, claims_god, accused_count, counter_seer, bot_prev_same（7 个文本类——恒 0）

function extractV3Features(room, voterId, candId, bel, tot) {
  const base = voteFeatures(room, voterId, candId);
  if (!base) return null;
  const alive = room.players.filter(p => p.alive);
  const n = Math.max(1, alive.length);
  const p = bel.posterior[candId] != null ? bel.posterior[candId] : 0.5;
  const cc = bel.credibility[candId] != null ? bel.credibility[candId] : 0.5;
  const cv = bel.credibility[voterId] != null ? bel.credibility[voterId] : 0.5;
  const share = tot ? (tot[candId] || 0) / Math.max(1, Object.keys(tot).length) : 0;
  // 死亡因果链（被刀者投过候选次数——方向修复：嫌疑-）
  const deathInfer = Math.min(1, (room._deathInferCounts && room._deathInferCounts[candId] || 0) / 3);
  // 查验验证（候选被查杀声明数——方向修复：狼悍跳居多 → 嫌疑+（因为声明反向））
  const claimSuspect = Math.min(1, (room._claimSuspectCounts && room._claimSuspectCounts[candId] || 0) / 2);
  // 候选当前票型是否第一
  let voteLeadOrder = 0;
  if (tot) {
    const sorted = Object.entries(tot).sort((a, b) => b[1] - a[1]);
    if (sorted.length && sorted[0][0] === candId) voteLeadOrder = 1;
  }
  // 跟票关系强度（投票者跟随候选票型）
  const follows = bel.follows[voterId] || {};
  let followStrength = 0;
  for (const [lead, cnt] of Object.entries(follows)) if (lead === candId) followStrength = Math.min(1, cnt / 3);
  // 查验声明（messages 里的金水/查杀）
  let seerCheck = 0;
  for (const m of room.messages || []) {
    if (m.ch === 'all' && m.from !== voterId && m.text && m.text.includes(candId === candId ? '' : '')) {}
    if (m.ch === 'all' && m.from !== voterId && m.text) {
      const cand = room.players.find(q => q.id === candId);
      if (cand && m.text.includes(cand.name) && m.text.includes('查杀')) { seerCheck = 1; break; }
    }
  }
  // 被刀者保过候选（金水方向）
  const wolfKillSurvivor = 0;
  // 可信度波动（近期变化——简化：与 0.5 的距离）
  const credDerived = Math.abs(cc - 0.5) * 2;
  return base.concat([p, cc, cv, share, deathInfer, 0, claimSuspect, voteLeadOrder, followStrength, seerCheck, wolfKillSurvivor, credDerived]);
}

(async () => {
  const tags = tagsArg === 'all' ? TAGS : tagsArg.split(',');
  for (const tag of tags) {
    const file = path.join(inDir, `vv3-${tag}.jsonl`);
    if (!fs.existsSync(file)) { console.log(`[v3] 跳过 ${tag}（文件不存在）`); continue; }
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const outLines = [];
    const t0 = Date.now();
    for (const l of lines) {
      const r = JSON.parse(l);
      const players = r.players || [];
      const idx = new Map(players.map((p, i) => [p.id, i]));
      const alive = players.map(() => true);
      const room = { players, messages: [], votes: {}, lastVoteResult: null, actionLog: [], _deathInferCounts: {}, _claimSuspectCounts: {} };
      const counts = {};
      for (const p of players) { const rk = String(p.roleKey || '').toLowerCase(); if (rk.includes('wolf')) counts.wolf = (counts.wolf || 0) + 1; else if (rk.includes('seer')) counts.seer = (counts.seer || 0) + 1; else if (rk.includes('witch')) counts.witch = (counts.witch || 0) + 1; else if (rk.includes('guard')) counts.guard = (counts.guard || 0) + 1; else if (rk.includes('hunter')) counts.hunter = (counts.hunter || 0) + 1; else if (rk.includes('cupid')) counts.cupid = (counts.cupid || 0) + 1; else counts.villager = (counts.villager || 0) + 1; }
      const eng = createBeliefEngine(players, counts);
      const truth = new Map(); for (const p of players) truth.set(p.id, String(p.roleKey || '').toLowerCase().includes('wolf') ? 1 : 0);
      const auditQ = new Map();
      for (const a of r.rolloutAudit || []) { if (a.dv == null) continue; if (!auditQ.has(a.bot)) auditQ.set(a.bot, []); auditQ.get(a.bot).push(a); }
      let lastSnapTotals = null;
      for (const ev of r.events || []) {
        applyEvent(eng, ev);
        const t = ev.t;
        if (t === 'speech' && ev.data && ev.data.counts) {
          // 发言量重建（数据源限制：无文本，仅 counts——talk_count 特征可用）
          for (const [pid, cnt] of Object.entries(ev.data.counts)) {
            for (let k = 0; k < Math.min(3, cnt); k++) room.messages.push({ ch: 'all', from: pid, text: '' });
          }
        }
        if (t === 'deaths' && ev.data && Array.isArray(ev.data.deaths)) { for (const d of ev.data.deaths) { const i = idx.get(typeof d === 'string' ? d : d.id); if (i != null) alive[i] = false; } }
        if (t === 'exile' && ev.data && ev.data.exiled) { const i = idx.get(ev.data.exiled); if (i != null) alive[i] = false; }
        if (t === 'vote' && ev.data && ev.data.totals) {
          // 结算后：上轮票数（prev_votes 特征）——vote 事件在 exile 前，本轮的 vote_cast 已过，下轮才消费
          room.lastVoteResult = { totals: ev.data.totals };
        }
        if (t === 'vote_cast' && ev.data && Array.isArray(ev.data.votes)) {
          room.votes = {}; for (const v of ev.data.votes) { if (v.voter !== ev.data.voter) room.votes[v.voter] = v.target; } // 1.7.17：排除本次票（决策时刻语义——与 voteFeatures A-2 一致）
          // lastVoteResult 保留（上轮 vote 事件设置——prev_votes 特征；首轮无则 null）
          const tot = {}; for (const v of ev.data.votes) tot[v.target] = (tot[v.target] || 0) + 1;
          lastSnapTotals = tot;
          const voter = ev.data.voter;
          const q = auditQ.get(voter); const aud = q && q.length ? q.shift() : null;
          if (!alive[idx.get(voter)] || truth.get(voter)) continue;
          const bel = getBeliefs(eng);
          for (const cand of players) {
            if (cand.id === voter || !alive[idx.get(cand.id)]) continue;
            const fe = extractV3Features(room, voter, cand.id, bel, tot);
            if (!fe) continue;
            outLines.push(JSON.stringify({ gameId: r.gameId, f: fe, tIsWolf: truth.get(cand.id), dvTarget: aud ? aud.dv : null }));
          }
        }
      }
    }
    fs.writeFileSync(path.join(outDir, tag + '.jsonl'), outLines.join('\n'));
    console.log(`[v3] ${tag}: ${lines.length} 局 → ${outLines.length} 样本对（${((Date.now() - t0) / 1000).toFixed(0)}s）`);
  }
  console.log('[v3] 完成');
})().catch(e => { console.error(e); process.exit(1); });
