// Site-wide helper for Halvia bot: sends halvia.cloud/bot (no trailing slash) to /bot/,
// so the offline copy opens even without a connection. Everything else passes straight through.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.mode === 'navigate' && url.origin === location.origin && url.pathname === '/bot') e.respondWith(Response.redirect('/bot/' + url.search, 302));
});
