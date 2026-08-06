# archive/lover-v2 —— 恋人机制引擎化（favens v2）存档

| 里程碑 | 状态 | 产物 |
|---|---|---|
| M0 | ✅ | `M0-classic-基线.json`：classic 6 配置基线（局四 10000 局 + 局五~十五人各 3000 局，v2 对照口径） |
| M1 | ✅ | `loverCore.js`（引擎）+ game.js 集成 + `test/check-lover-v2.js`（T1-T8）——解绑/双权能/恋人刀/付费护短/三态开关 |
| M2 | ✅ | favens v2 策略（index.js 分支/wolfLover 保丘比特/goodLover 付费护短/bot-brain 权能） |
| M3 | ✅ | `lover-regress-summary.json`：6 配置 ×3000 局配对——v2 机制中性（Δwolf ≤2pp），局四落带 51.57% |
| M4 | ✅ | client.js：解绑按钮/权能二选一/事件图标 |
| M5 | ✅ | README v2 章节 + 本目录 |

## 核心结论（v1.7.9 数据）

1. **favens v1 系统性偏狼的根源 = 行为注入层无代价端**（弃票/护短/红线全是纯增益）；v2 机制下沉引擎并带代价端后，**Δwolf 收敛至 ±2pp（机制中性）**——"规则在引擎、策略在 AI、权能有代价端"命题验证成立。
2. **局四 v2 落带**：51.57%[50.3,52.8] PASS；局八 46.4/十五人 43.0 FAIL 为 M0 已知基线擦边（v2 未使其恶化）。
3. **时序敏感性待外生化验证**：原始三桶极差 26-36pp 为逆向因果（狼强→早刀丘比特），非机制敏感直接证据；bot 局解绑未触发（策略待迭代）。

## 复现

```cmd
:: v2 6 配置配对回归（M3）
node test/lab/data/pool/lover-regress.js --workers=14
:: 单配置 v2 跑批
WOLF_CLAIM_GOD=0.1 FAVENS=1 node test/lab/lab.js pool --preset=10 --seed-groups=30 --per-group=100 --lover-mode=v2 --out=test/lab/data/pool/v2-10.jsonl --workers=14
:: 引擎单测
node test/check-lover-v2.js
```
