// Bundle the multiplayer client SDKs (partysocket, ably) into single-file ESM
// builds under vendor/net/, mirroring how three.js is vendored under
// vendor/three/. The import map in index.html points the bare specifiers at
// these files, so the game never fetches them from a CDN at runtime — the same
// bytes ship on the web and inside the native app bundle, and the multiplayer
// menu no longer needs the network just to load its code (connecting still
// does, of course).
//
// Re-run after bumping either package: npm run vendor:net (commit the output).

import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "vendor", "net");
mkdirSync(outDir, { recursive: true });

const COMMON = {
  bundle: true,
  format: "esm",
  platform: "browser",
  minify: true,
  // Match the game's actual floor: recent mobile Safari / Chrome. Keeps the
  // output modern (no legacy transforms) without breaking the iOS web view.
  target: ["safari15", "chrome100"],
  logLevel: "info",
};

for (const name of ["partysocket", "ably"]) {
  await build({
    ...COMMON,
    entryPoints: [name],
    outfile: join(outDir, `${name}.min.js`),
  });
}
