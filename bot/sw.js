// Halvia bot offline cache. The app shell and starter library are cached on install; the
// AI engine and PDF reader are cached the first time they're used. Model weights are cached
// separately by WebLLM itself.
const SHELL_CACHE = 'halvia-bot-shell-v1';
const VENDOR_CACHE = 'halvia-bot-vendor-v1';
const SHELL = [
  './', 'index.html', 'bot.css', 'bot.js', 'llm-worker.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'library/index.json', 'library/news2.md', 'library/sepsis.md', 'library/abcde.md', 'library/sbar.md', 'library/black-eye.md', 'library/halvia-bot.md',
  '../assets/fonts/fonts.css', '../assets/fonts/InterTight.woff2', '../assets/fonts/JetBrainsMono.woff2', '../favicon.png',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('halvia-bot-') && k !== SHELL_CACHE && k !== VENDOR_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/bot/vendor/')) {
    e.respondWith(caches.open(VENDOR_CACHE).then(async c => (await c.match(req)) || fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; })));
    return;
  }
  // Everything else: answer from the cache straight away and refresh it in the background.
  e.respondWith(caches.open(SHELL_CACHE).then(async c => {
    const key = req.mode === 'navigate' ? new URL('./', self.registration.scope).href : req;
    const hit = await c.match(key, { ignoreSearch: req.mode === 'navigate' });
    const net = fetch(req).then(r => { if (r.ok && r.type === 'basic') c.put(key, r.clone()); return r; }).catch(() => hit || Response.error());
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net;
  }));
});
