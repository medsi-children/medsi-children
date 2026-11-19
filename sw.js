self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
  let payload = {};

  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = {
      title: 'Медси Бот',
      body: event.data ? event.data.text() : 'Новое уведомление'
    };
  }

  if (!payload || typeof payload !== 'object') return;

  if (payload.action === 'close-notification') {
    event.waitUntil(
      self.registration.getNotifications({ tag: payload.tag || 'medsi-message' })
        .then(items => items.forEach(item => item.close()))
    );
    return;
  }

  if (typeof payload.body !== 'string' || !payload.body.trim()) return;

  const title = payload.title || 'Медси Бот';
  const options = {
    body: payload.body || 'Новое сообщение',
    icon: payload.icon || '/apple-touch-icon.png',
    badge: payload.badge || '/apple-touch-icon.png',
    tag: payload.tag || 'medsi-message',
    // Retries replace the same notification quietly instead of buzzing again.
    renotify: false,
    silent: false,
    timestamp: Date.now(),
    data: {
      url: payload.url || '/'
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  const notificationData = event.notification.data || {};
  const targetUrl = new URL(
    notificationData && notificationData.url
      ? notificationData.url
      : '/',
    self.location.origin
  ).href;
  function normalizePanelPath(path) {
    const value = String(path || '/');
    if (value === '/tutors.html') return '/tutors';
    return value;
  }

  const targetPath = normalizePanelPath(new URL(targetUrl).pathname);

  event.waitUntil((async () => {
    const clientsList = await clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    for (const client of clientsList) {
      const clientPath = normalizePanelPath(new URL(client.url || '/', self.location.origin).pathname);
      if (clientPath === targetPath && 'focus' in client) {
        await client.focus();
        return;
      }
    }

    if (clients.openWindow) {
      await clients.openWindow(targetUrl);
    }
  })());
});
