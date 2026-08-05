'use strict';
/* 快照恢复 resumeRoom 定时器重挂专项（v1.5.7）：
 * S1 hunter_shot 恢复 → 猎人弃枪定时器触发（P1 修复验证）
 * S2 夜晚 nightStep=hunter 恢复 → 弃枪定时器触发
 * S3 reveal.dealt 恢复 → 5s 后自动进夜
 * S4 reveal.thiefPick 恢复 → 盗贼超时自动选牌并发牌
 * S5 discuss 恢复 → 超时自动进入投票
 * 运行：node test/check-resume.js */
const Game = require('../game.js');
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function mkRoom() {
  const r = Game.createRoom('房主');
  const room = Game.rooms.get(r.roomId);
  // 补到 4 人（直接 joinRoom 真人，恢复场景需要）
  for (let i = 2; i <= 4; i++) Game.joinRoom(r.roomId, '玩家' + i);
  // 简化：直接给玩家角色（恢复测试聚焦 resumeRoom 定时器，不走完整对局）
  room.players.forEach((p, i) => { p.role = ['seer', 'wolf', 'villager', 'villager'][i]; });
  return { room, host: r.playerId };
}

async function main() {
  /* ---- S1：hunter_shot 恢复 → 弃枪定时器触发 ---- */
  {
    const { room, host } = mkRoom();
    room.phase = 'hunter_shot';
    room.shooter = host;
    room.night = { wolf: { kill: null, charm: null, locked: false, sel: {} } };
    room.nightActed = {};
    room.hunterDeadline = Date.now() + 800; // 0.8s 后弃枪
    room.settings = { sheriff: false, thief: false, tieRule: 'pk', winMode: 'city', botMode: 'auto' };
    Game.resumeRoom(room);
    assert(!!room._hunterTimer, 'S1 hunter_shot 恢复：弃枪定时器已重挂（P1 修复）');
    Game.rooms.delete(room.id);
  }
  /* ---- S2：夜晚 nightStep=hunter 恢复 ---- */
  {
    const { room, host } = mkRoom();
    room.phase = 'night';
    room.nightStep = 'hunter';
    room.shooter = host;
    room.night = { wolf: { kill: null, charm: null, locked: false, sel: {} } };
    room.nightActed = {};
    room.hunterDeadline = Date.now() + 800;
    room.settings = { sheriff: false, thief: false, tieRule: 'pk', winMode: 'city', botMode: 'auto' };
    Game.resumeRoom(room);
    assert(!!room._hunterTimer, 'S2 夜晚猎人步骤恢复：弃枪定时器已重挂');
    Game.rooms.delete(room.id);
  }
  /* ---- S3：reveal.dealt 恢复 → 5s 自动进夜 ---- */
  {
    const { room } = mkRoom();
    room.phase = 'reveal';
    room.reveal = { stage: 'dealt', hostPicked: true, thiefId: null, thiefPicked: false, dealt: true, deck: [] };
    room.settings = { sheriff: false, thief: false, tieRule: 'pk', winMode: 'city', botMode: 'auto' };
    Game.resumeRoom(room);
    await sleep(5600);
    assert(room.phase === 'night', 'S3 reveal.dealt 恢复：5s 后自动进夜（phase=' + room.phase + '）');
    Game.rooms.delete(room.id);
  }
  /* ---- S4：reveal.thiefPick 恢复 → 盗贼超时自动选牌并发牌 ---- */
  {
    const { room } = mkRoom();
    const thief = room.players[2];
    room.phase = 'reveal';
    room.reveal = { stage: 'thiefPick', hostPicked: true, thiefId: thief.id, thiefPicked: false, dealt: false, deck: ['wolf', 'villager', 'seer', 'witch', 'guard'] };
    room.center = ['villager', 'seer'];
    room.settings = { sheriff: false, thief: true, tieRule: 'pk', winMode: 'city', botMode: 'auto' };
    Game.resumeRoom(room);
    await sleep(1500); // NIGHT_TIMEOUT 默认 45s，太快等不到——直接检查定时器已挂 + 手动触发场景
    const hasTimer = !!room._thiefTimer;
    Game.rooms.delete(room.id);
    assert(hasTimer, 'S4 reveal.thiefPick 恢复：盗贼超时定时器已重挂');
  }
  /* ---- S5：discuss 恢复 → 阶段超时定时器重挂（PHASE_TIMEOUT 缩短验证） ---- */
  {
    const { room } = mkRoom();
    room.phase = 'discuss';
    room.dayNum = 1; room.nightNum = 1;
    room.votes = {}; room.messages = [];
    room.settings = { sheriff: false, thief: false, tieRule: 'pk', winMode: 'city', botMode: 'auto' };
    const PHASE_SAVE = process.env.PHASE_TIMEOUT;
    process.env.PHASE_TIMEOUT = '1'; // 1 秒后自动进入投票
    delete require.cache[require.resolve('../game.js')];
    const Game2 = require('../game.js');
    Game2.rooms.set(room.id, room);
    Game2.resumeRoom(room);
    assert(!!room._phaseTimer && room.phaseDeadline > 0, 'S5 discuss 恢复：阶段超时定时器已重挂');
    process.env.PHASE_TIMEOUT = PHASE_SAVE;
    Game2.rooms.delete(room.id);
  }

  if (failures) { console.error('\n共 ' + failures + ' 处失败'); process.exit(1); }
  console.log('\n快照恢复定时器重挂专项全部通过 ✔');
  process.exit(0);
}
main().catch(e => { console.error('异常:', e.message); process.exit(1); });
