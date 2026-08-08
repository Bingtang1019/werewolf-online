// tools/ai/exp-belief.js —— V5.1a 验收：信念引擎（证据图+贝叶斯更新）后验校准
// 判定：后验 vs 真实身份（ROC AUC + 桶偏差）——信念引擎自身的验收（在 π 配对之前）
// 数据：data/records-v5-vote/*.jsonl（vote_cast 事件已就位）
// 用法：node tools/ai/exp-belief.js [--quick]
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { createBeliefEngine, applyEvent, getBeliefs } = require(path.join(root, 'server', 'ai', 'belief-engine.js'));

const quick = process.argv.includes('--quick');
const dataDir = path.join(root, 'test', 'lab', 'data');
const files = fs.existsSync(dataDir) ? fs.readdirSync(dataDir).filter(f => f.startsWith('belief4') && f.endsWith('.jsonl')) : [];
if (!files.length) { console.log('未找到 belief.jsonl（需先采集：node test/lab/run-batch.js --tag belief ...）'); process.exit(1); }
const use = quick ? files.slice(0, 1) : files;
console.log('数据文件: ' + use.length + ' 个（' + (quick ? 'quick' : '全量') + '）');

// 收集：每天每个存活玩家 { posterior, isWolf }
const samples = []; // { p, y }
let games = 0, events = 0;
for (const fn of use) {
  const lines = fs.readFileSync(path.join(dataDir, fn), 'utf8').split('\n').filter(Boolean);
  for (const l of lines) {
    const r = JSON.parse(l);
    games++;
    const players = r.players || [];
    const counts = { wolf: 0, villager: 0, seer: 0, witch: 0, guard: 0, hunter: 0, wolfBeauty: 0, cupid: 0 };
    for (const p of players) {
      const rk = String(p.roleKey || '').toLowerCase();
      if (rk.includes('wolf')) { if (rk.includes('beauty')) counts.wolfBeauty++; else counts.wolf++; }
      else if (rk.includes('seer')) counts.seer++;
      else if (rk.includes('witch')) counts.witch++;
      else if (rk.includes('guard')) counts.guard++;
      else if (rk.includes('hunter')) counts.hunter++;
      else if (rk.includes('cupid')) counts.cupid++;
      else counts.villager++;
    }
    const eng = createBeliefEngine(players, counts);
    // 重放事件，在每天 exile 后采样（局中状态）
    const evs = r.events || [];
    let lastNight = 0;
    for (const ev of evs) {
      events++;
      applyEvent(eng, ev);
      if (ev.t === 'exile') {
        lastNight = ev.night;
        // 采样：所有存活玩家（排除已死）——用真实身份
        const aliveIds = new Set(players.filter(p => eng.alive.has(p.id)).map(p => p.id));
        const bel = getBeliefs(eng);
        for (const p of players) {
          if (!aliveIds.has(p.id)) continue;
          const isWolf = String(p.roleKey || '').toLowerCase().includes('wolf');
          samples.push({ p: bel.posterior[p.id], y: isWolf ? 1 : 0 });
        }
      }
    }
  }
}
console.log('对局: ' + games + ' 事件: ' + events + ' 样本: ' + samples.length + '（仅存活玩家——投票决策实际判别对象）');
if (!samples.length) { console.log('无样本'); process.exit(1); }

// ---- ROC AUC ----
const sorted = samples.map((s, i) => ({ ...s, i })).sort((a, b) => b.p - a.p);
const nPos = samples.filter(s => s.y === 1).length;
const nNeg = samples.length - nPos;
let rankSum = 0;
sorted.forEach((s, idx) => { if (s.y === 1) rankSum += idx + 1; });
const auc = (rankSum - nPos * (nPos + 1) / 2) / (nPos * nNeg);

// ---- 桶偏差（按后验分 5 桶，实际狼率 vs 后验均值）----
const bins = [0, 0, 0, 0, 0];
const binsN = [0, 0, 0, 0, 0];
for (const s of samples) {
  const b = Math.min(4, Math.floor(s.p * 5));
  bins[b] += s.y;
  binsN[b]++;
}
console.log('\n===== V5.1a 信念引擎验收 =====');
console.log('样本: ' + samples.length + '（狼 ' + nPos + ' / 好人 ' + nNeg + '）');
console.log('ROC AUC: ' + auc.toFixed(4));
console.log('\n桶偏差（后验区间 → 实际狼率）:');
for (let b = 0; b < 5; b++) {
  const lo = b / 5, hi = (b + 1) / 5;
  const rate = binsN[b] ? 100 * bins[b] / binsN[b] : 0;
  const mid = (lo + hi) / 2;
  console.log('  [' + lo.toFixed(1) + ',' + hi.toFixed(1) + ') n=' + String(binsN[b]).padStart(6) + ' 实际狼率=' + rate.toFixed(1) + '%  vs 后验中点=' + (100 * mid).toFixed(0) + '%  ' + (Math.abs(rate - 100 * mid) < 12 ? '✓' : '⚠'));
}
// 基线对比（先验=狼占比）
const base = 100 * nPos / samples.length;
console.log('\n基线（先验狼占比）: ' + base.toFixed(1) + '%');
console.log('AUC>0.5 且高桶>低桶 → 信念引擎有区分度（0.5=随机）');