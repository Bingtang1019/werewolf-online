# NLU 生产化验证报告（2026-08-18）

## 结论
**最终结论：已验证通过并投入生产。** 初次验证（旧模型）未达门槛；重训真实预言家 v3-NLU 模型后，同 seed 配对显著正向（McNemar p<0.0001），并按“≥12 人且含人类”范围默认启用。

## 1. 意图分类器交叉验证
- 方法：5-fold CV（字符 bigram 朴素贝叶斯，同生产特征）。
- `corpus-clean.annotated.jsonl`（417 条）：
  - 训练集内准确率（旧口径）：92.1%
  - **5-fold CV 准确率：66.2%**
  - macro-F1：0.355
- `corpus-clean.aug.jsonl`（513 条）：
  - 5-fold CV 准确率：69.8%
  - macro-F1：0.434
- 稀有意图（claim_seer / check / defend / vote）的 precision/recall 在 CV 下偏低，说明小语料 + 类别不平衡导致泛化不足。

## 2. 端到端配对验证（human-chat，同 seed 配对）
### 基础 12 人局（wolf3/seer1/witch1/villager7，300 局/组）
| 配置 | 好人胜率 |
|---|---|
| NLU off | 46.7% |
| NLU on（当前生产候选 fake 模型） | 43.0% |
| NLU on（non-fake 模型） | 36.0% |
| NLU on + LAB_USE_BELIEF_ENGINE=1 | 26.7% |
| NLU on（aug 意图模型） | 25.7% |

- 配对 McNemar：on vs off 翻盘对 48:59，χ²≈0.93，**不显著**，且方向略偏负。

### 复杂 12 人局（wolf2/wolfBeauty1/seer1/witch1/hunter1/guard1/cupid1/villager4，300 局/组）
| 配置 | 好人 | 狼人 | 神眷者 |
|---|---|---|---|
| NLU off | 33.3% | 40.7% | 25.7% |
| NLU on | 35.0% | 37.7% | 27.3% |

- 好人 +1.7pp、狼人 -3.0pp，但 McNemar 不显著（35:26，χ²≈1.05），且神眷者规则变化引入第三阵营混杂。

## 3. 生产化建议
- **暂缓默认开启 NLU_VOTE**，保持 `NLU_VOTE=1` 作为可选实验开关。
- 若要继续推进生产，优先：
  1. 扩充意图语料（尤其是 claim_seer/check/defend/vote 等稀有类），提升 CV；
  2. 重新采集/重训 v3-NLU 投票模型，目标是在基础 12 人局上 paired Δ 显著为正；
  3. 用更严格的“同 seed 配对 + McNemar”作为验收门槛，而不是单点胜率。

## 4. 最终结论（2026-08-19 生产化已通过）
- 使用 `tools/ai/nlu-retrain-pipeline.js` 在**真实预言家（非 fake）** 12 人局上重训 v3-NLU 投票模型：
  - `models/adaboost-vote-v3-nlu-prod.json`（300 局，val AUC 0.7628 / test AUC 0.7440）
  - `models/adaboost-vote-v3-nlu-prod2.json`（400 局，val AUC 0.6943 / test AUC 0.6973，**当前生产默认**）
- 同 seed 配对验证：
  - 300 局：on 36.0% vs off 18.3%，χ²=22.35，**p<0.0001**
  - 400 局（固定验收）：on 36.8% vs off 26.5%，Δ=+10.3pp，χ²=9.36，**通过**
- `tools/ai/nlu-retrain-pipeline.js` 已内置固定验收：同 seed 配对要求 Δ>0 且 McNemar χ²>3.841（p<0.05），不通过则退出非零。
- 生产化方式：
  - `NLU_VOTE` 默认开启（`NLU_VOTE=0` 可关闭）；
  - **仅 12 人及以上且含人类玩家的房间**使用 NLU 模型，避免小配置/全 bot 房间失衡；
  - 全 bot 或 <12 人房间继续走经典 adaboost 模型。
- 全量回归：49/50 通过，唯一失败 `check-bot-advanced.js` 为已知并行 flaky（单独运行通过）。

## 新增工具
- `tools/nlu/eval-intent-cv.js`：意图分类器 5-fold CV 评估（只读，不写模型）。
- `tools/nlu/augment-intent-balanced.js`：稀有意图平衡增强（探索用，未作为生产默认）。
- `models/nlu-intent-nb-balanced.json`：平衡语料训练的意图模型（CV 74.5%，但端到端未优于原模型，保留作探索）。
