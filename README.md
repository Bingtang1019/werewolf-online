# 🐺 狼人杀（在线版）

和朋友一起玩的 Web 在线狼人杀。**零依赖**：只使用 Node.js 内置模块，不需要 `npm install`。

> 当前版本：**1.9.0**。完整历史见 [`更新公告.md`](更新公告.md)，本文只保留“现在能用什么、怎么用”。

**1.9.0 亮点**

- **V5 意图线（D 系列）全链路**：意图分类器 → 8 维意图特征 → v3v3 意图投票模型 / π 意图策略，全部带 lab 采集、按对局分组的留出口径与一键流水线；
- **房主 V5 托管**：服务端代打房主真人角色（简单 / 智能 / 模拟三档），托管中锁定房主界面，真实对局反馈落盘；
- **MoE（价值层/策略层）已实现并完成真实留出验收**：当前无排名增益 → 默认 `off`，学习型门控作为可选通路保留；
- **审计修复**：房间级 RNG 真正注入、`vote_share` 训练/推理口径统一、模型路径修复（wolf-god / wolf-win 恢复可加载）、A-2 严格模式、死代码清理；
- **质量**：`npm test` 全量 **55/55** 通过。

## 快速开始

```bash
node server.js
```

浏览器打开 `http://localhost:3000`（可用环境变量改端口：`PORT=8080 node server.js`）。

- 房主「创建房间」→ 生成 6 位房间号（0-9 + A-Z）→ 发给朋友；
- 朋友「进入房间」输入房间号即可加入；
- 支持 4~18 人；满员后房主配置职业并开局；
- 首页「🎮 离线模式」一键建房并加满智能人机，可单机陪练。

**局域网联机**：同一局域网内，其他设备访问 `http://你的电脑IP:3000`（Windows 可用 `ipconfig` 查看 IP）；也可双击 `启动游戏.bat`。

## 🚀 部署到公网

### 方式 A：Render（免费，Blueprint 一键导入）

1. 把本目录推到 GitHub 仓库；
2. 打开 [render.com](https://render.com) → New → **Blueprint** → 选择该仓库；
3. 项目自带 `render.yaml`（node / free / `node server.js` / 健康检查 `/healthz`），直接 Apply；
4. 浏览器打开 `https://xxx.onrender.com/healthz` 看到 `{"ok":true,...}` 即成功。

手动创建 Web Service 时：Build Command 留空（零依赖）、Start Command `node server.js`、Health Check Path `/healthz`。

**注意事项**
- 房间状态保存在服务器内存 + `data/rooms.json` 快照：请保持**单实例**（免费版默认 1 实例，不要扩容）；
- 免费实例闲置 15 分钟会休眠（首次访问冷启动约 30~60 秒）；对局进行中不会休眠。可用 [UptimeRobot](https://uptimerobot.com) 每 10 分钟 ping `/healthz`；
- 重新部署会重启实例，尽量在对局结束后再 push。

### 方式 B：Cloudflare 快速隧道（本机开房间给异地朋友）

Windows 双击 `开启公网联机.bat`：自动启动服务器 + cloudflared 隧道，崩溃自动重启并打印公网地址。

### 安全部署（公网必配环境变量）

- `PUBLIC_HOST`：公网域名（逗号分隔）——**防 DNS rebinding**：未配置时仅本机/局域网可访问（其他 Host 一律 403）；
- `STATS_TOKEN` / `DEBUG_TOKEN`：在线统计/调试接口凭证（未配置仅本机可用）；
- `SNAPSHOT_SECRET`：快照完整性校验密钥（防离线改档）；
- `MODS=0`：公网生产建议关闭模组加载与注入端点（模组非沙箱，见 `mods/README.md`）；
- `CF_TUNNEL_MODE`：Cloudflare 快速通道特化（`auto` 默认自动检测 / `on` 强制 / `off` 关闭；开启后客户端免 SSE、使用隧道调优轮询）。

## 功能清单

- **房间**：创建 / 加入 / 踢人 / 离开、人数与职业配置（4~18 人）、房间号实时校验、邀请链接直达（`?room=` 自动填入）。
- **首页**：双卡入口、趣味昵称生成、房间号大卡过渡、在线房间统计（🔥 正在开黑）、首屏夜景、字号调节、离线模式。
- **对局体验**：行动反馈动画、房主可见“谁已投/投给谁”明细（`votedBy` 仅房主下发）、移动端震动、夜晚面板角色色光晕、胜利动效、实时事件时间轴与玩家卡状态仪表盘。
- **人机（四档 + 托管）**：
  - 挂机（仅补必要动作/弃票）、简单（关键词嫌疑度 + 贝叶斯记忆）、智能（信念推理 + 投票模型）、模拟（5 状态态度模型 + rollout 规划层）；
  - **公平玩家定位**：人机不使用服务器真相作弊（守卫/摄梦人/女巫仅基于发言与信念决策；狼仅知狼队友，不知恋人关系）；
  - **房主 V5 托管**：房主可开启服务端代打（力度三档），托管中界面锁定仅保留关闭入口，决策与反馈写入 `data/host-autoplay-log.jsonl`。
- **社交传播**：邀请链接复制 / 原生分享、赛后趣味统计（最话痨/最快出局/最惨烈之夜）、PWA 可安装（网络优先、API 不缓存）。
- **房主特权**：警长选举、屠城/屠边、平票规则（PK / 无人出局）、开局后自选职业、盗贼玩法开关、人机调试（添加/移除、四档）。
- **职业**：平民、预言家、女巫、猎人、摄梦人、守卫、狼人、狼美人、丘比特、警长（盗贼为可选玩法）。
- **规则特色**：
  - 盗贼：抽两张身份牌择一（有狼必选狼），选定后丧失盗贼身份；发牌完毕 5 秒自动入夜；
  - 丘比特开局默认神眷者，情侣殉情后可重新指定（阵营随新情侣动态变化），自连一律属神眷者；
  - 胜利条件：好人与狼人均不需消灭神眷者；**神眷者活到最后才获胜**；
  - 狼美人仅在被放逐时带走被魅惑者；狼人频道仅夜晚开启、情侣频道全天、全体频道夜间关闭；
  - 同守同救、摄梦人免疫、警徽移交、遗言、翻牌等详见 [`rules.md`](rules.md)。
- **聊天**：全体 / 狼人私密（仅夜晚）/ 情侣私密；死亡玩家可继续发言、不能投票。
- **防卡局**：全员操作后自动推进，房主可「强制继续」。

## 🤖 AI 与模型

三层结构、单向依赖，均可 fail-open 回退，模型缺失不影响对局可用性：

```
感知层  features.js / vote-state.js → model-loader.js（v1/v2/v3、NLU 房型路由）
规划层  rollout.js → value-model-v4.js（V4.2 HiCVN）/ value-model.js（V3.1 回退）
策略层  vote-pi.js（π 快照/信念版）/ legacy/decide.js（规则老师）
意图层  nlu-intent.js + intent-features.js（分类器 + 规则兜底 + 8 维意图特征）
融合层  moe-value.js（V3.1 × V4.2 × V5-intent；MOE_MODE=off|shadow|on，默认 off）
```

### 当前默认与实测

| 层 | 模型 | 评估口径 | 指标 |
|---|---|---|---|
| 价值（默认） | `models/value-hicvn-v42.json`（V4.2 HiCVN MLP 集成） | 16 配置同测试集等权 | **AUC 0.8055**（V3.1 同集 0.7819；配对终裁 16/16 无劣化） |
| 价值（回退） | `models/value-vote-v31.json`（V3.1 LSTD） | 同上 | AUC 0.7819（`VALUE_MODEL=v3`） |
| 投票（真人房） | `models/adaboost-vote-v3-nlu-prod2.json` | 固定 McNemar 验收 | 真人房默认 |
| 投票（bot 房） | `models/adaboost-vote-v3.json` / v2 回退 | 分层路由 | 无模型时回退纯信念 |
| 意图分类 | `models/nlu-intent-nb.json` | 5 折 macro AUC（生成语料） | **0.7506** |
| V5 意图投票 | `models/adaboost-vote-v3-v5.json` | 2000 局 / 52,167 样本，按对局分组留出 | **AUC 0.8096**（base13 消融 0.7050） |
| V5 π 意图策略 | `models/v5-pi-lab.json` | 同口径 | **AUC 0.8667**（base13 消融 0.7618） |
| A3 值层意图 | `models/value-hicvn-v4-intent-real.json` | 1500 局 / 49,209 真实状态 | intent38 0.6882 vs base33 0.6988 → **值层无稳定增益，默认关** |
| MoE 学习门控 | `models/moe-gate-v1.json` | 同一留出集（49,209 状态） | 0.6883 ≈ 最强单专家 0.6882 → **无排名增益，默认 off** |

> 诚实评估纪律：所有报告优先使用**按对局分组（group split）**的留出口径，避免同局样本跨训练/测试抬高 AUC；`randomTestAUC` 仅作对照。此前 0.9156 的 π 指标即因测试集早停 + 同局泄漏而修正。

### V5 意图线（A1–A5）速查

```bash
# 采集（同时产出 A2/A5 投票样本与 A3 值层 state；不影响默认对局行为）
V5_SAMPLES=1 V5_VALUE_SAMPLES=1 V5_INTENT_VALUE=1 \
  node test/lab/lab.js sample --games=2000 --parallel=6 --sample-file=data/vote-v3-v5/samples-big.jsonl

# 一键流水线：采集 → A5 π → A2 v3v3 → A3 真实对照 → B 监控
node tools/ai/v5-pipeline.js --games=200

# 单独评估
node tools/ai/eval-intent-talk.js --ab-games=400   # A4：语料覆盖/准确率 + lab A/B
node tools/ai/eval-moe.js                            # MoE A/D 配对验收
node tools/ai/eval-strategy-moe.js                   # MoE B 策略层验收
node tools/ai/v5-restart-monitor.js                  # B 系列产物/信号监控
```

- **A1** 意图分类器：`nlu-intent.js`（字符 bigram 朴素贝叶斯）+ `intent-features.js` 规则兜底；
- **A2** 意图特征并入 v3v3 特征集（13 基础 + 8 意图 = 21 维），按对局分组 AUC **+0.10**；
- **A3** 意图状态（房间级 5 维）接入价值层：lab 真实状态对照显示无稳定增益 → `V5_INTENT_VALUE` 默认关；
- **A4** 意图感知回应：仅回应点名自己的攻击/带票/查杀，他人跳预言家必接，0.65 概率门限（`V5_INTENT_TALK=1`）；
- **A5** π 意图策略：同口径 **+0.10**，模型落 `models/v5-pi-lab.json`；
- **B 系列**：`v5-restart-monitor.js` 检查产物完整性与重启信号；真实对局数据缺口未消前不重启 PPO。

### 审计修复（1.9.x）

- **房间级 RNG 真正生效**：`S.CUR_RNG` 改为闭包访问器（旧实现是 null 快照，全房间共用全局种子）；
- **`vote_share` 单一口径**：新增 `vote-state.voteShare()`，训练/推理/审计埋点/π/PPO 统一为“候选得票 / 总票数”；
- **模型路径统一**：`wolf-god` / `wolf-win` / `vGood` / vote-v1-iso 从 `bot-brain/models/`（不存在）改为仓库根 `models/`；wolf-win 保持文档约定的显式开关；
- **A-2 严格模式**：`LAB_A2=1` 时未训配置显式抛错，不再被 fail-open 静默吞掉；`buildX` 在 `config=null` 时补齐全零 cfg 特征；
- **健壮性**：动态转移矩阵除零保护、态度模型显式初始化、警长证据稳定 dayKey、rollout 噪声按需抽样（去除缓冲取模复用）；
- **死代码清理**：不可达的 `decisionEasy`、重复的 `TALK_*` / `EVIDENCE` / `TRANSFER_5` / `defend_lover` 副本，净减约 275 行。

## 目录结构

```
werewolf/
├── server.js               # HTTP 服务器（静态 + JSON API + /healthz + 安全加固 + mods）
├── bot-brain.js / game.js  # 薄入口（实际逻辑在 server/ 模块）
├── server/
│   ├── game/               # 游戏引擎（shared/flow/vote/chat/actions/bot/view/index）
│   ├── ai/
│   │   ├── model-loader.js / features.js / vote-state.js / belief-engine.js
│   │   ├── value-model.js（V3.1）/ value-model-v4.js（V4.2）/ moe-value.js（MoE）
│   │   ├── rollout.js / vote-pi.js / rng.js / confidence.js
│   │   ├── nlu-intent.js / nlu-claims.js / intent-features.js
│   │   └── bot-brain/      # 人机决策（shared/memory/vote/smart/talk/attitudes/main/index）
│   └── clock.js            # 虚拟时钟（lab 加速与确定性）
├── public/                 # 网页客户端（js 模块 + style.css + sw.js + manifest）
├── models/                 # 模型文件（共 57 个：V3.1/V4.2 价值、vote v1~v5、意图、MoE 门控等）
├── test/                   # 55 个自动化脚本（含 test/lab/ 蒙特卡洛实验室）
├── tools/
│   ├── ai/                 # 训练/评估/验收（train-*、eval-*、v5-pipeline、v5-restart-monitor）
│   ├── nlu/                # 意图语料生成与标注工具
│   ├── music/              # 本地音频素材处理
│   └── selfcheck.js        # 代码自检（语法/版本串/文档一致性，--tests 全量）
├── wolfTrain/              # 狼刀/狼刀胜率训练工具（实验）
├── favens/                 # 恋人机制 v2（引擎层）
├── mods/                   # 模组目录（mod.json + entry.js + client.js）
├── archive/                # 归档（模型卡、实验记录、V5/MoE 验收文档）
├── data/                   # 运行时数据（快照/语料/跑批产物，gitignore）
├── rules.md / 更新公告.md
├── render.yaml             # Render Blueprint
└── 开启公网联机.bat / 启动游戏.bat / server-loop.bat
```

## 技术说明

- 客户端轮询 `/api/state` 获取个性化状态（自适应间隔，版本号增量更新）；操作 POST `/api/action`，写操作带 `opId` 幂等去重；
- SSE 推送唤醒（`CF_TUNNEL_MODE` 下自动切换为隧道调优轮询）；
- 房间快照保存在 `data/rooms.json`，重启自动恢复进行中对局（删除即清空）；闲置房间自动回收；
- 身份信息只在服务端可见，客户端按玩家过滤（狼队友、情侣、女巫视野、预言家历史等）；
- 前端 CSP `script-src 'self'`，所有交互走事件委托（`data-*`），无内联脚本；
- 随机流显式注入：`server/ai/rng.js`（xorshift128+）支持房间级种子与快照续流，`tools/ai/determinism-check.js` 同种子逐字节验证。
- 刷新页面可通过 localStorage 自动重连。

## 环境变量速查（常用）

| 类别 | 变量 | 说明 |
|---|---|---|
| 部署 | `PORT` / `PUBLIC_HOST` / `SNAPSHOT_SECRET` / `MODS` | 端口 / 防 DNS rebinding 白名单 / 快照校验 / 模组总开关 |
| 部署 | `STATS_TOKEN` / `DEBUG_TOKEN` / `CF_TUNNEL_MODE` / `MAX_RSS_MB` | 统计与调试凭证 / 隧道特化 / 内存看门狗 |
| 节奏 | `SEED` / `BOT_DELAY_MS` / `PHASE_TIMEOUT` / `NIGHT_TIMEOUT` / `CHAT_INTERVAL` | 种子 / 人机思考延迟 / 阶段超时 |
| 价值模型 | `VALUE_MODEL`（`v4` 默认 / `v3` / `v2` / `moe`）/ `PAYOFF_MODE` | 规划层路由 |
| 投票模型 | `VOTE_MODEL_MODE` / `VOTE_STRATEGY`（`pi-snap` / `pi` / `pi-pure`）/ `NLU_VOTE` | 感知层与 π 路由 |
| MoE | `MOE_MODE`（`off` 默认 / `shadow` / `on`）/ `MOE_GATE_MODEL` / `MOE_V5_MODEL` | 融合层开关与门控/专家文件 |
| 狼刀 | `WOLF_GOD_MODEL` / `WOLF_WIN_MODEL` | 刀神分类器（默认加载）/ 狼刀胜率模型（显式开关） |
| V5 采集 | `V5_SAMPLES` / `V5_VALUE_SAMPLES` / `V5_INTENT_VALUE` / `V5_INTENT_TALK` | 投票样本 / 值层样本 / 值层意图 / 意图回应 |
| lab/验收 | `LAB_A2` / `LAB_NO_MODEL` / `LAB_NO_CHAOS` / `LAB_VS` / `LAB_PI_EPS` / `LAB_PI_TEMP` | A-2 严格 / 关模型 / 关混沌 / 关快照 / π 探索 |

## 🧪 蒙特卡洛实验室（test/lab/）

跑局与分析解耦：一次跑局产出 `GameRecord`（JSONL），胜率报告、训练样本、配对统计、确定性重放全部从中产出。

```bash
node test/lab/lab.js smoke                       # 冒烟（10 局 8 人）
node test/lab/lab.js baseline --games=500 --cap=13 --parallel=8
node test/lab/lab.js sample --games=2000 --cap=13 --parallel=6 --out=data/lab-records.jsonl
node test/lab/lab.js deterministic --games=20 --seed=abc
node test/lab/lab.js paired --strategy-a=smart --strategy-b=simulate --games=400 --seed=pair-001
```

- 架构：`scenario → core → game.js` 单向依赖；`stats/`（Wilson / McNemar / report）纯函数零依赖；
- GameRecord：`{schema, gameId, seed, scenario, config, result, players, events, firstKill, samples, voteAudit, rolloutAudit}`，错误分类（config/engine/stall）一跑就知道该查谁；
- `--workers=N` 多进程并行（master/worker 对局池），同 seed 跨进程 2000/2000 一致；
- 数据落 `data/*.jsonl`（已 gitignore），流式落盘 + 断点续跑。

## 测试

```bash
npm test        # 全量 55 个脚本，并行执行（约 2~4 分钟）
```

常用单测：

```bash
node test/simulate.js                  # 完整对局场景 1~6（基础/全职业/守卫摄梦/盗贼/平票 PK/丘比特重选）
node test/check-bot-smart.js           # 人机三档决策
node test/check-bot-advanced.js      # 高阶 bot（银水/对跳/魅惑/悍跳/挂机）
node test/check-v5-intent-features.js  # V5 意图特征 21 维
node test/check-v5-intent-talk.js      # V5 A4 意图回应（指向性/门限/占位符）
node test/check-v5-moe.js              # MoE off/shadow/on + 学习型门控回退
node test/check-audit-fixes.js         # 审计修复回归（RNG/口径/A-2/维度/噪声…）
node test/check-docs.js                # 文档-代码一致性
node tools/selfcheck.js --tests        # 自检 + 全量回归
```

## 常见问题

- **点“创建房间”没反应？** 确认已运行 `node server.js` 并通过 `http://localhost:3000` 访问（不要直接双击 `index.html`）。
- **房间号在哪里？** 创建成功后自动复制到剪贴板并显示在页面顶部，可点「复制」。
- **公网联机**：Render 部署后把 `https://xxx.onrender.com` 发给任何地方的网友即可；或用 `开启公网联机.bat` 走 Cloudflare 隧道。
- **人机会不会“开天眼”？** 不会。人机只用公开信息（发言、投票、公开声称、自己角色的合法信息）决策；阵营视野（狼队友/情侣/女巫救药）严格按规则注入。
- **MoE / V5 意图功能默认开了吗？** 没有。MoE 默认 `off`；值层意图（`V5_INTENT_VALUE`）与意图回应（`V5_INTENT_TALK`）均为实验开关，默认关闭，不影响正常对局。
- **模型文件缺失会怎样？** 全部 fail-open：回退规则策略或上一代模型，对局照常进行。
