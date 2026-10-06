// 채채 답장함 서비스워커: 홈 화면 앱 + 알림/배지용 (데이터는 캐시하지 않음)
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./');
  }));
});
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch(_) {}
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || '채채 답장함', { body: d.body || '새 답장 초안이 올라왔어요', icon:'icon-192.png', tag:'cci-new' }),
    (typeof d.count === 'number' && self.navigator && self.navigator.setAppBadge) ? self.navigator.setAppBadge(d.count) : Promise.resolve()
  ]));
});
