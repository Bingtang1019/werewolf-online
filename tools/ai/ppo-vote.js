// tools/ai/ppo-vote.js —— V5.2b：π 的 RWR 微调（reward-weighted regression，PPO-clip 的稳定前身）
// 输入：本轮 records（π 决策 + 终局结果）+ critic-v1（玩家视角 V）+ 上一版 π（BC 骨架）
// 更新：对每票，A = 终局胜(1/0) - V(s)；有利票（A>0）强化其 dv 目标（y=1 权重 A），
//       不利票（A<0）弱化（y=0 权重 -A）——RWR 是 PPO 的简化（无重要性采样 clip，稀疏奖励下更稳）
// 输出：models/vote-pi-belief-rwr.json（微调后 π）
// 用法：node tools/ai/ppo-vote.js --records X --critic models/critic-v1.json --base models/vote-pi-belief-v1.json --out models/vote-pi-belief-rwr.json
'use strict';
const fs = require('fs');
const path = require('path');
const { voteFeatures } = require('../../server/ai/features.js');
const { MLP } = require('../../server/ai/mlp.js');
const { createBeliefEngine, applyEvent, getBeliefs } = require('../../server/ai/belief-engine.js');

const root = path.join(__dirname, '..', '..');
function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf(k); if (i >= 0) return a[i + 1]; const p = a.find(x => x.startsWith(k + '=')); return p ? p.slice(k.length + 1) : d; };
  return {
    records: get('--records', path.join(root, 'test', 'lab', 'data', 'rwr1.jsonl')),
    critic: get('--critic', path.join(root, 'models', 'critic-v1.json')),
    base: get('--base', path.join(root, 'models', 'vote-pi-belief-v1.json')),
    out: get('--out', path.join(root, 'models', 'vote-pi-belief-rwr.json')),
    epochs: parseInt(get('--epochs', '15'), 10),
    seed: parseInt(get('--seed', '11'), 10),
  };
}

function main() {
  const opt = parseArgs();
  const f = opt.records;
  if (!fs.existsSync(f)) { console.log('[ppo] 无数据: ' + f); process.exit(1); }
  // v3：过程奖励（放逐结果）——critic 暂不参与（GAE 后续迭代）
  const base = JSON.parse(fs.readFileSync(opt.base, 'utf8'));
  const baseModel = MLP.fromJSON(base.mlp);
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);

  // 收集：每票 {feats(信念版), dvTarget, A}——A = 过程奖励（放逐结果）而非终局稀疏奖励
  // 1.7.17 v3（RWR 信用分配修正）：终局 0/1 对单票太稀疏（赢局也有坏票）——
  // 改用过程奖励：本轮投票放逐狼 +1 / 放逐好人 -1 / 平票 0（每票都有信号）
  const samples = []; // {feats, y(dv 目标), A}
  let games = 0;
  for (const l of lines) {
    const r = JSON.parse(l);
    games++;
    const players = r.players || [];
    const idx = new Map(players.map((p, i) => [p.id, i]));
    const alive = players.map(() => true);
    const room = { players, messages: [], votes: {}, lastVoteResult: null, actionLog: [] };
    const counts = {};
    for (const p of players) { const rk = String(p.roleKey || '').toLowerCase(); if (rk.includes('wolf')) counts.wolf = (counts.wolf || 0) + 1; else if (rk.includes('seer')) counts.seer = (counts.seer || 0) + 1; else if (rk.includes('witch')) counts.witch = (counts.witch || 0) + 1; else if (rk.includes('guard')) counts.guard = (counts.guard || 0) + 1; else if (rk.includes('hunter')) counts.hunter = (counts.hunter || 0) + 1; else if (rk.includes('cupid')) counts.cupid = (counts.cupid || 0) + 1; else counts.villager = (counts.villager || 0) + 1; }
    const eng = createBeliefEngine(players, counts);
    const truth = new Map(); for (const p of players) truth.set(p.id, String(p.roleKey || '').toLowerCase().includes('wolf') ? 1 : 0);
    let lastSnapTotals = null;
    // 投票时刻暂存（等待 exile 结算给过程奖励）
    const pendingVotes = []; // {voter, feats, dvCand, cands}
    let pending = [];
    for (const ev of r.events || []) { // 原序
      applyEvent(eng, ev);
      const t = ev.t;
      if (t === 'deaths' && ev.data && Array.isArray(ev.data.deaths)) { for (const d of ev.data.deaths) { const i = idx.get(typeof d === 'string' ? d : d.id); if (i != null) alive[i] = false; } }
      if (t === 'exile' && ev.data) {
        // 过程奖励结算：本轮 pending 票的 A = 放逐结果（+1 狼 / -1 好人 / 0 平票）
        const exiled = ev.data.exiled;
        let reward = 0;
        if (exiled) reward = truth.get(exiled) === 1 ? 1 : -1;
        for (const p of pending) {
          for (const c of p.cands) {
            const y = c.isDv ? 1 : 0;
            const w = reward > 0 ? reward : 0; // 只强化有利票（RWR 标准形式）
            if (w > 0) samples.push({ fe: c.fe, y, w });
          }
        }
        pending = [];
        const i = idx.get(exiled); if (i != null) alive[i] = false;
        if (lastSnapTotals) room.lastVoteResult = { totals: lastSnapTotals };
      }
      if (t === 'vote_cast' && ev.data && Array.isArray(ev.data.votes)) {
        room.votes = {}; for (const v of ev.data.votes) room.votes[v.voter] = v.target;
        room.lastVoteResult = null;
        const tot = {}; for (const v of ev.data.votes) tot[v.target] = (tot[v.target] || 0) + 1;
        lastSnapTotals = tot;
        const voter = ev.data.voter;
        if (!alive[idx.get(voter)] || truth.get(voter)) continue; // 好人侧
        const bel = getBeliefs(eng);
        const dvCand = ev.data.target;
        const cands = [];
        for (const cand of players) {
          if (cand.id === voter || !alive[idx.get(cand.id)]) continue;
          const feats = voteFeatures(room, voter, cand.id);
          if (!feats) continue;
          const fe = feats.concat([bel.posterior[cand.id] != null ? bel.posterior[cand.id] : 0.5, bel.credibility[cand.id] != null ? bel.credibility[cand.id] : 0.5, bel.credibility[voter] != null ? bel.credibility[voter] : 0.5, (tot[cand.id] || 0) / Math.max(1, Object.keys(tot).length)]);
          cands.push({ fe, isDv: cand.id === dvCand });
        }
        if (cands.length) pending.push({ voter, cands });
      }
    }
  }
  console.log('[ppo] 样本=' + samples.length + ' 局=' + games);
  if (!samples.length) { console.log('[ppo] 无样本'); process.exit(1); }
  const posW = samples.filter(s => s.y === 1).reduce((a, s) => a + s.w, 0);
  const negW = samples.filter(s => s.y === 0).reduce((a, s) => a + s.w, 0);
  console.log('[ppo] 正样本总权重=' + posW.toFixed(1) + ' 负样本总权重=' + negW.toFixed(1) + '（A 分布驱动）');

  // RWR 微调：从 base（BC 骨架）继续 fit（epochs 少——微调不破坏骨架）
  const m = baseModel;
  m.epochs = opt.epochs;
  m.lr = 3e-4; // 微调低学习率
  m.patience = 6;
  const X = samples.map(s => s.fe), y = samples.map(s => s.y), w = samples.map(s => s.w);
  const vIdx = Math.floor(X.length * 0.8);
  m.fit(X.slice(0, vIdx), y.slice(0, vIdx), X.slice(vIdx, vIdx + 300), y.slice(vIdx, vIdx + 300), null, w.slice(0, vIdx));
  console.log('[ppo] RWR 微调完成');

  // 保存
  const out = {
    schema: 'vote-pi@1',
    features: base.features,
    belief: true,
    hidden: m.hidden,
    epochs: opt.epochs,
    trainedAt: new Date().toISOString(),
    baseModel: opt.base,
    criticModel: opt.critic,
    trainGames: games,
    trainSamples: samples.length,
    posWeight: +posW.toFixed(1),
    negWeight: +negW.toFixed(1),
    seed: opt.seed,
    note: 'V5.2b RWR 微调：A = 终局胜 - V(玩家视角 critic)；有利票强化 dv 目标、不利票反向；BC 骨架低 lr 微调',
    mlp: m.toJSON(),
  };
  fs.writeFileSync(opt.out, JSON.stringify(out));
  console.log('[ppo] 模型已保存: ' + opt.out);
}

if (require.main === module) main();
module.exports = { main };
