// オフライン用キャッシュ。ファイルを更新したら VERSION を上げる
// 同じ github.io ドメインの他アプリとキャッシュを共有するため、名前に接頭辞を付けて自分の分だけ消す
const PREFIX = "fgen-";
const VERSION = PREFIX + "v5";
const FILES = [
  "./", "index.html", "manifest.webmanifest",
  "js/app.js", "js/sim.js", "js/scope.js", "js/transport.js", "js/inverter.js",
  "js/signals.js", "js/measure.js", "js/menus.js",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ネット優先 (更新をすぐ反映)、オフライン時はキャッシュ
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
