/*! pwa-sw.js — service worker
 *  Сгенерировано Icon Forge · 28.09.2026 08:15
 *  Режим кэша: smart — Умный
 *  Файл должен лежать в корне сайта, рядом с index.html.
 */
'use strict';

var VERSION  = '202609220144';
var MODE     = 'smart';                 // minimal | smart | offline
var CACHE    = 'pwa-cache-' + VERSION;
var OFFLINE  = '/offline.html';
var PRECACHE = [
  "/offline.html",
  "/icons/manifest.json",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png"
];

/* Эти пути не кэшируются никогда — иначе приложение покажет старые данные */
var NEVER = [/\/api\//, /\/_vercel\//, /\.json(\?|$)/];

function isNever(url) {
  for (var i = 0; i < NEVER.length; i++) if (NEVER[i].test(url)) return true;
  return false;
}
function isStatic(req) {
  // скрипты сюда не входят: из кэша они отдаются первыми, и правка в js видна только со второй загрузки
  return /\.(png|jpe?g|webp|svg|gif|ico|css|woff2?|ttf|otf)(\?|$)/i.test(req.url);
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // по одному: один битый путь не должен рушить всю установку
      return Promise.all(PRECACHE.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE && k.indexOf('pwa-cache-') === 0) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function networkFirst(req, offlineOk) {
  return fetch(req).then(function (res) {
    // только 200: у 206 (кусок аудио или видео) cache.put всегда падает
    if (res && res.status === 200 && MODE !== 'minimal') {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { return c.put(req, copy); }).catch(function () {});
    }
    return res;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then(function (hit) {
      if (hit) return hit;
      // офлайн-страница — только вместо страницы: иначе аудио и данные получают HTML вместо ошибки
      if (!offlineOk) return Response.error();
      return caches.match(OFFLINE).then(function (off) { return off || Response.error(); });
    });
  });
}

function cacheFirst(req) {
  return caches.match(req).then(function (hit) {
    if (hit) return hit;
    return fetch(req).then(function (res) {
      if (res && res.status === 200) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { return c.put(req, copy); }).catch(function () {});
      }
      return res;
    });
  });
}

function staleWhileRevalidate(req) {
  return caches.match(req).then(function (hit) {
    var net = fetch(req).then(function (res) {
      if (res && res.status === 200) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { return c.put(req, copy); }).catch(function () {});
      }
      return res;
    }).catch(function () { return hit || Response.error(); });
    return hit || net;
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;

  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  if (isNever(req.url)) return;

  // Страницы: всегда свежие, офлайн — из кэша
  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req, true));
    return;
  }

  if (MODE === 'minimal') {
    // только то, что лежит в precache (иконки), остальное — сеть
    e.respondWith(caches.match(req).then(function (hit) { return hit || fetch(req); }));
    return;
  }

  if (isStatic(req)) {
    e.respondWith(MODE === 'offline' ? cacheFirst(req) : staleWhileRevalidate(req));
    return;
  }

  e.respondWith(networkFirst(req, false));
});
