/* 狼人杀在线版 PWA Service Worker（v1.3.0）
 * 策略：网络优先，失败回退缓存 —— 联机游戏始终要最新状态，缓存只做弱网兜底；
 * /api/ 请求一律不缓存（由服务器实时应答）。
 * 发版时只需更新 CACHE 版本号，activate 阶段自动清理旧缓存。 */
const CACHE = 'ww-v1.5.5';
const PRECACHE = ['/', 'index.html', 'style.css', 'client.js', 'manifest.json', 'icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()).catch(() => {})
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // API 永不缓存
  e.respondWith(
    fetch(req)
      .then(async res => {
        // 成功响应：更新缓存后返回
        if (res.ok && (res.type === 'basic' || res.type === 'default')) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
          return res;
        }
        // v1.5.5：非 2xx（524/502/504 等隧道断连错误页）→ 回退缓存，
        // 让页面从缓存打开而不是直接显示错误页；导航请求回退到缓存的首页
        const hit = await caches.match(req);
        if (hit) return hit;
        if (req.mode === 'navigate') {
          const home = await caches.match('/');
          if (home) return home;
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        if (req.mode === 'navigate') return (await caches.match('/')) || Response.error();
        return Response.error();
      })
  );
});
