/* [优化1] 缓存版本升级至 v7：fetch 策略变更（仅缓存 GET、离线导航回退），
   新版本号可触发旧 SW 退场、新缓存生效 */
const CACHE_NAME = 'focus-timer-v48';
const urlsToCache = [
  './',                 // [优化2] 预缓存根路径，离线访问目录 URL 时也能命中
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];
self.addEventListener('install', e => {
  // 不再立即 skipWaiting：新版本安装完成后进入等待态，
  // 由页面弹出更新提示、用户确认后通过 message 触发 skipWaiting
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});
// 页面确认更新后，激活等待中的新 SW
self.addEventListener('message', e => {
  if(e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  // [优化3] 只处理 GET 请求；POST/PUT 等直接放行，避免被缓存逻辑误拦截
  if (e.request.method !== 'GET') return;
  // [优化5] version.json 不经过缓存、直连网络：更新提示条要向服务器实时拉取新版本说明，
  // 若被缓存优先策略拦截，旧缓存会把旧版本说明喂回来
  if (new URL(e.request.url).pathname.endsWith('/version.json')) return;
  e.respondWith(
    caches.match(e.request, {ignoreSearch: true})
      .then(response => {
        // [优化4] 缓存优先；未命中则走网络，网络失败时若为页面导航则回退到缓存的首页，
        // 保证 PWA 在完全离线状态下仍可打开（原代码离线刷新会白屏）
        if (response) return response;
        return fetch(e.request).catch(() => {
          if (e.request.mode === 'navigate') return caches.match('./index.html');
          return Response.error();
        });
      })
  );
});
