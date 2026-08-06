'use strict';
const fs = require('fs');
const root = 'C:/Users/dell/Desktop/狼人杀在线版 1.0.0';
const OLD = '1.7.0', NEW = '1.7.1';
// 1. package.json
{
  const f = root + '/package.json';
  let s = fs.readFileSync(f, 'utf8');
  s = s.replace('"version": "' + OLD + '"', '"version": "' + NEW + '"');
  fs.writeFileSync(f, s);
}
// 2. index.html footer
{
  const f = root + '/public/index.html';
  let s = fs.readFileSync(f, 'utf8');
  s = s.replace('<span>v' + OLD + '</span>', '<span>v' + NEW + '</span>');
  fs.writeFileSync(f, s);
}
// 3. sw.js CACHE
{
  const f = root + '/public/sw.js';
  let s = fs.readFileSync(f, 'utf8');
  s = s.replace("'ww-" + OLD + "'", "'ww-" + NEW + "'");
  fs.writeFileSync(f, s);
}
// 4. README 版本行（版本号 + 插入 1.7.1 描述）
{
  const f = root + '/README.md';
  let s = fs.readFileSync(f, 'utf8');
  s = s.replace('**' + OLD + '**', '**' + NEW + '**');
  s = s.replace('>当前版本：**' + NEW + '**', '>当前版本：**' + NEW + '**（可注入时钟+虚拟时间：全量回归/样本管道/规则测试提速 45 倍；更新公告见 `更新公告.md`）');
  fs.writeFileSync(f, s);
}
// 5. 更新公告：版本行 + 表格 1.7.1 行 + 1.7.1 小节
{
  const f = root + '/更新公告.md';
  let s = fs.readFileSync(f, 'utf8');
  s = s.replace('**' + OLD + '**', '**' + NEW + '**');
  const row171 = '| [v1.7.1](https://github.com/Bingtang1019/werewolf-online/tree/v1.7.1) |2026-08-05 |全量回归小时级、样本管道分钟级、规则测试要摆盘 |①server/clock.js 可注入时钟单例（real/virtual，默认 real 零变化）；②game.js 37 处 Date.now/setTimeout/clearTimeout 全部换 clock.*；③debugRoom 摆盘构造器（毫秒级规则测试）；④实验室平台虚拟时间驱动（同 seed 双跑严格确定，50 局墙钟 0.52s）；⑤守卫测试 check-lab-virtual |替换 server/clock.js + game.js + test/lab/* + public/sw.js，重启 |全量回归/样本/规则测试提速约 45 倍 |';
  // 表格：在 1.7.0 行前插入 1.7.1 行
  const anchor = '| [v1.7.0](';
  if (!s.includes('v1.7.1')) {
    s = s.replace(anchor, row171 + '\n' + anchor);
  }
  const sec = '## 🔧 1.7.1 —— 可注入时钟 + 虚拟时间加速\n' +
    '- **① server/clock.js 可注入时钟单例**：`setMode(\'real\')` 生产（行为零变化，默认）/ `setMode(\'virtual\')` 测试与实验室（墙钟不随游戏流逝）；定时器按触发时刻有序排队，`tickNext()` 同步执行回调。\n' +
    '- **② game.js 37 处定时器/时间戳全部换 clock.\***：阶段超时、夜晚步骤、猎人/盗贼倒计时、bot 调度、发言限流、消息/事件时间戳、快照恢复重挂；bot-brain.js 盲区自查通过（决策纯同步、随机全走 rng()、无真实时间依赖，虚拟加速不破功）。\n' +
    '- **③ debugRoom 测试构造器**：跳过建房/发牌直接摆盘（phase/roles/night 自动补齐前置步骤），seed 可确定性，毫秒级规则测试；已导出供测试/实验室使用。\n' +
    '- **④ 实验室平台升级虚拟时间驱动**（runOneLabGame）：同 seed 双跑严格确定（事件流逐字节一致）；驱动只推时钟游戏自动走完——**50 局墙钟 0.52s**（真实模式每局 2-4s），2000 局样本管道从分钟级压到秒级。\n' +
    '- **⑤ 守卫测试 check-lab-virtual**：墙钟 <3s + 同 seed 两遍事件流 hash 一致（防架构回归）。\n' +
    '\n\n';
  // 在 🧪 实验室平台小节前插入 1.7.1 小节
  s = s.replace('## 🧪 蒙特卡洛实验室平台', sec + '## 🧪 蒙特卡洛实验室平台');
  fs.writeFileSync(f, s);
}
console.log('1.7.1 版本同步 + 更新公告完成');
// 校验
const pkg = JSON.parse(fs.readFileSync(root + '/package.json', 'utf8'));
console.log('package.json:', pkg.version);
console.log('index.html:', fs.readFileSync(root + '/public/index.html', 'utf8').match(/<span>v([\d.]+)<\/span>/)[1]);
console.log('sw.js:', fs.readFileSync(root + '/public/sw.js', 'utf8').match(/ww-([\d.]+)/)[1]);
console.log('README:', fs.readFileSync(root + '/README.md', 'utf8').match(/当前版本：\*\*([\d.]+)\*\*/)[1]);
console.log('更新公告:', fs.readFileSync(root + '/更新公告.md', 'utf8').match(/当前版本：\*\*([\d.]+)\*\*/)[1]);
