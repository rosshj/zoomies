// One launch policy for browser checks: portable software rendering by default
// on Linux, native rendering on desktop hosts, and an explicit override for CI.
import { chromium } from "playwright-core";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
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
