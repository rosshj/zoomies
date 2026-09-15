// Electron desktop shell for Zoomies GP — the Steam build.
//
// The game itself is the same dist/ bundle the web deploy and the Capacitor
// native shells consume (tools/build-web.mjs); this shell only hosts it. It
// is served over a custom app:// scheme rather than file:// because the game
// is ES modules behind an import map, and module scripts are CORS-blocked on
// a file:// origin.
const { app, BrowserWindow, protocol, net, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

// productName in package.json names the packaged app; setName makes dev
// launches match everywhere the OS takes the name from the process (userData
// path, notifications). Known limit: the macOS MENU BAR in a dev launch
// still says "Electron" — that string comes from Electron.app's own
// Info.plist and only a packaged .app (npm run dist) can change it.
// Set FIRST: everything below that touches userData (log, saves, window
// state) must resolve to the "Zoomies GP" folder, never "Electron".
app.setName("Zoomies GP");

// --- Rolling shell log: userData/logs/main.log ------------------------------
// Everything the shell prints (console.log/warn/error in THIS process) is also
// appended here, so a player's "it went black and closed" report comes with
// the renderer-gone reason, the Steam init result and the build/backend line
// instead of a terminal nobody was watching. Capped at ~200 KB: when the file
// grows past the cap it is cut back to its newest half, so it never grows
// unbounded and the most recent launches are always the ones kept.
const LOG_CAP = 200 * 1024;
const LOG_KEEP = LOG_CAP / 2;
let _logPath = null;
let _logSize = 0;
function installLog() {
  try {
    const dir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(dir, { recursive: true });
    _logPath = path.join(dir, "main.log");
    try { _logSize = fs.statSync(_logPath).size; } catch { _logSize = 0; }
    rollLog();
  } catch {
    _logPath = null; // read-only userData? the terminal still gets everything
  }
  const wrap = (level, orig) => (...args) => {
    orig(...args);
    if (!_logPath) return;
    const text = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "string" ? a : safeJson(a))).join(" ");
    const line = `${new Date().toISOString()} ${level} ${text}\n`;
    try {
      fs.appendFileSync(_logPath, line);
      _logSize += Buffer.byteLength(line);
      if (_logSize > LOG_CAP) rollLog();
    } catch { /* never let logging take the shell down */ }
  };
  console.log = wrap("info", console.log.bind(console));
  console.warn = wrap("warn", console.warn.bind(console));
  console.error = wrap("error", console.error.bind(console));
}
function rollLog() {
  if (!_logPath || _logSize <= LOG_CAP) return;
  try {
    const buf = fs.readFileSync(_logPath);
    let tail = buf.subarray(buf.length - LOG_KEEP);
    const nl = tail.indexOf(10); // start on a whole line
    if (nl >= 0) tail = tail.subarray(nl + 1);
    fs.writeFileSync(_logPath, tail);
    _logSize = tail.length;
  } catch { /* best-effort */ }
}
function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}
installLog();

// Packaged builds carry dist/ in resources (see electron-builder.json). Dev
// launches serve the REPO ROOT directly — the web app runs from the working
// tree as-is (that's how every headless check serves it), so a `git pull` is
// live on the next launch with no build step. dist/ + build-web.mjs remain
// the packaging path only. (A stale dist/ once shipped an old build to a
// tester through `start:fast` — this removes that class of error.)
const DIST = app.isPackaged
  ? path.join(process.resourcesPath, "dist")
  : path.join(__dirname, "..");

// Steam Deck: Gaming Mode launches set SteamDeck=1 in the environment.
// Two accommodations, both scoped to that env so nothing else changes:
//  • Chromium's SUID sandbox helper can't get its setuid bit on SteamOS's
//    immutable filesystem, so a stock launch dies at startup — run without
//    the sandbox there (the game loads only its own bundled app:// content).
//  • Start fullscreen: the Deck is a handheld console, a floating 1280x800
//    window in Desktop Mode test launches is never what you want either.
// Detect by OS identity, not just env: Gaming Mode's SteamDeck=1 does NOT
// reach non-Steam shortcuts (field report: black screen at launch until
// --no-sandbox was typed into Launch Options by hand), and Desktop Mode
// never sets it at all. /etc/os-release names SteamOS on every path.
// Belt-and-braces detection, each with a name so the log says WHICH one
// fired (a Deck running in Gaming Mode with an empty Launch Options field
// once stalled into software rendering — the flags below were not applied,
// and nothing said why):
//  • env: SteamDeck (Gaming Mode), SteamGamepadUI, or a gamescope desktop
//  • /etc/os-release ID or ID_LIKE naming steamos, or /etc/steamos-release
//  • unprivileged user namespaces disabled — the case where Chromium's
//    namespace sandbox can't work without the SUID helper on ANY Linux
const DECK_REASON = (() => {
  const env = process.env;
  if (env.SteamDeck) return "env:SteamDeck";
  if (env.SteamGamepadUI) return "env:SteamGamepadUI";
  if (/gamescope/i.test(env.XDG_CURRENT_DESKTOP || "") || /gamescope/i.test(env.XDG_SESSION_DESKTOP || "")) return "env:gamescope";
  try {
    const rel = fs.readFileSync("/etc/os-release", "utf8");
    if (/^ID=["']?steamos/m.test(rel) || /^ID_LIKE=.*steamos/m.test(rel)) return "os-release";
  } catch { /* not there */ }
  if (fs.existsSync("/etc/steamos-release")) return "steamos-release";
  if (process.platform === "linux") {
    try {
      if (fs.readFileSync("/proc/sys/kernel/unprivileged_userns_clone", "utf8").trim() === "0") return "no-userns";
    } catch { /* knob absent on most kernels */ }
    try {
      if (fs.readFileSync("/proc/sys/user/max_user_namespaces", "utf8").trim() === "0") return "no-userns";
    } catch { /* ignore */ }
  }
  return "";
})();
const ON_DECK = !!DECK_REASON;
if (ON_DECK) {
  app.commandLine.appendSwitch("no-sandbox");
  // Field-tested on a real Deck (candidate flag sets A/B/C'd by hand in
  // Konsole): the ZYGOTE's child processes are the ones denied shared
  // memory on SteamOS — every shm create failed with ESRCH in /dev/shm and
  // /tmp alike, killing the renderer at birth (live app, black window, both
  // modes). Skipping the zygote so children spawn directly (legal only
  // with no-sandbox, which the Deck path already runs) is the combination
  // that showed the game. shm stays routed to /tmp belt-and-braces.
  app.commandLine.appendSwitch("no-zygote");
  app.commandLine.appendSwitch("disable-dev-shm-usage");
}

// …but appendSwitch is NOT enough for these two. Chromium decides sandbox
// and zygote before any of this JavaScript runs, so the in-process switches
// above never took effect: every good Deck launch so far had the flags typed
// into Steam's Launch Options, and an empty field stalled into software
// rendering (v0.1.3 field test). They have to be on the REAL command line:
//  1. The packaged Linux build's `zoomies-desktop` is a launcher script
//     (desktop/after-pack.cjs) that detects SteamOS and execs the binary
//     with the flags — the normal path; it sets ZOOMIES_LAUNCHER so the log
//     line below can say so.
//  2. Fallback, for a bare binary / dev run on SteamOS: when the flags are
//     missing, relaunch this same executable with them and stay alive as
//     the parent (Steam tracks the process it started; if it exited the
//     game would count as closed).
const DECK_ARGV = ["--no-sandbox", "--no-zygote", "--disable-dev-shm-usage"];
const HAS_DECK_ARGV = process.argv.includes("--no-sandbox");
const REEXEC_PARENT = ON_DECK && !HAS_DECK_ARGV && !process.env.ZOOMIES_REEXEC;
if (REEXEC_PARENT) {
  const { spawn } = require("node:child_process");
  const args = [...process.argv.slice(1), ...DECK_ARGV];
  console.log(`[shell] SteamOS (${DECK_REASON}) without ${DECK_ARGV.join(" ")} on argv: relaunching with them`);
  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    env: { ...process.env, ZOOMIES_REEXEC: "1" },
  });
  child.on("exit", (code, signal) => {
    console.log(`[shell] child exited (${code ?? signal})`);
    process.exit(code ?? 0);
  });
  child.on("error", (err) => {
    // Can't relaunch: fall through and run in-process as before.
    console.error(`[shell] relaunch failed: ${err.message}`);
  });
}

// WebGPU retest switch: ZOOMIES_WEBGPU=1 drops the WebGL2 pin (see gameUrl)
// and, on Linux, turns on Chromium's Vulkan-backed WebGPU, which is still
// gated there. One env var so the test is the same on a Mac terminal and in
// a Steam launch option (`ZOOMIES_WEBGPU=1 %command%`). Off = today's shell.
// Two strengths on Linux, because the first field test (Deck, Gaming Mode)
// never showed a window with the compositor forced onto Vulkan:
//   ZOOMIES_WEBGPU=1       lift Chromium's WebGPU gate only (Dawn brings its
//                          own Vulkan device; the compositor stays as it is)
//   ZOOMIES_WEBGPU=vulkan  additionally move the compositor to Vulkan
const WEBGPU_MODE = (process.env.ZOOMIES_WEBGPU || "").toLowerCase();
const WANT_WEBGPU = WEBGPU_MODE === "1" || WEBGPU_MODE === "vulkan";
if (WANT_WEBGPU && process.platform === "linux") {
  app.commandLine.appendSwitch("enable-unsafe-webgpu");
  app.commandLine.appendSwitch("ignore-gpu-blocklist");
  if (WEBGPU_MODE === "vulkan") app.commandLine.appendSwitch("enable-features", "Vulkan");
}

// app:// must be registered standard+secure BEFORE app ready so module
// scripts, fetch and localStorage all behave like a normal https origin.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// --- Steam (optional at every layer) ----------------------------------------
// With steamworks.js installed and a steam_appid.txt next to the executable
// (or a real Steam launch), the API initialises; without either the game just
// runs. Nothing in the renderer depends on Steam yet — achievements/cloud
// hook in here later.
//
// Two phases, because the overlay hook is really a set of Chromium command
// line switches (in-process-gpu, disable-direct-composition) and
// `app.commandLine.appendSwitch` is only honoured BEFORE the app is ready:
//  1. top level (now): require the module and apply the overlay switches;
//  2. after ready: `init()`, which needs the running app and the Steam client.
// The overlay inside Electron is unreliable regardless (see desktop/README.md)
// — best-effort, the game must stay playable without it.
let steamworks = null;
let steam = null;
try {
  steamworks = require("steamworks.js");
} catch (err) {
  // (First line only: a MODULE_NOT_FOUND message drags a require stack along.)
  console.log("[steam] steamworks.js not installed:", String(err.message).split("\n")[0]);
}
if (steamworks) {
  try {
    steamworks.electronEnableSteamOverlay?.();
  } catch (err) {
    console.log("[steam] overlay switches not applied:", err.message);
  }
}
function initSteam() {
  if (!steamworks) return;
  try {
    steam = steamworks.init();
    console.log("[steam] running as:", steam.localplayer.getName());
  } catch (err) {
    console.log("[steam] not active:", err.message);
  }
}

// --- Save bridge (see preload.cjs) — the file Steam Cloud syncs ------------
const savePath = () => path.join(app.getPath("userData"), "zoomies-save.json");
function writeSave(payload) {
  if (!payload || typeof payload.stamp !== "number" || !payload.data || typeof payload.data !== "object") {
    console.error("[save-bridge] refusing malformed save payload");
    return;
  }
  try {
    const tmp = savePath() + ".tmp"; // atomic: never leave a half-written save
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, savePath());
  } catch (err) {
    console.error("[save-bridge] write failed:", err.message);
  }
}

// --- Window state: remember size + fullscreen across launches ---------------
const winStatePath = () => path.join(app.getPath("userData"), "window-state.json");
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

// Dev launches print the working tree's branch + commit, so "am I running
// the latest?" is answered by the terminal instead of archaeology ("same
// issues still exist" once meant an un-pulled checkout, twice). Reads .git
// directly — no git binary needed.
function gitHead() {
  try {
    const root = path.join(__dirname, "..");
    // A worktree's .git is a FILE pointing at the real gitdir; its refs live
    // in the common dir one level up (worktrees/<name>/commondir says where).
    let gitDir = path.join(root, ".git");
    if (fs.statSync(gitDir).isFile()) {
      const m = fs.readFileSync(gitDir, "utf8").match(/^gitdir: (.+)$/m);
      gitDir = path.resolve(root, m[1].trim());
    }
    let commonDir = gitDir;
    try { commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim()); } catch { /* not a worktree */ }
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    const m = head.match(/^ref: (.+)$/);
    if (!m) return head.slice(0, 8); // detached HEAD: the sha itself
    const ref = m[1];
    let sha = "";
    const refPath = path.join(commonDir, ref);
    if (fs.existsSync(refPath)) sha = fs.readFileSync(refPath, "utf8").trim();
    else {
      const packed = fs.readFileSync(path.join(commonDir, "packed-refs"), "utf8");
      const line = packed.split("\n").find((l) => l.trim().endsWith(" " + ref) || l.trim().endsWith("\t" + ref));
      sha = line ? line.trim().split(/\s+/)[0] : "";
    }
    return `${ref.replace("refs/heads/", "")} @ ${sha.slice(0, 8)}`;
  } catch {
    return "unknown (no .git?)";
  }
}

// The one game window. Module-level so second-instance / IPC can reach it.
let win = null;

// Shown INSTEAD of the game when the renderer has died twice in a row (one
// automatic reload is tried first — a transient GPU hiccup usually survives
// that). Inline data: page: it must render with nothing loading from dist/,
// because dist/ not loading may be the very reason we are here.
function crashPage(reason) {
  const html = `<!doctype html><meta charset="utf-8"><title>Zoomies GP</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e1320;color:#e8ecf4;font:16px/1.5 system-ui,sans-serif}
main{max-width:34em;padding:2em;text-align:center}h1{font-size:1.4em;margin:0 0 .5em}code{color:#ffcf6b}p{margin:.6em 0}
button{margin-top:1em;padding:.6em 1.6em;font:inherit;border:0;border-radius:.5em;background:#ffcf6b;color:#0e1320;cursor:pointer}</style>
<main><h1>Zoomies GP hit a wall</h1>
<p>The game's renderer stopped twice in a row (<code>${String(reason).replace(/[<>&]/g, "")}</code>).</p>
<p>Relaunch the game from Steam. If it keeps happening, updating your graphics driver is the usual fix; the shell log is in the game's data folder under <code>logs/main.log</code>.</p>
<button onclick="window.zoomiesDesktop&&window.zoomiesDesktop.quit()">Quit</button></main>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

function gameUrl() {
  // nosw=1: the service worker exists for offline WEB play; a desktop build
  // is already offline-complete, and a stale SW cache masking a shipped
  // update is the exact failure mode the build stamp exists to catch.
  //
  // webgl=1: the shell pins the game to its WebGL2 backend. Chromium's WebGPU
  // swap-chain in Electron on macOS presents STALE frames — a screen
  // recording showed the compositor interleaving the live render with frames
  // from ~37s earlier, every other frame ("the menus flicker"). That happens
  // below the app (one render loop, one camera — verified), so the fix is to
  // not ride that path: WebGL2 is the game's fully supported backend, the one
  // every headless check runs, and ANGLE-on-Metal presents rock-solid.
  // Retest WebGPU after Electron upgrades with ZOOMIES_WEBGPU=1 (or
  // ZOOMIES_QUERY=webgpu=1) — the pin is dropped then and webgpu=1 also
  // clears the game's sticky prefer-WebGL flag, because in gpu.js a webgl
  // param always beats webgpu.
  const extra = process.env.ZOOMIES_QUERY || "";
  const forced = /webgpu|webgl/.test(extra);
  const pin = forced ? "" : WANT_WEBGPU ? "&webgpu=1" : "&webgl=1";
  return `app://game/index.html?nosw=1${pin}${extra ? "&" + extra : ""}`;
}

function createWindow() {
  const saved = readJson(winStatePath());
  // Dev-launch dock/window icon (packaged builds get theirs from
  // electron-builder). dist/ ships the same 512px icon the PWA uses.
  const icon = path.join(DIST, "icon-512.png");
  if (process.platform === "darwin" && fs.existsSync(icon)) {
    try { app.dock?.setIcon(icon); } catch { /* dev nicety only */ }
  }
  win = new BrowserWindow({
    icon: fs.existsSync(icon) ? icon : undefined,
    width: saved?.width || 1280,
    height: saved?.height || 800,
    minWidth: 960,
    minHeight: 600,
    // Fullscreen by default on a first launch (a Steam game opens like a
    // game, not like a browser); after that the window remembers what the
    // player left it in (F11 / Alt+Enter / the bridge's setFullscreen).
    // NEVER fullscreen-at-creation on the Deck: Gaming Mode's compositor
    // fullscreens the window itself, and fullscreen-at-creation in the
    // Deck's sessions produced a stuck black window (field-reported in both
    // modes — and once it happened, the saved window-state re-armed it on
    // every later launch, so the saved flag is ignored there too). Plain
    // window, F11 as ever.
    fullscreen: !ON_DECK && (saved?.fullscreen ?? true),
    backgroundColor: "#0e1320", // matches the game's loading screen
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
    },
  });
  win.on("close", () => {
    // getNormalBounds so a fullscreen quit remembers the WINDOWED size too.
    const b = win.getNormalBounds();
    try {
      fs.writeFileSync(winStatePath(), JSON.stringify({
        width: b.width, height: b.height, fullscreen: win.isFullScreen(),
      }));
    } catch { /* best-effort */ }
  });
  win.on("closed", () => { win = null; });

  // Focus tracking → renderer (pause on focus loss lives in the game; the
  // preload turns these into zoomies:blur / zoomies:focus window events).
  const tell = (ch) => { if (win && !win.webContents.isDestroyed()) win.webContents.send(ch); };
  win.on("blur", () => tell("zoomies:blur"));
  win.on("focus", () => tell("zoomies:focus"));

  // Renderer health. A crashed renderer gets ONE automatic reload; a second
  // death within the next few minutes lands on the inline error page instead
  // of looping forever. A game that then stays up for 5 minutes has earned
  // its strike back, so an isolated crash an hour later gets a free reload
  // too.
  let rendererDeaths = 0;
  let healthyTimer = null;
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error(`[shell] renderer gone: ${details.reason} (exit ${details.exitCode})`);
    if (details.reason === "clean-exit" || !win) return;
    clearTimeout(healthyTimer);
    rendererDeaths++;
    if (rendererDeaths === 1) {
      console.log("[shell] reloading the game once");
      win.loadURL(gameUrl());
    } else {
      console.error("[shell] renderer died again — showing the error page");
      win.loadURL(crashPage(details.reason));
    }
  });
  // The game's own boot lines ("[zoomies] boot: … build=… rev=…", the
  // renderer backend, the perf watchdog) go into the shell log too, so one
  // file answers "which build, which backend, what happened" from the field.
  win.webContents.on("console-message", (_e, level, message) => {
    if (/^\[zoomies\]|^\[gpu\]|^\[crashguard\]/.test(message) || level >= 2) {
      console.log(`[renderer] ${String(message).slice(0, 400)}`);
    }
  });
  win.webContents.on("did-finish-load", () => {
    clearTimeout(healthyTimer);
    if (win.webContents.getURL().startsWith("app://")) {
      healthyTimer = setTimeout(() => { rendererDeaths = 0; }, 5 * 60 * 1000);
    }
  });
  win.on("unresponsive", () => console.error("[shell] renderer unresponsive (hung > 30s of no input handling)"));
  win.on("responsive", () => console.log("[shell] renderer responsive again"));

  const url = gameUrl();
  // Printed to the npm-start terminal so "which build/backend am I actually
  // running?" is answerable at a glance (a stale build once burned a tester).
  console.log(`[shell] loading ${url} (packaged=${app.isPackaged}, deck=${ON_DECK}${DECK_REASON ? ":" + DECK_REASON : ""}, deckFlags=${HAS_DECK_ARGV ? (process.env.ZOOMIES_LAUNCHER ? "launcher:" + process.env.ZOOMIES_LAUNCHER : process.env.ZOOMIES_REEXEC ? "reexec" : "argv") : "none"}, webgpu=${WEBGPU_MODE || "off"}, electron=${process.versions.electron})`);
  if (!app.isPackaged) console.log(`[shell] source ${gitHead()}`);
  win.loadURL(url);

  // F11 / Alt+Enter toggle fullscreen (the desktop-game habit).
  win.webContents.on("before-input-event", (e, input) => {
    const altEnter = input.key === "Enter" && input.alt;
    if (input.type === "keyDown" && (input.key === "F11" || altEnter)) {
      win.setFullScreen(!win.isFullScreen());
      e.preventDefault();
    }
  });
  return win;
}

// Steam relaunches the same executable if the player hits PLAY again: the
// second copy quits, and the first one comes to the front.
if (!REEXEC_PARENT && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

// GPU / utility / other child processes dying is logged; Chromium restarts
// the GPU process itself, and the render-process-gone handler above covers
// the renderer, so there is nothing more to do here than leave a trace.
app.on("child-process-gone", (_e, details) => {
  console.error(`[shell] child process gone: ${details.type} ${details.name || ""} ${details.reason} (exit ${details.exitCode})`);
});

app.whenReady().then(() => {
  // The relaunch parent only waits for its child; the child does the work.
  if (REEXEC_PARENT) return;
  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    console.error(`[shell] no game at ${DIST}` + (app.isPackaged ? "" : " — is the repo checkout intact?"));
    app.quit();
    return;
  }

  // Serve dist/ over app://game/, resolving strictly INSIDE dist. A missing
  // file is a plain 404 (net.fetch on a nonexistent file: URL rejects, which
  // would surface as a protocol error instead of the ordinary resource miss a
  // desktop dist — no manifest.json, no sw.js — legitimately produces).
  protocol.handle("app", (req) => {
    const url = new URL(req.url);
    let p = decodeURIComponent(url.pathname);
    if (p === "/" || p === "") p = "/index.html";
    const file = path.normalize(path.join(DIST, p));
    if (!file.startsWith(DIST + path.sep)) return new Response("forbidden", { status: 403 });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return new Response("not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  initSteam();
  ipcMain.on("zoomies:quit", () => app.quit());
  ipcMain.on("zoomies:load-save", (e) => { e.returnValue = readJson(savePath()); });
  ipcMain.on("zoomies:save", (_e, payload) => writeSave(payload));
  ipcMain.on("zoomies:save-flush", (e, payload) => { writeSave(payload); e.returnValue = true; });
  // Bridge queries (sync so game code can read them like plain properties).
  ipcMain.on("zoomies:deck", (e) => { e.returnValue = ON_DECK; });
  ipcMain.on("zoomies:is-fullscreen", (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    e.returnValue = !!(w && w.isFullScreen());
  });
  ipcMain.on("zoomies:set-fullscreen", (e, on) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.setFullScreen(!!on);
  });
  createWindow();
});

app.on("window-all-closed", () => app.quit());
