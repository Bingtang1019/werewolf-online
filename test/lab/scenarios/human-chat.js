'use strict';
/* test/lab/scenarios/human-chat.js —— NLU 端到端：真人预言家每天报查验（有/无 NLU 解析对比）
 * 用法：node test/lab/lab.js human-chat --games=200 --cap=12 --counts="wolf=3,seer=1,witch=1,villager=7" [--nlu=0|1] [--fake-seer=0|1]
 */
const path = require('path');
const Game = require('../../../game.js');
const { runOneLabGame } = require('../core/room-runner');
const { runPool } = require('../core/pool');
const { createRecorder } = require('../core/recorder');
const { summarize } = require('../stats/report');

function injectSeerChat(room, host) {
  const hostP = room.players.find(p => p.id === host);
  const role = String(hostP && (hostP.roleKey || hostP.role) || '').toLowerCase();
  if (!hostP || (!role.includes('seer') && !role.includes('预言家'))) return; // 死后仍可发言（遗言/死后聊天），保证查验信息能注入
  if (!room._nluInjectedClaims) room._nluInjectedClaims = new Set();
  if (process.env.LAB_DEBUG_NLU === '1') console.log('[nlu-debug] injectSeerChat role=' + role + ' seerHistory=' + JSON.stringify(room.seerHistory));
  const reported = room._nluInjectedClaims;
  // 优先用真实 seerHistory；lab 中 host 是真人不会自动查验，则用真实身份模拟“完美预言家”报查验
  let targets = [];
  if (room.seerHistory && room.seerHistory.length) {
    for (const h of room.seerHistory) {
      if (h.night >= room.dayNum) continue;
      const key = 'h:' + h.night + ':' + h.target;
      if (reported.has(key)) continue;
      const target = room.players.find(p => p.id === h.target);
      if (!target) continue;
      targets.push({ target, isWolf: h.result === 'wolf', key });
    }
  }
  if (!targets.length) {
    const cand = room.players.find(p => p.id !== host && p.role && !reported.has('t:' + p.id));
    if (cand) {
      const isWolf = cand.role === 'wolf' || cand.role === 'wolfBeauty';
      targets.push({ target: cand, isWolf, key: 't:' + cand.id });
    }
  }
  for (const { target, isWolf, key } of targets) {
    const text = `我是预言家，昨晚查了${target.name}：${isWolf ? '查杀' : '金水'}`;
    if (process.env.LAB_DEBUG_NLU === '1') console.log('[nlu-debug] inject seer claim target=' + target.name + ' isWolf=' + isWolf + ' text=' + text);
    try { const rr = Game.handleChat(room.id, host, { ch: 'all', text }, 0); if (process.env.LAB_DEBUG_NLU === '1') console.log('[nlu-debug] chat result', JSON.stringify(rr)); reported.add(key); } catch (e) { if (process.env.LAB_DEBUG_NLU === '1') console.log('[nlu-debug] chat error', e.message); }
  }
}

function injectFakeSeerChat(room, host) {
  // 找一只狼扮演悍跳预言家，每天对一个好人假查杀（用于训练/评估抗干扰）
  const fake = room.players.find(p => p.id !== host && (p.role === 'wolf' || p.role === 'wolfBeauty'));
  if (!fake) return;
  if (!room._nluInjectedFakeClaims) room._nluInjectedFakeClaims = new Set();
  const reported = room._nluInjectedFakeClaims;
  const target = room.players.find(p => p.id !== host && p.id !== fake.id && p.role && p.role !== 'wolf' && p.role !== 'wolfBeauty' && !reported.has('f:' + p.id));
  if (!target) return;
  const text = `我是预言家，昨晚查了${target.name}：查杀`;
  if (process.env.LAB_DEBUG_NLU === '1') console.log('[nlu-debug] inject fake seer claim target=' + target.name);
  try { Game.handleChat(room.id, fake.id, { ch: 'all', text }, 0); reported.add('f:' + target.id); } catch (e) { /* 注入失败不影响 */ }
}

function planTasks(cfg) {
  const ROOT = path.resolve(__dirname, '..', '..', '..');
  const out = path.isAbsolute(cfg.out || '') ? cfg.out : path.join(ROOT, cfg.out || 'data/lab-human-chat.jsonl');
  const rec = createRecorder(out);
  const nlu = cfg.nlu !== 0; // --nlu=0 关闭 NLU 注入（对照）
  const fakeSeer = cfg.fakeSeer === 1; // --fake-seer=1 额外注入狼悍跳假预言家
  let i = -1;
  return {
    total: cfg.games, rec, out, nlu, fakeSeer,
    next() {
      if (++i >= cfg.games) return null;
      const gameId = `hc-${i}`;
      if (rec.has(gameId)) return { skip: true, gameId };
      return { id: gameId, gameId, seed: `${cfg.seed || 'hc'}-${i}`, full: true };
    },
  };
}
async function run(cfg) {
  const gen = planTasks(cfg);
  const records = [];
  const nlu = gen.nlu, fakeSeer = gen.fakeSeer;
  const onDiscuss = nlu ? (room, host) => { injectSeerChat(room, host); if (fakeSeer) injectFakeSeerChat(room, host); } : null;
  await runPool(cfg.games, cfg.parallel, async (i, seed) => {
    const r = await runOneLabGame(Object.assign({}, cfg, { hostRole: 'seer', onDiscuss, seed, gameId: `hc-${i}` }));
    if (!gen.rec.has(r.gameId)) gen.rec.write(r);
    records.push(r);
    return r;
  }, { seedBase: cfg.seed || 'hc', doneSet: gen.rec, onProgress: (f, t, ms) => process.stderr.write(`\r[lab] ${f}/${t}  (${(ms / 1000).toFixed(0)}s)`) });
  gen.rec.close();
  const s = summarize(records);
  console.log('\n--- 阵营胜率（NLU=' + (nlu ? 'on' : 'off') + (fakeSeer ? ' + fake-seer' : '') + '）---');
  for (const [c, v] of Object.entries(s.camps)) console.log(`${c.padEnd(6)} ${(v.pct * 100).toFixed(1)}% (${v.wins}/${v.n})  [${(v.ci[0] * 100).toFixed(1)}%, ${(v.ci[1] * 100).toFixed(1)}%]`);
  console.log(`超时 ${s.timeouts} | 错误 ${JSON.stringify(s.errors)} | 平均局时 ${(s.avgDurMs / 1000).toFixed(1)}s`);
}
module.exports = { run, planTasks, report: () => {}, streamable: false };
