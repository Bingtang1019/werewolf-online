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
- A. 价值层软门控 MoE（已实现；配对验收未通过，默认关）
- B. 策略层 MoE（未开始）
- C. 分层路由 MoE（未开始）
- D. 残差/堆叠 MoE（已实现学习型门控 `models/moe-gate-v1.json`；验收≈打平最强单专家，未接线默认）
- E. 不确定性门控（已含 σ 触发；σ 门控把权重推向 V3.1 是 A 方案失败根因，待重标定）
- F. Shadow 模式（已实现，默认关；shadow 记录含 gate 字段）

## 已知问题
- `models/value-hicvn-v4-intent.json` 维度已修正为 38/38（A3 脚本原 D=36 与 features 数组 38 不一致）；MoE 现已能加载 V5 价值专家。
- MoE 当前未做配对验收，仅为可运行基础版。

## 配对验收结果（2026-09-16 晚，真实留出组）
数据：`V5_VALUE_SAMPLES=1` 采集 1500 局 → 49,209 状态；按对局分组 80/20（seed 43），留出 300 局 / 9,837 状态，标签 = P(好人胜)。

| 方案 | AUC | Brier | LogLoss |
|---|---|---|---|
| V3.1 | 0.5744 | 0.2706 | 0.7841 |
| V4.2 | 0.6382 | 0.3786 | 1.1652 |
| V5-intent（lab 真实状态、留出组） | **0.6882** | **0.2257** | **0.6433** |
| 50:50 静态平均 | 0.6013 | 0.3021 | 0.8418 |
| MoE A 启发式门控 | 0.6133 | 0.2619 | 0.7325 |
| MoE D 学习型门控（logit 堆叠） | 0.6883 | 0.2246 | 0.6409 |
| 训练集网格最优静态权重（w3=0.1/w4=0/w5=0.9） | 0.6863 | 0.2259 | — |

结论：
1. **MoE A 门控失准**：留出组平均权重 w3=0.571 / w4=0.151 / w5=0.277，把过半权重给了最弱的 V3.1 → 融合反而低于 V4.2/V5 单专家；固定先验在真实分布上不成立。
2. **MoE D 学习型门控（已实现 `models/moe-gate-v1.json`）几乎打平 V5 单专家**（+0.0001 AUC / −0.0011 Brier）：融合有价值但**当前不显著**，不足以作为默认上线依据。
3. V5-intent 专家同时是校准最好的（Brier 0.2257），V4.2 排序尚可但**过度自信**（Brier 0.3786 / LogLoss 1.17），σ 门控因此频繁把权重推向 V3.1 —— 这是 A 方案失败的根因。
4. 建议：`MOE_MODE` 维持默认 `off`；MoE D 作为已验证通路保留（`MOE_GATE_MODEL` 可启用）；待真人局数据（分布不同于 lab bot 局）复核后再考虑 `on`。

## 验收计划
1. Shadow 收 1000+ 状态样本；
2. 离线比较 V4.2 vs MoE 的 AUC / Brier / 校准桶 / 专家权重分布；
3. 同 seed 配对 + McNemar χ²>3.841；
4. 通过后再考虑 `MOE_MODE=on` 进入 lab；生产最后再开。
