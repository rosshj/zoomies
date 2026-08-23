// One-command desktop release: build the platform zips and publish them to
// the PUBLIC rosshj/zoomies-releases repo (the game repo stays private —
// release assets on a private repo can't be downloaded by players).
//
//   GITHUB_TOKEN=ghp_xxx node tools/release.mjs v0.1.1
//   GITHUB_TOKEN=ghp_xxx node tools/release.mjs v0.2.0 --platforms linux,mac
//
// Asset names are VERSION-FREE on purpose: the download page links to
// .../releases/latest/download/<name>, so shipping a new release updates the
// site's links with zero site changes. The token needs repo scope on
// zoomies-releases only.
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, copyFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "rosshj";
const REPO = "zoomies-releases";
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

const tag = process.argv[2];
if (!/^v\d+\.\d+/.test(tag || "")) {
  console.error("usage: GITHUB_TOKEN=... node tools/release.mjs vX.Y.Z [--platforms linux,mac,win]");
  process.exit(1);
}
const token = process.env.GITHUB_TOKEN;
if (!token) { console.error("GITHUB_TOKEN is required (repo scope on zoomies-releases)"); process.exit(1); }
const platIdx = process.argv.indexOf("--platforms");
const platforms = (platIdx > 0 ? process.argv[platIdx + 1] : "linux").split(",");

// Platform → electron-builder flags + the stable asset name players download.
const PLATFORMS = {
  linux: { flags: "--linux zip --x64", asset: "zoomies-gp-linux-x64.zip" },
  mac: { flags: "--mac zip", asset: "zoomies-gp-macos.zip" },
  win: { flags: "--win zip --x64", asset: "zoomies-gp-windows-x64.zip" },
};

const sh = (cmd, cwd = ROOT) => execSync(cmd, { cwd, stdio: "inherit" });
const gh = async (url, opts = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok && res.status !== 404) throw new Error(`${opts.method || "GET"} ${url} → ${res.status}: ${await res.text()}`);
  return res.status === 404 ? null : res.json();
};

// 1. Build the web bundle once, then package each requested platform.
sh("node tools/build-web.mjs");
const outDir = join(ROOT, "desktop", "out");
const staging = join(outDir, "release-assets");
mkdirSync(staging, { recursive: true });
for (const p of platforms) {
  const cfg = PLATFORMS[p];
  if (!cfg) { console.error(`unknown platform: ${p}`); process.exit(1); }
  console.log(`\n[release] packaging ${p}…`);
  sh(`npx electron-builder --config electron-builder.json ${cfg.flags}`, join(ROOT, "desktop"));
  // electron-builder names zips by product/version; grab the newest zip and
  // restage it under the stable asset name.
  const zips = readdirSync(outDir).filter((f) => f.endsWith(".zip"));
  if (!zips.length) { console.error(`no zip produced for ${p}`); process.exit(1); }
  const newest = zips
    .map((f) => ({ f, t: execSync(`stat -f %m "${join(outDir, f)}" 2>/dev/null || stat -c %Y "${join(outDir, f)}"`).toString().trim() }))
    .sort((a, b) => b.t - a.t)[0].f;
  copyFileSync(join(outDir, newest), join(staging, cfg.asset));
  console.log(`[release] ${newest} → ${cfg.asset}`);
}

// 2. Create (or reuse) the release for this tag.
let release = await gh(`${API}/releases/tags/${tag}`);
if (!release) {
  release = await gh(`${API}/releases`, {
    method: "POST",
    body: JSON.stringify({ tag_name: tag, name: `Zoomies GP ${tag.replace(/^v/, "")}`, make_latest: "true" }),
  });
  console.log(`[release] created ${tag}`);
} else {
  console.log(`[release] found existing ${tag}`);
}

// 3. Upload each asset, replacing a same-named one from a re-run.
for (const p of platforms) {
  const { asset } = PLATFORMS[p];
  const existing = (release.assets || []).find((a) => a.name === asset);
  if (existing) {
    await gh(`${API}/releases/assets/${existing.id}`, { method: "DELETE" });
    console.log(`[release] replaced old ${asset}`);
  }
  const data = readFileSync(join(staging, asset));
  const upload = release.upload_url.replace(/\{.*\}$/, "") + `?name=${encodeURIComponent(asset)}`;
  await gh(upload, {
    method: "POST",
    headers: { "Content-Type": "application/zip", "Content-Length": String(data.length) },
    body: data,
  });
  console.log(`[release] uploaded ${asset} (${(data.length / 1e6).toFixed(0)} MB)`);
}
console.log(`\n[release] done → https://github.com/${OWNER}/${REPO}/releases/tag/${tag}`);
console.log("[release] the site's latest-download links now serve these builds.");
