'use strict';
/* =========================================================================
 * 狼人杀 Web 服务器（零依赖：仅 Node.js 内置模块）
 * 启动：node server.js   （默认端口 3000，可用 PORT 环境变量修改）
 * 访问：http://localhost:3000
 * ========================================================================= */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const Game = require('./game.js');

const PORT = process.env.PORT || 3000;

function lanIPs() {
  const ips = [];
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
      }
    }
  } catch (e) { /* ignore */ }
  return ips;
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function acceptsGzip(req) { return /\bgzip\b/.test(req.headers['accept-encoding'] || ''); }
function sendJSON(res, obj) {
  const s = JSON.stringify(obj);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Accept-Encoding' };
  if (acceptsGzip(res.req) && s.length > 256) {
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    res.end(zlib.gzipSync(s));
  } else {
    res.writeHead(200, headers);
    res.end(s);
  }
}
const MAX_BODY = 1 * 1024 * 1024; // POST body 上限 1MB，超限直接 413（防恶意大请求占内存）
function readBody(req, res, cb) {
  const chunks = [];
  let size = 0;
  let tooBig = false;
  req.on('data', c => {
    size += c.length;
    if (size > MAX_BODY) {
      // 超限：不再缓冲（丢弃后续数据），立即回 413；不 destroy，保证响应能送达
      if (!tooBig) {
        tooBig = true;
        try { res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Payload Too Large'); } catch (e) { /* ignore */ }
      }
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (tooBig) return; // 已回复 413
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch (e) { body = {}; }
    cb(body);
  });
}

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch (e) { res.writeHead(400); res.end('Bad Request'); return; }
  // 路径穿越防护：解码后仍含 ..（含 %2e%2e 等编码变体）→ 拒绝；控制字符（如 %00）→ 拒绝
  if (pathname.includes('..')) { res.writeHead(403); res.end('Forbidden'); return; }
  if (/[\x00-\x1f\x7f]/.test(pathname)) { res.writeHead(400); res.end('Bad Request'); return; }
  if (pathname === '/') pathname = '/index.html';

  /* ------------------------- API ------------------------- */
  if (pathname === '/healthz') {
    return sendJSON(res, { ok: true, uptime: process.uptime() });
  }
  if (pathname.startsWith('/api/')) {
    if (pathname === '/api/create' && req.method === 'POST') {
      return readBody(req, res, body => {
        const r = Game.createRoom(String(body.name || '').slice(0, 12) || '玩家');
        sendJSON(res, { roomId: r.roomId, playerId: r.playerId, view: r.view });
      });
    }
    if (pathname === '/api/join' && req.method === 'POST') {
      return readBody(req, res, body => {
        const roomId = String(body.roomId || '').toUpperCase().trim();
        if (!/^[0-9A-Z]{6}$/.test(roomId)) return sendJSON(res, { error: '房间号格式错误（6 位数字或字母）' });
        const r = Game.joinRoom(roomId, String(body.name || '').slice(0, 12) || '玩家');
        if (r.error) return sendJSON(res, { error: r.error });
        sendJSON(res, { playerId: r.playerId, view: r.view });
      });
    }
    if (pathname === '/api/state' && req.method === 'GET') {
      const url = new URL(req.url, 'http://x');
      const roomId = (url.searchParams.get('room') || '').toUpperCase();
      const me = url.searchParams.get('me') || '';
      // 参数格式校验：房间号 6 位字母数字，玩家 ID 16 位 hex（顺手挡掉垃圾请求）
      if (!/^[0-9A-Z]{6}$/.test(roomId)) return sendJSON(res, { error: 'room-not-found' });
      if (!/^[0-9a-f]{16}$/.test(me)) return sendJSON(res, { error: 'player-not-found' });
      const room = Game.rooms.get(roomId);
      if (!room) return sendJSON(res, { error: 'room-not-found' });
      room.lastActive = Date.now(); // 记录活跃时间，供 TTL 清理使用
      const p = room.players.find(q => q.id === me);
      if (!p) return sendJSON(res, { error: 'player-not-found' });
      // 版本一致 → 返回极小的“未变化”响应，避免每次轮询都传输完整状态（隧道带宽/CPU 关键优化）
      const clientV = parseInt(url.searchParams.get('v') || '-1', 10);
      if (clientV === room.version) return sendJSON(res, { v: room.version, changed: false });
      return sendJSON(res, Game.viewFor(room, me));
    }
    if (pathname === '/api/action' && req.method === 'POST') {
      return readBody(req, res, body => {
        const r = Game.handleAction(body.room, body.me, body.action, body.data || {});
        if (r.error) return sendJSON(res, { error: r.error });
        sendJSON(res, { ok: true, view: r.view, left: !!r.left });
      });
    }
    if (pathname === '/api/chat' && req.method === 'POST') {
      return readBody(req, res, body => {
        const r = Game.handleChat(body.room, body.me, body.data || {});
        if (r.error) return sendJSON(res, { error: r.error });
        sendJSON(res, { ok: true, view: r.view });
      });
    }
    if (pathname === '/api/advance' && req.method === 'POST') {
      return readBody(req, res, body => {
        const r = Game.handleAdvance(body.room, body.me);
        if (r.error) return sendJSON(res, { error: r.error });
        sendJSON(res, { ok: true, view: r.view });
      });
    }
    if (pathname === '/api/leave' && req.method === 'POST') {
      return readBody(req, res, body => { Game.handleLeave(body.room, body.me); sendJSON(res, { ok: true }); });
    }
    if (pathname === '/api/kick' && req.method === 'POST') {
      return readBody(req, res, body => {
        const r = Game.handleKick(body.room, body.me, body.target);
        if (r.error) return sendJSON(res, { error: r.error });
        sendJSON(res, { ok: true, view: r.view });
      });
    }
    res.writeHead(404); res.end('Not Found'); return;
  }

  /* ------------------------- 静态文件 ------------------------- */
  // 双重校验：规范化后的路径必须位于 public 目录内（纵深防御）
  const publicDir = path.join(__dirname, 'public');
  const file = path.join(publicDir, pathname);
  if (!file.startsWith(publicDir + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    const headers = { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Vary': 'Accept-Encoding' };
    if (acceptsGzip(req) && data.length > 512) {
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      res.end(zlib.gzipSync(data));
    } else {
      res.writeHead(200, headers);
      res.end(data);
    }
  });
});

/* ---------------------------- 崩溃容错 ---------------------------- */
// 记录异常日志而不是直接退出：隧道场景下避免偶发错误中断整局游戏（日志写入 server.log，超 1MB 自动轮转 .old）
function logError(tag, err) {
  const line = `[${new Date().toISOString()}] ${tag}: ${(err && err.stack) || err}`;
  const file = path.join(__dirname, 'server.log');
  try {
    // 简单轮转：超过 1MB 把旧日志改名 .old（覆盖旧的 .old）
    const st = fs.existsSync(file) ? fs.statSync(file) : null;
    if (st && st.size > 1024 * 1024) {
      try { fs.renameSync(file, file + '.old'); } catch (e) { /* 改名失败忽略 */ }
    }
    fs.appendFileSync(file, line + '\n');
  } catch (e) { /* ignore */ }
  console.error(line);
}
process.on('uncaughtException', err => {
  if (err && err.code === 'EADDRINUSE') { console.error(`[错误] 端口 ${PORT} 已被占用，请先关闭已运行的服务器`); process.exit(1); }
  logError('uncaughtException', err);
});
process.on('unhandledRejection', err => logError('unhandledRejection', err));

server.on('error', err => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[错误] 端口 ${PORT} 已被占用，请先关闭已运行的服务器，或用 PORT 环境变量改用其他端口`);
    process.exit(1);
  }
  logError('server-error', err);
  process.exit(1);
});

// 房间 TTL：轮询架构没有断线事件，超过 ROOM_TTL_MIN 分钟无任何轮询（lastActive 在 /api/state 中刷新）的房间直接回收
// 可用环境变量调整：ROOM_TTL_MIN（默认 120 分钟）、ROOM_SWEEP_SEC（默认 300 秒扫一次）
const ROOM_TTL_MS = Math.max(1, parseInt(process.env.ROOM_TTL_MIN || '120', 10)) * 60 * 1000;
const ROOM_SWEEP_MS = Math.max(5, parseInt(process.env.ROOM_SWEEP_SEC || '300', 10)) * 1000;
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [id, r] of Game.rooms) {
    if (now - (r.lastActive || 0) > ROOM_TTL_MS) {
      if (r._phaseTimer) clearTimeout(r._phaseTimer);
      if (r._nightTimer) clearTimeout(r._nightTimer);
      Game.rooms.delete(id);
      removed++;
    }
  }
  if (removed) console.log(`[sweep] 清理 ${removed} 个超过 ${ROOM_TTL_MS / 60000} 分钟无活动的房间`);
}, ROOM_SWEEP_MS);

// 每 10 分钟输出一次运行统计，便于排查卡顿/崩溃（房间数、玩家数、内存）
setInterval(() => {
  let players = 0;
  for (const r of Game.rooms.values()) players += r.players.length;
  console.log(`[stats] rooms=${Game.rooms.size} players=${players} mem=${(process.memoryUsage().rss / 1048576).toFixed(1)}MB`);
}, 600000);

server.listen(PORT, () => {
  console.log('==============================================');
  console.log('  狼人杀 服务器已启动');
  console.log(`  本机访问: http://localhost:${PORT}`);
  lanIPs().forEach(ip => console.log(`  局域网访问: http://${ip}:${PORT}`));
  console.log('  公网联机：部署到 Render/VPS 后，把平台域名分享给朋友即可');
  console.log('==============================================');
});
