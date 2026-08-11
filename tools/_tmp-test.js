// 分批跑测试（每批 6 个，避免超时）
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const proj = path.resolve(__dirname, '..');
const tests = fs.readdirSync(path.join(proj, 'test')).filter(f => f.startsWith('check-') && f.endsWith('.js'));

const batch = process.argv[2] ? [process.argv[2] + '.js'] : tests.slice(0, 6);
const nodeExe = path.join(proj, 'node.exe');
const results = [];
for (const t of batch) {
  try {
    const out = execSync('"' + nodeExe + '" test/' + t, { cwd: proj, encoding: 'utf8', shell: 'cmd', timeout: 90000 });
    const pass = /全部通过|PASS|✓.*全部/.test(out);
    results.push((pass ? '✅' : '⚠️') + ' ' + t);
  } catch (e) {
    const err = (e.stderr || e.stdout || '').toString();
    const lastLine = err.trim().split('\n').filter(Boolean).slice(-1)[0] || '';
    results.push('❌ ' + t + ' — ' + lastLine.slice(0, 100));
  }
}
console.log(results.join('\n'));
