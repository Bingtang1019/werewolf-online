# wolfTrain/ — 狼刀/发言策略训练实验区（v1.7.7 起）

> 状态：**运行时消费** 与 **独立实验工具** 并存。本目录不入库训练数据（在 `data/`）。

## 运行时消费（推理链直接 require）

| 文件 | 消费方 | 用途 |
|---|---|---|
| `adaboost.js` | bot-brain.js / favens/wolfLover.js | AdaBoost 狼/好判别（vote-v2 同族） |
| `features.js` | bot-brain.js / game.js | 特征构建 |
| `kill.js` | bot-brain.js | 夜刀决策（α3） |
| `collector.js` | game.js | 样本采集钩子 |

## 独立实验工具（无运行时引用——手工运行）

| 文件 | 用途 | 说明 |
|---|---|---|
| `train.js` | α5 训练循环骨架（采集→重训→验证 3000 局） | v1.7.7 骨架，未接线正式训练流水线 |
| `gridSearch.js` | S3 社会性参数网格搜索（claimGod/counterSeer） | 自爆机制挂起（rules.md 无自爆规则） |
| `selfplay.js` | 狼侧自博弈循环（`LAB_WOLF_EPS` 采样本 → 训 wolf-god → baseline 评估） | V5.2 A 线自动化；首轮 wolf-god-v4 未改变 54/46 |
| `rollout.js` | smart.js 夜刀精排（`LAB_WOLF_ROLLOUT=1` 启用，`LAB_WOLF_ROLLOUT_FULL=1` 切完整刀后世界模拟） | 默认关；lite 曾致 12p 偏狼（44/56），完整版 8/12p 接近平衡、13p 偏狼（41/59） |

`train.js` / `gridSearch.js` 仍是实验规划产物，保留供 B1-9 等后续工作复用；`rollout.js` 已接入实验开关（默认关，生产零影响）。
