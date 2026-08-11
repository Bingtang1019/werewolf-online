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
const crypto = require('crypto'); // 安全加固（M2）：快照 HMAC 完整性校验
const Game = require('./game.js');
const { createRng } = require('./server/ai/rng.js'); // 1.7.0（B1-8）

/* 1.7.0（B1-8）：全局 RNG——SEED env 可注入（确定性回放/配对验收）；房间创建时从全局派生房间种子 */
global.rng = createRng(parseInt(process.env.SEED || '0', 10) || (Date.now() >>> 0));

const PORT = process.env.PORT || 3000;

/* ---------- 运行时环境常量（v1.6.2：统一上移，此前声明在使用之后易误判 TDZ） ---------- */
/* /api/stats 的“活跃”判定窗口：超过该时长无轮询/SSE/操作视为非活动房间，不计入在线统计（默认 30 秒） */
const STATS_ACTIVE_MS = Math.max(1, parseInt(process.env.STATS_ACTIVE_SEC || '30', 10)) * 1000;
// 房间 TTL：轮询架构没有断线事件，超过 ROOM_TTL_MIN 分钟无任何轮询（lastActive 在 /api/state 中刷新）的房间直接回收
// 可用环境变量调整：ROOM_TTL_MIN（默认 120 分钟）、ROOM_SWEEP_SEC（默认 300 秒扫一次）
const ROOM_TTL_MS = Math.max(1, parseInt(process.env.ROOM_TTL_MIN || '120', 10)) * 60 * 1000;
// v1.5.5：lobby/已结束房间用短 TTL（默认 30 分钟及时回收挂机房），已开局的房间用长 TTL（默认 120 分钟，给隧道断线恢复留足时间）
const ROOM_LOBBY_TTL_MS = Math.max(1, parseInt(process.env.ROOM_LOBBY_TTL_MIN || '30', 10)) * 60 * 1000;
const ROOM_SWEEP_MS = Math.max(5, parseInt(process.env.ROOM_SWEEP_SEC || '300', 10)) * 1000;
/* v1.5.6：内存看门狗——RSS 持续超限（泄漏）则主动退出让平台/脚本重启；与 log-and-continue 崩溃容错互补 */
const MAX_RSS_MB = Math.max(64, parseInt(process.env.MAX_RSS_MB || '400', 10));

/* v1.6.4（A1-P2-1）：服务器端指标——请求总数/失败数/延迟直方图（固定毫秒桶，p95 从直方图 O(1) 估算，避免把统计本身做成热点） */
const httpStats = { total: 0, fail: 0, buckets: new Array(20).fill(0) };
const HTTP_BUCKETS = [5, 10, 25, 50, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000, 8000, 12000, Infinity]; // 20 桶（含上界）
function recordHttp(ms, isFail) {
  httpStats.total++;
  if (isFail) httpStats.fail++;
  let i = 0;
  while (i < HTTP_BUCKETS.length - 1 && ms > HTTP_BUCKETS[i]) i++;
  httpStats.buckets[i]++;
}
function p95Estimate() {
  const total = httpStats.buckets.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  const target = Math.ceil(total * 0.95);
  let acc = 0;
  for (let i = 0; i < HTTP_BUCKETS.length; i++) {
    acc += httpStats.buckets[i];
    if (acc >= target) return HTTP_BUCKETS[i] === Infinity ? HTTP_BUCKETS[HTTP_BUCKETS.length - 2] : HTTP_BUCKETS[i];
  }
  return 0;
}
/* 慢请求日志（>500ms，节流 ≥1s 一条）：隧道与服务器谁慢一眼可见 */
let lastSlowLogAt = 0;
function logSlow(pathname, ms) {
  const now = Date.now();
  if (now - lastSlowLogAt < 1000) return; // 节流
  lastSlowLogAt = now;
  logError('slow', '[' + ms + 'ms] ' + pathname); // 写 server.log + console
}

/* v1.6.4（A1-P1-1）：写操作 opId 幂等去重——客户端网络重试时防止“发言说两遍”类双执行。
 * 并发窗口：先写 pending 占位再处理，重试命中 pending 视为成功（写操作幂等）；
 * 只缓存轻量确认 {ok,code,ts}，不缓存完整响应体；懒清理（读取时比对 TTL + 超上限删最旧一半），无定时器；
 * 进程重启丢缓存可接受（重试窗口极小）。 */
const recentOps = new Map();
const OP_TTL_MS = 5 * 60 * 1000;
const OP_MAX = 2000;
function opCheck(body) {
  const opId = String((body && body.opId) || '');
  if (!opId || opId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(opId)) return { pass: true }; // 无 opId 的旧客户端直接放行
  const now = Date.now();
  const hit = recentOps.get(opId);
  if (hit) {
    if (hit.status === 'pending') return { replay: true, ok: true }; // 并发窗口：A 在处理中，B 到达 → 视为成功
    if (now - hit.ts > OP_TTL_MS) recentOps.delete(opId); // 过期 → 允许再次执行
    else return { replay: true, ok: hit.ok, code: hit.code };
  }
  if (recentOps.size >= OP_MAX) { // 懒清理：删除最旧一半（O(n) 一次）
    const arr = [...recentOps.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < arr.length / 2; i++) recentOps.delete(arr[i][0]);
  }
  recentOps.set(opId, { status: 'pending', ts: now });
  return { pass: true, opId };
}
function opCommit(opId, ok, code) {
  if (!opId) return;
  recentOps.set(opId, { ok: !!ok, code: code || 200, ts: Date.now() });
}

/* v1.6.4（A1-P2-1）：/api/stats 与 /api/debug 访问控制——
 * STATS_TOKEN / DEBUG_TOKEN 环境变量存在 → 要求 X-API-Token 或 Authorization: Bearer 匹配（token 不放 query，避免被中间层 access log 记录）；
 * 未配置 → 仅绑 localhost（公网访问 404/403，防裸奔——别让“忘了配 env”变成裸奔）。 */
function apiTokenOk(req, envName) {
  const token = process.env[envName];
  const ip = clientIp(req);
  if (token) {
    const h = String(req.headers['x-api-token'] || '').trim() || String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    return h === token;
  }
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

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
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
};

function acceptsGzip(req) { return /\bgzip\b/.test(req.headers['accept-encoding'] || ''); }
/* ============ v1.5.6 房间快照持久化：重启/崩溃恢复进行中对局（rooms.json，已 gitignore） ============ */
/* v1.6.4（A3）：快照收纳到 data/ 子目录（与代码分离，避免根目录散落 rooms.json*）；启动自动建目录；
 * 不自动迁移旧路径——检测到根目录旧 rooms.json 时打 WARN 提示手动移动，否则用户“房间全没了”无解释 */
const DATA_DIR = path.join(__dirname, 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'rooms.json');
const SNAPSHOT_ENABLED = parseInt(process.env.SNAPSHOT_SEC || '60', 10) > 0; // 0 表示禁用（测试环境）
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* 目录创建失败不影响主流程 */ }
try {
  if (fs.existsSync(path.join(__dirname, 'rooms.json')) && !fs.existsSync(SNAPSHOT_FILE)) {
    console.warn('[snapshot] 检测到根目录旧 rooms.json —— v1.6.4 起快照改存 data/rooms.json；如需保留旧对局请手动移动该文件到 data/ 目录');
  }
} catch (e) { /* ignore */ }
const SNAPSHOT_SEC = SNAPSHOT_ENABLED ? Math.max(3, parseInt(process.env.SNAPSHOT_SEC || '60', 10)) : 0; // v1.7.19：补默认值——未设 env 时 parseInt(undefined)=NaN → setInterval(NaN) 触发 TimeoutNaNWarning
const SNAPSHOT_REPLACER = (k, v) => {
  if (v instanceof Set) return { __set: [...v] };
  if (v instanceof Map) return { __map: [...v] }; // v1.6.1：防御未来加入 Map
  return v;
};
const SNAPSHOT_REVIVER = (k, v) => (v && v.__set ? new Set(v.__set) : (v && v.__map ? new Map(v.__map) : v));
function saveSnapshot() {
  if (!SNAPSHOT_ENABLED) return; // v1.5.6：禁用（测试环境）
  try {
    const data = { version: 1, savedAt: Date.now(), rooms: [...Game.rooms.values()].map(r => {
      const c = { ...r };
      delete c._phaseTimer; delete c._nightTimer; delete c._nightStepTimer;
      delete c._thiefTimer; delete c._hunterTimer; delete c._botTimer;
      c.rngState = r.rng ? r.rng.state() : null; delete c.rng; // 1.7.0（B1-8）：快照记录 RNG 状态（s 数组），恢复后随机序列连续不重演
      return c;
    }) };
    // 安全加固（M2）：快照 HMAC 完整性校验（SNAPSHOT_SECRET 配置后启用——防离线改档）
    if (process.env.SNAPSHOT_SECRET) {
      data.sig = crypto.createHmac('sha256', process.env.SNAPSHOT_SECRET).update(JSON.stringify(data)).digest('hex');
    }
    const tmp = SNAPSHOT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, SNAPSHOT_REPLACER));
    if (fs.existsSync(SNAPSHOT_FILE)) fs.copyFileSync(SNAPSHOT_FILE, SNAPSHOT_FILE + '.bak'); // C2：先备份上一次成功版本
    fs.renameSync(tmp, SNAPSHOT_FILE);
  } catch (e) { /* 快照失败不影响主流程 */ }
}
let dirtyTimer = null;
function markDirty() { // 房间变更后防抖 1s 原子写
  if (dirtyTimer) return;
  dirtyTimer = setTimeout(() => { dirtyTimer = null; saveSnapshot(); }, 1000);
}
function restoreRoomFromSnapshot(roomId) {
  if (!SNAPSHOT_ENABLED || !roomId) return false;
  try {
    if (!fs.existsSync(SNAPSHOT_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'), SNAPSHOT_REVIVER);
    if (!data || data.version !== 1 || !Array.isArray(data.rooms)) return false;
    const src = data.rooms.find(r => r && r.id === roomId);
    if (!src) return false;
    if (Array.isArray(src.rngState)) src.rng = createRng(0, src.rngState); // 1.7.0（B1-8）：恢复房间 RNG 续流
    else src.rng = createRng(Date.now() >>> 0);
    const room = Game.rooms.get(roomId);
    if (room) { // 清理旧定时器
      if (room._phaseTimer) clearTimeout(room._phaseTimer);
      if (room._nightTimer) clearTimeout(room._nightTimer);
      if (room._nightStepTimer) clearTimeout(room._nightStepTimer);
      if (room._thiefTimer) clearTimeout(room._thiefTimer);
      if (room._hunterTimer) clearTimeout(room._hunterTimer);
      if (room._botTimer) clearTimeout(room._botTimer);
    }
    Game.rooms.set(roomId, src);
    Game.resumeRoom(src);
    return true;
  } catch (e) { return false; }
}
function loadSnapshot() {
  if (!SNAPSHOT_ENABLED) return 0; // v1.5.6：禁用（测试环境）
  try {
    let raw = null, src = null;
    if (fs.existsSync(SNAPSHOT_FILE)) { raw = fs.readFileSync(SNAPSHOT_FILE, 'utf8'); src = SNAPSHOT_FILE; }
    let data = null;
    try { if (raw) data = JSON.parse(raw, SNAPSHOT_REVIVER); } catch (e) { data = null; }
    if (!data) { // C2：主文件损坏 → 回退 .bak
      try {
        if (fs.existsSync(SNAPSHOT_FILE + '.bak')) { data = JSON.parse(fs.readFileSync(SNAPSHOT_FILE + '.bak', 'utf8'), SNAPSHOT_REVIVER); src = SNAPSHOT_FILE + '.bak'; }
      } catch (e2) { data = null; }
    }
    // 安全加固（M2）：快照 HMAC 校验（SNAPSHOT_SECRET 配置后启用——防离线改档）
    if (process.env.SNAPSHOT_SECRET && data && data.sig) {
      const sig = data.sig; delete data.sig;
      const calc = crypto.createHmac('sha256', process.env.SNAPSHOT_SECRET).update(JSON.stringify(data, SNAPSHOT_REPLACER)).digest('hex');
      if (calc !== sig) { console.warn('[snapshot] 校验失败，拒绝恢复（可能被离线篡改）'); return 0; }
      data.sig = sig;
    }
    if (!data || data.version !== 1 || !Array.isArray(data.rooms)) return 0; // 格式不兼容 → 安全丢弃，绝不崩启动
    let n = 0;
    for (const r of data.rooms) {
      if (!r || !r.id) continue;
      r.lastActive = Date.now(); // 防 TTL 秒杀
      if (Array.isArray(r.rngState)) r.rng = createRng(0, r.rngState); // 1.7.0（B1-8）：恢复房间 RNG 续流
      else r.rng = createRng(Date.now() >>> 0);
      Game.rooms.set(r.id, r);
      try { Game.resumeRoom(r); } catch (e) { /* 单个房间恢复失败不影响其他 */ }
      n++;
    }
    return n;
  } catch (e) { return 0; }
}

/* v1.5.6：内存级令牌桶限流（防脚本刷房/刷号）；公网隧道下用 CF-Connecting-IP 取真实用户，避免全房间共享同一地址误伤 */
const ipBuckets = new Map();
function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  // v1.6.1：仅当请求来自本机代理（cloudflared/Render 反代）时才信任转发头；公网直连一律用真实 socket 地址，防伪造绕过限流
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') {
    return (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || remote;
  }
  return remote;
}
const LOCAL_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/* 安全加固（H1 防 DNS rebinding）：Host 白名单——私有网段默认放行，公网部署用 PUBLIC_HOST 配置域名（逗号分隔）
 * v1.7.21：cloudflared 免费隧道（开启公网联机.bat）域名动态生成（xxx.trycloudflare.com），无法预配置——
 * 放行该后缀（cloudflared 专用域，DNS rebinding 攻击者无法伪造；且仅当隧道实际转发时才可达） */
const PRIVATE_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\]|::1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const TUNNEL_HOST_RE = /\.trycloudflare\.com$/;
const PUBLIC_HOSTS = new Set((process.env.PUBLIC_HOST || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
/* 安全加固（H1 辅助）：POST Origin 校验——同源/无 Origin（脚本/curl）/PUBLIC_HOST 白名单放行 */
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    const oh = new URL(o).host.toLowerCase();
    const hh = String(req.headers.host || '').toLowerCase();
    if (oh === hh) return true;
    const port = process.env.PORT || '3000';
    return (process.env.PUBLIC_HOST || '').split(',').some(h => oh === h.trim().toLowerCase() + ':' + port);
  } catch (e) { return false; }
}
/* v1.6.2：POST 会话参数格式校验（与 /api/state 的 GET 校验同规则，防垃圾请求打到引擎）
 * 安全加固（C1/C2/C3）：me（玩家 id）改为 token（服务端会话凭证，128bit 熵，永不进视图） */
function validSession(body) {
  return /^[0-9A-Z]{6}$/.test(String(body && body.room || '')) && /^[0-9a-f]{32}$/.test(String(body && body.token || ''));
}
function rateLimit(ip, key, limit, windowMs) {
  if (!ip) return true;
  if (LOCAL_IPS.has(ip)) return true; // v1.6.2：仅回环（本机开发/测试）不限流；局域网直连与公网照常限流——公网部署时 socket 对端可能是反代内网地址，私有段豁免会导致限流失效
  const k = ip + ':' + key;
  const now = Date.now();
  let b = ipBuckets.get(k);
  if (!b || now - b.start > windowMs) { b = { start: now, n: 0 }; ipBuckets.set(k, b); }
  if (++b.n > limit) return false;
  return true;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of ipBuckets) { if (now - b.start > 60000) ipBuckets.delete(k); } }, 60000);

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
/* 静态文件缓存：按 mtime 缓存原始内容与 gzip 结果，避免每个请求重复读盘+压缩 */
const staticCache = new Map();
function serveStatic(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    const key = file;
    const hit = staticCache.get(key);
    const mime = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': mime, 'Cache-Control': 'no-cache', 'Vary': 'Accept-Encoding' };
    // 安全加固（M3）：CSP 纵深防御（模板含内联 style 属性，style-src 需 'unsafe-inline'；无内联 script）
    if (mime.startsWith('text/html')) {
      headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'";
    }
    const useGzip = acceptsGzip(req) && st.size > 512 && st.size <= 1024 * 1024;
    // 大文件（音频/视频）：不缓存不压缩，流式传输（防内存爆炸）；支持 Range（206）——浏览器
    // <audio> 播放大文件依赖 Range/渐进播放，200 全量响应会导致无声/长时间缓冲
    if (st.size > 1024 * 1024) {
      headers['Accept-Ranges'] = 'bytes';
      const rng = /bytes=(\d*)-(\d*)/.exec(String(req.headers.range || ''));
      if (rng) {
        let start = rng[1] ? parseInt(rng[1], 10) : 0;
        let end = rng[2] ? parseInt(rng[2], 10) : st.size - 1;
        if (isNaN(start) || start < 0) start = 0;
        if (isNaN(end) || end >= st.size) end = st.size - 1;
        if (start > end) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + st.size });
          res.end(); return;
        }
        res.writeHead(206, Object.assign({}, headers, {
          'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size,
          'Content-Length': end - start + 1
        }));
        const rs = fs.createReadStream(file, { start, end });
        rs.pipe(res);
        rs.on('error', () => { try { res.destroy(); } catch (e) {} });
        return;
      }
      res.writeHead(200, Object.assign({}, headers, { 'Content-Length': st.size }));
      const rs = fs.createReadStream(file);
      rs.pipe(res);
      rs.on('error', () => { try { res.destroy(); } catch (e) {} });
      return;
    }
    if (hit && hit.mtimeMs === st.mtimeMs) {
      if (useGzip) { headers['Content-Encoding'] = 'gzip'; res.writeHead(200, headers); res.end(hit.gz); }
      else { res.writeHead(200, headers); res.end(hit.data); }
      return;
    }
    fs.readFile(file, (e2, data) => {
      if (e2) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
      staticCache.set(key, { mtimeMs: st.mtimeMs, data, gz: data.length > 512 ? zlib.gzipSync(data) : null });
      if (useGzip) { headers['Content-Encoding'] = 'gzip'; res.writeHead(200, headers); res.end(staticCache.get(key).gz); }
      else { res.writeHead(200, headers); res.end(data); }
    });
  });
}
function readBody(req, res, cb) {
  const chunks = [];
  let size = 0;
  let tooBig = false;
  req.on('data', c => {
    size += c.length;
    if (size > MAX_BODY) {
      // 超限：不再缓冲（丢弃后续数据），立即回 413；不 destroy，保证响应能送达
      req.resume(); // v1.6.1：主动丢弃剩余数据，避免连接被占住
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

/* ---------------------------- SSE 推送唤醒（可选优化，不影响轮询 API） ---------------------------- */
const sseClients = new Map(); // roomId -> { lastV: number, res: Set<ServerResponse> }
// 每 1 秒检查订阅房间的版本变化，变化即推送 {v}（几字节），客户端收到后再拉 /api/state
setInterval(() => {
  const now = Date.now();
  for (const [roomId, entry] of sseClients) {
    const room = Game.rooms.get(roomId);
    if (!room) {
      // 房间已解散/被 TTL 回收：结束所有订阅连接
      for (const res of entry.res) { try { res.end(); } catch (e) {} }
      sseClients.delete(roomId);
      continue;
    }
    room.lastActive = now; // SSE 订阅也算活跃，防 TTL 误回收
    if (entry.lastV !== room.version) {
      entry.lastV = room.version;
      const msg = `data: ${JSON.stringify({ v: room.version })}\n\n`;
      for (const res of entry.res) { try { res.write(msg); } catch (e) {} }
    }
  }
}, 1000);

const server = http.createServer((req, res) => {
  const reqStart = Date.now();
  res.on('finish', () => { // v1.6.4（A1-P2-1）：请求结束打点（状态码 >=400 记失败）+ 慢请求日志
    const ms = Date.now() - reqStart;
    recordHttp(ms, res.statusCode >= 400);
    if (ms > 500) logSlow(pathname, ms);
  });
  // 安全加固（H1 防 DNS rebinding）：Host 不在白名单/私有网段/隧道域 → 403
  const hostHdr = String(req.headers.host || '').toLowerCase().split(':')[0];
  if (!PRIVATE_HOST_RE.test(hostHdr) && !PUBLIC_HOSTS.has(hostHdr) && !TUNNEL_HOST_RE.test(hostHdr)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  // 安全加固（H1 辅助）：POST 请求 Origin 校验（同源/白名单/无 Origin 放行）
  if (req.method === 'POST' && !originOk(req)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch (e) { res.writeHead(400); res.end('Bad Request'); return; }
  // 路径穿越防护：解码后仍含 ..（含 %2e%2e 等编码变体）→ 拒绝；控制字符（如 %00）→ 拒绝
  if (pathname.includes('..')) { res.writeHead(403); res.end('Forbidden'); return; }
  if (/[\x00-\x1f\x7f]/.test(pathname)) { res.writeHead(400); res.end('Bad Request'); return; }
  if (pathname === '/') pathname = '/index.html';

  /* ------------------------- API ------------------------- */
  if (pathname === '/healthz') {
    const rss = process.memoryUsage().rss / 1048576;
    if (rss > MAX_RSS_MB) { // B1：sendJSON 固定 writeHead(200)，这里必须直接写响应，否则 ERR_HTTP_HEADERS_SENT
      const hb = JSON.stringify({ ok: false, error: 'memory-limit', rss: Math.round(rss) });
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); // v1.6.1
      return res.end(hb);
    }
    return sendJSON(res, { ok: true, uptime: process.uptime(), rss: Math.round(rss), rooms: Game.rooms.size, http: { total: httpStats.total, fail: httpStats.fail, p95ms: p95Estimate() } }); // v1.6.4（A1-P2-1）
  }
  if (pathname.startsWith('/api/')) {
    /* 在线统计：当前“活跃”房间数/玩家数（首页“🔥 正在开黑”）。
     * 活跃判定与 TTL 共用 lastActive：超过 STATS_ACTIVE_MS 无轮询/SSE/操作视为非活动房间，不计入。
     * 阈值可用 STATS_ACTIVE_SEC 环境变量调整（默认 30 秒，测试可调小）。 */
    if (pathname === '/api/stats' && req.method === 'GET') {
      if (!apiTokenOk(req, 'STATS_TOKEN')) { res.writeHead(404); res.end('Not Found'); return; } // v1.6.4（A1-P2-1）：未配 token 仅 localhost
      const now = Date.now();
      let rooms = 0, players = 0;
      for (const r of Game.rooms.values()) {
        if (now - (r.lastActive || 0) > STATS_ACTIVE_MS) continue;
        rooms++;
        players += r.players.length;
      }
      return sendJSON(res, { rooms, players, http: { total: httpStats.total, fail: httpStats.fail, p95ms: p95Estimate() } });
    }
    if (pathname === '/api/debug' && req.method === 'GET') { // v1.6.0：事件流勘查/上帝视角回放数据源
      if (!apiTokenOk(req, 'DEBUG_TOKEN')) { res.writeHead(404); res.end('Not Found'); return; } // v1.6.4（A1-P2-1）：防泄露（含玩家名）
      const url = new URL(req.url, 'http://x');
      const roomId = (url.searchParams.get('room') || '').toUpperCase();
      const room = Game.rooms.get(roomId);
      if (!room) return sendJSON(res, { error: 'room-not-found' });
      return sendJSON(res, { phase: room.phase, nightStep: room.nightStep || null, dayNum: room.dayNum, nightNum: room.nightNum, players: room.players.length, events: (room.events || []).slice(-200) });
    }
    if (pathname === '/api/create' && req.method === 'POST') {
      const cip = clientIp(req);
      if (!rateLimit(cip, 'create', 10, 60000)) return sendJSON(res, { error: '创建房间过于频繁，请稍后再试' });
      if (Game.rooms.size >= 300) return sendJSON(res, { error: '服务器房间已满，请稍后再试' });
      return readBody(req, res, body => {
        const r = Game.createRoom(String(body.name || '').slice(0, 12) || '玩家', String(body.deviceId || ''));
        markDirty();
        sendJSON(res, { roomId: r.roomId, token: r.token, playerId: r.playerId, view: r.view });
      });
    }
    if (pathname === '/api/join' && req.method === 'POST') {
      if (!rateLimit(clientIp(req), 'join', 30, 60000)) return sendJSON(res, { error: '加入房间过于频繁，请稍后再试' });
      return readBody(req, res, body => {
        const roomId = String(body.roomId || '').toUpperCase().trim();
        if (!/^[0-9A-Z]{6}$/.test(roomId)) return sendJSON(res, { error: '房间号格式错误（6 位数字或字母）' });
        const r = Game.joinRoom(roomId, String(body.name || '').slice(0, 12) || '玩家', String(body.token || ''), String(body.deviceId || ''));
        if (r.error) return sendJSON(res, { error: r.error });
        markDirty();
        sendJSON(res, { token: r.token, playerId: r.playerId, reused: !!r.reused, view: r.view });
      });
    }
    if (pathname === '/api/state' && req.method === 'GET') {
      const url = new URL(req.url, 'http://x');
      const roomId = (url.searchParams.get('room') || '').toUpperCase();
      const token = url.searchParams.get('token') || '';
      // 安全加固（H2）：state 限流——未知房间 10 次/分，已知房间 300 次/分（8 人正常轮询 1~2s 足够）
      if (!rateLimit(clientIp(req), 'state-miss', 10, 60000) || !rateLimit(clientIp(req), 'state', 300, 60000)) return sendJSON(res, { error: 'rate-limit' });
      // 参数格式校验：房间号 6 位字母数字，会话 token 32 位 hex（安全加固 C1/C2/C3：me→token，id 不再作为凭证）
      if (!/^[0-9A-Z]{6}$/.test(roomId)) return sendJSON(res, { error: 'room-not-found' });
      if (!/^[0-9a-f]{32}$/.test(token)) return sendJSON(res, { error: 'player-not-found' });
      const room = Game.rooms.get(roomId);
      if (!room) return sendJSON(res, { error: 'room-not-found' });
      room.lastActive = Date.now(); // 记录活跃时间，供 TTL 清理使用
      const p = Game.byToken(room, token);
      if (!p) return sendJSON(res, { error: 'player-not-found' });
      if (p._disconnectedAt) p._disconnectedAt = null; // v1.7.21：活跃轮询 = 未断线（清除标记）
      // 版本一致 → 返回极小的“未变化”响应，避免每次轮询都传输完整状态（隧道带宽/CPU 关键优化）
      const clientV = parseInt(url.searchParams.get('v') || '-1', 10);
      if (clientV === room.version) return sendJSON(res, { v: room.version, changed: false });
      // 聊天增量：客户端带上最后一条消息的 ts（since），服务端只发新消息，避免全量重发
      const chatSince = parseInt(url.searchParams.get('since') || '0', 10) || 0;
      return sendJSON(res, Game.viewFor(room, p.id, chatSince));
    }
    if (pathname === '/api/stream' && req.method === 'GET') {
      const url = new URL(req.url, 'http://x');
      const roomId = (url.searchParams.get('room') || '').toUpperCase();
      const token = url.searchParams.get('token') || '';
      if (!/^[0-9A-Z]{6}$/.test(roomId)) { res.writeHead(404); res.end(); return; }
      if (!/^[0-9a-f]{32}$/.test(token)) { res.writeHead(404); res.end(); return; }
      const room = Game.rooms.get(roomId);
      if (!room) { res.writeHead(404); res.end(); return; }
      const p = Game.byToken(room, token);
      if (!p) { res.writeHead(404); res.end(); return; }
      // 安全加固（M1）：SSE 每房间连接数上限 64（防单 IP 挂大量长连接占内存）
      const curEntry = sseClients.get(roomId);
      if (curEntry && curEntry.res.size >= 64) { res.writeHead(429); res.end('Too Many Connections'); return; }
      // SSE：只推送版本号，数据仍走 /api/state（保持单一数据源）
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // 告知部分反向代理不要缓冲 SSE
      });
      res.write(`data: ${JSON.stringify({ v: room.version })}\n\n`);
      let entry = sseClients.get(roomId);
      if (!entry) { entry = { lastV: room.version, res: new Set() }; sseClients.set(roomId, entry); }
      entry.res.add(res);
      if (p._disconnectedAt) { p._disconnectedAt = null; } // v1.7.21：断线后重连——清除断线标记（不清理）
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000); // 防中间设备掐空闲连接
      req.on('close', () => {
        clearInterval(hb);
        entry.res.delete(res);
        if (!entry.res.size) sseClients.delete(roomId);
        // v1.7.21（双占位修复）：SSE 断开 → 标记断线，60s 未重连则移除玩家（防清理后台残留双占位）
        // 延迟窗口防误伤：浏览器刷新/短暂断网会在 60s 内重连（清除标记）
        p._disconnectedAt = Date.now();
        setTimeout(() => {
          const r2 = Game.rooms.get(roomId);
          if (!r2) return;
          const p2 = Game.byToken(r2, token);
          if (p2 && p2._disconnectedAt && Date.now() - p2._disconnectedAt >= 60000) {
            // 仍断线且超时：若 token 未续期（byToken 用旧 token 还能找到 = 玩家未重连/未重新 join）→ 移除
            Game.removePlayer(r2, p2.id);
          }
        }, 61000);
      });
      return;
    }
    if (pathname === '/api/action' && req.method === 'POST') {
      return readBody(req, res, body => {
        if (!validSession(body)) return sendJSON(res, { error: '参数格式错误' });
        // 安全加固（H2）：action 每 IP 60 次/分钟（正常玩家远用不到）
        if (!rateLimit(clientIp(req), 'action', 60, 60000)) return sendJSON(res, { error: '操作过于频繁' });
        const op = opCheck(body); // v1.6.4（A1-P1-1）：opId 幂等去重（重试命中 → 直接返回缓存确认）
        if (op.replay) return sendJSON(res, { ok: op.ok, code: op.code, replayed: true });
        const room = Game.rooms.get(body.room);
        const p = room && Game.byToken(room, body.token); // 安全加固：凭证 = token（id 不再可冒充）
        if (!p) return sendJSON(res, { error: '玩家不存在' });
        const r = Game.handleAction(body.room, p.id, body.action, body.data || {}, body.chatSince || 0);
        if (r.error) { opCommit(op.opId, false, 400); return sendJSON(res, { error: r.error }); }
        markDirty();
        opCommit(op.opId, true, 200);
        sendJSON(res, { ok: true, view: r.view, left: !!r.left });
      });
    }
    if (pathname === '/api/chat' && req.method === 'POST') {
      return readBody(req, res, body => {
        if (!validSession(body)) return sendJSON(res, { error: '参数格式错误' });
        const op = opCheck(body);
        if (op.replay) return sendJSON(res, { ok: op.ok, code: op.code, replayed: true });
        const room = Game.rooms.get(body.room);
        const p = room && Game.byToken(room, body.token);
        if (!p) return sendJSON(res, { error: '玩家不存在' });
        const r = Game.handleChat(body.room, p.id, body.data || {}, body.chatSince || 0);
        if (r.error) { opCommit(op.opId, false, 400); return sendJSON(res, { error: r.error }); }
        markDirty();
        opCommit(op.opId, true, 200);
        sendJSON(res, { ok: true, view: r.view });
      });
    }
    if (pathname === '/api/advance' && req.method === 'POST') {
      return readBody(req, res, body => {
        if (!validSession(body)) return sendJSON(res, { error: '参数格式错误' });
        const op = opCheck(body); // v1.6.4（A1-P1-1）：advance 也去重——重试不会把阶段连跳两格
        if (op.replay) return sendJSON(res, { ok: op.ok, code: op.code, replayed: true });
        const room = Game.rooms.get(body.room);
        const p = room && Game.byToken(room, body.token);
        if (!p) return sendJSON(res, { error: '玩家不存在' });
        const r = Game.handleAdvance(body.room, p.id, body.chatSince || 0);
        if (r.error) { opCommit(op.opId, false, 400); return sendJSON(res, { error: r.error }); }
        markDirty();
        opCommit(op.opId, true, 200);
        sendJSON(res, { ok: true, view: r.view });
      });
    }
    if (pathname === '/api/leave' && req.method === 'POST') {
      return readBody(req, res, body => {
        if (!validSession(body)) return sendJSON(res, { error: '参数格式错误' });
        const room = Game.rooms.get(body.room);
        const p = room && Game.byToken(room, body.token);
        if (!p) return sendJSON(res, { error: '玩家不存在' });
        Game.handleLeave(body.room, p.id); markDirty(); sendJSON(res, { ok: true });
      });
    }
    if (pathname === '/api/kick' && req.method === 'POST') {
      return readBody(req, res, body => {
        if (!validSession(body) || (body.target && !/^[0-9a-f]{16}$/.test(String(body.target)))) return sendJSON(res, { error: '参数格式错误' });
        const room = Game.rooms.get(body.room);
        const p = room && Game.byToken(room, body.token);
        if (!p) return sendJSON(res, { error: '玩家不存在' });
        const r = Game.handleKick(body.room, p.id, body.target, body.chatSince || 0);
        if (r.error) return sendJSON(res, { error: r.error });
        markDirty();
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
  return serveStatic(req, res, file);
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

setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [id, r] of Game.rooms) {
    const ttl = (r.phase === 'lobby' || r.phase === 'ended') ? ROOM_LOBBY_TTL_MS : ROOM_TTL_MS; // v1.5.5
    if (now - (r.lastActive || 0) > ttl) {
      if (r._phaseTimer) clearTimeout(r._phaseTimer);
      if (r._nightTimer) clearTimeout(r._nightTimer);
      if (r._nightStepTimer) clearTimeout(r._nightStepTimer);
      if (r._thiefTimer) clearTimeout(r._thiefTimer);
      if (r._hunterTimer) clearTimeout(r._hunterTimer);
      if (r._botTimer) clearTimeout(r._botTimer); // v1.6.2：此前清扫漏清 bot 调度定时器（与 restoreRoom/onBroken 两处保持一致）
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

// v1.5.5：调大 keep-alive（node 默认 5s），减少与 cloudflared/代理层的连接重建；headersTimeout 必须更大
/* v1.5.6：内存看门狗——RSS 持续超限（泄漏）则主动退出让平台/脚本重启；与 log-and-continue 崩溃容错互补（MAX_RSS_MB 见文件顶部） */
setInterval(() => {
  const rss = process.memoryUsage().rss / 1048576;
  if (rss > MAX_RSS_MB) {
    console.error('[watchdog] RSS ' + rss.toFixed(1) + 'MB 超过 ' + MAX_RSS_MB + 'MB，主动退出让平台重启');
    process.exit(1);
  }
}, 30000);

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000; // v1.6.2：必须 > keepAliveTimeout（node 对 headers 的计时含 keep-alive 空闲期，65s 形同虚设）
server.requestTimeout = 90000; // v1.6.4（A1-P2-2）：请求生命周期（含 body 接收）上限，大 POST 防挂起；三者关系：requestTimeout(请求全程) > headersTimeout(含空闲) > keepAliveTimeout(纯空闲)

/* v1.5.6：启动时恢复快照（房间 + 进行中对局）；失败/格式不兼容则静默忽略 */
/* v1.6.1：钩子必须在 loadSnapshot 之前注册（恢复过程任何变更也计入防抖落盘） */
Game.setOnChange(() => markDirty());
Game.setOnBroken((roomId, reason) => { // v1.6.1：不变式校验失败 → 快照回滚该房间（局级事务）
  try {
    const room = Game.rooms.get(roomId);
    const cnt = (room && room._brokenCount || 0) + 1;
    if (restoreRoomFromSnapshot(roomId)) {
      const r2 = Game.rooms.get(roomId);
      if (r2) {
        r2._brokenCount = cnt;
        if (cnt >= 3) { // 快照也救不回来（持续触发）→ 解散房间，避免回滚风暴
          try { if (r2._phaseTimer) clearTimeout(r2._phaseTimer); if (r2._nightTimer) clearTimeout(r2._nightTimer); if (r2._nightStepTimer) clearTimeout(r2._nightStepTimer); if (r2._thiefTimer) clearTimeout(r2._thiefTimer); if (r2._hunterTimer) clearTimeout(r2._hunterTimer); if (r2._botTimer) clearTimeout(r2._botTimer); } catch (e) {}
          Game.rooms.delete(roomId);
          console.error('[invariants] ' + roomId + ' 连续异常，已解散（' + reason + '）');
          markDirty();
          return;
        }
        try { Game.addMessage(r2, null, 'all', '⚠️ 房间检测到异常，已自动回滚到最近存档（' + reason + '）', '系统'); } catch (e) {}
        console.error('[invariants] ' + roomId + ' 回滚（' + reason + '）');
        markDirty();
      }
    }
  } catch (e) {}
});
const restoredRooms = loadSnapshot();
if (restoredRooms > 0) console.log('[snapshot] 已恢复 ' + restoredRooms + ' 个房间（含进行中对局）');
setInterval(saveSnapshot, SNAPSHOT_SEC * 1000); // 定期兜底保存

process.on('SIGTERM', () => { try { saveSnapshot(); } catch (e) {} process.exit(0); });
process.on('SIGINT', () => { try { saveSnapshot(); } catch (e) {} process.exit(0); });
process.on('exit', () => { try { saveSnapshot(); } catch (e) {} });

server.listen(PORT, () => {
  console.log('==============================================');
  console.log('  狼人杀 服务器已启动');
  console.log(`  本机访问: http://localhost:${PORT}`);
  lanIPs().forEach(ip => console.log(`  局域网访问: http://${ip}:${PORT}`));
  console.log('  公网联机：部署到 Render/VPS 后，把平台域名分享给朋友即可');
  console.log('==============================================');
});
