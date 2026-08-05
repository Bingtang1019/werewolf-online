'use strict';
/* 更新公告.md 批量更新（v1.6.4）：版本行 / 表格行 / 新小节 / 已知事项路径 */
const fs = require('fs');
const p = process.argv[2];
let src = fs.readFileSync(p, 'utf8');

// 1) 版本行
src = src.replace('> 当前版本：**1.6.3**', '> 当前版本：**1.6.4**（A 系列：公网稳定性三件套+可观测性 / 真实反馈修复：全灭终局兜底+好人 bot 发言+投票不确定性 / 快照迁移 data/ / 动态发言 / confidence 置信度接口）');

// 2) 正式版表格插入 1.6.4 行
const row164 = '| [v1.6.4](https://github.com/Bingtang1019/werewolf-online/tree/v1.6.4) | 2026-08-05 | 隧道 50% 失败率、全灭不结束、好人 bot 沉默、投票失真 | ①公网稳定性三件套：POST 幂等重试（opId 去重防“说两遍”）、失败轮询退避（已有指数退避确认）、快速隧道免 SSE；②可观测性：healthz/stats 增 HTTP 总数/失败/p95、慢请求日志、stats/debug token 防护；③requestTimeout 90s；④A2-1 全灭判平局结束 + 阶段入口兜底（终局幂等）；⑤A2-3/A2-5 好人 bot 报查验/辩解/表态 + 组合式生成（lexicon.json）；⑥A2-4 投票不确定性表达（confidence.js 置信度接口，A5）；⑦A4 动态发言次数（人类占比）；⑧A3 快照迁移 data/；新增 4 个专项测试 | 替换 server/game/bot-brain/public/sw.js，重启，Ctrl+F5 | 弱网“点不动”大减、全灭必终局、人机更像真人、观测不再靠猜 |';
src = src.replace('| [v1.6.3](https://github.com/Bingtang1019/werewolf-online/tree/v1.6.3) |', row164 + '\n| [v1.6.3](https://github.com/Bingtang1019/werewolf-online/tree/v1.6.3) |');

// 3) 新增 1.6.4 小节（在 1.6.3 小节前）
const lines = [
  '## 🔧 1.6.4 —— A 系列实施（公网稳定性 + 真实反馈 + 基建）',
  '',
  '> 来源：08-05 真实公网测试（cloudflared metrics 证实 trycloudflare 50% 请求失败）+ 真实玩家反馈；工作清单 A 系列。',
  '',
  '### ① 公网稳定性三件套（A1）',
  '- **P1-1 POST 幂等重试**：act()/chatSend() 网络失败自动重试（幂等动作清单），携带 opId；服务端写操作统一入口（action/chat/advance）recentOps 去重——先写 pending 占位再处理（并发窗口堵死“发言说两遍”），只缓存轻量确认不缓存大响应，懒清理无定时器，无 opId 旧客户端放行',
  '- **P1-2 轮询退避**：现有指数退避（连续失败 2s/4s/8s…15s 封顶，成功即恢复）确认已满足，无需改动',
  '- **P1-3 快速隧道免 SSE**：*.trycloudflare.com 检测 → 直接纯轮询，省掉每次进房的 3 次 SSE 失败风暴',
  '### ② 可观测性（A1-P2）',
  '- healthz、/api/stats 新增 http.total/fail/p95ms（固定 20 桶直方图，O(1) 估算）；慢请求日志（>500ms，≥1s 节流）',
  '- /api/stats、/api/debug 访问控制：STATS_TOKEN/DEBUG_TOKEN（Authorization: Bearer 或 X-API-Token，不放 query）；未配置仅绑 localhost（防裸奔）',
  '- **P2-2**：requestTimeout=90s（请求生命周期）；headersTimeout=70s > keepAliveTimeout=65s 已确认满足',
  '### ③ 真实玩家反馈（A2）',
  '- **A2-1【严重】全灭不结束**：根因 = checkWin 对“无活人”返回 null → 全灭判平局结束（draw）+ 终局幂等（ended 直接返回）+ 阶段推进入口统一 checkGameEnd 兜底（防“结算后无人可行动”挂起）',
  '- **A2-3 好人 bot 沉默**：easy 预言家补报查验；被投票/被查杀开口辩解；平民表态/质疑（不再“p 都不放一个”）',
  '- **A2-4 投票失真**：不确定性表达——confidenceOf 置信度低时小概率偏离最优（随机/跟风），高置信才准；缓解“太傻”与“太准”两端抱怨',
  '- **A2-5 发言质量**：新建 server/ai/lexicon.json（意图→语料库键值，C1 未来只消费它）+ 组合式生成（prefix/core/suffix），施压/气氛/狼夜/遗言/辩护全面接入',
  '- **A2-2 狼胜率**：配合 A2-3/A2-4 调整后跑平衡实验室 13 人局验证（见实施记录）',
  '- **A2-6 聊天流程**：待用户明确期望，未实施（保持占位）',
  '### ④ 基建（A3/A4/A5）',
  '- **A3 快照迁移**：快照收纳 data/rooms.json（启动自动建目录）；根目录旧文件启动 WARN 提示手动移动（不自动迁移）；.gitignore/check-docs/check-snapshot 同步',
  '- **A4 动态发言次数**：人类占比 >50% → 配额 1 条；>80% → 仅被质疑时开口（被投/被查杀允许额外 1 条）；否则 2 条',
  '- **A5 confidence.js**：server/ai/confidence.js 统一置信度入口（suspicion 方差版 0.15..0.95）；B1 只换 Platt 内部实现、C1 混沌层消费同一入口；boundedCandidates 有界候选供 C1 执行层',
  '### ⑤ 测试与部署',
  '- 新增：check-opid.js（opId 去重 11 断言）、check-game-end.js（全灭终局 8 断言）、check-bot-expression.js（发言 4 组）、check-bot-vote-noise.js（投票波动 4 组）；更新 check-snapshot.js（data/ 路径）、check-docs.js（data/ 断言）',
  '- 测试 41 个全绿；部署：替换 server/game/bot-brain/public/sw.js，重启，Ctrl+F5',
  '',
  '---',
  ''
];
const sec164 = lines.join('\n');
const idx163 = src.indexOf('\n## 🔧 1.6.3');
if (idx163 < 0) { console.error('未找到 1.6.3 小节锚点'); process.exit(1); }
src = src.slice(0, idx163 + 1) + sec164 + src.slice(idx163 + 1);

// 4) 已知事项第一条 → data/ 路径
const oldKnown = '- 服务器默认在 `rooms.json` 中保存房间快照（v1.5.6+），重启后自动恢复进行中的对局；如需完全清空，删除该文件即可。Render 免费实例休眠后快照可恢复；但若平台回收磁盘，则快照亦会丢失；';
const newKnown = '- 服务器默认在 `data/rooms.json` 中保存房间快照（v1.5.6+；v1.6.4 起收纳到 `data/` 子目录），重启后自动恢复进行中的对局；如需完全清空，删除 `data/rooms.json` 即可（根目录旧文件启动时会提示手动移动）。Render 免费实例休眠后快照可恢复；但若平台回收磁盘，则快照亦会丢失；';
if (!src.includes(oldKnown)) { console.error('未找到已知事项旧文案'); process.exit(1); }
src = src.replace(oldKnown, newKnown);

fs.writeFileSync(p, src);
const s = fs.readFileSync(p, 'utf8');
console.log('版本行:', s.match(/当前版本：\*\*([\d.]+)\*\*/)[1]);
console.log('1.6.4表格行:', s.includes('tree/v1.6.4'));
console.log('1.6.4小节:', s.includes('## 🔧 1.6.4'));
console.log('已知事项data:', s.includes('data/rooms.json'));
console.log('OK');
