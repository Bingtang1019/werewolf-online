'use strict';
/* 房主 V5 托管（F）：
 * H1 开关：host_autoplay 只有房主可操作，开启后写入真实对局反馈日志、视图下发托管状态、
 *       所有房主普通操作被拒绝（仅关闭托管可用）。
 * H2 调度：pendingBotActors 在投票/夜晚等阶段把托管房主纳入“待代行动玩家”。
 * H3 决策：createBotDecision 在 reveal hostChoice 自动返回 hostPick random；发牌后自动 confirm。
 * 运行：node test/check-host-autoplay.js
 */
process.env.LAB_NO_MODEL = '1';
process.env.SNAPSHOT_SEC = '0';
process.env.LAB_NO_CHAOS = '1';
process.env.BOT_DELAY_MS = '50';

const fs = require('fs');
const os = require('os');
const path = require('path');
// 必须在 require server/game 前设置，actions.js 在模块加载时读取该常量
process.env.HOST_AUTOPLAY_LOG = path.join(os.tmpdir(), 'host-autoplay-test-' + process.pid + '.jsonl');
const Game = require('../server/game');
const shared = require('../server/game/shared');
const { createBotDecision } = require('../bot-brain');

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(' ✓ ' + msg);
  else { failures++; console.error(' ✗ FAIL: ' + msg); }
}

(async () => {
  // 独立临时日志文件，避免污染 data/（真实运行由 HOST_AUTOPLAY_LOG 可配置）
  process.env.HOST_AUTOPLAY_LOG = path.join(os.tmpdir(), 'host-autoplay-test-' + process.pid + '.jsonl');
  try { fs.unlinkSync(process.env.HOST_AUTOPLAY_LOG); } catch (e) {}

  /* ---------- H1 开关/锁定/日志 ---------- */
  const base = Game.debugRoom({ roles: [{ id: 'H', name: '房主' }, { id: 'B', name: '人机·阿蓝', isBot: true }] });
  base.host = 'H';
  const host = base.players[0];
  const r1 = Game.handleAction(base.id, 'H', 'host_autoplay', { enable: true, level: 'smart' });
  assert(!!r1.ok, 'H1 房主可开启 V5 托管');
  assert(host.hostAutoplay === true && host.autoplayLevel === 'smart', 'H1 服务端记录托管状态与力度');
  const v1 = Game.viewFor(base, 'H');
  assert(v1.my.hostAutoplay === true && v1.my.autoplayLevel === 'smart', 'H1 视图下发托管状态');
  assert(!!Game.handleAction(base.id, 'H', 'mood', { mood: null }).error, 'H1 托管中拒绝普通房主操作');
  const n1 = Game.handleAction(base.id, 'X', 'host_autoplay', { enable: true });
  assert(!!n1.error, 'H1 非房主无法操作托管');
  const log = process.env.HOST_AUTOPLAY_LOG;
  assert(fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('"type":"on"'), 'H1 开启托管写入反馈日志');
  const r2 = Game.handleAction(base.id, 'H', 'host_autoplay', { enable: false });
  assert(!!r2.ok && host.hostAutoplay === false, 'H1 可关闭托管');
  assert(fs.readFileSync(log, 'utf8').includes('"type":"off"'), 'H1 关闭托管写入反馈日志');

  /* ---------- H2 调度包含托管房主 ---------- */
  const voteRoom = Game.debugRoom({ phase: 'vote', roles: [
    { id: 'H', name: '房主' }, { id: 'B', name: '人机·阿蓝', isBot: true }, { id: 'C', name: '人机·阿紫', isBot: true }
  ] });
  voteRoom.host = 'H';
  voteRoom.players[0].hostAutoplay = true;
  voteRoom.players[0].autoplayLevel = 'smart';
  const pending = shared.ctx.pendingBotActors(voteRoom);
  assert(pending.some(p => p.id === 'H'), 'H2 vote 阶段托管房主进入待行动列表');

  /* ---------- H3 reveal 自动选身份/confirm ---------- */
  const revRoom = Game.debugRoom({ phase: 'reveal', roles: [
    { id: 'H', name: '房主' }, { id: 'B', name: '人机·阿蓝', isBot: true }
  ] });
  revRoom.host = 'H';
  const rh = revRoom.players[0];
  rh.hostAutoplay = true;
  rh.autoplayLevel = 'smart';
  revRoom.reveal = { stage: 'hostChoice', hostPicked: false, thiefId: null, thiefPicked: false, dealt: false, deck: ['wolf', 'seer', 'villager'] };
  const d1 = createBotDecision(revRoom, rh);
  assert(d1 && d1.action === 'hostPick' && d1.data.role === 'random', 'H3 Reveal 自动 hostPick(random)');
  revRoom.reveal.dealt = true;
  revRoom.reveal.stage = 'dealt';
  const d2 = createBotDecision(revRoom, rh);
  assert(d2 && d2.action === 'confirm', 'H3 发牌后托管房主自动 confirm');

  if (failures) {
    console.error('\n房主 V5 托管测试失败 ' + failures + ' 项');
    process.exit(1);
  }
  console.log('\n房主 V5 托管全部通过 ✔');
})();
