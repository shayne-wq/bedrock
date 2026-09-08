// Tombstone — not a cache.
//
// The deck used to be served from the site root, and every visitor who opened
// it still carries a service worker registered here with scope "/". That worker
// is cache-first over everything beneath it, including this marketing page's
// images and JS, and nothing would ever displace it: the page that now occupies
// the root registers no worker of its own, so the stale one would sit there
// serving whichever build a visitor happened to see first, forever.
//
// A registered worker's script is re-fetched by the browser on its own
// schedule, which makes replacing the file the only reliable way to retire the
// registration. This claims the clients it inherits, unregisters itself, and
// reloads them so they get the real page rather than whatever the old cache
// was holding.
//
// It deliberately does NOT clear caches: Cache Storage is per-origin, so
// deleting everything here would also wipe the deck's offline cache at /pit/.
// That worker already deletes every cache but its own on activate, so the
// orphan is collected the next time someone opens the deck.
//
// Once the installed base has cycled through, this file can be deleted.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  await self.registration.unregister();
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const c of clients) c.navigate(c.url).catch(() => {});
})()));
