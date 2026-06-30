// Zoomies GP service worker — makes the installed PWA play fully offline.
//
// Strategy:
//   • Same-origin app files (HTML / JS / CSS / vendored three / icons): NETWORK-
//     FIRST with a cache fallback. Online players always get the freshest deploy;
//     offline players get the last-cached copy. Every successful response is
//     cached, so one online visit is enough to make the whole game work offline.
//   • Cross-origin CDN modules (ably / partysocket): CACHE-FIRST (versioned URLs
//     are immutable). These only matter for multiplayer, which needs the network
//     anyway, but caching them keeps the menu from erroring out offline.
//   • Range requests (the music <audio>): served as a 206 sliced from the cached
//     full body, so audio plays offline too.
//
// Bump CACHE when the shell list or caching logic changes to retire old caches.
const CACHE = "zoomies-v1";

// A small, reliable core precached on install. Everything else (the rest of src/,
// the vendored three files, audio) is cached on first fetch by the handlers below,
// so this list intentionally stays short and can't fail the install if one entry
// 404s (addAll is best-effort per item).
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.json",
  "./vendor/three/three.webgpu.min.js",
  "./vendor/three/three.core.min.js",
  "./vendor/three/three.tsl.min.js",
  "./src/main.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      // Cache each shell item individually so one failure can't abort the install.
      await Promise.all(SHELL.map((u) => cache.add(u).catch(() => {})));
      await self.skipWaiting();
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never cache POSTs etc.
  const url = new URL(req.url);

  if (req.headers.has("range")) {
    event.respondWith(rangeResponse(req));
    return;
  }
  if (url.origin !== self.location.origin) {
    event.respondWith(cacheFirst(req)); // immutable CDN modules
    return;
  }
  event.respondWith(networkFirst(req)); // same-origin app files
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
    return res;
  } catch {
    return hit || Response.error();
  }
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req);
    if (hit) return hit;
    // Navigations fall back to the cached shell so a deep link still opens offline.
    if (req.mode === "navigate") {
      const shell = await cache.match("./index.html");
      if (shell) return shell;
    }
    return Response.error();
  }
}

// Serve a byte-range request (HTMLAudioElement uses these) from the cached full
// body, fetching+caching the full resource first if we don't have it yet.
async function rangeResponse(req) {
  const cache = await caches.open(CACHE);
  const bare = new Request(req.url, { credentials: req.credentials });
  let full = await cache.match(bare);
  if (!full) {
    try {
      const res = await fetch(bare);
      if (res && res.ok) { cache.put(bare, res.clone()); full = res; }
    } catch {
      /* offline and not cached */
    }
  }
  if (!full) {
    try { return await fetch(req); } catch { return Response.error(); }
  }
  const buf = await full.arrayBuffer();
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.get("range") || "");
  const start = m ? parseInt(m[1], 10) : 0;
  const end = m && m[2] ? parseInt(m[2], 10) : buf.byteLength - 1;
  const slice = buf.slice(start, end + 1);
  return new Response(slice, {
    status: 206,
    statusText: "Partial Content",
    headers: {
      "Content-Type": full.headers.get("Content-Type") || "application/octet-stream",
      "Content-Range": `bytes ${start}-${end}/${buf.byteLength}`,
      "Accept-Ranges": "bytes",
      "Content-Length": String(slice.byteLength),
    },
  });
}
