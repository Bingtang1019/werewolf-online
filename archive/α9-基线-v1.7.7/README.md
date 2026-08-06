# α9 冻结平衡基线 · 四件套存档（v1.7.7，2026-08-06）

**用途**：β（favens）的对照组口径依赖。α9 基线 = 训练后狼人 + 冻结好人 + 普通丘比特（无 favens）。

## 1. 狼美配置（十二人局三·狼美，claimGod=0.25）

- cap: 12，counts: `{ wolf:3, wolfBeauty:1, seer:1, dreamer:1, guard:1, witch:1, villager:4 }`
- winMode: `edge`（屠边）
- `WOLF_CLAIM_GOD=0.25`（狼自称神职——S3 穿衣服杠杆，**逐配置显式开启**，其余配置默认 0）
- 与 β 测量配置（局四·丘比特 claimGod=0.1）口径区别：丘比特加入改变了平衡，claimGod 需单独标定

## 2. claimGod 参数档

| 配置 | claimGod | 依据 |
|---|---|---|
| 十二人局三·狼美（α9 基线） | 0.25 | α9 冻结：狼 49.6%[48.3,50.9] |
| 十二人局四·丘比特（β0a） | 0.1 | β 对照组实测狼 52.12%[51.1,53.1] |
| 其余配置（无狼美） | 0（默认） | 纪律：穿衣服会打崩已平衡小局 |

## 3. 模型快照（本目录 models/，冻结于 2026-08-06）

- `adaboost-vote-v1.json`（12.7KB，03:40）：好人投票 AdaBoost（13 维特征，含 claims_god）
- `value-vote-v1.json`（0.4KB，04:22）：V(R,S,M,N) 胜率模型（拟合，AUC 0.78）→ payoff 用 V 差分
- `wolf-god-v1.json`（4.5KB，14:05）：狼刀神分类器（P(神)/P(民)，AUC 0.89）
- 加载注意：AdaBoost 桩的 predict 是函数，fromJSON 必须重建（曾致 TypeError）

## 4. seed 记录

- seedBase：`s3c`（S3 穿衣服阶段 3000 局）、`a8v`（α8 验证轮 3000 局，新 seed 随机配置）
- seed 串格式：`${seedBase}-p${presetIdx}-${g}`（balance 场景，FNV-1a → 全局 RNG）
- 结果：s3c 狼 49.6%、a8v 狼 49.8%（两 seed 复现，CI ±1.26pp，不漂移）
- 复现命令：`WOLF_CLAIM_GOD=0.25 node test/lab/lab.js balance --games=3000 --presets=9 --no-random=1 --seed=s3c`

## 生产安全项（冻结时确认）

- claimGod 默认 0，仅狼美局/β 配置显式开启
- 采集偏置：只采决策结果会污染 label 分布，必须对照采样
- AUC 排序方向：升序 rank（降序会把好模型算成反向）
- 随机配置已固化：`data/random-presets-v2.json`
