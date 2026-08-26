# V5 / D 系列进度与 V5 补全计划（2026-08-26）

## 已完成底稿

- **D0（V5.0）**：π 决策骨架，行为克隆，300/300 等价，113× 性能。
- **D1（V5.1）**：信念引擎，π 信念版。
- **D2（V5.2）**：终局/重启裁决已归档：
  - RWR v1/v2/v3 全废；
  - 同质生态无“π 超越 dv”信号；
  - 多样化池只产生“涨潮”，不改变 π-dv 差距；
  - 纯 π 在变体池好 20%/狼 80%，不可生产；
  - 结论：π 超越 dv 的唯一路径是信息优势（信念/声明/NLU），而非生态多样性或 RL 微调。
- **D3（V5.3）基础件**：
  - 意图分类器生产版：`models/nlu-intent-nb.json`，417 条人工语料，5-fold CV 66.2%，macro-F1 0.355；
  - `server/ai/nlu-intent.js` + `extractClaims` 已接入真人房 NLU 投票链路；
  - `v3-NLU` 投票模型 `adaboost-vote-v3-nlu-prod2.json` 已通过固定 McNemar 验收并默认用于真人房。

## 本次补全新增代码

- `server/ai/intent-features.js`：V5 A2 规则/分类器意图特征（attack/defend/claim_seer/claim_god/cand_attack/vote_pressure/check_mention/smalltalk），供 v3v3 / π 意图版训练推理使用。
- `tools/nlu/eval-intent-macro-auc.js`：V5 A1 宏平均 AUC 验收工具（5-fold one-vs-rest AUC）。

## 待办（需要外部数据/算力/继续推进）

- **A1 完整版**：将意图语料从 417 条扩到 5000+（真实锚点 + LLM 生成），目标宏平均 AUC > 0.75；候选分类器 NB/MLP/fastText 级。
- **A2 重训**：用 `intent-features.js` 叠加到 vote 特征集，在线重采后训练 v3v3；不改变现有 `FEATURE_NAMES`，避免旧模型 fail-open。
- **A3**：意图特征加入 V4.2 价值模型，跑 V4.2 vs V3.1 对照。
- **A4**：bot 发言从规则意图升级为“分类器意图 + 局势特征”决策。
- **A5**：意图特征加入 π 特征集，训练 π 意图版 BC。
- **B2/B3**：监控意图特征后生态多样化信号，决定是否重启 PPO。

## 重启信号监控（B）

- 信号 1：意图版 v3v3 上线后，bot 策略分化度是否可测量上升；
- 信号 2：π 意图版与 dv 的差距是否收窄；
- 信号 3：意图书写/价值层是否产生可复现的新信息增益；
- 当前：三个信号均未触发，PPO 不重启。
