/*
 * Service Worker de "Mis Clientes": recibe las notificaciones push.
 * El push llega vacío; acá se pide al servidor el detalle de las alertas y se muestran.
 * El token del dispositivo viene en la URL con que se registró: sw.js?t=<token>&api=<servidor>
 */
const params = new URL(self.location).searchParams;
const TOKEN = params.get('t');
const API = params.get('api');

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let avisos = [];
    try {
      const r = await fetch(`${API}/alertas`, { headers: { Authorization: 'Bearer ' + TOKEN }, cache: 'no-store' });
      if (r.ok) avisos = (await r.json()).avisos || [];
    } catch (e) {}
    // iPhone exige mostrar siempre una notificación por cada push recibido
    if (!avisos.length) avisos = [{ title: 'Mis Clientes', body: 'Tenés alertas pendientes. Abrí la app para verlas.', tag: 'general' }];
    await Promise.all(avisos.map(a => self.registration.showNotification(a.title, {
      body: a.body,
      tag: a.tag,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      data: { tab: a.tab || '' },
    })));
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const tab = (event.notification.data || {}).tab;
  const destino = new URL('clientes.html' + (tab ? '?tab=' + tab : ''), self.registration.scope).href;
  event.waitUntil((async () => {
    const abiertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of abiertas) {
      if (c.url.startsWith(self.registration.scope)) { await c.focus(); if (tab) c.postMessage({ tab }); return; }
    }
    await self.clients.openWindow(destino);
  })());
});
