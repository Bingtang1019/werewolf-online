'use strict';
/* 审计修复回归测试（P0/P1）：CUR_RNG 注入、vote_share 单一口径、A-2 严格模式、cfg 维度、
 * 态度模型初始化/除零、查杀否定句、rollout 噪声抽样确定性、stale π 模型 fail-open。 */
require('../server/ai/bot-brain/index.js'); // 注册 bot-brain ctx
const shared = require('../server/ai/bot-brain/shared.js');
const S = shared.S;
const ctx = shared.ctx;
const { voteShare } = require('../server/ai/vote-state.js');
const { getBeliefs, createBeliefEngine } = require('../server/ai/belief-engine.js');
const v4 = require('../server/ai/value-model-v4.js');
const { rolloutVote } = require('../server/ai/rollout.js');
const { createRng } = require('../server/ai/rng.js');
const attitudes = require('../server/ai/bot-brain/attitudes.js');
const { beliefFeatures25 } = require('../server/ai/bot-brain/vote.js');
const { loadPi } = require('../server/ai/vote-pi.js');

let failures = 0;
function assert(c, m) { if (c) console.log(' ok  ' + m); else { failures++; console.error(' FAIL: ' + m); } }

/* 1. CUR_RNG：S.CUR_RNG 写入必须进入 rng() 闭包（审计 #1） */
{
  const fake = { next: () => 0.42, int: () => 0 };
  S.CUR_RNG = fake;
  assert(ctx.rng() === fake, 'S.CUR_RNG 写入生效（ctx.rng() 返回注入 RNG）');
  S.CUR_RNG = null;
  assert(ctx.rng() === global.rng, 'S.CUR_RNG=null 回退 global.rng');
}

/* 2. vote_share 单一口径：候选得票 / 总票数（审计 #4） */
{
  const room = { votes: { a: 'X', b: 'X', c: 'Y' } };
  assert(Math.abs(voteShare(room, 'X') - 2 / 3) < 1e-9, 'voteShare(X)=2/3（总票数口径）');
  assert(Math.abs(voteShare(room, 'Y') - 1 / 3) < 1e-9, 'voteShare(Y)=1/3');
  const featsRoom = {
    players: [
      { id: 'b1', name: '甲', seat: 1, alive: true, role: 'villager' },
      { id: 'c1', name: '乙', seat: 2, alive: true, role: 'wolf' },
      { id: 'c2', name: '丙', seat: 3, alive: true, role: 'villager' },
    ],
    messages: [], votes: { b1: 'c1', c2: 'c1' }, lastVoteResult: { totals: {} }, actionLog: [], day: 1, _voteCastCount: 0,
  };
  featsRoom._beliefEngine = createBeliefEngine(featsRoom.players, { wolf: 1, villager: 2 });
  featsRoom._belCache = { bel: getBeliefs(featsRoom._beliefEngine) };
  const f = beliefFeatures25(featsRoom, 'b1', 'c1');
  assert(Array.isArray(f) && f.length === 25, 'beliefFeatures25 输出 25 维');
  assert(f && Math.abs(f[16] - voteShare(featsRoom, 'c1')) < 1e-9, 'beliefFeatures25[16] 与 voteShare 同口径');
}

/* 3. buildX：config=null 也必须补齐 cfg one-hot（审计 #8） */
{
  const m = v4.loadV4();
  if (m) {
    const st = { R: 2, S: 3, M: 4, cap: 12, wolf0: 3, god0: 4, vill0: 5, info: {} };
    const a = v4.buildX(st, m, '12a');
    const b = v4.buildX(st, m, null);
    assert(a.length === b.length, `buildX config=null 维度一致（${a.length}）`);
    const cfgLen = (m.cfgKeys || []).length;
    assert(b.slice(11, 11 + cfgLen).every(x => x === 0), 'config=null → cfg one-hot 全零');
  } else { console.log(' skip: V4 模型未加载'); }
}

/* 4. A-2 严格模式：LAB_A2=1 时缺配置必须抛；默认 fail-open 返回 0（审计 #9/#10） */
{
  const st = { R: 2, S: 3, M: 4, cap: 12, wolf0: 3, god0: 4, vill0: 5, info: {} };
  if (v4.loadV4()) {
    process.env.LAB_A2 = '1';
    let threw = false;
    try { v4.payoff(st, st, '__unknown_cfg__'); } catch (e) { threw = true; }
    assert(threw, 'LAB_A2=1 + 未训配置 → payoff 抛错');
    process.env.LAB_A2 = '0';
    const v = v4.payoff(st, st, '__unknown_cfg__');
    assert(v === 0, 'LAB_A2=0（默认）→ fail-open 返回 0');
    delete process.env.LAB_A2;
  } else { console.log(' skip: V4 模型未加载'); }
}

/* 5. 态度模型：未初始化可直接更新；矩阵变换不产生 Infinity/NaN（审计 #5/#6） */
{
  const room = { players: [{ id: 'a' }, { id: 'b' }], nightNum: 10, dayNum: 5, votes: {}, lastVoteResult: null };
  const bot = { id: 'a', role: 'villager', botMemory: {} };
  assert(Array.isArray(attitudes.getDynamicMatrix('balanced', 10)[0]), 'getDynamicMatrix 可计算');
  const mat = attitudes.getDynamicMatrix('balanced', 20);
  assert(mat.flat().every(Number.isFinite), 'getDynamicMatrix 深夜轮无 Infinity/NaN');
  assert(mat.every(row => Math.abs(row.reduce((a, b) => a + b, 0) - 1) < 1e-6), 'getDynamicMatrix 行和为 1');
  attitudes.updateAttitude5(room, bot, 'b', S.EVIDENCE.VOTE_AGAINST, 1);
  assert(!!bot.botMemory.attitudes && !!bot.botMemory.attitudes.b, 'updateAttitude5 未初始化也能安全执行');
}

/* 6. 警长票证据：dayNum 缺失不重复处理（审计 #7） */
{
  const room = { players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], nightNum: 2, votes: { b: 'c' }, lastVoteResult: { kind: 'sheriff' } };
  const bot = { id: 'a', role: 'villager', botMemory: {} };
  attitudes.processAdditionalEvidence(room, bot);
  const first = bot.botMemory.lastSheriffRound;
  assert(first !== undefined && first !== null, 'dayNum 缺失时写入稳定 dayKey（不再 undefined 反复处理）');
  const before = JSON.stringify(bot.botMemory.attitudes || {});
  attitudes.processAdditionalEvidence(room, bot);
  assert(JSON.stringify(bot.botMemory.attitudes || {}) === before, '同 dayKey 重复调用不重复应用警长证据');
}

/* 7. isCheckedTarget 排除否定句（审计 #11） */
{
  const t = { id: 'x', name: '阿青' };
  const mk = text => ({ messages: [{ ch: 'all', text }] });
  assert(ctx.isCheckedTarget(mk('查杀阿青'), t) === true, '“查杀阿青”识别为查杀');
  assert(ctx.isCheckedTarget(mk('我不是查杀阿青'), t) === false, '“我不是查杀阿青”不再误判');
  assert(ctx.isCheckedTarget(mk('查杀阿蓝'), t) === false, '查杀他人不误判');
}

/* 8. rollout 噪声：关闭时确定性不变，开启时结果有效（审计 #12） */
{
  const world = { faction: 'good', me: 'a', teammates: [], scores: { b: 0.8, c: 0.3, d: 0.4, e: 0.5 }, allVoters: ['a', 'b', 'c', 'd', 'e'],
    wolfAlive: 2, godAlive: 2, villAlive: 3, wolfInit: 3, godInit: 3, villInit: 5, configKey: '12p', hasPreset: false, info: {} };
  const state = ['b', 'c', 'd', 'e'];
  delete process.env.LAB_ROLLOUT_NOISE;
  const r1 = rolloutVote(world, state, createRng(42), { worlds: 8, useValue: false });
  const r2 = rolloutVote(world, state, createRng(42), { worlds: 8, useValue: false });
  assert(JSON.stringify(r1) === JSON.stringify(r2), 'LAB_ROLLOUT_NOISE=0 时同 seed 结果一致');
  process.env.LAB_ROLLOUT_NOISE = '0.05';
  const r3 = rolloutVote(world, state, createRng(42), { worlds: 8, useValue: false });
  const r4 = rolloutVote(world, state, createRng(42), { worlds: 8, useValue: false });
  assert(r3 && state.includes(r3.target), 'LAB_ROLLOUT_NOISE>0 仍返回合法候选');
  assert(r3.margin === null || Number.isFinite(r3.margin), 'LAB_ROLLOUT_NOISE>0 margin 有限或 null（无 NaN）');
  assert(JSON.stringify(r3) === JSON.stringify(r4), '噪声开启时同 seed 仍确定性');
  delete process.env.LAB_ROLLOUT_NOISE;
}

/* 9. stale 信念 π 模型 fail-open（审计 #4 后续：口径变更后旧模型废弃） */
{
  delete process.env.MODEL_VOTE_PI;
  assert(loadPi(false) === null, 'stale 的 vote-pi-belief-v1 fail-open（返回 null → 调用方回退 dv）');
  assert(loadPi(true) !== null, '13 维快照版 π 仍可加载（不受影响）');
}

if (failures) { console.error(`\n审计修复回归: ${failures} 项失败`); process.exit(1); }
console.log('\n审计修复回归测试全部通过');
