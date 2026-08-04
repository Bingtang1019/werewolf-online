/* 狼人杀在线版 PWA Service Worker（v1.3.0）
 * 策略：网络优先，失败回退缓存 —— 联机游戏始终要最新状态，缓存只做弱网兜底；
 * /api/ 请求一律不缓存（由服务器实时应答）。
 * 发版时只需更新 CACHE 版本号，activate 阶段自动清理旧缓存。 */
const CACHE = 'ww-v1.3.0';
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
      .then(res => {
        const copy = res.clone();
        if (res.ok && (res.type === 'basic' || res.type === 'default')) {
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('/')))
  );
});
