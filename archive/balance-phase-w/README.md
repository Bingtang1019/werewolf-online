# Phase W：狼侧平衡快速扫描（2026-08-17）

> 前置：Phase G 已将默认 vote model 切到 v2（好人侧 12p 约 39%）。
> 当前目标：在 Phase G 基线上继续压低狼胜率到 50% 附近。

## 12 人局快速扫描（100 局/组）

| 配置 | 狼% | 好% | 说明 |
|---|---|---|---|
| 默认（v2 + w0.6） | 61.0% | 39.0% | Phase G 后基线 |
| WOLF_COUNTER_SEER=0.3 | 61.0% | 39.0% | 无明显效果 |
| WOLF_CLAIM_GOD=0.25 | 79.0% | 21.0% | 显著偏狼，确认默认 0 正确 |
| BOT_SUSPICION_W=0.8 | 63.0% | 37.0% | 不如 w0.6 |
| VOTE_MODEL_MODE=heuristic | 86.0% | 14.0% | 严重偏狼，确认模型不可关 |

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

## wolf-god-v2 小样本训练（2026-08-17）
- 用修复后的样本管道采集 20 局，得到 153 条 wolf 夜刀样本。
- 训练出 `models/wolf-god-v2.json`（100 轮，pos=48/neg=105）。
- 12p 50 局快速验证：狼 68% / 好 32%，**比默认 v1 更偏狼**。
- 结论：当前 12p 狼已偏强，wolf-god-v2 不应默认启用；保留为 `WOLF_GOD_MODEL=wolf-god-v2.json` 可选开关，供狼偏弱配置使用。
- 默认仍走 `wolf-god-v1.json`。

## wolf-god-v3 正式训练（2026-08-17）
- 用 500 局 12p 样本采集，得到 **5699 条 wolf 夜刀样本**（pos=1221 / neg=4478）。
- 训练出 `models/wolf-god-v3.json`（200 轮）。
- 12p 100 局验证：狼 65% / 好 35%，仍比默认 v1（61/39）偏狼。
- 结论：wolf-god 系列是“增强狼刀”杠杆；当前 12p 狼已偏强，v2/v3 都保持为可选模型，不默认启用。

## Phase G 平衡基线上的狼侧扫描（2026-08-17）
- 在 8/12/13 人局已平衡（≈50%）的基线上测试：
  - wolf-god-v2 / wolf-god-v3
  - WOLF_COUNTER_SEER=0
- 结果：12p 仍为 53/47，8p 50/50，13p 51/49，**与基线无差异**。
- 结论：当前狼侧简单参数/模型替换不再改变胜率；Phase G 已达到平衡，Phase W 需更复杂训练（rollout/自博弈）才有意义。

## rollout-lite 接入（2026-08-17）
- 实现了 `wolfTrain/rollout.js` 同步版 `rolloutNightKillSync` + `simulateWolfKillLite`，并在 `smart.js` 中以 `LAB_WOLF_ROLLOUT=1` 接入。
- 默认关闭，不影响生产。
- 12p 100 局验证：好 44% / 狼 56%，**比平衡基线更偏狼**。
- 结论：当前 rollout-lite 会破坏平衡，保持默认关闭；真正的狼侧 rollout 仍需完整“刀后世界模拟”。

## 完整狼侧 rollout（刀后世界模拟，2026-08-17）
- 实现 `wolfTrain/rollout.js` 的 `simulateWolfKillFull`：从 `world.allVoters` 移除被刀候选 → 按狼 bot 信念采样剩余身份（狼队友强制为狼）→ 模拟下一白天投票（好人跟票集中、狼投最低嫌疑非队友）→ 按放逐阵营判 wolf/good。
- 接入：`LAB_WOLF_ROLLOUT=1` + `LAB_WOLF_ROLLOUT_FULL=1`（默认关，不影响生产；`LAB_WOLF_ROLLOUT=1` 单独仍走 lite）。
- 验证（baseline，bot 全 smart）：
  - 8p 100 局：好 48% / 狼 52%
  - 12p 300 局：好 52.3% / 狼 47.7%（CI [46.7,57.9]）
  - 13p 100 局：好 41% / 狼 59%（CI [31.9,50.8] 好）
- 结论：完整版比 lite 更接近平衡，8/12p 可用作狼侧增强候选；13p 仍明显偏狼，整体保持默认关闭。后续可考虑按人数分档启用（如 13+ 不启用）或继续调模拟深度。

## 下一步
- [x] 在平衡基线上评估 wolf-god v2/v3
- [x] 评估 WOLF_COUNTER_SEER
- [x] rollout-lite 接入（默认关）
- [x] 完整狼侧 rollout（刀后世界模拟）
- [ ] V5.2 自博弈对抗训练
