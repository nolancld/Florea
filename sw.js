// Service Worker Florea — reçoit les notifications push du serveur

self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'Florea 🌿', {
      body: data.body || 'Une plante a besoin d\'eau !',
      icon: '/icon.png',
      badge: '/icon.png',
      tag: data.tag || 'florea',
      renotify: true,
      vibrate: [200, 100, 200],
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('/'));
});
