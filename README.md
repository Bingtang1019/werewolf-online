# 🐺 狼人杀（在线版）

和朋友一起玩的 Web 在线狼人杀。**零依赖**：只使用 Node.js 内置模块，无需 `npm install`。

> 当前版本：**1.7.6**（实验室多进程并发：mpool master/worker 对局池，--workers=N 跨进程并行，deterministic/paired 两遍并行，同 seed 跨进程 2000/2000 一致；更新公告见`更新公告.md`）（规则补足终版：丘比特判定表（自连按组合判定）/查验·翻牌口径分离/摄梦人免疫消耗语义/警长平票 PK/胜利条件阵营归属；更新公告见`更新公告.md`）（rollout 阵营分流 + 卖狼特判 + 数据驱动 V 差分 payoff（拟合 AUC 0.78，配对 p<0.0001）；simulate 档好人 63%，模型净贡献 47pp；更新公告见 `更新公告.md`）（管线防线：模型特征数校验 / rng 兑底 throw / confidenceOf 接 Platt / 波动有界；simulate 档好人 17%→40%，配对 p<0.0001；更新公告见 `更新公告.md`）（B1 人机强度系统：感知层 AdaBoost + 规划层 Rollout；显式 RNG / 样本管道 / 配对验收；更新公告见 `更新公告.md`）（A 系列：公网稳定性三件套 + 可观测性；真实反馈修复：全灭终局兜底 / 好人 bot 发言 / 投票不确定性；快照迁移 data/；动态发言；confidence 置信度接口；更新公告见 `更新公告.md`）（人机狼恋人逻辑：护恋人/引导狼队/白天辩护；声音设置面板分项开关+上帝配音并入；起始页精简；更新公告见 `更新公告.md`）（系统性代码审查修复：stepText 作用域回归 / 人机公平化 / 竞选投票修复 / 事件流补齐 / 版本串同步检查；更新公告见 `更新公告.md`）（审查修复：狼投票方向/狼总数取配置/第三方阵营判定 + 引擎不变式自检快照回滚；更新公告见 `更新公告.md`）（后台通知 + 上帝配音 + 游戏事件流 + 蒙特卡洛平衡实验室；更新公告见 `更新公告.md`）（快照恢复修复：hunter_shot 弃枪定时器 + .gitignore 隐私补漏；更新公告见 `更新公告.md`）（跨局记忆治理 + 房间快照恢复 + 内存看门狗 + 防滥用限流；更新公告见 `更新公告.md`）（快速隧道代码侧加固：SW 非 2xx 回退缓存页 + 进行中房间长 TTL + keep-alive 65s；更新公告见 `更新公告.md`）

## 快速开始

```bash
node server.js
```

浏览器打开 `http://localhost:3000`（可用环境变量改端口：`PORT=8080 node server.js`）。

- 房主「创建房间」→ 生成 6 位房间号（0-9 + A-Z）→ 发给朋友；
- 朋友「进入房间」输入房间号即可加入；
- 支持 4~18 人；满员后房主配置职业并开局。

**局域网联机**：同一局域网内，其他设备访问 `http://你的电脑IP:3000`（Windows 可用 `ipconfig` 查看 IP）。

## 🚀 部署到 Render（免费，公网可玩，不限局域网）

部署后所有人（无论在哪）访问你的 `https://xxx.onrender.com` 即可开黑。

**方式 A（推荐）：Blueprint 一键导入**
1. 把本目录推到 GitHub 仓库；
2. 打开 [render.com](https://render.com) → New → **Blueprint** → 选择该仓库；
3. 项目已自带 `render.yaml`（node / free / `node server.js` / 健康检查 `/healthz`），直接 Apply 即可。

**方式 B：手动创建 Web Service**
1. 推到 GitHub 后，New → **Web Service** → 选择仓库；
2. 配置：
   - **Build Command**：留空（零依赖）
   - **Start Command**：`node server.js`
   - **Health Check Path**：`/healthz`
3. 部署完成后，把 `https://xxx.onrender.com` 链接发给朋友。

**部署成功自检**
- 浏览器打开 `https://xxx.onrender.com/healthz`，看到 `{"ok":true,...}` 即成功；
- 打开首页创建一个房间，把房间号发给异地朋友加入，即可跨地域联机。

**公网联机的技术要点（已内置，无需额外配置）**
- 前端全部使用**相对路径**引用资源和请求 API，部署后自动跟随 HTTPS，**不需要 CORS 配置**；
- 服务器监听 `PORT` 环境变量（Render 自动注入），绑定所有网卡；
- 房间号机制：朋友只需输入 6 位房间号即可加入，无需知道服务器地址。

**注意事项（重要）**
- 房间状态保存在**服务器内存**：必须保持**单实例**（免费版默认 1 个实例，不要扩容）；
- **免费实例闲置 15 分钟会休眠**（休眠后房间全部清空，首次访问需等约 30~60 秒冷启动）：
  - 对局进行中不会休眠（有持续轮询流量）；
  - 防止休眠：用 [UptimeRobot](https://uptimerobot.com) 免费计划添加 HTTP 监控，每 10 分钟 ping `https://你的服务.onrender.com/healthz`；
  - 免费实例每月还有 750 小时额度上限；长期开黑可考虑升级付费实例（不会休眠）。
- 重新部署（自动部署每次 push）会重启实例、清空房间——尽量在对局结束后再 push。

## 功能清单

- 房间：创建 / 加入 / 踢人 / 离开、人数与职业配置（4~18 人）
- 首页：双卡入口（创建/加入，加入框常显）、趣味昵称自动生成（🎲 换一个）、房间号实时校验（非法红框抖动 / 6 位合法自动进入）、创建成功「房间号大卡」过渡、在线房间统计（🔥 正在开黑）、首屏夜景（月亮 / 云层 / 狼影呼吸）、字号调节（A-/A/A+）、邀请链接直达（`?room=` 自动填入）
- 对局体验：行动反馈动画（验/守/梦/刀/魅/救/毒/枪后目标卡闪现职业图标）、房主可见“谁已投/投给谁”明细（`votedBy` 仅房主下发）、移动端震动（轮到我/死亡/被踢）、夜晚面板按步骤角色色光晕
- 人机：四档决策（`bot-brain.js`）——挂机（仅补必要动作/弃票）、简单（关键词嫌疑度，可投被查杀者）、智能（贝叶斯推理：查验/查杀/金水/狼刀死亡/放逐投票为证据，狼人视角可校准预言家可信度并优先刀跳预言家者，多狼 bot 信念共享）、模拟（5 状态态度模型）；**公平玩家定位**：人机不使用服务器真相作弊（守卫/摄梦人/女巫仅基于发言与信念决策；狼仅知狼队友，不知恋人关系）；**狼恋人专项**（v1.6.3）：人机狼作为情侣之一时护恋人——不刀/不魅惑/不投恋人，狼频道引导狼队改刀，白天为恋人辩护；大厅添加人机时按 bot 选择级别，房间 botMode 作为默认级别
- 节奏与离线：夜晚各环节 45s、白天各环节 60s 倒计时；人机行动前等待 10s±2.5s（模拟真人思考，`BOT_DELAY_MS` 可覆盖）；首页「🎮 离线模式」一键建房并加满 5 名智能人机（单机陪练）；狼美人本就参与狼队出刀（`check-allroles.js` 断言覆盖）
- 社交传播：邀请链接（顶栏复制/📤 原生分享面板/创建大卡复制）、赛后趣味统计（最话痨/最快出局/最惨烈之夜）、PWA 可安装（manifest + Service Worker 网络优先、API 不缓存）、环境粒子（夜晚流星/白天阳光）
- 房主特权：警长选举开关、屠城/屠边、平票规则（PK / 无人出局）、开局后自选职业、**盗贼玩法开关**、**人机调试（添加/移除人机，挂机/简单/智能/模拟四档）**
- 职业：平民、预言家、女巫、猎人、摄梦人、守卫、狼人、狼美人、丘比特、警长（盗贼为房主可选玩法）
- 规则特色：
  - 盗贼玩法：随机指定一名玩家为盗贼，从身份牌堆抽两张择一（有狼必选狼），选定后即**丧失盗贼身份**变为所选职业；身份发放完毕后等待 5 秒自动进入夜晚（全员确认可提前）
  - 丘比特**开局默认为第三方**；可在情侣殉情后**重新指定情侣**，阵营随新情侣动态变化，重新指认前保持当前阵营；**自连一律属第三方**
  - 情侣被指认的瞬间醒来，**彼此确认对方身份**并知道丘比特是谁；丘比特不知道情侣身份，无法确定自己的阵营
  - **胜利条件**：好人与狼人均不需消灭第三方（好人=剔除第三方后的狼全灭即胜；屠城=好人全灭即胜）；**第三方活到最后才获胜**
  - **狼美人仅在被放逐时带走被魅惑者**（被狼刀/被毒/被猎人枪杀均不触发）
  - 狼人私密频道**仅夜晚开启**；情侣私密频道**全天开启**；**全体频道夜间关闭**
  - 狼队共享刀人目标，同伴可互相看到选定目标
  - 盗贼强制选狼、同守同救、摄梦人免疫、警徽移交、遗言、翻牌等（见 `rules.md`）
- 聊天：全体 / 狼人私密（仅夜晚）/ 情侣私密 三个频道
- 死亡玩家：可继续发言，不能投票
- 防卡局：所有行动阶段全员操作后自动推进，房主可「强制继续」
- 人机调试：房主可在**大厅**添加/移除人机玩家（`settings.botMode` 选「简单AI（会投票）」或「挂机（弃票）」），新加人机可选**挂机/简单/智能/模拟**四档（`simulate`=5状态态度模型+风格参数），人机由服务端自动执行本职业行动（夜晚决策/白天投票），用于缺人陪练与调试

## 目录结构

```
werewolf/
├── server.js          # HTTP 服务器（静态文件 + JSON API + /healthz + 安全加固）
├── game.js            # 游戏引擎（房间/阶段/结算/胜负）
├── package.json       # Render 部署用（start 脚本）
├── render.yaml        # Render Blueprint 一键部署配置
├── rules.md           # 规则确认文档
├── 更新公告.md        # 版本更新记录
├── 开启公网联机.bat   # 一键启动服务器 + Cloudflare 隧道（崩溃自动重启）
├── 启动游戏.bat       # 局域网联机启动
├── server-loop.bat    # 服务器崩溃自动重启（供公网联机脚本调用）
├── public/            # 网页客户端（index.html / style.css / client.js）
└── test/              # 自动化测试（41 个脚本 + 1 个渲染 harness）
└── tools/selfcheck.js # 代码自检工具（语法/版本串/死代码/重复case/文档-代码一致，--tests 可带全量测试）
└── tools/ai/determinism-check.js # 对局确定性验证（1.7.0 B1-8：同种子两遍 actionLog 逐字节一致；--seed/--cap/--bots）
```

## 技术说明

- 客户端轮询 `/api/state` 获取个性化状态（自适应间隔 700ms/1600ms，携带版本号增量更新，未变化时返回极小响应）；操作通过 POST `/api/action` 提交；
- 在线统计 `GET /api/stats` 返回当前活跃房间数/玩家数（超过 30 秒无轮询/SSE/操作视为非活动，不计入；阈值可用 `STATS_ACTIVE_SEC` 调整），首页每 30 秒刷新；
- 房间状态快照保存在 `data/rooms.json`（v1.5.6+，v1.6.4 起收纳到 data/ 子目录），**重启自动恢复进行中对局**（如需完全清空删除该文件即可）；闲置超过 2 小时无轮询的房间自动回收；
- 身份信息只在服务端可见，客户端按玩家过滤（狼队友、情侣、女巫视野、预言家历史等）；
- 刷新页面可通过 localStorage 自动重连。

## 测试

```bash
node test/simulate.js                 # 完整对局测试：场景 1~6（基础/全职业/守卫摄梦/盗贼+踢人/平票PK/丘比特重选）
node test/simulate-cupid-self.js      # 场景7：丘比特自连人狼情侣 → 第三方获胜
node test/simulate-wolfbeauty-gun.js  # 场景8：狼美人被枪杀不带走被魅惑者
node test/simulate-third-survive.js   # 场景9：第三方活到最后获胜
node test/simulate-timer.js           # 白天倒计时自动推进
node test/client-flow.js              # 浏览器流程：创建/加入/轮询/重连/错误提示
node test/check-s1.js                 # 狼频道可见性专项
node test/check-security.js           # 安全加固专项（路径穿越/参数校验/413/TTL）
node test/simulate-bot.js             # 人机测试：add_bot 权限校验 + T1挂机/T2简单AI 完整对局
node test/check-opt.js               # 优化专项（轮询版本化/自适应频率/gzip/静态缓存）
node test/check-handover.js          # 警徽移交规则专项
node test/check-night-timeout.js     # 夜晚/盗贼选牌超时自动跳过
node test/check-thief-view.js        # 盗贼视野信息隐藏回归
node test/check-chat-limit.js        # 聊天限流专项
node test/check-hunter-shot.js       # 猎人开枪/弃枪场景
node test/check-hunter-timeout.js    # 猎人 30 秒超时弃枪
node test/check-gaps.js              # 覆盖缺口补全（女巫自救/摄梦死亡链/猎人毒杀/守卫连守/警长全弃权/PK再平票/房主转移）
node test/check-sse.js               # SSE 推送唤醒（合法性 404/初始推送/版本变化推送/房间解散关连接）
node test/check-stats.js             # 在线统计 /api/stats（初始 0/创建计入/加入 +1/空闲过滤/轮询恢复/POST 404/解散归零）
node test/check-votedby.js           # 房主投票明细（votedBy 仅房主可见/弃票 null/警长投票同规则）
node test/check-pwa.js               # PWA 静态资源（manifest/sw/icon 200 + MIME + API 不缓存）
node test/check-bot-smart.js         # 人机三档决策（level 参数校验/smart 狼刀预言家/smart+easy 投被查杀者）
node test/check-bot-simulate.js      # simulate 态度模型（单元：情感累积/风格回退；黑盒：投被查杀者/狼夜正常行动）
node test/check-bot-third.js         # 第三方阵营适配（factionOf 单元/狼不刀恋人/第三方不投恋人/神职声称刀/人狼恋黑盒）
node test/check-bot-opt.js           # 策略优化（投票集中/卖狼美人/守卫守神职/摄梦人保命/盗贼选神职/职业发言）
node test/check-bot-debate.js        # bot 辩论/穿衣服/狼夜频道/遗言（B1 对跳反驳/B2 狼夜发言/B3 遗言）
node test/check-bot-advanced.js     # bot 高阶（银水/对跳查验/魅惑策略/发言模拟/悍跳/挂机沉默）
node test/check-allroles.js         # 全职业能力 + 频道验证（盗贼局 10 人全职业夜晚逐行动作）
node test/check-client-render.js    # 客户端渲染回归（DOM stub 直接跑渲染链，夜晚各步骤/频道 tabs/白天阶段）
node test/check-snapshot.js         # 房间快照持久化与恢复（建房推进→杀进程→新实例恢复→继续对局）
node test/check-resume.js           # 快照恢复定时器重挂（hunter_shot/夜晚猎人/进夜/盗贼/白天阶段）
node test/check-debug.js            # 游戏事件流 /api/debug（night_start/night_step/wolf_kill 等）
node test/check-invariants.js       # 引擎不变式自检 + 快照回滚（正常不误报/破坏触发/回滚链）
node test/check-balance-lab.js      # 蒙特卡洛平衡实验室（工具：--games/--cap/--counts/--bots/--winMode 批量自动对局输出胜率）
node tools/ai/model-validate.js     # 模型配对验收（同 seed 逐局「带模型 vs LAB_NO_MODEL」McNemar，默认 100 局，--quick 跑 50 局）
node tools/ai/vote-direction-stats.js # 投票方向统计（放逐狼/好人的投票者身份分布——A-1 LR 方向验证，默认 200 局）
node tools/ai/eval-vote-auc.js      # 跨配置 AUC（模型在带模型 bot 生态下的判别力——生态内过拟合检测）
node test/check-version-sync.js     # 版本串同步检查（package.json/页脚/sw.js CACHE/README/更新公告 五处一致）
node test/check-bot-lover.js        # 狼恋人逻辑专项（不刀/不魅惑/不投恋人、狼频道引导、白天辩护）
node test/check-docs.js             # 文档-代码一致性（版本总览表结构/已知事项与实现双向一致/版本标签齐全）
node test/check-opid.js             # 写操作 opId 幂等去重（重试不双执行/并发窗口/旧客户端放行/advance 不连跳）
node test/check-game-end.js         # 终局幂等兜底（屠边结束/猎人同归平局/无活人阶段入口兜底/ended 幂等）
node test/check-bot-expression.js   # 好人 bot 发言（easy 预言家报查验/被投辩解/平民表态/组合式生成质量）
node test/check-bot-vote-noise.js   # 投票不确定性表达（低置信波动/高置信稳定/波动不投恋人/confidenceOf）
node test/check-lab-stats.js        # 实验室 stats 纯函数（Wilson CI/McNemar/报告错误分类）
node tools/selfcheck.js             # 代码自检工具：语法+版本串+死代码+重复case+遗留标记+文档一致（--quick 快速；--tests 带全量回归）
node tools/ai/determinism-check.js  # 对局确定性验证（1.7.0 B1-8：同种子跑两遍，actionLog 逐字节一致）
```


### 🤖 1.7.0（B1）人机强度系统：感知层 AdaBoost + 规划层 Rollout
- **B1-8 显式 RNG**：`server/ai/rng.js`（xorshift128+）全局+房间级；快照续流；`tools/ai/determinism-check.js` 同种子逐字节验证
- **B1-1 纯行动接口**：`server/ai/legacy/decide.js`（decideVote/decideNightKill）；阶梯重排 easy←现smart、smart←现simulate、simulate←新simulate(+rollout)
- **B1-2/B1-3 训练管线**：`server/ai/features.js`（训练/推理同构）+ `tools/ai/train-vote-adaboost.js`（AdaBoost+Platt，三件套验收）；模型 `models/adaboost-vote-v1.json`（fail-open 加载）
- **B1-4 感知注入**：`server/ai/model-loader.js`——好人侧投票前模型 P(wolf) 混合（好人胜率 3%→40% 验证）
- **B1-5 Rollout**：`server/ai/rollout.js`——信念采样+模拟本轮投票（64 世界，预算内）
- **B1-6/B1-9 验收**：lab paired 400 局 p=0.0274 显著；13 人局狼 63-84%（较 96.2% 基线改善，未均衡）

### 🧪 蒙特卡洛实验室平台（test/lab/）——数据生产/消费分离

跑局与分析彻底解耦：**跑一次局产出 GameRecord（JSONL），胜率报告、训练样本、配对统计、确定性重放全部从中产出**。

```bash
node test/lab/lab.js smoke          # 冒烟（10 局 8 人）
node test/lab/lab.js baseline --games=500 --cap=13 --parallel=8   # 胜率基线（Wilson CI）
node test/lab/lab.js sample --games=2000 --cap=13 --out=data/lab-records.jsonl  # B1-2 样本管道（流式落盘+断点续跑）
node test/lab/lab.js deterministic --games=20 --seed=abc          # B1-0 确定性验收（同种子两遍事件流 hash 一致）
node test/lab/lab.js paired --strategy-a=smart --strategy-b=simulate --games=400 --seed=pair-001  # B1-6 配对验收（McNemar）
```

- 架构：`scenario → core → game.js` 单向依赖；`stats/`（wilson/mcnemar/report）纯函数零依赖
- GameRecord：`{schema, gameId, seed, scenario, config, result{winner,timeout,error{kind}}, players, events, firstKill}`——错误分类（config/engine/stall）一跑就知道该查谁
- 事件标准化（`core/events.js`）映射表已按 game.js 核对固化（night_start/night_step/wolf_kill/deaths/exile/shot）
- 任何新实验 = 新增一个 30 行的 scenario 文件，core 一行不改
- 数据落 `data/lab-*.jsonl`（已 gitignore）；2000 局约 200MB（JSONL 流式，断点续跑）

- `simulate.js`：模拟 6 个完整对局场景（基础局、全职业+盗贼玩法局、守卫/摄梦人局、盗贼局、平票 PK 局、丘比特重选/频道规则局），验证夜晚结算、猎人开枪、殉情、魅惑、同守同救、警徽移交、1.5 票、胜负判定、频道权限等；盗贼可能抽到与配置重复的职业牌（两个守卫/女巫等）或作废任意职业，测试覆盖了这些随机组合。
- `simulate-cupid-self.js`：丘比特把自己连进人狼情侣 → 第三方 = 丘比特+狼 两人，清场后第三方获胜。
- `client-flow.js`：验证“创建房间→显示房间号并进入→朋友加入→错误房间号提示→刷新重连→健康检查”，以及服务器未启动时的友好报错。

## 常见问题

- **点“创建房间”没反应？** 请确认已运行 `node server.js`，并通过 `http://localhost:3000` 访问（不要直接双击打开 `index.html`）。若服务器未启动，首页会显示红色提示；若直接打开了本地文件，也会提示。
- **房间号在哪里？** 创建成功后会自动复制到剪贴板并弹出提示，同时显示在页面顶部，也可点“复制”按钮。
- **公网联机**：部署到 Render 后，把 `https://xxx.onrender.com` 发给任何地方的网友即可，无需在同一局域网。

