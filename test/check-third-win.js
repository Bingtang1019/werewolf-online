'use strict';
/* 神眷者/第三方阵营胜率计算验证
 * 运行：node test/check-third-win.js
 */
const Game = require('../game.js');
const { ctx } = require('../server/game/shared.js');
const { summarize } = require('./lab/stats/report.js');
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };

// T1: checkWin 在“场上仅剩第三方”时返回 third
{
  const room = Game.debugRoom({ phase: 'vote', roles: [
    { id: 'cup', role: 'cupid', alive: true }, { id: 'w', role: 'wolf', alive: true }, { id: 'v', role: 'villager', alive: false },
  ], lovers: ['cup', 'w'], cupidCamp: 'third' });
  const win = Game.checkWin(room);
  assert(win === 'third', `T1 仅剩第三方时 checkWin=third（实际 ${win}）`);
  Game.rooms.delete(room.id);
}

// T2: lab summarize 能统计 third 胜场
{
  const rec = { schema: 'lab.game-record@1', gameId: 't', result: { winner: 'third' }, config: { cap: 3 }, players: [], events: [] };
  const s = summarize([rec]);
  assert(s.camps.third && s.camps.third.wins === 1, 'T2 summarize 统计 third 胜场');
}

// T3: thirdFaction 名单 = 情侣两人 + 丘比特（不在情侣中）
{
  const room = Game.debugRoom({ phase: 'vote', roles: [
    { id: 'cup', role: 'cupid', alive: true }, { id: 'w', role: 'wolf', alive: true }, { id: 'v', role: 'villager', alive: true },
  ], lovers: ['w', 'v'], cupidCamp: 'third' });
  const third = ctx.thirdFaction(room);
  assert(third.includes('w') && third.includes('v') && third.includes('cup'), `T3 thirdFaction=${JSON.stringify(third)} 含情侣+丘比特`);
  Game.rooms.delete(room.id);
}

if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
console.log('\n神眷者/第三方胜率计算验证全部通过 ✔');
process.exit(0);
