'use strict';
/* =========================================================================
 * train-vote-pi.js —— V5.0：π 投票策略网络训练（BC from decideVote）
 * 目标：π(13维公开特征, 候选集) → 投票目标——克隆 decideVote 行为（label=audit dv，无 rollout 污染）
 * 训练：MLP BCE（每 voter×cand 一个样本，y=dv 是否投该 cand）
 * 推理：对候选集逐 cand 打分 → argmax = π 目标
 * 输出：models/vote-pi-v1.json（schema: vote-pi@1，含 features/hidden/weights——推理端可加载）
 * 验收：top-1 输出保真（随机 9-11% 基线）；真相命中（重放回填，对照 decideVote 54.4%）
 * 数据：data/records-v5-bc（vote_cast + rolloutAudit dv）
 * 用法：node tools/ai/train-vote-pi.js [--quick] [--epochs 30] [--hidden 64] [--out models/vote-pi-v1.json]
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const { voteFeatures } = require('../../server/ai/features.js');
const { voteFeaturesV5, INTENT_FEATURE_NAMES, V5_FEATURE_NAMES } = require('../../server/ai/intent-features.js');
const { MLP } = require('../../server/ai/mlp.js');
const { createBeliefEngine, applyEvent, getBeliefs } = require('../../server/ai/belief-engine.js'); // V5.1b：信念引擎

const root = path.join(__dirname, '..', '..');

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf(k); if (i >= 0) return a[i + 1]; const p = a.find(x => x.startsWith(k + '=')); return p ? p.slice(k.length + 1) : d; };
  return {
    records: get('--records', path.join(root, 'data', 'records-v5-bc')),
    quick: a.includes('--quick'),
    belief: a.includes('--belief'), // V5.1b：信念特征扩展（后验/可信度/票数）
    v5: a.includes('--v5'), // V5 A2/A5：意图特征扩展（+8 维）
    hidden: parseInt(get('--hidden', '64'), 10),
    epochs: parseInt(get('--epochs', '30'), 10),
    seed: parseInt(get('--seed', '42'), 10),
    out: get('--out', path.join(root, 'models', 'vote-pi-v1.json')),
  };
}

/** 重放单局：产出 [样本, 真相回填]——真相 = 每局结束时 players 的 roleKey */
function replayGame(rec, useBelief, useV5) {
  const players = rec.players || [];
  const idx = new Map(players.map((p, i) => [p.id, i]));
  const alive = players.map(() => true);
  const room = { players, messages: [], votes: {}, lastVoteResult: null, actionLog: [] };
  const evs = (rec.events || []).slice();
  // 1.7.17（校准审计）：事件序——i 全 0（新数据 room-runner 转换）时保留原序（sort 不稳定会打乱）；
  // 旧数据（i 递增）按 i 稳定排序（map 携带原索引保证稳定）
  if (evs.some(e => (e.i || 0) !== 0)) {
    evs.sort((a, b) => (a.i || 0) - (b.i || 0));
  }
  // V5.1b：信念引擎并行增量（消费 deaths/exile/vote_cast/claim 事件）
  const counts = {};
  for (const p of players) {
    const rk = String(p.roleKey || p.role || '').toLowerCase();
    if (rk.includes('wolf')) { if (rk.includes('beauty')) counts.wolfBeauty = (counts.wolfBeauty || 0) + 1; else counts.wolf = (counts.wolf || 0) + 1; }
    else if (rk.includes('seer')) counts.seer = (counts.seer || 0) + 1;
    else if (rk.includes('witch')) counts.witch = (counts.witch || 0) + 1;
    else if (rk.includes('guard')) counts.guard = (counts.guard || 0) + 1;
    else if (rk.includes('hunter')) counts.hunter = (counts.hunter || 0) + 1;
    else if (rk.includes('cupid')) counts.cupid = (counts.cupid || 0) + 1;
    else counts.villager = (counts.villager || 0) + 1;
  }
  const eng = useBelief ? createBeliefEngine(players, counts) : null;
  const auditQ = new Map();
  for (const a of rec.rolloutAudit || []) {
    if (a.dv == null) continue;
    if (!auditQ.has(a.bot)) auditQ.set(a.bot, []);
    auditQ.get(a.bot).push(a);
  }
  const out = { samples: [], truth: new Map() };
  let lastSnapTotals = null;
  for (const ev of evs) {
    const t = ev.t;
    if (eng) applyEvent(eng, ev);
    if (t === 'deaths' && ev.data && Array.isArray(ev.data.deaths)) {
      for (const d of ev.data.deaths) { const i = idx.get(typeof d === 'string' ? d : d.id); if (i != null) alive[i] = false; }
    }
    if (t === 'exile' && ev.data && ev.data.exiled) {
      const i = idx.get(ev.data.exiled); if (i != null) alive[i] = false;
      if (lastSnapTotals) room.lastVoteResult = { totals: lastSnapTotals };
    }
    if (t === 'vote_cast' && ev.data && Array.isArray(ev.data.votes)) {
      room.votes = {};
      for (const v of ev.data.votes) room.votes[v.voter] = v.target;
      room.lastVoteResult = null;
      const tot = {};
      for (const v of ev.data.votes) tot[v.target] = (tot[v.target] || 0) + 1;
      lastSnapTotals = tot;
      const voter = ev.data.voter;
      const q = auditQ.get(voter);
      const aud = q && q.length ? q.shift() : null;
      if (aud && alive[idx.get(voter)] != null && alive[idx.get(voter)]) {
        const vp = players[idx.get(voter)];
        // V5.1b：信念快照（vote_cast 时刻，增量引擎已消费到该事件）
        let belSnap = null;
        if (eng) {
          const bel = getBeliefs(eng, { temperature: parseFloat(process.env.BELIEF_T || '1') }); // 校准：温度缩放（T>1 压缩过冲——输入分布改善）
          belSnap = bel;
        }
        for (const cand of players) {
          if (cand.id === voter || !alive[idx.get(cand.id)]) continue;
          const feats = useV5 ? voteFeaturesV5(room, voter, cand.id) : voteFeatures(room, voter, cand.id);
          if (!feats) continue;
          let fe = feats;
          if (belSnap) {
            if (process.env.BELIEF_NOISE === '1') { // 对照：信念特征随机化（增益是否来自特征本身）
              for (const c of players) { if (c.id !== voter) { belSnap.posterior[c.id] = 0.3 + 0.4 * Math.random(); belSnap.credibility[c.id] = 0.5; } }
            }
            // V5.1b 信念特征（附后）：候选后验 / 候选可信度 / 投票者可信度 / 候选累计票数（相对）
            fe = feats.concat([
              belSnap.posterior[cand.id] != null ? belSnap.posterior[cand.id] : 0.5,
              belSnap.credibility[cand.id] != null ? belSnap.credibility[cand.id] : 0.5,
              belSnap.credibility[voter] != null ? belSnap.credibility[voter] : 0.5,
              (tot[cand.id] || 0) / Math.max(1, Object.keys(tot).length),
            ]);
          }
          out.samples.push({ botId: voter, candId: cand.id, y: aud.dv === cand.id ? 1 : 0, feats: fe });
        }
        if (vp) room.actionLog.push({ action: 'vote', actor: vp.seat, data: { target: ev.data.target } });
      }
    }
  }
  // 真相回填：roleKey 含 'wolf' 的玩家 = 狼
  for (const p of players) {
    const rk = String(p.roleKey || p.role || '').toLowerCase();
    if (rk.includes('wolf')) out.truth.set(p.id, 1);
    else out.truth.set(p.id, 0);
  }
  return out;
}

function main() {
  const opt = parseArgs();
  const dir = opt.records;
  const files = fs.existsSync(dir)
    ? (fs.statSync(dir).isDirectory() ? fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)) : [dir])
    : [];
  if (!files.length) { console.log('[pi] 无数据（--records）'); process.exit(1); }
  const games = [];
  for (const f of files) for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { const rec = JSON.parse(t); if (rec.events && rec.rolloutAudit) games.push(rec); } catch (e) {}
  }
  console.log(`[pi] records=${games.length} 局`);
  const samples = [];
  const truths = new Map(); // botId → 该 bot 是狼?
  for (const rec of games) {
    const r = replayGame(rec, opt.belief, opt.v5);
    samples.push(...r.samples);
    for (const [id, w] of r.truth) if (!truths.has(id)) truths.set(id, w);
  }
  console.log(`[pi] 样本（voter×cand, label=dv）=${samples.length}` + (opt.belief ? '（信念特征版）' : '') + (opt.v5 ? '（意图特征版）' : ''));

  /* ---- 划分（按 botId 80/20） ---- */
  const bots = [...new Set(samples.map(s => s.botId))];
  let seed = opt.seed;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const trainB = new Set(), testB = new Set();
  for (const b of bots) { if (rnd() < 0.8) trainB.add(b); else testB.add(b); }
  const train = samples.filter(s => trainB.has(s.botId));
  const test = samples.filter(s => testB.has(s.botId));
  console.log(`[pi] train=${train.length} test=${test.length}（按 botId 划分）`);

  /* ---- 训练 ---- */
  const D = train[0].feats.length;
  const m = new MLP({ hidden: opt.hidden, epochs: opt.quick ? 5 : opt.epochs, lr: 1e-3, batch: 256, l2: 1e-4, seed: opt.seed });
  const vX = test.slice(0, Math.floor(test.length * 0.2)).map(s => s.feats);
  const vY = test.slice(0, Math.floor(test.length * 0.2)).map(s => s.y);
  const t0 = Date.now();
  m.fit(train.map(s => s.feats), train.map(s => s.y), vX, vY, null);
  console.log(`[pi] MLP 训练完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);

  /* ---- 评估 1：输出保真（π top-1 = dv 目标？） ---- */
  const testByVoter = new Map();
  for (const s of test) { if (!testByVoter.has(s.botId)) testByVoter.set(s.botId, []); testByVoter.get(s.botId).push(s); }
  let predCorrect = 0, predTotal = 0;
  for (const [k, arr] of testByVoter) {
    let best = null, bs = -Infinity;
    for (const s of arr) { const p = m.predict(s.feats); if (p > bs) { bs = p; best = s; } }
    if (best) { predTotal++; if (best.y === 1) predCorrect++; }
  }
  const acc = 100 * predCorrect / Math.max(1, predTotal);
  console.log(`\n[pi] 输出保真 top-1（π=dv?）: ${acc.toFixed(1)}%（随机基线 ~9-11%）`);

  /* ---- 评估 2：真相命中（π 目标是否投中狼）---- */
  let piHit = 0, piTotal = 0, dvHit = 0, dvTotal = 0;
  for (const [k, arr] of testByVoter) {
    const isWolfVoter = truths.get(k) === 1;
    // dv 目标
    const dvCand = arr.find(s => s.y === 1);
    // π 目标
    let piCand = null, bs = -Infinity;
    for (const s of arr) { const p = m.predict(s.feats); if (p > bs) { bs = p; piCand = s; } }
    if (isWolfVoter) continue; // 真相命中只看好人侧（狼投狼是误投）
    if (dvCand && truths.has(dvCand.candId)) { dvTotal++; if (truths.get(dvCand.candId) === 1) dvHit++; }
    if (piCand && truths.has(piCand.candId)) { piTotal++; if (truths.get(piCand.candId) === 1) piHit++; }
  }
  console.log(`[pi] 真相命中（好人侧）: π=${(100 * piHit / Math.max(1, piTotal)).toFixed(1)}%（${piHit}/${piTotal}） vs dv=${(100 * dvHit / Math.max(1, dvTotal)).toFixed(1)}%（${dvHit}/${dvTotal}）`);

  /* ---- 保存模型 ---- */
  const BASE13 = ['seat_norm', 'ring_dist', 'talk_count', 'checked_wolf', 'checked_good', 'votes_against', 'prev_votes', 'claims_seer', 'claims_god', 'accused_count', 'counter_seer', 'vote_lead', 'bot_prev_same'];
  const BELIEF4 = ['bel_posterior', 'bel_cred_cand', 'bel_cred_voter', 'bel_vote_share'];
  const features = (opt.v5 ? V5_FEATURE_NAMES.slice() : BASE13.slice()).concat(opt.belief ? BELIEF4.slice() : []);
  const out = {
    schema: 'vote-pi@1',
    features,
    belief: opt.belief ? true : false,
    intent: opt.v5 ? true : false,
    hidden: opt.hidden,
    epochs: opt.quick ? 5 : opt.epochs,
    trainedAt: new Date().toISOString(),
    trainGames: games.length,
    trainSamples: train.length,
    testSamples: test.length,
    outputFidelity: +(acc.toFixed(3)),
    truthHitPi: +(100 * piHit / Math.max(1, piTotal)).toFixed(3),
    truthHitDv: +(100 * dvHit / Math.max(1, dvTotal)).toFixed(3),
    seed: opt.seed,
    note: opt.v5
      ? 'V5 A2/A5 π（意图特征版）：13 快照 + 8 意图 + 可选 4 信念；BC from decideVote'
      : (opt.belief
        ? 'V5.1b π（信念特征版）：13 维快照 + 4 维信念（后验/可信度/票占）；BC from decideVote；配对验收锚点 62.6%+3pp'
        : 'V5.0 π：BC from decideVote（label=audit dv，无 rollout 污染）；推理=逐候选打分 argmax；口径：输出保真（行为）≠ 真相命中（决策质量）'),
    mlp: m.toJSON(),
  };
  fs.writeFileSync(opt.out, JSON.stringify(out));
  console.log(`[pi] 模型已保存: ${opt.out}`);
}

if (require.main === module) main();
module.exports = { main };
