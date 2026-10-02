// One launch policy for browser checks: portable software rendering by default
// on Linux, native rendering on desktop hosts, and an explicit override for CI.
import { chromium } from "playwright-core";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { readFile } from "node:fs/promises";
export const softwareRendering =
  process.env.SOFTWARE === "1" || (process.env.NATIVE !== "1" && process.platform === "linux");
function chromePath() {
  if (process.env.PW_CHROME) return process.env.PW_CHROME;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/opt/pw-browsers/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    chromium.executablePath(),
  ];
  if (existsSync("/opt/pw-browsers"))
    for (const dir of readdirSync("/opt/pw-browsers")) {
      candidates.push(path.join("/opt/pw-browsers", dir, "chrome-linux/chrome"));
      candidates.push(path.join("/opt/pw-browsers", dir, "chrome-linux64/chrome"));
    }
  const found = candidates.find((p) => existsSync(p) && statSync(p).isFile());
  if (!found) throw Error("Chrome not found. Set PW_CHROME or install Playwright Chromium.");
  return found;
}
export async function launchArtBrowser() {
  const executablePath = chromePath();
  console.log(`[browser] ${softwareRendering ? "SwiftShader" : "native"}: ${executablePath}`);
  return chromium.launch({
    executablePath,
    args: [
      "--no-sandbox",
      ...(softwareRendering
        ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
        : []),
    ],
  });
}
export async function artBackends(browser, port) {
  if (process.env.BACKENDS) {
    const names = [...new Set(process.env.BACKENDS.split(","))];
    if (names.some((n) => !["webgl", "webgpu"].includes(n)))
      throw Error("BACKENDS must be webgl, webgpu, or webgl,webgpu");
    return names;
  }
  if (softwareRendering) return ["webgl"];
  const p = await browser.newPage();
  let gpu = false;
  try {
    await p.route("**/__gpu_probe__", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>GPU probe</title>" }),
    );
    await p.goto(`http://127.0.0.1:${port}/__gpu_probe__`);
    gpu = await p.evaluate(async () => !!(await navigator.gpu?.requestAdapter())).catch(() => false);
  } finally {
    await p.close();
  }
  console.log(`[browser] ${gpu ? "WebGL + WebGPU" : "WebGPU unavailable; exercising WebGL fallback"}`);
  return gpu ? ["webgl", "webgpu"] : ["webgl"];
}

// Serve the repository root over plain HTTP for a browser check. Port 0 picks
// a free port so checks can run side by side; the server is unref'd so a tool
// that forgets to close it still exits. Returns the origin to navigate to.
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".woff2": "font/woff2",
};
export async function serveRepo({ port = 0 } = {}) {
  const root = path.resolve(new URL("..", import.meta.url).pathname);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const file = path.join(root, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
      if (!file.startsWith(root)) throw Error("outside root");
      res.setHeader("content-type", MIME[path.extname(file)] || "application/octet-stream");
      res.end(await readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  server.unref();
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}
