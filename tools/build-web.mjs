// Assemble a clean `dist/` containing exactly the web app — the shared source of
// truth that BOTH the web deploy and the Capacitor native shells load.
//
// Why this exists: Capacitor's `webDir` must point at a folder holding only the
// web assets (it copies that folder verbatim into the iOS/Android app bundle).
// The repo root can't be used directly — it also holds .git, node_modules,
// party/, tools/, package manifests, etc. This script copies the curated
// allowlist below into `dist/` so there is one build both platforms consume.
//
// It is intentionally dependency-free (pure Node, no bundler) so it runs
// anywhere with zero install. Adopting a real bundler (Vite) later is a drop-in
// replacement for this file — see IOS_SETUP.md.

import { existsSync, rmSync, mkdirSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

// Everything the running game needs at runtime, and nothing else. Directories
// are copied recursively. Keep this list in sync with the assets index.html and
// sw.js actually reference.
const INCLUDE = [
  "index.html",
  "viewer.html", // dev asset viewer (/viewer.html) — shares src/ + vendor/ below
  "download", // static /download/ page (desktop builds live on the zoomies-releases repo)
  "styles.css",
  "sw.js",
  "manifest.json",
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png",
  "src",
  "vendor",
  "assets",
];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

let copied = 0;
for (const entry of INCLUDE) {
  const from = join(root, entry);
  if (!existsSync(from)) {
    console.warn(`[build-web] skip (missing): ${entry}`);
    continue;
  }
  cpSync(from, join(dist, entry), { recursive: true });
  copied++;
}

// Stamp the build time into dist/index.html (the repo copy stays "dev"). The
// boot log prints it, so any device log immediately shows WHICH build is
// actually running — a stale service-worker cache once served weeks-old code
// while we debugged fixes that "didn't work" because they weren't running.
const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
const indexPath = join(dist, "index.html");
const html = readFileSync(indexPath, "utf8").replace(
  '<meta name="zoomies-build" content="dev" />',
  `<meta name="zoomies-build" content="${stamp}" />`
);
writeFileSync(indexPath, html);

console.log(`[build-web] assembled ${copied}/${INCLUDE.length} entries → dist/ (build ${stamp})`);
