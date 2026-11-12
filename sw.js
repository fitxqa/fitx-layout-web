// FitX Gym Layout Planner – offline cache
const CACHE = "fitx-layout-v12";
const FILES = ["./", "./index.html", "./manifest.json", "./lib/three.min.js", "./lib/OrbitControls.js",
  "./lib/jspdf.umd.min.js", "./lib/pdf.min.js", "./lib/pdf.worker.min.js", "./cloud.js?v=11", "./config.js?v=11",
  "./lib/firebase-app-compat.js", "./lib/firebase-auth-compat.js", "./lib/firebase-firestore-compat.js", "./icons/icon-192.png", "./icons/icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return; // Firebase traffic goes straight to Google
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok && new URL(e.request.url).origin === location.origin) { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); }
      return r;
    }).catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
  );
});
