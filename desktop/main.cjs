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
const ON_DECK = !!process.env.SteamDeck || (() => {
  try { return /^ID=steamos$/m.test(fs.readFileSync("/etc/os-release", "utf8")); }
  catch { return false; }
})();
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

// app:// must be registered standard+secure BEFORE app ready so module
// scripts, fetch and localStorage all behave like a normal https origin.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// Steam is optional at every layer: with steamworks.js installed and a
// steam_appid.txt next to the executable (or a real Steam launch), the API
// initialises; without either the game just runs. Nothing in the renderer
// depends on Steam yet — achievements/cloud hook in here later.
let steam = null;
function initSteam() {
  try {
    const sw = require("steamworks.js");
    steam = sw.init();
    console.log("[steam] running as:", steam.localplayer.getName());
    // Best-effort overlay hook — the overlay inside Electron is unreliable
    // (see desktop/README.md); the game must stay playable without it.
    sw.electronEnableSteamOverlay?.();
  } catch (err) {
    console.log("[steam] not active:", err.message);
  }
}

// --- Save bridge (see preload.cjs) — the file Steam Cloud syncs ------------
const savePath = () => path.join(app.getPath("userData"), "zoomies-save.json");
function writeSave(payload) {
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
    const head = fs.readFileSync(path.join(root, ".git", "HEAD"), "utf8").trim();
    const m = head.match(/^ref: (.+)$/);
    if (!m) return head.slice(0, 8); // detached HEAD: the sha itself
    const ref = m[1];
    let sha = "";
    const refPath = path.join(root, ".git", ref);
    if (fs.existsSync(refPath)) sha = fs.readFileSync(refPath, "utf8").trim();
    else {
      const packed = fs.readFileSync(path.join(root, ".git", "packed-refs"), "utf8");
      const line = packed.split("\n").find((l) => l.trim().endsWith(" " + ref) || l.trim().endsWith("\t" + ref));
      sha = line ? line.trim().split(/\s+/)[0] : "";
    }
    return `${ref.replace("refs/heads/", "")} @ ${sha.slice(0, 8)}`;
  } catch {
    return "unknown (no .git?)";
  }
}

function createWindow() {
  const saved = readJson(winStatePath());
  // Dev-launch dock/window icon (packaged builds get theirs from
  // electron-builder). dist/ ships the same 512px icon the PWA uses.
  const icon = path.join(DIST, "icon-512.png");
  if (process.platform === "darwin" && fs.existsSync(icon)) {
    try { app.dock?.setIcon(icon); } catch { /* dev nicety only */ }
  }
  const win = new BrowserWindow({
    icon: fs.existsSync(icon) ? icon : undefined,
    width: saved?.width || 1280,
    height: saved?.height || 800,
    minWidth: 960,
    minHeight: 600,
    // NEVER fullscreen-at-creation on the Deck: Gaming Mode's compositor
    // fullscreens the window itself, and fullscreen-at-creation in the
    // Deck's sessions produced a stuck black window (field-reported in both
    // modes — and once it happened, the saved window-state re-armed it on
    // every later launch, so the saved flag is ignored there too). Plain
    // window, F11 as ever.
    fullscreen: !ON_DECK && !!saved?.fullscreen,
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
  // Retest WebGPU after Electron upgrades with ZOOMIES_QUERY=webgpu=1 — the
  // pin is dropped then, because in gpu.js a webgl param always beats webgpu.
  const extra = process.env.ZOOMIES_QUERY || "";
  const pin = /webgpu/.test(extra) ? "" : "&webgl=1";
  const url = `app://game/index.html?nosw=1${pin}${extra ? "&" + extra : ""}`;
  // Printed to the npm-start terminal so "which build/backend am I actually
  // running?" is answerable at a glance (a stale build once burned a tester).
  console.log(`[shell] loading ${url} (packaged=${app.isPackaged})`);
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

// productName in package.json names the packaged app; setName makes dev
// launches match everywhere the OS takes the name from the process (userData
// path, notifications). Known limit: the macOS MENU BAR in a dev launch
// still says "Electron" — that string comes from Electron.app's own
// Info.plist and only a packaged .app (npm run dist) can change it.
app.setName("Zoomies GP");

// Steam relaunches the same executable if the player hits PLAY again.
if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(() => {
  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    console.error(`[shell] no game at ${DIST}` + (app.isPackaged ? "" : " — is the repo checkout intact?"));
    app.quit();
    return;
  }

  // Serve dist/ over app://game/, resolving strictly INSIDE dist.
  protocol.handle("app", (req) => {
    const url = new URL(req.url);
    let p = decodeURIComponent(url.pathname);
    if (p === "/" || p === "") p = "/index.html";
    const file = path.normalize(path.join(DIST, p));
    if (!file.startsWith(DIST + path.sep)) return new Response("forbidden", { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  initSteam();
  ipcMain.on("zoomies:quit", () => app.quit());
  ipcMain.on("zoomies:load-save", (e) => { e.returnValue = readJson(savePath()); });
  ipcMain.on("zoomies:save", (_e, payload) => writeSave(payload));
  ipcMain.on("zoomies:save-flush", (e, payload) => { writeSave(payload); e.returnValue = true; });
  createWindow();
});

app.on("window-all-closed", () => app.quit());
