'use strict';
/* PWA 静态资源（v1.3.0）：
 * P1 GET /manifest.json → 200 + application/json
 * P2 GET /sw.js → 200 + text/javascript
 * P3 GET /icon.svg → 200 + image/svg+xml
 * P4 sw.js 含 API 跳过逻辑（/api/ 永不缓存）且为网络优先策略
 * 运行：node test/check-pwa.js
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PORT = 8389;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, SNAPSHOT_SEC: '0', PORT: String(PORT) } });
  let ready = false;
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`${BASE}/healthz`); if (r.status === 200) { ready = true; break; } } catch (e) {} await sleep(200); }
  if (!ready) { console.error('服务器未就绪'); srv.kill(); process.exit(1); }
  try {
    const mf = await fetch(BASE + '/manifest.json');
    assert(mf.status === 200, 'P1 /manifest.json → 200');
    assert((mf.headers.get('content-type') || '').includes('application/json'), 'P1 manifest Content-Type 为 application/json');
    const mfBody = await mf.json();
    assert(mfBody.short_name === '狼人杀' && mfBody.display === 'standalone', 'P1 manifest 字段完整（short_name/display）');
    const sw = await fetch(BASE + '/sw.js');
    assert(sw.status === 200, 'P2 /sw.js → 200');
    assert((sw.headers.get('content-type') || '').includes('text/javascript'), 'P2 sw.js Content-Type 为 text/javascript');
    const ic = await fetch(BASE + '/icon.svg');
    assert(ic.status === 200, 'P3 /icon.svg → 200');
    assert((ic.headers.get('content-type') || '').includes('image/svg+xml'), 'P3 icon.svg Content-Type 为 image/svg+xml');
    const swBody = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
    assert(swBody.includes("startsWith('/api/')") && swBody.includes('fetch(req)'), 'P4 sw.js 网络优先且 /api/ 永不缓存');
  } catch (e) { failures++; console.error('!!异常: ' + ((e && e.stack) || e)); }
  finally { srv.kill(); }
  await sleep(300);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\nPWA 静态资源专项测试全部通过 ✔');
  process.exit(0);
}
main();
