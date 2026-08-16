# Phase W：狼侧平衡快速扫描（2026-08-17）

> 前置：Phase G 已将默认 vote model 切到 v2（好人侧 12p 约 39%）。
> 当前目标：在 Phase G 基线上继续压低狼胜率到 50% 附近。

## 12 人局快速扫描（100 局/组）

| 配置 | 狼% | 好% | 说明 |
|---|---|---|---|
| 默认（v2 + w0.6） | 61.0% | 39.0% | Phase G 后基线 |
| WOLF_COUNTER_SEER=0.3 | 61.0% | 39.0% | 无明显效果 |
| WOLF_CLAIM_GOD=0.25 | 79.0% | 21.0% | 显著偏狼，确认默认 0 正确 |

## 结论
- 简单的狼侧发言参数没有找到立刻压低狼胜率的旋钮。
- `WOLF_CLAIM_GOD` 开启会严重偏狼，保持默认 0。
- 下一步需要走正式狼侧对称训练：wolf-god 分类器重训、狼侧 rollout、自博弈。

## 样本采集诊断（2026-08-17）
- 运行 `sample --games=50 --cap=8 --sample-file=data/wolf-samples.jsonl` 后：
  - records 正常落盘 50 局；
  - 但 `samples` 字段为 0，且 `data/wolf-samples.jsonl` 未生成。
- 说明当前 lab 样本采集链路在拆分后没有真正采到 vote/wolf 样本，**Phase W 正式训练前需要先修这条链路**。
- 可能原因：`room.labSampleFile` 未生效、bot 行动未走采集钩子、或 `flushLabSamples` 未触发。需要进一步定位。

## ✅ 已修复（2026-08-17）
- `server/game/actions.js` 拆分后缺失导入：
  - 补 `fs`、`createRng`、`voteFeatures`
  - 修正 `wolfTrain/collector.js` 相对路径（`./wolfTrain` → `../../wolfTrain`）
- 复测 `sample --games=20 --cap=8`：
  - 20 局全部正常完成（winner 正常）
  - 生成 `data/wolf-samples2.jsonl`，共 **325 条样本**
  - 包含 wolf 夜刀样本（isKill/label）与 vote 样本

## 下一步
- [ ] 用已修复的样本管道跑正式 wolf-god 训练
- [ ] 重训 wolf-god 分类器
- [ ] 狼侧 rollout / decideNightKill 接入
- [ ] V5.2 自博弈对抗训练
