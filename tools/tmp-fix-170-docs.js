'use strict';
const fs = require('fs');
const root = 'C:/Users/dell/Desktop/狼人杀在线版 1.0.0';

// ===== 1) README：版本行补 1.7.0 描述（放在版本号后、1.6.4 描述前） =====
let r = fs.readFileSync(root + '/README.md', 'utf8');
const b1Desc = '（B1 人机强度系统：感知层 AdaBoost + 规划层 Rollout；显式 RNG / 样本管道 / 配对验收；更新公告见 `更新公告.md`）';
if (!r.includes('B1 人机强度系统')) {
  r = r.replace('> 当前版本：**1.7.0**', '> 当前版本：**1.7.0**' + b1Desc);
  fs.writeFileSync(root + '/README.md', r);
  console.log('README 版本行已补 1.7.0 描述');
} else console.log('README 已有 1.7.0 描述');

// ===== 2) 更新公告：插入 1.7.0 小节（在 1.6.4 小节前，标题带空格格式） =====
let s = fs.readFileSync(root + '/更新公告.md', 'utf8');
if (s.includes('## 🔧 1.7.0')) { console.log('更新公告已有 1.7.0 小节'); process.exit(0); }
const sec = [
  '## 🔧 1.7.0 —— 人机强度系统升级（B1：感知层 AdaBoost + 规划层 Rollout）',
  '- ①**B1-8 显式 RNG 注入**：server/ai/rng.js（xorshift128+）全局+房间级；快照记录 RNG 状态（恢复后序列不重演）；同种子对局 actionLog/事件流逐字节一致（deterministic 验收）',
  '- ②**B1-1 纯行动接口拆分**（server/ai/legacy/decide.js）：decideVote/decideNightKill 纯函数（阵营分流/跟票/卖狼/平局注入 rng 打破），态度逻辑排除干净（留给 C1 混沌层）',
  '- ③**B1-0 基线**：simulate 档 13 人局狼胜率 96.2%（500 局 records 落盘）',
  '- ④**B1-2 样本管道**：vote 特征（server/ai/features.js，13 维公开特征，训练/推理同构）；game.js 决策时刻采集钩子；lab sample 落 2000 局 + 5.6 万条样本',
  '- ⑤**B1-3 AdaBoost+Platt 训练器**（tools/ai/train-vote-adaboost.js）：200 决策树桩；三件套验收 Brier0.0301 / AUC0.9901 / avgPWolf-avgPGood 0.7799；模型 models/adaboost-vote-v1.json（随仓分发，fail-open 加载）',
  '- ⑥**B1-4 感知层注入**（server/ai/model-loader.js）：好人侧投票前模型 P(wolf) 混合（0.6 信念+0.4 模型）；同 seed 100 局好人胜率 3%→40%',
  '- ⑦**B1-5 Rollout 规划层**（server/ai/rollout.js）：信念采样 + 模拟本轮投票结算；逐候选“投 X 促成 X 放逐”收益（+2/-1 不对称）；64 世界',
  '- ⑧**B1-1② 阶梯重排**：easy←现smart、smart←现simulate、simulate←新simulate(+rollout)（LEVEL_MAP）',
  '- ⑨**B1-6 配对验收**：lab paired 400 局，新simulate vs 旧simulate discordant 83:56，χ²=4.86 p=0.0274 显著通过',
  '- ⑩**B1-9 平衡验证**：13 人局狼胜率 easy63% / smart84% / simulate83%（无超时无错误）；模型对好人侧提升最大；较 96.2% 基线改善但未均衡',
  '- **蒙特卡洛实验室架构重写**（数据生产/消费分离）：GameRecord 标准 schema（lab.game-record@1，JSONL 落盘）+ core（config/room-runner/pool/recorder/events，确定性驱动、错误分类 config/engine/stall、seed 注入、checkpoint 续跑）+ scenarios（baseline/sample/deterministic/paired）+ stats（wilson/mcnemar/report 纯函数）；依赖单向（scenario→core→game.js）；本次 B1 全程消费：基线、样本、确定性验收、配对验收、平衡验证',
  '',
  '',
].join('\n');
s = s.replace('## 🔧 1.6.4', sec + '## 🔧 1.6.4');
fs.writeFileSync(root + '/更新公告.md', s);
console.log('更新公告已插入 1.7.0 小节');
