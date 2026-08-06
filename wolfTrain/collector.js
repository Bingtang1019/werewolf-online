'use strict';
/* =========================================================================
 * wolfTrain/collector.js —— 夜刀时刻采集（v1.7.7 α3，对齐点②）
 * 挂 game.js 的 wolf_set 成功处（与 vote 采集钩子同模式：room.labSampleFile + buf）。
 * label：victim 真实身份是否神职（seer/hunter/guard/witch/dreamer，狼美不算）。
 * ========================================================================= */
const { wolfGodFeatures } = require('./features.js');

const GOD_SET = new Set(['seer', 'hunter', 'guard', 'witch', 'dreamer']);

function collectKillSample(room, wolfBotId, victimId) {
  if (!room || !wolfBotId || !victimId) return null;
  const f = wolfGodFeatures(room, wolfBotId, victimId);
  if (!f) return null;
  const v = room.players.find(p => p.id === victimId);
  const isGod = !!(v && v.role && GOD_SET.has(v.role));
  return { X: f, y: isGod ? 1 : 0, victimId, isGod };
}

/* v1.7.7（α3）采集偏置修正：只采“被杀者”会让 label 分布被狼刀法偏置污染（狼刀最像好人的，
 * 神/民在该子集的区分度失真——实测 AUC 反向 0.13）。改为“被杀者 + 随机对照”采样：
 * 每夜每狼 bot 决策时采 1 被杀者 + upTo 个随机活人对照（label=是否神职），训练集无选择偏置。
 * 随机走房间 rng（B1-8 确定性纪律），不碰 Math.random。 */
function collectKillSamples(room, wolfBotId, killId, upTo = 3) {
  if (!room || !wolfBotId) return [];
  const alive = room.players.filter(q => q.alive && q.id !== wolfBotId);
  if (!alive.length) return [];
  const ids = [killId];
  const others = alive.filter(q => q.id !== killId);
  const rng = room.rng || global.rng;
  for (let i = 0; i < Math.min(upTo, others.length); i++) {
    ids.push(others[rng.int(others.length)].id);
  }
  const out = [];
  for (const vid of ids) {
    const smp = collectKillSample(room, wolfBotId, vid);
    if (smp) out.push(Object.assign({}, smp, { isKill: vid === killId ? 1 : 0 }));
  }
  return out;
}
module.exports = { collectKillSample, collectKillSamples, GOD_SET };
