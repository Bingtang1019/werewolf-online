const { execFileSync } = require('child_process');
const fs = require('fs');
const cwd = 'C:/Users/dell/Desktop/狼人杀在线版 1.0.0';
// 标注体系文档复制到 archive（data/ 被 gitignore——文档随 archive 入库）
fs.copyFileSync(cwd + '/data/nlu/README.md', cwd + '/archive/nlu-phase1.md');
// 三十节纪律 C 已写入（在上个失败的提交里没执行 commit——检查是否已写入）
const f = cwd + '/archive/v5-投票判定实验/README.md';
const c = fs.readFileSync(f, 'utf8');
console.log('纪律 C 已写入:', c.includes('纪律 C：实验门控'));
try {
  execFileSync('git', ['add', 'tools/nlu/', 'archive/nlu-phase1.md', 'archive/v5-投票判定实验/README.md'], { cwd, encoding: 'utf8' });
  execFileSync('git', ['commit', '-m', 'feat: NLU Phase 1 语料清洗分档（443→270 真实语料 + 意图标注体系 9 类 + 规则预标注 23 条——语料数据本地保留不入库，标注体系文档入 archive）+ 三十节纪律 C（LAB_* 门控默认值入切换清单）'], { cwd, encoding: 'utf8' });
  execFileSync('git', ['push'], { cwd, encoding: 'utf8', timeout: 60000 });
  console.log('提交 + push OK');
} catch (e) { console.log('失败:', (e.stderr || e.stdout || e.message).toString().slice(0, 300)); }
console.log(execFileSync('git', ['log', '--oneline', '-2'], { cwd, encoding: 'utf8' }));
