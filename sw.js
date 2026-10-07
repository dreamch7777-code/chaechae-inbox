// 채채 답장함 서비스워커 v7: 홈 화면 앱 + 알림/배지용 (데이터는 캐시하지 않음)
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
// 홈 화면 앱이 예전 화면을 붙잡지 않도록: 페이지·버전 파일은 항상 인터넷에서 최신으로 받음
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin) return;
  if (e.request.mode === 'navigate' || /\.(html|txt|webmanifest)$/.test(u.pathname) || u.pathname.endsWith('/')) {
    e.respondWith(fetch(e.request, { cache: 'no-store' }).catch(() => fetch(e.request)));
  }
});
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
    self.registration.showNotification(d.title || '채채 답장함', { body: d.body || '새 답장 초안이 올라왔어요', icon:'icon2-192.png', tag:'cci-new' }),
    (typeof d.count === 'number' && self.navigator && self.navigator.setAppBadge) ? self.navigator.setAppBadge(d.count) : Promise.resolve()
  ]));
});
