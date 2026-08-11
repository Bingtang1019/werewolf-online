// 服务器启动错误捕获
const { spawn } = require('child_process');
const path = require('path');
const proj = path.resolve(__dirname, '..');
const nodeExe = path.join(proj, 'node.exe');
const srv = spawn(nodeExe, ['server.js'], { cwd: proj });
let err = '';
srv.stderr.on('data', d => err += d.toString());
srv.stdout.on('data', d => err += d.toString());
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await wait(3000);
  console.log('服务器输出:');
  console.log(err.slice(0, 1500));
  srv.kill();
  process.exit(0);
})();
