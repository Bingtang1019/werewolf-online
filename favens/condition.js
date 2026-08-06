'use strict';
/* favens/condition.js —— 概率条件化 + 狼数守恒（β 核心，测量正确性的前提）
 * 语义：恋人互认身份后，把"普通策略先验"条件化为"满足已知身份 + 狼数守恒"的信念分布。
 * 只做概率，不做行为（不投恋人/不刀恋人是 goodLover/wolfLover 的行为层）。
 *
 * 设计约束（v1.7.8 β）：
 * ① constraints 必须包含自身身份（self）——否则自己的 P(wolf) 会进入 unknown 池被缩放失真；
 * ② 互认消息（系统神谕）是硬覆盖：out[已知]=0/1 直接锁定，优先于模型/查杀/发言判断（注释写明，勿"修"掉）；
 * ③ 路由层先过滤已死玩家（已死无投票，且 wolfCount 已扣）；conditionOn 假定入参均为存活；
 * ④ 冲突检测：纯函数 throw（矛盾=数据/实现 bug 早暴露）；调用层（index.js 路由）try/catch → invalid 标记，
 *    对局跑完但剔除出胜率统计 + 汇总时上报 invalid 数（bug 仍早暴露，批量不中断）。
 *
 * 守恒：wolfCount = roleCounts.wolf + wolfBeauty − 已翻牌死狼（全部公开可算）；
 * 一次性比例缩放（保持相对排序，投票依赖 argmax/采样）+ cap 到 1 后二次分配（两遍误差趋零）。
 */

/**
 * conditionOn(prior, constraints, wolfCount) → {id: P(wolf)}
 * @param prior       {id: P(wolf)} 普通策略信念（模型/查杀/发言融合后的）
 * @param constraints [{id, camp}] 已知身份（必须含自身；camp ∈ {wolf, good}；已死玩家请先过滤）
 * @param wolfCount   存活狼数（公开）
 * @throws 约束冲突（knownWolf>wolfCount / cap 溢出 / 未知阵营 / 剩余狼数<0）
 */
function conditionOn(prior, constraints, wolfCount) {
  const out = Object.assign({}, prior);
  let knownWolf = 0;
  for (const c of constraints) {
    if (c.camp === 'wolf') { out[c.id] = 1; knownWolf++; }
    else if (c.camp === 'good') { out[c.id] = 0; }
    else throw new Error('condition: 未知阵营 ' + c.camp);
  }
  if (knownWolf > wolfCount) throw new Error('condition: 约束冲突 已知狼' + knownWolf + '>存活狼' + wolfCount);
  const rest = wolfCount - knownWolf;
  if (rest < 0) throw new Error('condition: 剩余狼数 <0');
  const unknown = Object.keys(out).filter(id => !constraints.some(c => c.id === id));
  if (rest === 0) { for (const id of unknown) out[id] = 0; return out; }
  let sum = 0;
  for (const id of unknown) sum += out[id] || 0;
  if (sum <= 0) { const u = unknown.length || 1; for (const id of unknown) out[id] = rest / u; return out; }
  // 第一遍：比例缩放 + cap
  const f = rest / sum;
  for (const id of unknown) out[id] = Math.min(1, (out[id] || 0) * f);
  // 第二遍：cap 到 1 的玩家锁死，剩余玩家二次缩放补足（cap 极少发生，两遍后误差趋零）
  let cappedSum = 0, remSum = 0;
  const rem = [];
  for (const id of unknown) {
    if (out[id] >= 1 - 1e-9) cappedSum += 1;
    else { rem.push(id); remSum += out[id]; }
  }
  const rest2 = rest - cappedSum;
  if (rest2 < 0) throw new Error('condition: cap 溢出 已知+capped>存活狼');
  if (rest2 > 0 && rem.length) {
    const f2 = rest2 / remSum;
    for (const id of rem) out[id] = Math.min(1, out[id] * f2);
  }
  return out;
}
module.exports = { conditionOn };
