// tools/ai/train-critic.js —— V5.2a：玩家视角 critic 训练（监督）
// 修正设计（输入同源纪律）：critic 输入 = 玩家视角信念状态特征（与 π 同源），标签 = 终局该 bot 阵营胜（0/1）
// 不用 V4.2（全知视角 R/S/M 与 π 玩家视角不同源——GAE 要求 V(s) 与 π 状态同源）
// 输出：models/critic-v1.json（schema: critic@1）——V5.2b PPO 的 GAE 基础
// 用法：node tools/ai/train-critic.js [--records X] [--epochs 30] [--out models/critic-v1.json]
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
    records: get('--records', path.join(root, 'test', 'lab', 'data', 'belief4.jsonl')),
    quick: a.includes('--quick'),
    hidden: parseInt(get('--hidden', '32'), 10),
    epochs: parseInt(get('--epochs', '30'), 10),
    seed: parseInt(get('--seed', '7'), 10),
    out: get('--out', path.join(root, 'models', 'critic-v1.json')),
  };
}

function main() {
  const opt = parseArgs();
  const f = opt.records;
  if (!fs.existsSync(f)) { console.log('[critic] 无数据: ' + f); process.exit(1); }
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  // 收集：每个 vote_cast 时刻（好人侧），信念特征 + 终局胜率（该 bot 阵营 good → winner 含 good）
  const samples = [];
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
    const goodWin = String(r.result && r.result.winner || '').toLowerCase().includes('good');
    let lastSnapTotals = null;
    for (const ev of r.events || []) { // 原序（i 全 0）
      applyEvent(eng, ev);
      const t = ev.t;
      if (t === 'deaths' && ev.data && Array.isArray(ev.data.deaths)) { for (const d of ev.data.deaths) { const i = idx.get(typeof d === 'string' ? d : d.id); if (i != null) alive[i] = false; } }
      if (t === 'exile' && ev.data && ev.data.exiled) { const i = idx.get(ev.data.exiled); if (i != null) alive[i] = false; if (lastSnapTotals) room.lastVoteResult = { totals: lastSnapTotals }; }
      if (t === 'vote_cast' && ev.data && Array.isArray(ev.data.votes)) {
        room.votes = {}; for (const v of ev.data.votes) room.votes[v.voter] = v.target;
        room.lastVoteResult = null;
        const tot = {}; for (const v of ev.data.votes) tot[v.target] = (tot[v.target] || 0) + 1;
        lastSnapTotals = tot;
        const voter = ev.data.voter;
        if (!alive[idx.get(voter)] || truth.get(voter)) continue; // 好人侧存活
        const bel = getBeliefs(eng);
        // 状态特征 = 全候选信念 rank 摘要（投票者视角状态——critic 评估"当前局面"）
        const candRanks = [], candCred = [];
        for (const cand of players) {
          if (cand.id === voter || !alive[idx.get(cand.id)]) continue;
          candRanks.push(bel.ranks[cand.id] != null ? bel.ranks[cand.id] : 0.5);
          candCred.push(bel.credibility[cand.id] != null ? bel.credibility[cand.id] : 0.5);
        }
        // 特征：投票者信念分布（rank 最高/最低/均值/方差）+ 可信度分布 + 存活数 + 票数熵
        const nC = candRanks.length;
        if (nC < 2) continue;
        const maxR = Math.max(...candRanks), minR = Math.min(...candRanks);
        const meanR = candRanks.reduce((a, b) => a + b, 0) / nC;
        const varR = candRanks.reduce((a, b) => a + (b - meanR) ** 2, 0) / nC;
        const meanC = candCred.reduce((a, b) => a + b, 0) / nC;
        const votesArr = Object.values(tot);
        const totN = votesArr.reduce((a, b) => a + b, 0) || 1;
        const ent = -votesArr.reduce((a, b) => { const p = b / totN; return p > 0 ? a + p * Math.log(p) : a; }, 0) / Math.log(Math.max(2, votesArr.length));
        // 投票者自己的可信度 + 存活数比例
        const selfCred = bel.credibility[voter] != null ? bel.credibility[voter] : 0.5;
        const feat = [maxR, minR, meanR, varR, meanC, selfCred, nC / players.length, ent];
        samples.push({ feat, y: goodWin ? 1 : 0 });
      }
    }
  }
  console.log('[critic] 样本（状态×终局胜率）=' + samples.length + ' 局=' + games);
  // 划分（按状态样本随机——状态无 botId 归属，直接洗牌）
  let seed = opt.seed;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const sh = samples.slice().sort(() => rnd() - 0.5);
  const split = Math.floor(sh.length * 0.8);
  const train = sh.slice(0, split), test = sh.slice(split);
  const D = train[0].feat.length;
  const m = new MLP({ hidden: opt.hidden, epochs: opt.quick ? 5 : opt.epochs, lr: 1e-3, batch: 256, l2: 1e-4, seed: opt.seed });
  const vX = test.slice(0, 500).map(s => s.feat), vY = test.slice(0, 500).map(s => s.y);
  const t0 = Date.now();
  m.fit(train.map(s => s.feat), train.map(s => s.y), vX, vY, null);
  console.log('[critic] MLP 训练完成（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）');
  // 评估：V 值与终局胜率的相关性（critic 质量——GAE 前提）
  let mse = 0;
  for (const s of test) { const p = m.predict(s.feat); mse += (p - s.y) ** 2; }
  mse /= test.length;
  const meanY = train.reduce((a, s) => a + s.y, 0) / train.length;
  const baseMse = test.reduce((a, s) => a + (meanY - s.y) ** 2, 0) / test.length;
  console.log('[critic] MSE=' + mse.toFixed(4) + ' 基线=' + baseMse.toFixed(4) + ' 提升=' + (100 * (1 - mse / baseMse)).toFixed(1) + '%');
  // 分桶校准
  const bins = Array(5).fill(0).map(() => [0, 0]);
  for (const s of test) { const b = Math.min(4, Math.floor(m.predict(s.feat) * 5)); bins[b][0] += s.y; bins[b][1]++; }
  console.log('[critic] V 值分桶（预测区间 → 实际胜率）:');
  for (let b = 0; b < 5; b++) {
    if (bins[b][1]) console.log('  [' + (b / 5).toFixed(1) + ',' + ((b + 1) / 5).toFixed(1) + ') n=' + bins[b][1] + ' 实际=' + (100 * bins[b][0] / bins[b][1]).toFixed(1) + '%');
  }
  // 保存
  const out = {
    schema: 'critic@1',
    features: ['max_rank', 'min_rank', 'mean_rank', 'var_rank', 'mean_cred', 'self_cred', 'alive_frac', 'vote_entropy'],
    hidden: opt.hidden,
    trainedAt: new Date().toISOString(),
    trainGames: games,
    trainSamples: train.length,
    testSamples: test.length,
    mse: +mse.toFixed(4),
    baseMse: +baseMse.toFixed(4),
    seed: opt.seed,
    note: 'V5.2a 玩家视角 critic：输入=信念状态摘要（与 π 同源），标签=终局胜率；GAE 前提（V 与 π 状态同源——修正 V4.2 全知视角方案）',
    mlp: m.toJSON(),
  };
  fs.writeFileSync(opt.out, JSON.stringify(out));
  console.log('[critic] 模型已保存: ' + opt.out);
}

if (require.main === module) main();
module.exports = { main };
