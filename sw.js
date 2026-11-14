// Offline support. App files: network first (so updates arrive), cache as a
// fallback. pdf.js in vendor/: cache first (it changes only with the version).
const CACHE = "knit-rows-v3";
const SHELL = [
  "./",
  "index.html",
  "css/app.css",
  "js/main.js",
  "js/db.js",
  "js/library.js",
  "js/viewer.js",
  "js/render.js",
  "js/rows.js",
  "js/overlay.js",
  "js/calibrate.js",
  "js/stats.js",
  "js/lens.js",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "vendor/pdfjs/pdf.min.mjs",
  "vendor/pdfjs/pdf.worker.min.mjs",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.includes("/vendor/")) {
    e.respondWith(cacheFirst(req));
  } else {
    e.respondWith(networkFirst(req));
  }
});

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  try {
    // "no-cache" revalidates with the server (a cheap 304 when unchanged), so
    // all modules of one version arrive together after an update.
    const res = await fetch(req, { cache: "no-cache" });
    if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === "navigate") {
      const index = await caches.match("index.html");
      if (index) return index;
    }
    throw err;
  }
}
