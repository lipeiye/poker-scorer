// 极简 Service Worker：仅缓存首屏壳（index.html + 静态资源），
// 让首屏秒开、断网时也能看到壳而非浏览器默认断网页。游戏数据走 WS 必须联网。
// 版本号变更会触发重新缓存；不拦截任何网络请求（network-first，仅回退到缓存）。
const CACHE = 'pk-shell-v9';
const SHELL = [
  './',
  './styles.css?v=8',
  './manifest.webmanifest',
  './favicon.png',
  './icon-192.png',
  './apple-touch-icon.png',
  './assets/hero-d943dda7.jpg',
  './assets/name-avatar-square.jpg',
  './assets/winner-congrats.jpg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // 只处理同源 GET；WS / API / 跨域一律放行
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // /api 和 /ws 永远走网络
  if (req.url.includes('/api/') || req.url.includes('/ws/')) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // 成功则顺手刷新缓存
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((c) => c || caches.match('./')))
  );
});
