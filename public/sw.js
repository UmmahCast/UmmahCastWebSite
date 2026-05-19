// Validate that a push-payload URL is a same-origin path. Push payloads come
// signed by our VAPID key, but defense-in-depth: never call openWindow with
// a URL we wouldn't open ourselves (no javascript:, no cross-origin redirects).
function safePushUrl(input) {
  if (typeof input !== 'string') return '/';
  if (input.startsWith('/') && !input.startsWith('//')) return input;
  return '/';
}

self.addEventListener('push', (event) => {
  const data = event.data?.json() || {};
  const title = data.title || 'UmmahCast';
  const options = {
    body: data.body || 'The masjid is now live — join us!',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: safePushUrl(data.url) },
    vibrate: [200, 100, 200],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safePushUrl(event.notification.data?.url);
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
