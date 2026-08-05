'use strict';
/* 工作清单.md：勾选 B1-8 + 追加 1.7.0 第 0 步实施记录 */
const fs = require('fs');
const p = process.argv[2];
let s = fs.readFileSync(p, 'utf8');
// 勾选 B1-8（整行）
const b18 = s.indexOf('- [ ] **B1-8 显式 RNG 注入');
if (b18 < 0) { console.error('未找到 B1-8 行'); process.exit(1); }
const lineEnd = s.indexOf('\n', b18);
s = s.slice(0, b18) + s.slice(b18, lineEnd).replace('- [ ]', '- [x]') + ' ✅（v1.7.0 第 0 步完成，见文末实施记录）' + s.slice(lineEnd);

const record = `

---

## 📋 v1.7.0 实施记录 · B1-8 显式 RNG 注入（第 0 步，2026-08-06）

- 新增 \`server/ai/rng.js\`：xorshift128+（零依赖）\`createRng(seed, sArr?)\` → next/int/pick/shuffle/state；\`state()\` 返回 [s0,s1]，快照存 s 数组、恢复后随机序列连续不重演
- **注入方式**：server.js 启动 \`global.rng = createRng(SEED env 或随机)\`；房间创建时 \`room.rng = createRng(global.rng.int())\`（从全局派生，房间间随机流独立）；game.js/bot-brain.js 全部 18 处 \`Math.random\` 替换完毕（game.js 6 处：randInt/shuffle 改签名 \`(room, n/arr)\`、newRoomCode/botDelay 走全局 RNG；bot-brain 16 处概率判断走 \`rng().next()\` + \`CUR_RNG\` 模块级当前决策 RNG，createBotDecision 入口设置——同步决策安全）
- **快照续流**：saveSnapshot 存 \`rngState\`（s 数组），restoreRoomFromSnapshot/loadSnapshot 重建房间 RNG（\`createRng(0, sArr)\`）——恢复后不重演
- **L2-lite 动作日志**：applyAction 成功时记 \`room.actionLog\`（{n, phase, step, actor: seat, action, data}，5000 条上限，不进 view，mood 不记，新局清空）
- **确定性验证工具** \`tools/ai/determinism-check.js\`：同种子跑两遍全 bot 对局（驱动消除调度竞态：bot 行动完成再推进、discuss 等发言达配额、vote 等 bot 投完），actionLog 归一化（player id → 座位号）后逐字节对比
- **验收结果**：seed 42/7/99/1234/2026 × cap 6/8/10/13 × easy/smart/simulate 全部**两遍一致**（27~95 条动作逐字节一致）；全量 41 测试绿
- 顺带修复：check-bot-opt O2 暴露的"卖狼策略被 A2-4 投票波动覆盖"（卖狼/被查杀目标豁免波动，v1.6.4 遗留 40% 概率误投）
`;
s = s + record;
fs.writeFileSync(p, s);
const chk = fs.readFileSync(p, 'utf8');
console.log('B1-8 已勾选:', chk.includes('- [x] **B1-8'));
console.log('记录已追加:', chk.includes('## 📋 v1.7.0 实施记录'));
