# Phase A：对抗/自博弈（V5.2 方向）

> 状态：已开始跑配对冒烟，正式自博弈训练尚未开始。

## 目标
- 在 Phase G（好人侧）和 Phase W（狼侧）之后，用对抗/自博弈避免策略过拟合固定对手。
- 每局从 1 个 π/狼策略位置起步，渐进多位置。
- 监控 π vs rollout 狼侧胜率对抗梯度。

## 方法
1. 固定 Phase G 好人基线（当前默认 vote-v2 + w0.6，wolf-god 默认 v1）。
2. 狼侧用可选 wolf-god-v2/v3 做对抗对照。
3. 使用 lab paired 场景做同 seed 配对比较。
4. 若某一策略连续两轮优势显著，则把该策略作为新对手继续迭代。

## 当前工具
- `node test/lab/lab.js paired --strategy-a=smart --strategy-b=simulate --games=100 --cap=12`：策略配对冒烟。
- `node tools/ai/train-wolf-god.js`：狼刀模型训练。
- `node tools/ai/train-vote-adaboost.js`：好人投票模型训练。

## 配对结果（2026-08-17）
- smart vs simulate，12p 100 对：discordant 19:13，p=0.3768 → 不显著。
- 当前两档策略在 12p 好人胜率上无显著差异，可作为自博弈起点。

## 待办
- [x] 跑 smart vs simulate 配对基线
- [ ] 跑 wolf-god-v1 vs v3 配对
- [ ] 渐进多位置自博弈脚本
- [ ] PPO 微调（长期）
