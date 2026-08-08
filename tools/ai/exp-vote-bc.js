'use strict';
/* =========================================================================
 * exp-vote-bc.js —— V5 判定实验 2：BC from decideVote
 * 目标：π(13维公开特征) → decideVote 输出（label = audit 的 dv——纯规则策略输出，无 rollout 污染）
 * 判定：π 的 top-1 准确率 vs decideVote 自身命中率（54.4% 基线）——π 接近老师 → BC 有效
 *       → 策略网络能承载投票决策 → 路径 B 可行（rollout 可退役）
 * 数据：records-v5-bc（vote_cast 事件 + rolloutAudit dv 标签）
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
    records: get('--records', path.join(root, 'data', 'records-v5-bc')),
    quick: a.includes('--quick'),
    hidden: parseInt(get('--hidden', '64'), 10),
    epochs: parseInt(get('--epochs', '30'), 10),
    seed: parseInt(get('--seed', '42'), 10),
  };
}

function main() {
  const opt = parseArgs();
  const dir = opt.records;
  const files = fs.existsSync(dir)
    ? (fs.statSync(dir).isDirectory() ? fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)) : [dir])
    : [];
  if (!files.length) { console.log('[exp2] 无数据（--records）'); process.exit(1); }

  /* ---- 重放：vote_cast 特征 + audit dv 对齐 ---- */
  const samples = []; // { botId, candId, y(dv 是否投 cand), feats }
  const games = [];
  for (const f of files) for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (rec.events && rec.rolloutAudit) games.push(rec);
    } catch (e) {}
  }
  console.log(`[exp2] records=${games.length} 局`);
  for (const rec of games) {
    const players = rec.players || [];
    const idx = new Map(players.map((p, i) => [p.id, i]));
    const alive = players.map(() => true);
    const room = { players, messages: [], votes: {}, lastVoteResult: null, actionLog: [] };
    const evs = (rec.events || []).slice().sort((a, b) => (a.i || 0) - (b.i || 0));
    // audit 队列：botId → 决策记录队列（顺序 = 决策序）
    const auditQ = new Map();
    for (const a of rec.rolloutAudit || []) {
      if (a.dv == null) continue;
      if (!auditQ.has(a.bot)) auditQ.set(a.bot, []);
      auditQ.get(a.bot).push(a);
    }
    let lastSnapTotals = null;
    for (const ev of evs) {
      const t = ev.t;
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
        // 找该 voter 的下一条 audit（dv 标签）——决策先于落票，队列头即本次
        const q = auditQ.get(voter);
        const aud = q && q.length ? q.shift() : null;
        if (aud && alive[idx.get(voter)] != null && alive[idx.get(voter)]) {
          const vp = players[idx.get(voter)];
          for (const cand of players) {
            if (cand.id === voter || !alive[idx.get(cand.id)]) continue;
            const feats = voteFeatures(room, voter, cand.id);
            if (!feats) continue;
            samples.push({ botId: voter, candId: cand.id, y: aud.dv === cand.id ? 1 : 0, feats });
          }
          if (vp) room.actionLog.push({ action: 'vote', actor: vp.seat, data: { target: ev.data.target } });
        }
      }
    }
  }
  console.log(`[exp2] 对齐样本（voter×cand，label=dv）=${samples.length}`);

  /* ---- 划分（按 botId） ---- */
  const bots = [...new Set(samples.map(s => s.botId))];
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const trainB = new Set(), testB = new Set();
  for (const b of bots) { if (rnd() < 0.8) trainB.add(b); else testB.add(b); }
  const train = samples.filter(s => trainB.has(s.botId));
  const test = samples.filter(s => testB.has(s.botId));
  console.log(`[exp2] train=${train.length} test=${test.length}（按 botId 划分，防同 bot 泄漏）`);

  /* ---- 基线：decideVote 自身的命中率（dv 目标是否为狼——用真相） ---- */
  // 注：dv 是规则策略输出；"命中"= dv 目标为狼（与实验 1 的真相口径一致）
  // 用 test 集重放局回填真相太贵——直接用训练 MLP 的 top-1 对比：π(dv) vs 随机
  const testByVoter = new Map();
  for (const s of test) {
    const k = s.botId;
    if (!testByVoter.has(k)) testByVoter.set(k, []);
    testByVoter.get(k).push(s);
  }
  // 随机基线（top-1 随机选）
  let randCorrect = 0, randTotal = 0;
  for (const [k, arr] of testByVoter) {
    const pick = arr[Math.floor(rnd() * arr.length)];
    randTotal++;
    if (pick.y === 1) randCorrect++;
  }
  console.log(`[exp2] 随机基线 top-1: ${(100 * randCorrect / Math.max(1, randTotal)).toFixed(1)}%`);

  /* ---- MLP 训练（BC：学 dv 输出） ---- */
  const D = train[0].feats.length;
  const m = new MLP({ hidden: opt.hidden, epochs: opt.quick ? 5 : opt.epochs, lr: 1e-3, batch: 256, l2: 1e-4, seed: opt.seed });
  const X = train.map(s => s.feats), Y = train.map(s => s.y);
  const vX = test.slice(0, Math.floor(test.length * 0.2)).map(s => s.feats);
  const vY = test.slice(0, Math.floor(test.length * 0.2)).map(s => s.y);
  const t0 = Date.now();
  m.fit(X, Y, vX, vY, null);
  console.log(`[exp2] MLP 训练完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);

  /* ---- π 的 top-1（候选集内最高分 = dv 目标） ---- */
  let predCorrect = 0, predTotal = 0;
  for (const [k, arr] of testByVoter) {
    let best = null, bs = -Infinity;
    for (const s of arr) {
      const p = m.predict(s.feats);
      if (p > bs) { bs = p; best = s; }
    }
    if (best) { predTotal++; if (best.y === 1) predCorrect++; }
  }
  const acc = 100 * predCorrect / Math.max(1, predTotal);
  console.log(`\n[exp2] π(dv) top-1 准确率: ${predCorrect}/${predTotal} = ${acc.toFixed(1)}%`);
  console.log(`[exp2] 参考：decideVote 自身命中率（实验 1 审计）= 54.4%；随机 ≈ 1/候选数 ≈ 9-11%`);
  console.log(`\n[exp2] 判定: ${acc >= 50 ? '✅ π 能承载 decideVote 行为（BC 有效）→ 路径 B 可行（rollout 可退役）' : acc >= 40 ? '⚠ π 部分学到（需更强特征/架构）' : '❌ BC 失败（特征不足）→ 路径 B 受阻'}`);
}

if (require.main === module) main();
module.exports = { main };
