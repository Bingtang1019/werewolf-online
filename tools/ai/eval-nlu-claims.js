'use strict';
/* tools/ai/eval-nlu-claims.js —— 离线评估 NLU 声明证据对信念质量的提升
 * 用 records 重放：baseline 只吃原始事件；NLU 额外注入“真预言家查杀/金水声明”（基于 seerHistory）。
 * 对比两者在投票时刻对存活玩家 P(狼) 的 AUC。
 * 用法：node tools/ai/eval-nlu-claims.js --records=data/records-selfplay-eps.jsonl [--limit=50]
 */
const fs = require('fs');
const path = require('path');
const { createBeliefEngine, applyEvent, getBeliefs, onClaim } = require('../../server/ai/belief-engine.js');
const { MLP } = require('../../server/ai/mlp.js');

const root = path.resolve(__dirname, '..', '..');
function get(k, d) { const i = process.argv.indexOf('--' + k); if (i >= 0) return process.argv[i + 1]; const p = process.argv.find(x => x.startsWith('--' + k + '=')); return p ? p.slice(k.length + 3) : d; }
const recordFile = path.resolve(root, get('records', 'data/records-selfplay-eps.jsonl'));
const limit = parseInt(get('limit', '0'), 10) || Infinity;
const fakeSeer = parseInt(get('fake-seer', '0'), 10) || 0;

const lines = fs.readFileSync(recordFile, 'utf8').split('\n').filter(Boolean);
let games = 0;
const baseScores = [], nluScores = [];
let baseTopHit = 0, baseTopN = 0, nluTopHit = 0, nluTopN = 0;
for (const line of lines) {
  if (games >= limit) break;
  const r = JSON.parse(line);
  games++;
  const players = r.players || [];
  const idx = new Map(players.map((p, i) => [p.id, i]));
  const truth = new Map(); for (const p of players) truth.set(p.id, String(p.roleKey || '').toLowerCase().includes('wolf') ? 1 : 0);
  const seerId = players.find(p => String(p.roleKey || '').toLowerCase().includes('seer'));
  const counts = {};
  for (const p of players) { const rk = String(p.roleKey || '').toLowerCase(); if (rk.includes('wolf')) counts.wolf = (counts.wolf || 0) + 1; else if (rk.includes('seer')) counts.seer = (counts.seer || 0) + 1; else if (rk.includes('witch')) counts.witch = (counts.witch || 0) + 1; else if (rk.includes('guard')) counts.guard = (counts.guard || 0) + 1; else if (rk.includes('hunter')) counts.hunter = (counts.hunter || 0) + 1; else if (rk.includes('cupid')) counts.cupid = (counts.cupid || 0) + 1; else counts.villager = (counts.villager || 0) + 1; }
  const engB = createBeliefEngine(players, counts);
  const engN = createBeliefEngine(players, counts);
  const seerHistory = r.seerHistory || [];
  const alive = players.map(p => true);
  let seerClaimed = false;
  let fakeClaimed = false;
  const wolves = players.filter(p => String(p.roleKey || '').toLowerCase().includes('wolf'));
  const goods = players.filter(p => !String(p.roleKey || '').toLowerCase().includes('wolf') && p.id !== (seerId && seerId.id));
  const fakeSeerId = fakeSeer && wolves.length ? wolves[0].id : null;
  const fakeTarget = fakeSeer && goods.length ? goods[0].id : null;

  const sample = () => {
    const belB = getBeliefs(engB), belN = getBeliefs(engN);
    const arrB = [], arrN = [];
    for (const p of players) {
      const i = idx.get(p.id);
      if (!alive[i] || p.id === seerId) continue;
      const pb = belB.posterior[p.id] != null ? belB.posterior[p.id] : 0.5;
      const pn = belN.posterior[p.id] != null ? belN.posterior[p.id] : 0.5;
      baseScores.push([pb, truth.get(p.id)]);
      nluScores.push([pn, truth.get(p.id)]);
      arrB.push([pb, truth.get(p.id)]);
      arrN.push([pn, truth.get(p.id)]);
    }
    if (arrB.length) {
      arrB.sort((a, b) => b[0] - a[0]);
      baseTopN++; if (arrB[0][1] === 1) baseTopHit++;
      arrN.sort((a, b) => b[0] - a[0]);
      nluTopN++; if (arrN[0][1] === 1) nluTopHit++;
    }
  };

  for (const ev of r.events || []) {
    applyEvent(engB, ev);
    applyEvent(engN, ev);
    if (ev.t === 'deaths' && ev.data && Array.isArray(ev.data.deaths)) {
      for (const d of ev.data.deaths) { const i = idx.get(typeof d === 'string' ? d : d.id); if (i != null) alive[i] = false; }
      // 真预言家声明：在夜间结算后注入该夜查验结果（模拟白天报查验）
      for (const h of seerHistory) {
        if (h.night === ev.night && seerId) {
          if (!seerClaimed) { onClaim(engN, seerId.id, 'claim_seer', null); seerClaimed = true; }
          onClaim(engN, seerId.id, h.result === 'wolf' ? 'check_wolf' : 'check_good', h.target);
        }
      }
      // 狼悍跳预言家：首夜后注入一次假查杀（对好人），检验抗干扰
      if (!fakeClaimed && fakeSeerId && fakeTarget) {
        onClaim(engN, fakeSeerId, 'claim_seer', null);
        onClaim(engN, fakeSeerId, 'check_wolf', fakeTarget);
        fakeClaimed = true;
      }
    }
    if (ev.t === 'exile' && ev.data && ev.data.exiled) { const i = idx.get(ev.data.exiled); if (i != null) alive[i] = false; }
    if (ev.t === 'vote_cast') sample();
  }
  sample(); // 终局快照也计入
}
const auc = (arr) => {
  const y = arr.map(x => x[1]), s = arr.map(x => x[0]);
  return MLP._auc(y, s);
};
const baseAuc = auc(baseScores), nluAuc = auc(nluScores);
const baseTop1 = baseTopN ? baseTopHit / baseTopN : 0;
const nluTop1 = nluTopN ? nluTopHit / nluTopN : 0;
console.log(JSON.stringify({ games, baseSamples: baseScores.length, nluSamples: nluScores.length, baseAuc, nluAuc, delta: nluAuc - baseAuc, baseTop1, nluTop1, top1Delta: nluTop1 - baseTop1, baseTopN, nluTopN }, null, 2));
