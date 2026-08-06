'use strict';
/* favens/features.js —— wolfGodFeatures：复用 voteFeatures 13 维（已含 claims_god 索引 8）
 * 前提检查（v1.7.8）：13 维全为发言/票型/位置代理，无角色计数——模型不"数"身份；
 * 丘比特自称不匹配神职正则 → P(神) 低 → 不被优先刀（合理）；无"误判角色计数"风险。 */
const { voteFeatures } = require('../server/ai/features.js');
function wolfGodFeatures(room, wolfId, pid) {
  return voteFeatures(room, wolfId, pid);
}
module.exports = { wolfGodFeatures };
