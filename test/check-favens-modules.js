'use strict';
/* favens 模块单元测试（v1.7.8 β）
 * 覆盖：红线过滤（top 被过滤走次优）、人狼恋好方/狼方 conditionOn 集成、三路站队、护短 soft/never、invalid 回退 */
const assert = require('assert');
const wolfLover = require('../favens/wolfLover.js');
const goodLover = require('../favens/goodLover.js');
const cupid = require('../favens/cupid.js');
const index = require('../favens/index.js');
const { conditionOn } = require('../favens/condition.js');

function mkRoom(opts) {
  const players = (opts.roles || []).map((r, i) => ({ id: r[0], name: '玩家' + (i + 1), role: r[1], alive: r[2] !== false, isBot: true, botLevel: 'smart', botMemory: {} }));
  return {
    players, lovers: opts.lovers || null, cupidCamp: opts.cupidCamp || null,
    votes: opts.votes || {}, messages: opts.messages || [], roleCounts: opts.roleCounts || {},
    phase: 'vote', nightStep: null, night: {}, rng: null,
  };
}
const R12 = { wolf: 3, wolfBeauty: 1, seer: 1, dreamer: 1, cupid: 1, witch: 1, villager: 4 }; // 局四

/* W1 红线过滤：人狼恋狼恋人刀人——永不刀恋人（即使恋人自称神职），刀 safe 候选中的高价值者 */
{
  const room = mkRoom({
    roles: [['w', 'wolf'], ['l', 'villager'], ['s', 'seer'], ['d', 'witch'], ['c', 'cupid'], ['v', 'villager']],
    lovers: ['w', 'l'], cupidCamp: 'third', roleCounts: R12,
    messages: [{ ch: 'all', from: 'l', text: '我是预言家，昨晚查了金水' }, { ch: 'all', from: 's', text: '我是女巫，药还在' }],
  });
  const d = wolfLover.decideNightKill(room, room.players[0]);
  assert.ok(d && d.data.kill, 'W1a 有刀目标');
  assert.notStrictEqual(d.data.kill, 'l', 'W1b 红线：永不刀恋人（即使自称神职）');
  assert.ok(!wolfLover.isThirdMember(room, room.players.find(q => q.id === d.data.kill)), 'W1c 不刀第三方成员（丘比特）');
  const safe = ['s', 'd', 'v']; // 排除恋人 l + 丘比特 c
  assert.ok(safe.includes(d.data.kill), 'W1d 刀目标在 safe 候选中（实际 ' + d.data.kill + '）');
}

/* W2 人狼恋·好方：index 路由不护短、不投恋人、跟票（第三方各自为战） */
{
  const room = mkRoom({
    roles: [['w', 'wolf'], ['l', 'villager'], ['a', 'villager'], ['b', 'seer'], ['c', 'cupid']],
    lovers: ['w', 'l'], cupidCamp: 'third', roleCounts: R12,
    votes: { w: 'a', a: 'b', b: 'a' }, // 票型：a 2票 / b 1票（恋人 l 未被投）
  });
  const d = index.favensDecide(room, room.players.find(q => q.id === 'l'));
  assert.ok(d && d.action === 'vote', 'W2a 好恋人投票');
  assert.notStrictEqual(d.data.target, 'w', 'W2b 不投恋人（狼恋人）');
  assert.strictEqual(d.data.target, 'a', 'W2c 跟票（票型最高非恋人）');
}

/* W3 狼狼恋：红线过滤无操作（恋人也是狼，不在候选），刀 safe 好人 */
{
  const room = mkRoom({
    roles: [['w1', 'wolf'], ['w2', 'wolf'], ['s', 'seer'], ['v', 'villager'], ['c', 'cupid']],
    lovers: ['w1', 'w2'], cupidCamp: 'third', roleCounts: R12,
    messages: [{ ch: 'all', from: 's', text: '我是守卫，昨晚守了自己' }],
  });
  const d = wolfLover.decideNightKill(room, room.players[0]);
  assert.ok(d && d.data.kill, 'W3a 有刀目标');
  assert.ok(['s', 'v'].includes(d.data.kill), 'W3b 刀 safe 好人（实际 ' + d.data.kill + '）');
}

/* C5 集成：人狼恋好方 getBeliefs——自身锁 0、恋人（狼）锁 1、剩余 Σ=wolfCount−已知狼 */
{
  const room = mkRoom({
    roles: [['w', 'wolf'], ['l', 'villager'], ['a', 'villager'], ['b', 'seer'], ['w2', 'wolf']],
    lovers: ['w', 'l'], cupidCamp: 'third', roleCounts: { wolf: 2, seer: 1, villager: 2 },
  });
  const prior = { w: 0.2, l: 0.1, a: 0.3, b: 0.4, w2: 0.5 };
  const d = goodLover.getBeliefs(room, room.players.find(q => q.id === 'l'), prior);
  assert.strictEqual(d.w, 1, 'C5a 恋人（狼）锁 1');
  assert.strictEqual(d.l, 0, 'C5b 自身（好）锁 0');
  assert.ok(Math.abs(d.a + d.b + d.w2 - 1) < 1e-9, 'C5c 未知 Σ=wolfCount−已知狼（实际 ' + (d.a + d.b + d.w2) + '）');
}

/* G1 好恋人护短 soft：恋人被集火 → 投次优（不自称神职者→票型次高），不投恋人 */
{
  const room = mkRoom({
    roles: [['l', 'villager'], ['p', 'seer'], ['a', 'villager'], ['b', 'villager'], ['w', 'wolf']],
    lovers: ['l', 'p'], cupidCamp: 'good', roleCounts: R12,
    votes: { l: 'p', p: 'p', a: 'b' }, // 恋人 p 被集火（2票）
  });
  const d = goodLover.decideVote(room, room.players.find(q => q.id === 'l'), { protectLover: 'soft' });
  assert.notStrictEqual(d.data.target, 'p', 'G1a soft 不投恋人');
  assert.strictEqual(d.data.target, 'b', 'G1b soft 投次优（票型次高）');
}

/* G2 护短 never：恋人被集火 → 弃票 */
{
  const room = mkRoom({
    roles: [['l', 'villager'], ['p', 'seer'], ['a', 'villager']], lovers: ['l', 'p'], cupidCamp: 'good', roleCounts: R12,
    votes: { l: 'p', p: 'p' },
  });
  const d = goodLover.decideVote(room, room.players.find(q => q.id === 'l'), { protectLover: 'never' });
  assert.strictEqual(d.data.target, null, 'G2 never 弃票');
}

/* U1 丘比特三路站队：good→投自称神职者；wolf→投票型最高；third→搅局 */
{
  const r1 = mkRoom({ roles: [['c', 'cupid'], ['s', 'seer'], ['v', 'villager'], ['w', 'wolf']], cupidCamp: 'good', roleCounts: R12, messages: [{ ch: 'all', from: 's', text: '我是女巫，药还在' }] });
  const d1 = cupid.decideVote(r1, r1.players[0]);
  assert.strictEqual(d1.data.target, 's', 'U1a good 站队→投自称神职者');

  const r2 = mkRoom({ roles: [['c', 'cupid'], ['a', 'villager'], ['b', 'villager'], ['w', 'wolf']], cupidCamp: 'wolf', roleCounts: R12, votes: { w: 'a', a: 'a' } });
  const d2 = cupid.decideVote(r2, r2.players[0]);
  assert.strictEqual(d2.data.target, 'a', 'U1b wolf 站队→投票型最高');
}

/* U2 丘比特不投情侣（自连场景：情侣含丘比特） */
{
  const room = mkRoom({ roles: [['c', 'cupid'], ['l', 'villager'], ['a', 'villager'], ['w', 'wolf']], lovers: ['c', 'l'], cupidCamp: 'good', roleCounts: R12, votes: { w: 'l', a: 'l' } });
  const d = cupid.decideVote(room, room.players[0]);
  assert.notStrictEqual(d.data.target, 'l', 'U2 丘比特不投情侣');
  assert.notStrictEqual(d.data.target, 'c', 'U2b 不投自己');
}

/* I1 invalid 回退：conditionOn 冲突（已知狼>存活狼）→ getBeliefs 返回未条件化先验（不抛） */
{
  const room = mkRoom({ roles: [['w', 'wolf'], ['l', 'villager'], ['a', 'villager']], lovers: ['w', 'l'], cupidCamp: 'third', roleCounts: { wolf: 1, villager: 2 } });
  const prior = { w: 0.2, l: 0.1, a: 0.3 };
  const d = goodLover.getBeliefs(room, room.players.find(q => q.id === 'l'), prior); // knownWolf=1(恋人狼), wolfCount=1 → rest=0（合法，不冲突）
  assert.strictEqual(d.w, 1, 'I1a 恋人（狼）锁1');
  assert.strictEqual(d.a, 0, 'I1b 剩余0狼，未知归零');
  // 真正冲突：wolfCount=0 但恋人=狼 → knownWolf1>0 → throw → 返回 prior
  const room2 = mkRoom({ roles: [['w', 'wolf'], ['l', 'villager']], lovers: ['w', 'l'], cupidCamp: 'third', roleCounts: { wolf: 0, villager: 1 } });
  const d2 = goodLover.getBeliefs(room2, room2.players.find(q => q.id === 'l'), prior);
  assert.strictEqual(d2, prior, 'I1c invalid 回退未条件化先验');
}

console.log('favens 模块单元测试：W1–W3 / C5 / G1–G2 / U1–U2 / I1 全部通过');
process.exit(0);
