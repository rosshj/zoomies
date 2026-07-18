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
// v2: never store/serve REDIRECTED responses — iOS Safari refuses to serve a
// redirected response from a SW for a navigation ("Response served by service
// worker has redirections"), which broke offline relaunch because Vercel's
// cleanUrls 308-redirects /index.html → /. We rebuild such responses so the
// redirected flag is cleared. The bump also purges any poisoned v1 cache.
const CACHE = "zoomies-v2";

// Strip the "redirected" flag by rebuilding the response from its body. A Response
// with redirected===true cannot be returned from a SW navigation on Safari; a
// freshly-constructed Response has redirected===false. No-op for normal responses.
async function deredirect(res) {
  if (!res || !res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

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
  "./vendor/cuelume/index.js",
  "./vendor/cuelume/audio/engine.js",
  "./vendor/cuelume/interactions/bind.js",
  "./vendor/cuelume/sounds/recipes.js",
  "./src/main.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      // Cache each shell item individually (so one failure can't abort the install),
      // and de-redirect first so the cached page is never a redirected response.
      await Promise.all(SHELL.map(async (u) => {
        try {
          const res = await fetch(u, { cache: "reload" });
          if (res && res.ok) await cache.put(u, await deredirect(res));
        } catch {
          /* offline at install / item missing — best-effort */
        }
      }));
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
  const isNav = req.mode === "navigate";
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, await deredirect(res.clone())); // store a clean copy
    // A navigation must never hand back a redirected response (Safari rejects it).
    return isNav ? deredirect(res) : res;
  } catch {
    const hit = await cache.match(req);
    if (hit) return isNav ? deredirect(hit) : hit;
    // Navigations fall back to the cached shell so a deep link still opens offline.
    if (isNav) {
      const shell = (await cache.match("./index.html")) || (await cache.match("./"));
      if (shell) return deredirect(shell);
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
