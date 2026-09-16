# V5 MoE：V3.1 / V4.2 / V5-intent 价值层混合（2026-09-16）

## 背景
V3.1（LSTD 线性基线）、V4.2（HiCVN MLP 集成 + σ）、V5-intent（意图特征 + π / v3v3 / A3 合成价值）分别代表三类信息结构。目标是用条件门控把它们组合成一个系统级专家混合，而不是简单平均。

## 三个子代理视角（结论）
1. **架构代理**：优先价值层软门控；V4.2 主专家、V3.1 低方差锚点、V5-intent 意图条件专家；再考虑策略层 / 分层路由。
2. **工程代理**：新增 `server/ai/moe-value.js`，保持 `value`/`payoff` 接口；`VALUE_MODEL=moe` 切换；`MOE_MODE=off|shadow|on`；任一专家缺失 fail-open。
3. **风险代理**：专家相关性、A3 合成模型 D 维度不一致、门控泄漏、校准口径、专家塌缩；先 shadow 收数据，再配对验收。

## 已实现
- `server/ai/moe-value.js`
  - 专家：V3.1（`value-model.js`）、V4.2（`value-model-v4.js`）、V5-intent A3 合成（`models/value-hicvn-v4-intent.json`，当前因 D 维度不一致会被安全跳过）
  - 门控：V4.2 σ 高 → 增加 V3.1 权重；意图强度高 → 增加 V5 权重；否则 V4.2 主导
  - 模式：`MOE_MODE=off|shadow|on`（`on` 生效，`shadow` 记录 `data/moe-shadow.jsonl` 后仍返回 V4.2）
  - `payoff` 使用 V4.2 `payoffScale` 放大；狼侧仍走 V4 `V_wolf`
- `server/ai/rollout.js`
  - `VALUE_MODEL=moe` 分支 `valuePayoffMoe`
  - 导出 `valuePayoff` 供诊断
- `test/check-v5-moe.js`
  - off/shadow/on 值域、门控权重归一化、payoff、rollout 集成

## 方案清单（用户已全选，分批推进）
- A. 价值层软门控 MoE（已实现基础版）
- B. 策略层 MoE（未开始）
- C. 分层路由 MoE（未开始）
- D. 残差/堆叠 MoE（未开始）
- E. 不确定性门控（已含 σ 触发）
- F. Shadow 模式（已实现，默认关）

## 已知问题
- `models/value-hicvn-v4-intent.json` 维度已修正为 38/38（A3 脚本原 D=36 与 features 数组 38 不一致）；MoE 现已能加载 V5 价值专家。
- MoE 当前未做配对验收，仅为可运行基础版。

## 验收计划
1. Shadow 收 1000+ 状态样本；
2. 离线比较 V4.2 vs MoE 的 AUC / Brier / 校准桶 / 专家权重分布；
3. 同 seed 配对 + McNemar χ²>3.841；
4. 通过后再考虑 `MOE_MODE=on` 进入 lab；生产最后再开。
