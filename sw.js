/* The Indexer service worker: works offline, keeps the app and its libraries cached. */
const VERSION = '2.1.1-1793920083947';
const PRECACHE = ["./", "app.css", "icons/apple-touch-icon.png", "icons/favicon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/star-file-256.png", "index.html", "js/db.js", "js/main.js", "js/ocr/labelscan.js", "js/ocr/ocr-worker.js", "js/ocr/ppocr.js", "js/ocr/scan.js", "js/plan.js", "js/proj.js", "js/star.js", "js/stl.js", "js/store.js", "js/ui/common.js", "js/ui/count.js", "js/ui/history.js", "js/ui/home.js", "js/ui/inventory.js", "js/ui/kits.js", "js/ui/labels.js", "js/ui/part.js", "js/ui/print.js", "js/util.js", "js/vision/client.js", "js/vision/mat.js", "js/vision/match.js", "js/vision/worker.js", "lib/aruco/LICENSE.txt", "lib/aruco/aruco.js", "lib/aruco/cv.js", "lib/barcode-detector.js", "lib/zxing_reader.wasm", "manifest.webmanifest"];
const APP_CACHE = 'indexer-app-' + VERSION, LIB_CACHE = 'indexer-libs-v1';
const LIB_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('indexer-app-') && k !== APP_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (LIB_HOSTS.includes(url.hostname)) {
    // versioned library files: cache first
    e.respondWith(caches.open(LIB_CACHE).then(async (c) => { const hit = await c.match(req); if (hit) return hit; const res = await fetch(req); if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }));
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => { const cp = res.clone(); caches.open(APP_CACHE).then((c) => c.put('./', cp)); return res; }).catch(() => caches.match('./').then((r) => r || caches.match('index.html'))));
    return;
  }
  // app files: answer from cache, refresh in the background
  e.respondWith(caches.open(APP_CACHE).then(async (c) => {
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
