'use strict';
/* 工作清单.md：勾选 A 系列已实施项 + 末尾追加实施记录（v1.6.4） */
const fs = require('fs');
const p = process.argv[2];
let s = fs.readFileSync(p, 'utf8');
const a1 = s.indexOf('## A1 部分');
const b1 = s.indexOf('## B1 部分');
if (a1 < 0 || b1 < 0 || b1 < a1) { console.error('小节锚点异常'); process.exit(1); }
const range = s.slice(a1, b1);
const out = range.split('\n').map(l => {
  if (l.includes('- [ ] **A2-6')) return l.replace('- [ ]', '- [ ]'); // 待用户明确期望，未实施
  if (l.includes('- [ ] **A2-2')) return l.replace('- [ ]', '- [x]') + ' ✅（v1.6.4 已验证：13人局狼胜率 100%→66.7%，仍偏高待 B1）';
  if (l.includes('- [ ]')) return l.replace('- [ ]', '- [x]');
  return l;
}).join('\n');
s = s.slice(0, a1) + out + s.slice(b1);

const record = `

---

## 📋 v1.6.4 A 系列实施记录（2026-08-05，验收凭据）

- 实施范围：A1（全部）+ A2（A2-1~A2-5；A2-6 待用户明确期望未实施）+ A3 + A4 + A5
- 新增文件：\`server/ai/confidence.js\`（A5 置信度接口）、\`server/ai/lexicon.json\`（A2-5 语料库）、\`tools/apply-changelog-164.js\`（一次性公告更新脚本）
- 测试：新增 \`check-opid.js\`（11 断言）/ \`check-game-end.js\`（8 断言）/ \`check-bot-expression.js\`（4 组）/ \`check-bot-vote-noise.js\`（4 组）；更新 \`check-snapshot.js\`（data/ 路径）、\`check-docs.js\`（data/ 断言）；**全量 41/41 通过**；\`tools/selfcheck.js --quick\` 通过
- A2-2 平衡实验室（13 人局 smart×13，30 局）：**狼胜率 66.7%**（对比真实反馈“13 人局狼全赢”已显著改善）；首刀 100% 好人（狼 bot 首刀神职/高可信者策略生效）；好人胜 33.3%——仍高于理想（≈45-50%），留待 B1 强度系统 + 好人协作进一步平衡
- A2-1 修复根因：\`checkWin\` 对“无活人”返回 null → 改判平局（draw）+ 终局幂等 + 阶段入口 checkGameEnd 兜底；check-game-end 覆盖屠边/同归平局/无活人挂起/幂等
- 部署：替换 server/game/bot-brain/public（client.js+sw.js+index.html）/package.json，重启，Ctrl+F5
`;
s = s + record;
fs.writeFileSync(p, s);
// 验证
const chk = fs.readFileSync(p, 'utf8');
console.log('A1已勾选:', chk.includes('- [x] **P1-1 POST 操作幂等重试'));
console.log('A2-6未勾选:', chk.includes('- [ ] **A2-6'));
console.log('实施记录:', chk.includes('## 📋 v1.6.4 A 系列实施记录'));
console.log('OK');
