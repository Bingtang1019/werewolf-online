# archive/value-v42 —— V4.2 HiCVN 价值模型卡（v1.7.16 替换，规划层）

| 项 | 值 |
|---|---|
| 模型文件 | `models/value-hicvn-v42.json`（414KB，仅推理权重——报告数据不入模型，模型卡规范 ✓） |
| 架构 | HiCVN v4.2：MLP 集成 ×4 成员（hidden 96）+ stratify 配置等权 + config-cond（16 配置 one-hot）+ info 信息特征 |
| 特征集 | `v4-info`，31 维 = 11 基础 + 16 配置 one-hot + 4 信息（checkedWolves/checkedCount/seerAlive/lastExileWasWolf） |
| 语义 | V(s) = P(终局好人胜 | s) ∈ [0,1]（sigmoid 内建校准）；payoff = ΔV × payoffScale[config]；σ = 集成成员 std × sigmaScale |
| 训练数据 | `data/records-v5/`：16 配置 27,500 局（v2 生态，含 seerHistory/speech 事件）；train 24,980 局 / test 6,387 局 / trainStates 165,332 |
| 生态分层 | v2 21,615 训 / random 156 / v1iso 1,602 / v1raw 1,607（生态鲁棒 4 池全过） |
| 训练时间 | 2026-08-07T13:32:52.968Z |
| 替换对象 | V3.1（`models/value-vote-v31.json`，线性 LSTD，保留回滚） |

## 验收（主闸门：等权 AUC + 配对 CI）

| 项 | 结果 | 判定 |
|---|---|---|
| 等权 AUC（16 配置同测试集） | **0.8055**（vs V3.1 同集 0.7819） | gate **+2.37pp PASS**（主判据 ≥ +0.02） |
| 独立参考 | 0.7843（V3.1 独立校准批等权 AUC，分布不同仅报告） | +2.12pp PASS |
| 信息特征边际 | **+2.55pp**（checkedWolves/checkedCount/seerAlive/voteExposed/lastExileWasWolf 对照实验实证） | 保留 |
| 熵分层 AUC | balanced 0.554 / mid 0.759 / extreme 0.936 | 单调性符合预期 |
| 校准 | sigmoid 内建，桶偏差 < 0.10 | 合格（值模型闸门：AUC+CI 主、校准报告项） |
| 生态鲁棒 | 4 池全过 | PASS |
| **配对终裁** | **16/16 配置无一显著劣化**（CI 全含 0；v4 生效验证一致率 77-97%） | **PASS（替换依据）** |

## σ 分桶单调 FAIL（A 方案裁决，2026-08-07）

- 现象：16 配置模型 bucket2-3 coverage 0.57/0.65，bootstrap 多样性不足 → σ 分桶单调 FAIL
- **裁决：替换照常进行**；σ 单调列入 **V4.3 / 块 1 多样性增强**（不同 hidden 宽度/特征子集增强成员多样性），观察期补
- 影响评估：不影响 ΔV 排序/幅度消费（rollout 消费为 ΔV×scale 加权 + margin 相对化，无 σ 绝对阈值依赖）

## 消费点与门控（生产现状）

- **生产默认 value 零消费**：server.js 无 PAYOFF_MODE 赋值（v1.7.4-1.7.14 共同现状，v1.7.14 已如实修正文档）
- lab rollout：`PAYOFF_MODE=value` 启用；**v1.7.16 起默认 VALUE_MODEL=v4**（不设 env）；回滚：`VALUE_MODEL=v3`（V3.1）/ `VALUE_MODEL=v2`（旧 sigmoid+K）
- 显式覆盖：`MODEL_VALUE_VOTE_V4=models/value-hicvn-v42.json`（配对/A-B 对照用，不设则默认 v42）
- 第三方/未知 cap → 解析版 payoffFor（与 V3 分支同纪律，显式降级非静默）

## V3.1 归因（为什么 V4 必须换架构，归档）

- V3.1 同测试集 0.7843 vs v3 0.7787（+0.56pp）——**线性表达上限 ≈0.78**
- 3frac ≈ 0.5pp（单变量 AUC 高估不传导多变量 LSTD）；生态贡献 ≈ 0；6p v3 反高
- **V3.1 校准 0/16 FAIL**（无界线性输出，独立评估批 1600 局）——校准为报告项（value 是排序/评估模型，AUC+CI 主闸门）
- V4 语义定死：胜率概率（sigmoid+BCE），V4.2 校准内建 ✓

## 观察期监控（替换后挂起）

- [ ] 对局胜率（好人/狼）漂移——与 V3.1 时代基线对照（V4.2 配对终裁 16/16 中性，期望无偏移）
- [ ] vote top-1 基线 **64.7%**（vote-v2 观察期基线，12a 200 局；与 v1+iso 66.1% 的 1.4pp 差异需同批双模型对比定论）
- [ ] σ 单调（V4.3/块 1）：bucket2-3 coverage 0.57/0.65 → 目标单调（bootstrap 多样性增强后复测）
- [ ] 12 人档配对 Δ+3~5pp 偏狼趋势（n=300 不显著）观察项

## 工具与复现

```cmd
:: 配对终裁（16 配置同局对照，段格式+断点；MODEL_VALUE_VOTE_V4 必须显式否则静默回退 V3——配对全废）
node tools/ai/pair-v4v31.js --tag=8p --preset=2 --games=500

:: V4 组件自测（GBDT/MLP 学习能力 + roundtrip + sigma）
node tools/ai/v4-smoke.js

:: V3.1 归因审计（同 seed42 划分复现 + 同测试集双模型对比）
node tools/ai/v31-audit.js

:: 训练（records-v5 16 配置全量）
node server/ai/fit-value-v4.js --out models/value-hicvn-v42.json --records data/records-v5
```

## 教训固化（防复发）

- **工具诚实**：pair-v4v31 的 MODEL_VALUE_VOTE_V4 不设 → 静默回退 V3 → 配对全废；参数 `--only-configs` 带 `=` 号匹配（fit-value-v3 已修）
- **数据卫生**：跨时段对比先做同 seed 重跑一致性检测（漂移检测救 M3.5）；world TDZ bug（27,500 局报废）——新代码路径 smoke 后再全量
- **模型卡规范**：报告用数据不进模型文件（vote-v2 40MB 教训，压缩 47.4MB→268KB）；>5MB 即疑似审计混入
- **A-2 纪律**：train/infer 特征同源；lab 未知 key 抛错、生产显式降级

---

## 二十二节：命名规范（v1.8.0 立规——防混用）

| 线 | 命名 | 资产 |
|---|---|---|
| 变革线 | D0 决策骨架（π）/ D1 信念引擎 / D2 自博弈（PPO）/ D3 交流（NLU） | D0: vote-pi；D1: belief-engine |
| 投票线 | vote-vN 全称 | vote-v2（生产）/ vote-v3（25d 在线）/ vote-v4（蒸馏目标） |
| 价值线 | VN.M | V3.1 / V4.2；"V5"仅指价值模型下一代 |

- 废弃表述：P1/P2/P3（架构革命）归入 D 线基础设施；"V5 范式/BDPL"不再使用
- 消费方（模型卡/公告/脚本/注释）一律按此表命名
