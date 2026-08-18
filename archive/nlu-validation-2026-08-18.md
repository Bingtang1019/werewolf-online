# NLU 生产化验证报告（2026-08-18）

## 结论
**当前不建议将 NLU_VOTE 全数投入生产。** 严格验证未达到“显著正向且稳健”的门槛。

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

## 新增工具
- `tools/nlu/eval-intent-cv.js`：意图分类器 5-fold CV 评估（只读，不写模型）。
