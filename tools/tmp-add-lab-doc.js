'use strict';
const fs = require('fs');
const root = 'C:/Users/dell/Desktop/狼人杀在线版 1.0.0';
let s = fs.readFileSync(root + '/更新公告.md', 'utf8');
const sec = [
  '## 🧪 蒙特卡洛实验室平台（架构重写：数据生产/数据消费分离）',
  '',
  '**为什么重写**：实验室曾是单文件工具脚本（check-balance-lab.js），结果只进 console 无法复用/对比；而它接下来要同时服务 A2（平衡验证）、B1（样本管道/配对验收/确定性验证）、C1（混沌层 A/B）三条线——每条线要的“数据形态”不同，但“跑局”这件事是同一件。核心动作只有一个：**定义 GameRecord 标准数据模型，把“跑局”和“分析”彻底解耦**——跑一次局，胜率报告、训练样本、配对统计、确定性重放全都能从中产出。',
  '',
  '**依赖方向（单向）**：`scenario → core → game.js`；stats 谁都不依赖。core 不 import stats，scenario 不碰 game.js。',
  '',
  '**GameRecord schema（架构锚点，lab.game-record@1，JSONL 落盘）**：',
  '- `gameId/seed/scenario`：由 seed+局号派生，全局唯一（配对/确定性模式的核心）',
  '- `config`：cap/counts/botLine/winMode/tieRule——跑局参数可复现',
  '- `result`：winner + timeout + **error.kind 错误分类（config/engine/stall）**——config 错是实验室问题、engine 错是 game.js 问题、stall 是驱动问题，三者在报告里分开计，一跑就知道该查谁',
  '- `players`：ground truth（训练标签来源）；`events`：标准化事件流（样本管道/重放地基）；`firstKill`：首刀分布',
  '',
  '**core/（跑局）**：',
  '- `config.js`：默认值 < preset < CLI 三级合并 + 校验；狼数阶梯（13 人=3 狼，与 B1-3 验收先验对齐）；默认 botLine；`--counts=wolf2,seer1,...` 覆盖；`--sample-file/--out` 相对项目根解析',
  '- `room-runner.js`：单局执行器——**确定性驱动**（等 bot 行动/投票/发言达配额再推进，消除调度竞态，deterministic 验收的前提）；错误分类；**B1-8 seed 注入**（每局重置全局 RNG → 房间派生一致）；labSampleFile 投票样本采集（game.js 决策时刻钩子）',
  '- `pool.js`：并发池 + seed 派生（`${base}-${i}`）+ checkpoint 续跑（doneSet 跳过已完成 gameId，2000 局中断不废）',
  '- `recorder.js`：流式 JSONL 落盘 + gameId 去重',
  '- `events.js`：事件标准化（宽松提取 + 透传，映射表按 game.js 实际事件结构核对后固化）',
  '',
  '**scenarios/（分析，各 30~40 行）**：baseline（胜率 Wilson CI + 首刀 + 错误分类，`--out` 落盘）、sample（records + vote 样本双落盘）、deterministic（同 seed 双跑 → 事件流 id→座位归一化后 sha256 对比）、paired（同 seed 双策略 → McNemar 配对检验）。',
  '',
  '**stats/（纯函数，零依赖，可单测）**：wilson（95% CI）、mcnemar（连续性校正 + erfc）、report（records → 报告对象）——`check-lab-stats.js` 专项单测。',
  '',
  '**使用**：',
  '```bash',
  'node test/lab/lab.js smoke',
  'node test/lab/lab.js baseline --games=500 --cap=13 --parallel=8 --bots=simulate',
  'node test/lab/lab.js sample --games=2000 --cap=13 --out=data/lab-records.jsonl --sample-file=data/vote-samples.jsonl',
  'node test/lab/lab.js deterministic --games=20 --seed=abc',
  'node test/lab/lab.js paired --strategy-a=simulate --strategy-b=smart --games=400 --seed=pair-001',
  '```',
  '',
  '**验收标准（防止为架构而架构）**：任何新实验 = 新增一个 30 行的 scenario 文件，core 一行不改；红线：不做 GUI/看板、不引数据库（JSONL 够，2000 局约 200MB）、不搞插件系统（scenario 就是函数，注册表就是对象）、stats 不引依赖。',
  '',
  '**B1 全程消费**：基线（simulate 档 13 人局狼 96.2%，500 局落盘）、样本（2000 局 5.6 万条 vote 样本）、确定性验收（同 seed 事件流 hash 逐字节一致）、配对验收（400 局 McNemar p=0.0274）、平衡验证（各档胜率/首刀/局时）。',
  '',
  '',
].join('\n');
s = s.replace('## 🔧 1.6.4', sec + '## 🔧 1.6.4');
fs.writeFileSync(root + '/更新公告.md', s);
console.log('lab 平台详细原理/架构已补入更新公告（1.7.0 小节之后、1.6.4 之前）');
