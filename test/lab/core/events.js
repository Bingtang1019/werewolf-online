'use strict';
/* 事件标准化（样本管道与重放器的共同地基）
 * 映射表已按 game.js 实际事件结构核对固化（v1.7.0）：
 *   night_start: { night } | night_step: { step } | wolf_kill: { kill, saved }
 *   deaths: { deaths: [{id,name,by}] } | exile: { exile } | shot: { shooter, target }
 * 宽松提取（字段可能在顶层也可能在 data），映射表核对后不再依赖猜测。
 */
const ACTOR_KEYS = ['actor', 'playerId', 'from', 'shooter'];
const TARGET_KEYS = ['target', 'kill', 'victim', 'to', 'exile'];
const NIGHT_KEYS = ['night', 'round'];

function pick(e, keys) {
  for (const k of keys) if (e[k] != null) return e[k];
  if (e.data) for (const k of keys) if (e.data[k] != null) return e.data[k];
  return null;
}
function normalizeEvent(e, i) {
  return {
    i,
    t: e.type,
    night: pick(e, NIGHT_KEYS) || 0,
    actor: pick(e, ACTOR_KEYS) || null,
    target: pick(e, TARGET_KEYS) || null,
    data: e.data || {},
  };
}
module.exports = { normalizeEvent, pick };
