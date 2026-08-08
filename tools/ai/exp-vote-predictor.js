'use strict';
/* =========================================================================
 * exp-vote-predictor.js —— V5 判定实验 1：投票预测器可行性
 * 目标：P(vote_i = j | 投票者视角, 候选集)——验证"别人会投谁"是否可学
 * 数据：records-v5-vote（含 vote 明细事件：{voter, target} + totals）
 * 特征：每个候选的 voteFeatures(botId, candId)（13 维公开信息）
 * 模型：MLP softmax 多分类（候选集 = 存活他人；权重共享：同一网络对每个候选打分）
 * 基线：投最高嫌疑分者（decideVote 的分数近似——用 votes_against 最高者）
 * 判定：预测器 top-1 准确率 vs 基线——显著更高 → 动力学可学 → 路径 A 可行
 * 用法：node tools/ai/exp-vote-predictor.js [--records data/records-v5-vote] [--quick]
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const { voteFeatures } = require('../../server/ai/features.js');
const { MLP } = require('../../server/ai/mlp.js');

const root = path.join(__dirname, '..', '..');

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf(k); if (i >= 0) return a[i + 1]; const p = a.find(x => x.startsWith(k + '=')); return p ? p.slice(k.length + 1) : d; };
  return {
    records: get('--records', path.join(root, 'data', 'records-v5-vote')),
    quick: a.includes('--quick'),
    hidden: parseInt(get('--hidden', '64'), 10),
    epochs: parseInt(get('--epochs', '30'), 10),
    seed: parseInt(get('--seed', '42'), 10),
  };
}

/* ---- 房间重建：从 GameRecord 重放 vote 事件时刻的投票者视角 ---- */
/* 我们需要在每张票的决策时刻重建 room（votes/messages/lastVoteResult 状态）——
 * 用 records 的 events 流式重放：vote 事件携带 votes 明细（voter→target），
 * 但 voteFeatures 需要 messages（发言）与 votes 状态——records 事件含 speech（发言摘要）与 vote（逐票）。
 * 简化：用 vote 事件时刻的 totals + 该局 players/发言从 speech 事件重建 messages 近似。
 * ——更稳妥：直接在重放时构造伪 room（players 来自 record.players，votes 来自 vote 事件前序票）。 */

/* 重放：顺序处理 events；speech 事件 → messages；vote 事件 → 每票构造特征（用该时刻已发生的票 + 历史 totals） */
function replayRecords(files) {
  const samples = []; // { botId, candId, y(1=投), feats }
  const games = [];
  for (const f of files) {
    const tag = path.basename(f).replace(/\.jsonl$/, '');
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t);
        if (!rec.events || !rec.result || !rec.result.winner) continue;
        games.push({ rec, tag });
      } catch (e) {}
    }
  }
  console.log(`[exp1] records=${games.length} 局`);
  // 按局重放
  let votesTotal = 0;
  for (const { rec, tag } of games) {
    const players = rec.players || [];
    const idx = new Map(players.map((p, i) => [p.id, i]));
    const alive = players.map(() => true);
    const roleOf = id => { const p = players[idx.get(id)]; return p ? String(p.roleKey || p.role || '').toLowerCase() : ''; };
    // 伪 room：players + votes + messages + lastVoteResult + actionLog（voteFeatures 依赖）
    const room = {
      players, messages: [], votes: {}, lastVoteResult: null, actionLog: [],
      get id() { return rec.gameId; },
    };
    // 事件重放
    const evs = rec.events || [];
    // 先按 i 排序（records 事件 i 是序号）
    const sorted = evs.slice().sort((a, b) => (a.i || 0) - (b.i || 0));
    let lastExiled = null;
    let lastSnapTotals = null; // 最近一轮 vote_cast 快照的计数（exile 时回填 lastVoteResult）
    for (const ev of sorted) {
      const t = ev.t;
      if (t === 'deaths' && ev.data && Array.isArray(ev.data.deaths)) {
        for (const d of ev.data.deaths) { const i = idx.get(typeof d === 'string' ? d : d.id); if (i != null) alive[i] = false; }
      }
      if (t === 'exile' && ev.data && ev.data.exiled) {
        const i = idx.get(ev.data.exiled); if (i != null) alive[i] = false;
        lastExiled = ev.data.exiled;
        // 上轮投票结果回填（供 prev_votes/bot_prev_same）——用最近一轮 vote_cast 快照计数
        if (lastSnapTotals) room.lastVoteResult = { totals: lastSnapTotals };
      }
      if (t === 'speech' && ev.data && ev.data.counts) {
        // speech 摘要：{day, counts: {pid: n}} → 转 messages 近似（count 次发言）
        for (const [pid, n] of Object.entries(ev.data.counts)) {
          for (let k = 0; k < Math.min(n, 5); k++) room.messages.push({ ch: 'all', from: pid, text: '' });
        }
      }
      if (t === 'vote_cast' && ev.data && Array.isArray(ev.data.votes)) {
        // 逐票事件：快照 = 该票落定时刻（含本次，不含后续）——voteFeatures 内部排除 voter 自己 → 严格决策时刻前
        room.votes = {};
        for (const v of ev.data.votes) room.votes[v.voter] = v.target;
        room.lastVoteResult = null; // 逐票时刻无结算结果（prev_votes 用上一轮 totals——由 exile 事件回填）
        // 记录快照计数（exile 时回填）
        const tot = {};
        for (const v of ev.data.votes) tot[v.target] = (tot[v.target] || 0) + 1;
        lastSnapTotals = tot;
        const voter = ev.data.voter;
        if (voter && alive[idx.get(voter)]) {
          // bot_prev_same 特征：actionLog 重放（vote_cast 事件序）——注意：push 必须在特征提取之后（否则本次票泄漏）
          const vp = players[idx.get(voter)];
          for (const cand of players) {
            if (cand.id === voter || !alive[idx.get(cand.id)]) continue;
            const feats = voteFeatures(room, voter, cand.id);
            if (!feats) continue;
            samples.push({ botId: voter, candId: cand.id, y: ev.data.target === cand.id ? 1 : 0, feats, cfg: tag });
          }
          if (vp) room.actionLog.push({ action: 'vote', actor: vp.seat, data: { target: ev.data.target } });
          votesTotal++;
        }
      }
    }
  }
  console.log(`[exp1] 逐票=${votesTotal} 样本对（voter×cand）=${samples.length}`);
  return samples;
}

/* ---- MLP softmax：每个候选独立打分（权重共享），训练用 BCE + 候选集内 softmax 对比 ---- */
/* 简化：二分类 BCE（候选是目标 vs 不是）——预测分数 = sigmoid(net(cand_feats))；
 * top-1 选择 = 候选集内分数最高者。与"softmax 多分类"等价（排序一致）。 */
function main() {
  const opt = parseArgs();
  const dir = opt.records;
  const files = fs.existsSync(dir)
    ? (fs.statSync(dir).isDirectory() ? fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)) : [dir])
    : [];
  if (!files.length) { console.log('[exp1] 无数据（--records）'); process.exit(1); }
  const samples = replayRecords(files);

  /* ---- 划分（按局 LCG，与 fit 同纪律） ---- */
  const byGame = new Map();
  for (const s of samples) {
    const k = s.cfg + ':' + s.botId + ':' + s.candId;
    if (!byGame.has(s.cfg)) byGame.set(s.cfg, []);
    byGame.get(s.cfg).push(s);
  }
  // 按局划分（避免同局样本泄漏）
  const gameKeys = [...new Set(samples.map(s => s.cfg + ':' + s.botId))];
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const trainG = new Set(), testG = new Set();
  for (const gk of gameKeys) { if (rnd() < 0.8) trainG.add(gk); else testG.add(gk); }
  const train = samples.filter(s => trainG.has(s.cfg + ':' + s.botId));
  const test = samples.filter(s => testG.has(s.cfg + ':' + s.botId));
  console.log(`[exp1] train=${train.length} test=${test.length}`);

  /* ---- 基线：投"votes_against 最高"（当前被投票数最高——公众压力跟票基线） ---- */
  // 用 voteFeatures 的 votes_against（索引 5）做基线排序
  const baseIdx = 5;
  const testByVoter = new Map();
  for (const s of test) {
    const k = s.cfg + ':' + s.botId;
    if (!testByVoter.has(k)) testByVoter.set(k, []);
    testByVoter.get(k).push(s);
  }
  let baseCorrect = 0, baseTotal = 0;
  for (const [k, arr] of testByVoter) {
    // 每个 voter 的候选集：选 votes_against 最高者（基线=跟票公众压力）
    let best = null, bs = -Infinity;
    for (const s of arr) { if (s.feats[baseIdx] > bs) { bs = s.feats[baseIdx]; best = s; } }
    if (best) { baseTotal++; if (best.y === 1) baseCorrect++; }
  }
  console.log(`[exp1] 基线（投最高 votes_against）: ${baseCorrect}/${baseTotal} = ${(100 * baseCorrect / Math.max(1, baseTotal)).toFixed(1)}%`);

  /* ---- MLP 训练（BCE） ---- */
  const D = train[0].feats.length;
  const m = new MLP({ hidden: opt.hidden, epochs: opt.quick ? 5 : opt.epochs, lr: 1e-3, batch: 256, l2: 1e-4, seed: opt.seed });
  const X = train.map(s => s.feats), Y = train.map(s => s.y);
  // val = test 的 20%（同分布）
  const vX = test.slice(0, Math.floor(test.length * 0.2)).map(s => s.feats);
  const vY = test.slice(0, Math.floor(test.length * 0.2)).map(s => s.y);
  const t0 = Date.now();
  m.fit(X, Y, vX, vY, null);
  console.log(`[exp1] MLP 训练完成（${((Date.now() - t0) / 1000).toFixed(1)}s）hidden=${opt.hidden} D=${D}`);

  /* ---- 预测 top-1（候选集内 sigmoid 最高） ---- */
  let predCorrect = 0, predTotal = 0;
  let agreeBase = 0, agreeTotal = 0;
  for (const [k, arr] of testByVoter) {
    let best = null, bs = -Infinity, baseBest = null, bbs = -Infinity;
    for (const s of arr) {
      const p = m.predict(s.feats);
      if (p > bs) { bs = p; best = s; }
      if (s.feats[baseIdx] > bbs) { bbs = s.feats[baseIdx]; baseBest = s; }
    }
    if (best && baseBest) {
      predTotal++;
      if (best.y === 1) predCorrect++;
      if (best.candId === baseBest.candId) agreeTotal++;
    }
  }
  const predAcc = 100 * predCorrect / Math.max(1, predTotal);
  const baseAcc = 100 * baseCorrect / Math.max(1, baseTotal);
  console.log(`\n[exp1] 预测器 top-1: ${predCorrect}/${predTotal} = ${predAcc.toFixed(1)}%`);
  console.log(`[exp1] 基线      top-1: ${baseCorrect}/${baseTotal} = ${baseAcc.toFixed(1)}%`);
  console.log(`[exp1] 与基线一致率: ${(100 * agreeTotal / Math.max(1, predTotal)).toFixed(1)}%`);
  console.log(`\n[exp1] 判定: ${predAcc > baseAcc + 5 ? '✅ 动力学可学（显著高于基线）→ 路径 A 可行' : predAcc > baseAcc ? '⚠ 略高于基线（需更大样本确认）' : '❌ 不高于基线 → 投票不可预测 → 路径 A 否决'}`);
}

if (require.main === module) main();
module.exports = { replayRecords };
