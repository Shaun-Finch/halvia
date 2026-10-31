// Halvia bot offline cache.
// - App shell and libraries: network first (so updates arrive), falling back to the cache after
//   3.5 seconds or when offline.
// - AI engine, PDF reader, fonts and icons: cache first.
// Model weights are cached separately by WebLLM. Cache names must match CACHES in bot.js.
const SHELL_CACHE = 'halvia-bot-shell-v2';
const VENDOR_CACHE = 'halvia-bot-vendor-v1';
const SHELL = [
  './', 'index.html', 'bot.css', 'bot.js', 'llm-worker.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'library/index.json', 'library/research.json',
  '../assets/fonts/fonts.css', '../assets/fonts/InterTight.woff2', '../assets/fonts/JetBrainsMono.woff2', '../favicon.png',
];
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    await c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })));
    const lib = await (await fetch('library/index.json', { cache: 'reload' })).json();
    await c.addAll(lib.map(d => new Request('library/' + d.file, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('halvia-bot-') && k !== SHELL_CACHE && k !== VENDOR_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const cacheFirst = /\/bot\/(vendor|icons)\/|\/assets\/fonts\/|favicon\.png$/;
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (cacheFirst.test(url.pathname)) {
    const name = url.pathname.includes('/bot/vendor/') ? VENDOR_CACHE : SHELL_CACHE;
    e.respondWith(caches.open(name).then(async c => (await c.match(req)) || fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; })));
    return;
  }
  e.respondWith((async () => {
    const c = await caches.open(SHELL_CACHE);
    const nav = req.mode === 'navigate';
    const key = nav ? new URL('./', self.registration.scope).href : req;
    const net = fetch(req).then(r => { if (r.ok && r.type === 'basic') c.put(key, r.clone()); return r; });
    e.waitUntil(net.then(() => {}, () => {}));
    try {
      return await Promise.race([net, new Promise((_, no) => setTimeout(() => no(new Error('slow')), 3500))]);
    } catch {
      const hit = await c.match(key, { ignoreSearch: nav });
      if (hit) return hit;
      return net;
    }
  })());
});
