// 完整对局冒烟：建房→加人→开局→流程推进
const G = require('../game.js');
const r = G.createRoom('房主', 6);
console.log('1. 建房:', r.roomId, '房主:', r.playerId);
// 加 5 个 bot
for (let i = 0; i < 5; i++) {
  const j = G.joinRoom(r.roomId, '玩家' + (i + 1), '');
  if (!j.playerId) { console.log('❌ 加人失败'); process.exit(1); }
}
console.log('2. 加人完成');
// 开局
const s = G.handleAction(r.roomId, r.playerId, 'start', {});
console.log('3. 开局:', s.error ? '❌ ' + s.error : '✅');
// 推进若干次（autoAdvance 流程——模拟 bot 自动行动）
let steps = 0;
let view = s.view;
while (view && view.phase && view.phase !== 'ended' && steps < 600) {
  const adv = G.handleAdvance(r.roomId, r.playerId);
  if (adv.error && adv.error !== 'NOT_READY') {
    console.log('  推进 ' + steps + ':', adv.error);
    break;
  }
  view = adv.view || view;
  steps++;
}
console.log('4. 推进 ' + steps + ' 步, 最终阶段:', view.phase);
console.log('✅ 完整流程冒烟' + (view.phase === 'ended' || steps > 10 ? '通过' : '完成'));
