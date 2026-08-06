'use strict';
/* 预设配置库（v1.7.6 平衡预测）：16 种标准阵容（含胜利规则）。
 * 供 balance scenario 使用（预设每配置 N 局 + 随机配置同数量种类每类 2/3N 局，比例 3:2）。
 * cupid: true 表示含丘比特（第三方统计）。 */
const PRESETS = [
  { name: '四人局', cap: 4, counts: { wolf: 1, seer: 1, villager: 2 }, winMode: 'city', cupid: false },
  { name: '六人局', cap: 6, counts: { wolf: 2, seer: 1, hunter: 1, villager: 2 }, winMode: 'city', cupid: false },
  { name: '八人局', cap: 8, counts: { wolf: 2, seer: 1, hunter: 1, dreamer: 1, villager: 3 }, winMode: 'city', cupid: false },
  { name: '九人局一', cap: 9, counts: { wolf: 3, seer: 1, hunter: 1, witch: 1, villager: 3 }, winMode: 'edge', cupid: false },
  { name: '九人局二', cap: 9, counts: { wolf: 3, seer: 1, dreamer: 1, witch: 1, villager: 3 }, winMode: 'edge', cupid: false },
  { name: '九人局三', cap: 9, counts: { wolf: 3, seer: 1, guard: 1, witch: 1, villager: 3 }, winMode: 'edge', cupid: false },
  { name: '九人局四', cap: 9, counts: { wolf: 2, wolfBeauty: 1, seer: 1, dreamer: 1, witch: 1, villager: 3 }, winMode: 'edge', cupid: false },
  { name: '十二人局一', cap: 12, counts: { wolf: 4, seer: 1, hunter: 1, guard: 1, witch: 1, villager: 4 }, winMode: 'edge', cupid: false },
  { name: '十二人局二', cap: 12, counts: { wolf: 4, seer: 1, dreamer: 1, guard: 1, witch: 1, villager: 4 }, winMode: 'edge', cupid: false },
  { name: '十二人局三', cap: 12, counts: { wolf: 3, wolfBeauty: 1, seer: 1, dreamer: 1, guard: 1, witch: 1, villager: 4 }, winMode: 'edge', cupid: false },
  { name: '十二人局四·丘比特', cap: 12, counts: { wolf: 3, wolfBeauty: 1, seer: 1, dreamer: 1, cupid: 1, witch: 1, villager: 4 }, winMode: 'edge', cupid: true },
  { name: '十二人局五·丘比特', cap: 12, counts: { wolf: 4, seer: 1, dreamer: 1, cupid: 1, witch: 1, villager: 4 }, winMode: 'edge', cupid: true },
  { name: '十二人局六·丘比特', cap: 12, counts: { wolf: 4, seer: 1, cupid: 1, guard: 1, witch: 1, villager: 4 }, winMode: 'edge', cupid: true },
  { name: '十二人局七·丘比特', cap: 12, counts: { wolf: 4, seer: 1, cupid: 1, hunter: 1, witch: 1, villager: 4 }, winMode: 'edge', cupid: true },
  { name: '十二人局八·丘比特', cap: 12, counts: { wolf: 3, wolfBeauty: 1, seer: 1, cupid: 1, guard: 1, witch: 1, villager: 4 }, winMode: 'edge', cupid: true },
  { name: '十五人局·丘比特', cap: 15, counts: { wolf: 4, wolfBeauty: 1, seer: 1, cupid: 1, guard: 1, witch: 1, hunter: 1, villager: 5 }, winMode: 'edge', cupid: true },
];
function presetByIds(ids) { return PRESETS.filter((_, i) => ids.includes(i)); }
module.exports = { PRESETS, presetByIds };
