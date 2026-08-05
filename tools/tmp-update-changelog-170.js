'use strict';
const fs = require('fs');
const root = 'C:/Users/dell/Desktop/狼人杀在线版 1.0.0';
let s = fs.readFileSync(root + '/更新公告.md', 'utf8');
// 1) 版本行
s = s.replace('>当前版本：**1.6.4**', '>当前版本：**1.7.0**');
// 2) 版本表插入 1.7.0 行（1.6.4 行前）
const row = [
  '| [v1.7.0](https://github.com/Bingtang1019/werewolf-online/tree/v1.7.0) | 2026-08-05 | 人机强度系统升级（B1）：感知层 AdaBoost + 规划层 Rollout |',
  '①B1-8 显式 RNG 注入（全局+房间级 xorshift128+，快照续流，同种子对局逐字节一致）；②B1-1 纯行动接口拆分（decideVote/decideNightKill，态度排除）；③B1-0 基线（simulate 档 13 人局狼 96.2%）；',
  '④B1-2 样本管道（2000 局 5.6 万条 vote 样本，决策时刻采集）；⑤B1-3 AdaBoost+Platt 训练器（三件套验收 Brier0.03/AUC0.99/avgP差0.78）；⑥B1-4 感知层注入（模型 P(wolf) 混合，好人胜率 3%→40%）；',
  '⑦B1-5 Rollout 规划层（信念采样+模拟本轮投票，64 世界）；⑧B1-1② 阶梯重排（easy←现smart、smart←现simulate、simulate←新simulate+rollout）；⑨B1-6 配对验收（400 局 McNemar p=0.0274 显著）；',
  '⑩B1-9 平衡验证（13 人局狼 63-84%，较基线改善未均衡） | 替换 server/ai/ + bot-brain.js + game.js + tools/ai/ + models/，重启 | 人机投票有了数据支撑的感知与前瞻；阶梯强度重构 |',
].join('\n');
s = s.replace('| [v1.6.4](https://github.com/Bingtang1019/werewolf-online/tree/v1.6.4) |', row);
// 3) 新增 1.7.0 小节
const sec = [
  '## 🔧1.7.0 ——人机强度系统升级（B1：感知层 AdaBoost + 规划层 Rollout）',
  '- ①**B1-8 显式 RNG 注入**：xorshift128+（server/ai/rng.js）全局+房间级；快照记录 RNG 状态（恢复不重演）；同种子对局 actionLog/事件流逐字节一致（deterministic 验收）',
  '- ②**B1-1 纯行动接口拆分**（server/ai/legacy/decide.js）：decideVote/decideNightKill 纯函数（阵营分流/跟票/卖狼/平局注入 rng 打破），态度逻辑排除（留给 C1 混沌层）',
  '- ③**B1-0 基线**：simulate 档 13 人局狼胜率 96.2%（印证 A2-2 狼胜率过高）',
  '- ④**B1-2 样本管道**：vote 特征（server/ai/features.js，训练/推理同构，只含公开信息）；game.js 决策时刻采集钩子；lab sample scenario 落 2000 局 + 5.6 万条样本',
  '- ⑤**B1-3 AdaBoost+Platt 训练器**（tools/ai/train-vote-adaboost.js）：200 决策树桩；三件套验收 Brier0.0301 / AUC0.9901 / avgPWolf-avgPGood 0.7799（修复：桩错误公式方向反、AUC 排序方向反）',
  '- ⑥**B1-4 感知层注入**（server/ai/model-loader.js）：好人侧投票前模型 P(wolf) 混合（0.6 信念+0.4 模型，fail-open）；同 seed 100 局好人胜率 3%→40%',
  '- ⑦**B1-5 Rollout 规划层**（server/ai/rollout.js）：信念采样+模拟本轮投票结算；逐候选"投 X 促成 X 放逐"收益（+2/-1 不对称）；64 世界',
  '- ⑧**B1-1② 阶梯重排**：easy←现smart、smart←现simulate、simulate←新simulate(+rollout)（LEVEL_MAP）',
  '- ⑨**B1-6 配对验收**：lab paired 400 局，新simulate vs 旧simulate discordant 83:56，χ²=4.86 p=0.0274 显著',
  '- ⑩**B1-9 平衡验证**：13 人局狼胜率 easy63% / smart84% / simulate83%（无超时无错误）；模型对好人侧提升最大（easy37%）；较 96.2% 基线改善但未均衡',
  '- 实验室平台持续增强：--bots 档位、baseline --out、sample --sample-file 并行采集、LAB_NO_MODEL 对照、config 驼峰解析、默认 botLine',
  '',
].join('\n');
s = s.replace('## 🔧1.6.4', sec + '## 🔧1.6.4');
fs.writeFileSync(root + '/更新公告.md', s);
console.log('更新公告完成');
