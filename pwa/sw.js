const VERSION = "@@VERSION@@";
const PREFIX = `ssb-app:${self.registration.scope}:`;
const CACHE = PREFIX + VERSION;
const assets = new Map(Object.entries(@@ASSETS@@).map(([path, integrity]) => [new URL(path, self.registration.scope).href, integrity]));
const index = new URL("./index.html", self.registration.scope).href;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([...assets].map(([url, integrity]) =>
    new Request(url, { cache: "reload", redirect: "error", integrity })))));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SSB_ACTIVATE") event.waitUntil(self.skipWaiting());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const entry = event.request.mode === "navigate" && url.pathname === new URL(self.registration.scope).pathname ? index : url.href;
  if (!assets.has(entry) || url.origin !== self.location.origin) return;
  event.respondWith(caches.open(CACHE).then(async (cache) => (await cache.match(entry)) ??
    fetch(entry, { integrity: assets.get(entry), redirect: "error" })));
});
