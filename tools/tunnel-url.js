// 隧道 URL 提取器：读 tunnel-err.log / tunnel.log，输出最新 trycloudflare URL
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..');
const files = [path.join(dir, 'tunnel-err.log'), path.join(dir, 'tunnel.log')];
const re = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
let url = '';
for (const f of files) {
  try {
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (const l of lines) {
      const m = l.match(re);
      if (m) url = m[0];
    }
  } catch (e) { /* ignore */ }
}
process.stdout.write(url + '\n');
