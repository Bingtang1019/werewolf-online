'use strict';
/* 安全加固专项验证：路径穿越 / 参数校验 / body 上限 / 房间 TTL */
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8346;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const assert = (c, m) => { if (c) console.log('  ✓ ' + m); else { failures++; console.error('  ✗ FAIL: ' + m); } };

async function get(p) { return fetch(BASE + p); }
async function post(p, body) {
  return fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  await sleep(700);
  try {
    // ---- 1. 路径穿越 ----
    const vectors = [
      '/..%2f..%2f..%2f..%2fetc%2fpasswd',
      '/%2e%2e%2f%2e%2e%2fserver.js',
      '/..%5c..%5c..%5cwindows%5cwin.ini',
      '/%2e%2e/server.js',
      '/....//....//server.js',
      '/..%2f..%2fserver.log',
    ];
    for (const v of vectors) {
      const r = await get(v);
      // %2e%2e 会被 URL 解析器规范化（→404）；含 %2f 的变体则必须被我们拦截（403）
      assert(r.status === 403 || r.status === 404, `路径穿越拦截: ${v} → ${r.status}`);
    }
    // 控制字符
    const nul = await get('/index.html%00.js');
    assert(nul.status === 400 || nul.status === 403, `控制字符拦截: %00 → ${nul.status}`);
    // ---- 2. 正常静态文件仍可用 ----
    for (const p of ['/', '/index.html', '/style.css', '/client.js']) {
      const r = await get(p);
      assert(r.status === 200, `正常文件 200: ${p}`);
    }
    // ---- 3. 参数校验 ----
    const r1 = await get('/api/state?room=ABC&me=x');
    assert((await r1.json()).error === 'room-not-found', '非法房间号 → room-not-found');
    const r2 = await get('/api/state?room=ABC123&me=garbage!@#');
    assert((await r2.json()).error === 'player-not-found', '非法 me → player-not-found');
    // ---- 4. POST body 上限 ----
    const big = 'x'.repeat(2 * 1024 * 1024);
    const r3 = await post('/api/action', big);
    assert(r3.status === 413, `超大 body → 413 (实际 ${r3.status})`);
    // ---- 5. 正常业务仍可用 ----
    const cr = await post('/api/create', { name: '安全测试' });
    const j = await cr.json();
    assert(!!j.roomId && !!j.playerId, '创建房间正常');
    const st = await get(`/api/state?room=${j.roomId}&me=${j.playerId}`);
    const stj = await st.json();
    assert(st.status === 200 && stj.phase === 'lobby', 'state 正常');
    const st2 = await get(`/api/state?room=${j.roomId}&me=${j.playerId}&v=${stj.v}`);
    assert((await st2.json()).changed === false, '版本轮询 changed:false 正常');
  } catch (e) {
    failures++;
    console.error('✗ 异常:', e.message);
  } finally {
    srv.kill();
    console.log(failures === 0 ? '\n安全加固验证（穿越/参数/413）：全部通过 ✔' : `\n安全加固验证：${failures} 个失败 ✘`);
  }
  // ---- 6. TTL 验证（独立实例，TTL=1 分钟，5 秒扫一次） ----
  if (failures === 0) {
    const srv2 = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(8347), ROOM_TTL_MIN: '1', ROOM_SWEEP_SEC: '5' }, stdio: 'ignore' });
    await sleep(700);
    try {
      const B2 = 'http://127.0.0.1:8347';
      const mk = async name => {
        const r = await (await fetch(B2 + '/api/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).json();
        return r;
      };
      const roomA = await mk('A');
      const roomB = await mk('B');
      // 两个房间都轮询一次（设置 lastActive）
      await fetch(`${B2}/api/state?room=${roomA.roomId}&me=${roomA.playerId}`);
      await fetch(`${B2}/api/state?room=${roomB.roomId}&me=${roomB.playerId}`);
      // 之后只持续轮询 roomB，roomA 不再轮询
      const start = Date.now();
      while (Date.now() - start < 65 * 1000) {
        await fetch(`${B2}/api/state?room=${roomB.roomId}&me=${roomB.playerId}`);
        await sleep(1500);
      }
      const aState = await fetch(`${B2}/api/state?room=${roomA.roomId}&me=${roomA.playerId}`);
      const bState = await fetch(`${B2}/api/state?room=${roomB.roomId}&me=${roomB.playerId}`);
      assert((await aState.json()).error === 'room-not-found', 'TTL：空闲房间已回收（room-not-found）');
      assert(bState.status === 200, 'TTL：持续轮询的房间仍在');
      console.log(failures === 0 ? '\nTTL 验证：全部通过 ✔' : `\nTTL 验证：${failures} 个失败 ✘`);
    } catch (e) {
      failures++;
      console.error('✗ TTL 异常:', e.message);
    } finally {
      srv2.kill();
    }
  }
  process.exit(failures === 0 ? 0 : 1);
})();
