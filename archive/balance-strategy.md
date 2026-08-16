# 平衡训练策略：先好人、后狼人（对称/对抗）

> 状态：已按用户决策确定，作为后续 B1-9 / V4.3 / V5.x 的统一推进顺序。

## 原则

1. **先好人**：先把好人侧感知/规划/发言调到稳定且可复现的基线，再动狼人侧。
2. **后狼人**：在好人基线冻结后，用对称训练（wolf-god / 狼侧 rollout / 社会性参数）和对抗训练（狼 vs 好人自博弈）把狼人侧胜率收敛到目标带。
3. **冻结基线**：每阶段结束记录模型快照、配置、seed 池，作为下一阶段对照组。
4. **配对验收**：所有改动用同 seed 配对 + McNemar / Wilson CI 判定，不靠单点胜率。

## 阶段

### Phase G：好人侧基线
- 目标：好人侧胜率在主要配置（6/8/9/12/13/15 人）进入可复现区间。
- 内容：
  - 检查 vote-v2/v3 生产路由与回退链。
  - 用 `test/lab/lab.js baseline` 跑当前基线。
  - 修复好人 bot 的明显负贡献（发言/投票/查验信任）。
  - 记录 `archive/balance-phase-g/` 模型与数据。

### Phase W：狼人侧对称训练
- 目标：在 Phase G 冻结基线上，把狼胜率拉回 50±5%（或目标带）。
- 内容：
  - 狼刀分类器（wolf-god）重训/调参。
  - 狼侧 rollout / decideNightKill 前瞻。
  - 社会性参数（claimGod、counterSeer、狼队沟通）。
  - 每配置 3000+ 局配对验证。

### Phase A：对抗/自博弈
- 目标：避免狼侧过拟合好人固定策略。
- 内容：
  - 每局从 1 个 π/狼策略位置起步，渐进多位置。
  - 监控 π vs rollout 狼侧胜率对抗梯度。
  - 用 V5.2 自博弈流程迭代。

## 工具
- 平衡实验室：`node test/lab/lab.js baseline --games=N --cap=C`
- 配对验收：`node test/lab/lab.js paired ...`
- 模型卡：`archive/value-v42/README.md` 规范
- 样本管道：`tools/ai/` 系列

## 当前待办
- [ ] Phase G 基线跑批（small smoke 已通，正式跑批待资源）
- [ ] Phase W wolf-god 重训
- [ ] Phase A V5.2 自博弈
