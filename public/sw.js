/* 狼人杀在线版 PWA Service Worker（v1.3.0）
 * 策略：网络优先，失败回退缓存 —— 联机游戏始终要最新状态，缓存只做弱网兜底；
 * v1.6.4（P3-1）：导航请求（页面）改为 stale-while-revalidate——先返回缓存渲染、后台静默刷新，
 *   弱网/隧道挂时页面不白屏（activate 清旧缓存 → 发版后下一次导航缓存 miss 强制走网络，版本绑定不破裂）；
 *   子资源仍网络优先（保证新 client.js/style.css 立即生效）。
 * /api/ 请求一律不缓存（由服务器实时应答）。
 * 发版时只需更新 CACHE 版本号，activate 阶段自动清理旧缓存。 */
const CACHE = 'ww-v1.9.0'; // v1.7.29：client.js 拆分后 PRECACHE 更新为 7 模块（修复缓存旧 index.html → client.js 404 → 按钮全失效）
const PRECACHE = ['/', 'index.html', 'style.css', 'js/core.js', 'js/render.js', 'js/chat.js', 'js/game-actions.js', 'js/fx-sound.js', 'js/music.js', 'js/main.js', 'manifest.json', 'icon.svg'];

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
  // v1.7.23（音频）：/music/ 音频文件不缓存不拦截——直接透传（播放器需要 Range/渐进流，
  // SW 的 clone 会缓冲整个大文件导致无声/卡顿 + Cache Storage 膨胀）
  if (url.pathname.startsWith('/music/')) {
    e.respondWith(fetch(req).catch(() => Response.error()));
    return;
  }

  // v1.6.4（P3-1）：导航请求 stale-while-revalidate
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const cached = await caches.match(req) || await caches.match('/');
      if (cached) {
        // 先返回缓存，后台静默刷新（成功才更新缓存；失败忽略——下次导航仍用缓存）
        e.waitUntil(
          fetch(req)
            .then(res => {
              if (res.ok && (res.type === 'basic' || res.type === 'default')) {
                const copy = res.clone();
                caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
              }
              return res;
            })
            .catch(() => {})
        );
        return cached;
      }
      // 无缓存（含发版后 activate 清旧缓存）：网络优先
      const res = await fetch(req);
      if (res.ok && (res.type === 'basic' || res.type === 'default')) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    })());
    return;
  }

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
