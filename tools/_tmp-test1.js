// 逐个跑测试（60s/个）
const { execSync } = require('child_process');
const path = require('path');
const proj = path.resolve(__dirname, '..');
const nodeExe = path.join(proj, 'node.exe');
const t = process.argv[2] || 'check-balance-lab';
try {
  const out = execSync('"' + nodeExe + '" test/' + t + '.js', { cwd: proj, encoding: 'utf8', shell: 'cmd', timeout: 60000 });
  console.log('✅ ' + t + ' 完成');
  console.log(out.trim().split('\n').filter(l => /PASS|FAIL|通过|失败/.test(l)).slice(-5).join('\n'));
} catch (e) {
  console.log('❌ ' + t + ':', ((e.stderr || e.stdout || '').toString().trim().split('\n').filter(Boolean).slice(-3)).join('\n'));
}
