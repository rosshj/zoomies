// Feature playground (playground.html) — a sandbox for TRACK FEATURES: a few
// tiny test loops, each staging one kind of thing (destructible structures,
// jumps, power-ups, the shipped road props), driven with the real Kart, the
// real Track and the real prop/item code, so what you learn here transfers
// straight to a race. Like viewer.js it is deliberately independent of main.js
// (no menus, HUD, progression or platform seam): the glue a race needs for a
// kart to drive, smash, jump and fire items is re-created here in ~150 lines.
//
// Debug hook: window.__playground (see the bottom) — tools/playground-check.mjs
// drives the areas headlessly through it.
import * as THREE from "three";
import { Track } from "./track.js";
import { Kart, setSunShadow, KART_COLLIDE_MIN, kartBumpPower } from "./kart.js";
import { Input } from "./input.js";
import { initProps } from "./props.js";
import { ItemManager } from "./items.js";
import { HairballManager } from "./hairball.js";
import { EffectsManager } from "./effects.js";
import { createScene, moodForTimeOfDay } from "./scene.js";
import { buildWorld } from "./scenery.js";
import { ChaseCam } from "./split.js";
import { toonify, uSunViewNode, uSunColNode } from "./toon.js";
import { setWindClock } from "./wind.js";
import { audio } from "./audio.js";
import { CAT_PRESETS, KART_PRESETS } from "./presets.js";
import { SurfaceFeatures } from "./track-surface.js";
import { AREAS, areaPoints, resolveArea, areaTrackConfig } from "./playground-areas.js";

const params = new URLSearchParams(location.search);
if (params.has("plain")) document.body.classList.add("plain");
const $ = (id) => document.getElementById(id);
const statusEl = $("status"),
  teleEl = $("tele"),
  toastEl = $("toast"),
  itemsHud = $("items-hud");
let toastTimer = 0;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
}

// ---------------------------------------------------------------------------
// Scene: the game's own renderer/sky/sun (createScene wants a #game host).
// ---------------------------------------------------------------------------
const { renderer, scene, camera: _sceneCam, sun, applyMood, ready, skyMesh, starField } = createScene();
await ready;
const mood = moodForTimeOfDay(params.get("tod") || "midday");
applyMood(mood);
setSunShadow(mood.sunDir);
uSunColNode.value.set(mood.sunColor).multiplyScalar(0.35);
const sunDir = new THREE.Vector3(...mood.sunDir).normalize();
_sceneCam.visible = false;

// Flat lawn under everything (the real game builds terrain per track; a test
// area just needs a floor that takes shadows and reads as grass).
{
  const geo = new THREE.PlaneGeometry(1800, 1800, 24, 24);
  geo.rotateX(-Math.PI / 2);
  const col = new Float32Array(geo.attributes.position.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < geo.attributes.position.count; i++) {
    const x = geo.attributes.position.getX(i),
      z = geo.attributes.position.getZ(i);
    c.set(0x6f9d4f).multiplyScalar(0.92 + 0.08 * Math.sin(x * 0.011 + 1.3) * Math.cos(z * 0.013));
    col.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const lawn = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
  lawn.position.y = -0.12;
  lawn.receiveShadow = true;
  toonify(lawn);
  scene.add(lawn);
  var lawnMesh = lawn; // hidden while an area shows the real terrain
}

// ---------------------------------------------------------------------------
// Karts: the player (first garage cat + kart) and an optional dummy rival
// that cruises the loop so homing/targeted items have something to hit.
// ---------------------------------------------------------------------------
function buildKart(cat, kartPreset, isPlayer, skill = 1) {
  const kart = new Kart({
    name: isPlayer ? "You" : cat.name,
    isPlayer,
    skill,
    color: kartPreset.color,
    kartStyle: kartPreset.style,
    kartNumber: kartPreset.number,
    kartLivery: kartPreset.livery,
    catColor: cat.fur,
    catType: cat.type,
    catPattern: cat.pattern,
    catAccessory: cat.accessory,
  });
  kart.group.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) if (m.isMeshStandardMaterial) m.userData.rim = true;
  });
  toonify(kart.group);
  scene.add(kart.group);
  return kart;
}
const player = buildKart(CAT_PRESETS[0], KART_PRESETS[0], true);
const dummy = buildKart(CAT_PRESETS[2], KART_PRESETS[1], false, 0.62);
dummy.group.visible = false;
let dummyOn = false;
const karts = [player]; // live field (the dummy joins when spawned)

const input = new Input({ touch: false });
const hairballs = new HairballManager(scene);
const effects = new EffectsManager(scene);
const chase = new ChaseCam();
const camera = chase.camera;
camera.aspect = 1;

// ---------------------------------------------------------------------------
// Areas: built lazily on first visit, then shown/hidden. Each owns a Track
// (points mode), its surface features, its props layout and an ItemManager.
// ---------------------------------------------------------------------------
const built = new Map(); // area.id -> { area, track, surface, props, items, targets }
let cur = null;
let smashed = 0;

async function buildArea(area) {
  statusEl.textContent = `building ${area.name}…`;
  const track = new Track({
    mode: "points",
    points: areaPoints(area),
    width: area.width,
    biomes: area.biomes,
    features: [], // no set pieces on a test loop
    seed: "playground-" + area.id,
    ...areaTrackConfig(area),
  });
  track.totalLaps = 999;
  track.raceTime = 0;
  track.setStartLight?.(3);
  const { layout, surface: surfSpecs, targets } = resolveArea(area, track);
  const surface = new SurfaceFeatures(track);
  for (const spec of surfSpecs) surface.add(spec);
  track.group.add(surface.group);
  toonify(track.group);
  scene.add(track.group);
  const props = await initProps(scene, track, {
    seed: "playground-" + area.id,
    layout,
    onImpact: (kind, pos, strength) => audio.propImpact(kind, pos, strength),
    onBreak: (kart, st) => {
      // Smashing a structure costs pace in proportion to how solid it is —
      // the one place props push back on the kart.
      if (kart) kart.speed *= 1 - (st.spec.slow || 0);
      smashed++;
      toast(`💥 ${st.spec.name}`);
    },
    onItem: (kart) => grantItem(kart),
  });
  if (props) props.setItemsEnabled(!!area.items);
  const items = new ItemManager(scene, track);
  const rec = { area, track, surface, props, items, targets, itemsOn: !!area.items };
  built.set(area.id, rec);
  statusEl.textContent = "";
  return rec;
}

function showArea(rec, on) {
  rec.track.group.visible = on;
  if (rec.props) rec.props.group.visible = on;
  if (rec.worldGroup) rec.worldGroup.visible = on && rec.sceneryOn;
  lawnMesh.visible = !(on && rec.worldGroup && rec.sceneryOn);
  if (!on) {
    rec.items.clear();
  }
}

// The game's real scenery (terrain, trees, buildings, lakes…) around an
// area's loop — built on demand (it takes a few seconds) into a group that
// stands in for the scene, so it can be toggled and left behind on a switch.
function buildScenery(rec) {
  if (rec.worldGroup) return rec.world;
  statusEl.textContent = "building scenery…";
  const g = new THREE.Group();
  g.name = "world";
  scene.add(g);
  rec.worldGroup = g;
  rec.world = buildWorld(g, rec.track, { timeOfDay: mood.tod, detail: 1 });
  toonify(g);
  statusEl.textContent = "";
  return rec.world;
}
function setScenery(on) {
  if (!cur) return;
  if (on) buildScenery(cur);
  cur.sceneryOn = on;
  showArea(cur, true);
  fitSunToArea(cur);
  renderActions();
}

function fitSunToArea(rec) {
  // One static shadow map per area: fit the ortho frustum to the loop.
  const box = new THREE.Box3().setFromObject(rec.track.group);
  const c = box.getCenter(new THREE.Vector3());
  const r = box.getSize(new THREE.Vector3()).length() * 0.5 + 20;
  sun.target.position.copy(c);
  sun.target.updateMatrixWorld();
  sun.position.copy(c).addScaledVector(sunDir, 320);
  sun.shadow.camera.left = -r;
  sun.shadow.camera.right = r;
  sun.shadow.camera.top = r;
  sun.shadow.camera.bottom = -r;
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.needsUpdate = true;
}

function clearProjectiles() {
  for (const b of hairballs.balls) scene.remove(b.mesh);
  hairballs.balls.length = 0;
  cur?.items.clear();
}

function placeKart(kart, t, lateral = 0, back = 0) {
  const track = cur.track;
  const tt = t - back / track.length;
  const p = track.getPointAt(tt);
  const tan = track.getTangentAt(tt);
  const pos = p.clone().add(new THREE.Vector3(-tan.z, 0, tan.x).multiplyScalar(lateral));
  kart.placeAt(pos, Math.atan2(tan.x, tan.z), track);
  kart.vy = 0;
  kart.y = 0;
  kart.airborne = false;
  kart.spinTimer = 0;
  kart.knock.set(0, 0, 0);
  kart.update(0, track); // sync the mesh to the new pose this frame
  cur.props?.update(0, fieldSnapshot()); // restart the prop sweep from here (no phantom pass)
  chase.snap();
}

async function setArea(id) {
  const area = AREAS.find((a) => a.id === id) || AREAS[0];
  if (cur && cur.area.id === area.id) return;
  if (cur) showArea(cur, false);
  clearProjectiles();
  cur = built.get(area.id) || (await buildArea(area));
  showArea(cur, true);
  fitSunToArea(cur);
  for (const b of $("areas").children) b.classList.toggle("selected", b.dataset.id === area.id);
  $("blurb").textContent = area.blurb;
  fitMap();
  renderTargets();
  renderActions();
  placeKart(player, 0, 0, 12);
  setDummy(!!area.dummy && dummyOn, true);
  flight.reset();
  history.replaceState(
    null,
    "",
    `?area=${area.id}${params.has("webgl") ? "&webgl=1" : ""}${autoplay ? "&autoplay=1" : ""}`,
  );
  if (autoplay) setAutoplay(true); // re-arm (spawns the dummy in the item area)
  $("side").classList.remove("open");
}

function renderTargets() {
  const el = $("targets");
  el.innerHTML = "";
  for (const t of cur.targets) {
    const b = document.createElement("button");
    if (t.header) b.className = "header";
    b.innerHTML = `${t.header ? t.label : t.label.replace(/^[^·]+· /, "")}<small>t ${t.t.toFixed(2)}</small>`;
    b.addEventListener("click", () => teleportTo(t));
    el.appendChild(b);
  }
}
function teleportTo(t) {
  placeKart(player, t.t, t.lateral, t.header ? 10 : 34);
  toast(`→ ${t.label}`);
}

// ---------------------------------------------------------------------------
// Biome map: the loop drawn in the side panel, coloured by the biome each
// sample sits in, with the stations marked and the kart live. Click to jump
// to the nearest station.
// ---------------------------------------------------------------------------
const BIOME_COLORS = {
  meadow: "#5cb04a",
  forest: "#2f7a3a",
  alpine: "#b8c8d8",
  autumn: "#d4863a",
  beach: "#e8d59a",
  desert: "#e0b56a",
  mesa: "#c0603a",
  tundra: "#dfe8ee",
  city: "#8e959c",
  jungle: "#2e8a4a",
  wetlands: "#4f7a63",
  volcanic: "#4a3a38",
  savanna: "#c8a85a",
  blossom: "#f0a0c0",
  lavender: "#a48ed0",
};
const mapEl = $("map");
const mapCtx = mapEl.getContext("2d");
let mapFit = null;
function fitMap() {
  const pts = cur.track._pts;
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const W = mapEl.width,
    H = mapEl.height,
    pad = 14;
  const sc = Math.min((W - pad * 2) / (maxX - minX || 1), (H - pad * 2) / (maxZ - minZ || 1));
  mapFit = {
    sc,
    ox: W / 2 - ((minX + maxX) / 2) * sc,
    oz: H / 2 - ((minZ + maxZ) / 2) * sc,
  };
}
const mapXY = (x, z) => [mapFit.ox + x * mapFit.sc, mapFit.oz + z * mapFit.sc];
function drawMap() {
  if (!cur || !mapFit) return;
  const track = cur.track,
    pts = track._pts,
    names = track.biomeNames || [];
  const ctx = mapCtx;
  ctx.clearRect(0, 0, mapEl.width, mapEl.height);
  ctx.lineWidth = 7;
  ctx.lineCap = "round";
  for (let i = 0; i < pts.length; i += 4) {
    const a = pts[i],
      b = pts[(i + 4) % pts.length];
    ctx.strokeStyle = BIOME_COLORS[names[i]] || "#777";
    ctx.beginPath();
    ctx.moveTo(...mapXY(a.x, a.z));
    ctx.lineTo(...mapXY(b.x, b.z));
    ctx.stroke();
  }
  // Stations: a dot per scene / feature, a ring per biome header.
  for (const t of cur.targets) {
    const p = track.getPointAt(t.t, _mapP);
    const [x, y] = mapXY(p.x, p.z);
    ctx.beginPath();
    if (t.header) {
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.strokeStyle = "#ffd54f";
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = "#0e1320";
      ctx.fill();
    }
  }
  // The kart.
  const [kx, ky] = mapXY(player.position.x, player.position.z);
  ctx.beginPath();
  ctx.arc(kx, ky, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = "#ff5252";
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
}
const _mapP = new THREE.Vector3();
mapEl.addEventListener("click", (e) => {
  if (!cur || !mapFit) return;
  const r = mapEl.getBoundingClientRect();
  const mx = ((e.clientX - r.left) / r.width) * mapEl.width,
    my = ((e.clientY - r.top) / r.height) * mapEl.height;
  let best = null,
    bd = Infinity;
  for (const t of cur.targets) {
    const p = cur.track.getPointAt(t.t, _mapP);
    const [x, y] = mapXY(p.x, p.z);
    const d = (x - mx) ** 2 + (y - my) ** 2;
    if (d < bd) {
      bd = d;
      best = t;
    }
  }
  if (best) teleportTo(best);
});

// Area-specific actions (the power-up tester is where most of these live).
const ITEM_GIVERS = [
  ["🛡️ Shield", (k) => k.giveShield(10)],
  ["🐾 Tri-furball", (k) => k.giveTriShots(3)],
  ["🌿 Catnip", (k) => k.giveCatnip()],
  ["🧶 Yarn ball", (k) => k.giveYarn()],
  ["🥛 Milk", (k) => k.giveMilk()],
  ["😻 Nine lives", (k) => k.giveLife()],
  ["💨 Fill boost", (k) => (k.boostMeter = 1.2)],
  ["🌀 Spin me out", (k) => k.spinOut()],
];
function renderActions() {
  const el = $("actions");
  el.innerHTML = "";
  const add = (label, fn, cls = "") => {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = cls;
    b.addEventListener("click", fn);
    el.appendChild(b);
    return b;
  };
  for (const [label, fn] of ITEM_GIVERS)
    add(label, () => {
      fn(player);
      toast(label);
    });
  if (cur.area.tour) {
    const b = add(cur.sceneryOn ? "🌲 Scenery: on" : "🌲 Scenery: off", () => setScenery(!cur.sceneryOn), "wide");
    b.classList.toggle("on", !!cur.sceneryOn);
  }
  const dummyBtn = add(dummyOn ? "🐱 Remove dummy rival" : "🐱 Spawn dummy rival", () => setDummy(!dummyOn), "wide");
  dummyBtn.classList.toggle("on", dummyOn);
  if (cur.props)
    add(
      cur.itemsOn ? "🎁 Boxes: on" : "🎁 Boxes: off",
      (e) => {
        cur.itemsOn = !cur.itemsOn;
        cur.props.setItemsEnabled(cur.itemsOn);
        e.target.textContent = cur.itemsOn ? "🎁 Boxes: on" : "🎁 Boxes: off";
      },
      "wide",
    );
  $("actions-title").classList.remove("hidden");
}

function setDummy(on, silent = false) {
  dummyOn = on;
  dummy.group.visible = on;
  const i = karts.indexOf(dummy);
  if (on && i < 0) karts.push(dummy);
  if (!on && i >= 0) karts.splice(i, 1);
  if (on) {
    const t = ((player._proj?.t ?? 0) + 0.06) % 1;
    const track = cur.track;
    const p = track.getPointAt(t);
    const tan = track.getTangentAt(t);
    dummy.placeAt(p, Math.atan2(tan.x, tan.z), track);
    dummy.speed = 10;
  }
  if (!silent) renderActions();
}

// ---------------------------------------------------------------------------
// Race glue (the parts of main.js a kart needs to drive, smash and fire).
// ---------------------------------------------------------------------------
const SHOOT_CHARGE_TIME = 0.7;
const SHOOT_RECHARGE = 1.2;
const BOX_COOLDOWN = 3;
const ROLL = ["shield", "milk", "yarn", "tri", "life", "catnip"];
function grantItem(kart) {
  if (kart.boxCooldown > 0) return false;
  kart.boxCooldown = BOX_COOLDOWN;
  effects.tootBurst(kart, 2, false);
  audio.boost(kart === player ? null : kart.position);
  // Flat roll here (a race weights it by position — see main.js grantItem).
  const pick = ROLL[Math.floor(Math.random() * ROLL.length)];
  switch (pick) {
    case "shield":
      kart.giveShield(10);
      break;
    case "milk":
      kart.giveMilk();
      break;
    case "yarn":
      kart.giveYarn();
      break;
    case "tri":
      kart.giveTriShots(3);
      break;
    case "life":
      kart.giveLife();
      break;
    default:
      kart.giveCatnip();
  }
  if (kart === player) toast(`🎁 ${pick}`);
  return true;
}
function fireShot(kart, charge = 0) {
  if (kart.shootCooldown > 0 || kart.spinTimer > 0) return false;
  if (kart.yarnShots > 0) {
    kart.yarnShots = 0;
    let target = null,
      best = 0.28;
    for (const other of karts) {
      if (other === kart) continue;
      let gap = (other.trackT - kart.trackT) % 1;
      if (gap < 0) gap += 1;
      if (gap < best) {
        best = gap;
        target = other;
      }
    }
    cur.items.spawnYarn(kart, target);
    effects.tootBurst(kart, 1.4, false);
  } else {
    hairballs.spawn(kart, charge);
  }
  audio.shoot(kart === player ? null : kart.position);
  kart.shootCooldown = SHOOT_RECHARGE;
  return true;
}
function applyHumanControls(kart, inp, dt) {
  kart.steerInput = inp.steer;
  kart.throttleInput = inp.throttle;
  if (inp.consumeShieldEngage() && kart.drifting) {
    kart.drifting = false;
    kart.driftCharge = 0;
    kart.driftRamp = 0;
  }
  kart.shielding = inp.shielding;
  kart.driftHeld = inp.jumpHeld;
  if (inp.consumeJump()) kart.jump();
  if (inp.shootHeld && kart.shootCooldown <= 0)
    kart.shootCharge = Math.min(kart.shootCharge + dt / SHOOT_CHARGE_TIME, 1);
  if (inp.consumeShootRelease()) {
    fireShot(kart, kart.shootCharge);
    kart.shootCharge = 0;
  }
  if (inp.consumeMilk() && kart.milkBottles > 0 && kart.spinTimer <= 0) {
    kart.milkBottles = 0;
    cur.items.dropMilk(kart);
    toast("🥛 Spilled!");
  }
  if (inp.consumeBoost() && kart.boostMeter >= 1) {
    const over = kart.boostMeter > 1.02;
    if (kart.tootBoost(kart.boostMeter)) {
      kart.boostMeter = 0;
      effects.tootBurst(kart, over ? 3.5 : 2);
      audio.toot();
    }
  }
}
function applyBoostPads(dt) {
  const pads = cur.track.boostPads;
  if (!pads) return;
  for (const k of karts) {
    k._padCd = (k._padCd || 0) - dt;
    if (k.spinTimer > 0 || k._padCd > 0 || k.speed < 4) continue;
    for (const pad of pads) {
      const dx = k.position.x - pad.x,
        dz = k.position.z - pad.z;
      if (dx * dx + dz * dz < pad.r * pad.r) {
        k.applyBoost(1.4, 0.8);
        k._padCd = 1.2;
        break;
      }
    }
  }
}
function resolveCollisions() {
  for (let i = 0; i < karts.length; i++)
    for (let j = i + 1; j < karts.length; j++) {
      const a = karts[i],
        b = karts[j];
      const dx = b.position.x - a.position.x,
        dz = b.position.z - a.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= 1e-4 || d2 >= KART_COLLIDE_MIN * KART_COLLIDE_MIN) continue;
      const dist = Math.sqrt(d2),
        nx = dx / dist,
        nz = dz / dist,
        overlap = KART_COLLIDE_MIN - dist;
      const ima = 1 / a.mass,
        imb = 1 / b.mass,
        inv = ima + imb,
        sa = ima / inv,
        sb = imb / inv;
      a.position.x -= nx * overlap * sa;
      a.position.z -= nz * overlap * sa;
      b.position.x += nx * overlap * sb;
      b.position.z += nz * overlap * sb;
      const power = kartBumpPower(a.speed, b.speed);
      a.knock.x -= nx * power * sa;
      a.knock.z -= nz * power * sa;
      b.knock.x += nx * power * sb;
      b.knock.z += nz * power * sb;
      audio.bump(null, Math.min(1, power / 40));
      a.speed *= 0.99;
      b.speed *= 0.99;
    }
}
const _field = [];
function fieldSnapshot() {
  _field.length = 0;
  for (const k of karts) _field.push({ x: k.position.x, z: k.position.z, kart: k });
  return _field;
}

// Flight telemetry: time in the air, peak height and ground distance of the
// last jump (ramp launch or hop), so a ramp can be tuned by numbers.
const flight = {
  air: false,
  t: 0,
  peak: 0,
  from: new THREE.Vector3(),
  last: null,
  launchSpeed: 0,
  reset() {
    this.air = false;
    this.t = 0;
    this.peak = 0;
    this.last = null;
  },
  update(kart, dt) {
    if (kart.airborne && !this.air) {
      this.air = true;
      this.t = 0;
      this.peak = 0;
      this.from.copy(kart.position);
      this.launchSpeed = Math.abs(kart.speed);
    }
    if (this.air) {
      this.t += dt;
      this.peak = Math.max(this.peak, kart.y);
      if (!kart.airborne) {
        this.air = false;
        this.last = {
          air: this.t,
          peak: this.peak,
          dist: this.from.distanceTo(kart.position),
          speed: this.launchSpeed,
        };
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Autopilot: drives the player round the loop, lining up on each station in
// turn (the AI driver sticks to the racing line, which misses everything
// parked by the kerb), so an area can be watched hands-free — the phone test.
// In the power-up area it also hands itself an item every few seconds and
// uses it, with the dummy rival out as a target.
// ---------------------------------------------------------------------------
let autoplay = false;
const auto = { target: null, itemT: 0 };
const _apPoint = new THREE.Vector3(),
  _apTan = new THREE.Vector3();
function autopilot(dt) {
  const k = player,
    track = cur.track;
  const proj = k._proj || track.project(k.position);
  // Next station ahead on the lap (wrapping); stay with it until we're past.
  const targets = cur.targets;
  let best = null,
    bestGap = 2;
  for (const tg of targets) {
    let gap = (tg.t - proj.t + 1) % 1;
    if (gap < 0.004) gap += 1; // just passed it: it's the one a lap away now
    if (gap < bestGap) {
      bestGap = gap;
      best = tg;
    }
  }
  auto.target = best;
  const ahead = bestGap * track.length;
  // Aim lateral: the station's own offset once it's close, the centre line
  // in between (so the kart isn't scraping a kerb for half a lap).
  const wantLat = best && ahead < 70 ? best.lateral : 0;
  const look = 14 + Math.abs(k.speed) * 0.25;
  const tt = proj.t + look / track.length;
  track.getPointAt(tt, _apPoint);
  track.getTangentAt(tt, _apTan);
  _apPoint.x += -_apTan.z * wantLat;
  _apPoint.z += _apTan.x * wantLat;
  const want = Math.atan2(_apPoint.x - k.position.x, _apPoint.z - k.position.z);
  let d = want - k.heading;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  input._steerTarget = Math.max(-1, Math.min(1, d * 2.4));
  input._keyboardSteering = false;
  input.throttle = 1;
  input._keyboardThrottle = false;
  // Power-ups: a fresh item every few seconds, used straight away.
  if (cur.area.items) {
    auto.itemT -= dt;
    if (auto.itemT <= 0) {
      auto.itemT = 4;
      const giver = ITEM_GIVERS[Math.floor(Math.random() * 7)]; // not "spin me out"
      giver[1](k);
      toast(`🤖 ${giver[0]}`);
      if (k.milkBottles > 0 && k.spinTimer <= 0) {
        k.milkBottles = 0;
        cur.items.dropMilk(k);
      } else if (k.boostMeter >= 1 && !k.catnipBoosting && k.tootBoost(k.boostMeter)) {
        k.boostMeter = 0;
        effects.tootBurst(k, 2);
      } else {
        k.shootCooldown = 0;
        fireShot(k, 0.6);
      }
    }
  }
}
function setAutoplay(on) {
  autoplay = on;
  $("auto-btn").classList.toggle("on", on);
  $("auto-btn").textContent = on ? "⏹ Auto" : "▶ Auto";
  if (!on) {
    input._steerTarget = 0;
    input.throttle = 0;
  } else if (cur?.area.dummy && !dummyOn) setDummy(true);
}

// ---------------------------------------------------------------------------
// Cameras: the game's chase cam, a wide "action" cam for watching debris, and
// a top-down view. C cycles.
// ---------------------------------------------------------------------------
const CAM_MODES = ["chase", "action", "top"];
let camMode = 0;
const _camPos = new THREE.Vector3(),
  _camLook = new THREE.Vector3(),
  _camFwd = new THREE.Vector3();
let camSnap = true;
function updateCamera(dt) {
  const mode = CAM_MODES[camMode];
  if (mode === "chase") {
    chase.update(player, cur.track, dt);
    camSnap = true;
    return;
  }
  _camFwd.set(Math.sin(player.heading), 0, Math.cos(player.heading));
  if (mode === "action") {
    // Wide and high, trailing off to one side so a smash plays out in frame.
    _camPos
      .copy(player.position)
      .addScaledVector(_camFwd, -20)
      .add(new THREE.Vector3(-_camFwd.z * 9, 13, _camFwd.x * 9));
    _camLook.copy(player.position).addScaledVector(_camFwd, 10);
    _camLook.y += 1;
  } else {
    _camPos.copy(player.position).addScaledVector(_camFwd, 8);
    _camPos.y += 70;
    _camLook.copy(player.position).addScaledVector(_camFwd, 8.01);
  }
  const g = cur.track.groundYNear(_camPos.x, _camPos.z, player.position.y);
  if (_camPos.y < g + 4) _camPos.y = g + 4;
  const k = camSnap ? 1 : 1 - Math.pow(0.002, dt);
  camSnap = false;
  camera.position.lerp(_camPos, k);
  camera.lookAt(_camLook);
  if (camera.fov !== 62) {
    camera.fov = 62;
    camera.updateProjectionMatrix();
  }
}
function setCamMode(i) {
  camMode = ((i % CAM_MODES.length) + CAM_MODES.length) % CAM_MODES.length;
  camSnap = true;
  chase.snap();
  $("cam-btn").textContent = `📷 ${CAM_MODES[camMode][0].toUpperCase()}${CAM_MODES[camMode].slice(1)}`;
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
let slowMo = false;
let soundOn = false;
function setSlowMo(on) {
  slowMo = on;
  $("slow-btn").classList.toggle("on", on);
}
function setSound(on) {
  soundOn = on;
  if (on) {
    audio.unlock();
    audio.startEngine();
  } else audio.stopEngine();
  $("sound-btn").textContent = on ? "🔊 Sound" : "🔇 Sound";
  $("sound-btn").classList.toggle("on", on);
}
function resetArea() {
  if (!cur) return;
  cur.props?.reset();
  clearProjectiles();
  smashed = 0;
  placeKart(player, 0, 0, 12);
  if (dummyOn) setDummy(true, true);
  flight.reset();
  toast("↺ reset");
}
for (const a of AREAS) {
  const b = document.createElement("button");
  b.dataset.id = a.id;
  b.textContent = `${a.icon} ${a.name}`;
  b.addEventListener("click", () => setArea(a.id));
  $("areas").appendChild(b);
}
$("cam-btn").addEventListener("click", () => setCamMode(camMode + 1));
$("auto-btn").addEventListener("click", () => setAutoplay(!autoplay));
$("side-toggle").addEventListener("click", () => $("side").classList.toggle("open"));
$("slow-btn").addEventListener("click", () => setSlowMo(!slowMo));
$("sound-btn").addEventListener("click", () => setSound(!soundOn));
$("reset-btn").addEventListener("click", resetArea);
window.addEventListener("keydown", (e) => {
  if (e.repeat || e.target?.tagName === "INPUT") return;
  if (e.code === "KeyR") resetArea();
  else if (e.code === "KeyP") setAutoplay(!autoplay);
  else if (e.code === "KeyC") setCamMode(camMode + 1);
  else if (e.code === "KeyT") setSlowMo(!slowMo);
  else if (/^Digit[1-9]$/.test(e.code)) {
    const a = AREAS[Number(e.code.slice(5)) - 1];
    if (a) setArea(a.id);
  }
});
// The first real gesture is what lets audio start (browsers gate it).
window.addEventListener("pointerdown", () => soundOn && audio.unlock(), { once: true });

function resize() {
  const host = $("game");
  const w = host.clientWidth,
    h = host.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
new ResizeObserver(resize).observe($("game")); // the phone panel opening/closing resizes the canvas host

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------
let last = performance.now();
let fps = 0,
  fpsAcc = 0,
  fpsN = 0;
const _sunTravel = new THREE.Vector3();
let frozen = false; // tools: pause the sim (camera still renders)
let pinned = false; // tools: leave the camera exactly where a probe parked it
function step(dt) {
  input.update(dt);
  if (autoplay) autopilot(dt);
  applyHumanControls(player, input, dt);
  if (dummyOn) {
    dummy.driveAI(cur.track, dt, cur.props ? cur.props.boxTargets() : null, karts);
    dummy.throttleInput = Math.min(dummy.throttleInput, 0.55); // a slow cruiser, not a racer
  }
  for (const k of karts) k.update(dt, cur.track);
  applyBoostPads(dt);
  resolveCollisions();
  hairballs.update(dt, karts);
  cur.items.update(dt, karts, {
    onYarnHit: (k) => effects.tootBurst(k, 2, false),
    onYarnBlocked: (k) => effects.tootBurst(k, 1, false),
    onMilkHit: (k, p) => {
      effects.tootBurst(k, 2, false);
      if (p && p.owner && p.owner !== k) p.owner.gloat();
    },
  });
  cur.props?.update(dt, fieldSnapshot());
  for (const k of karts) {
    if (k.wallHit) {
      effects.wallSparks(k);
      if (soundOn) audio.scrape(k === player ? null : k.position);
      k.wallHit = false;
    }
    if (k.lifePulse) {
      k.lifePulse = false;
      effects.tootBurst(k, 1, false);
      if (k === player) toast("😻 Saved by a life!");
    }
    if (k.spinTimer > 0) effects.skid(k);
    if (k.drifting && Math.abs(k.speed) > 8) effects.driftSparks(k);
    if (k.boosting && Math.abs(k.speed) > 6) effects.trickle(k, k.catnipBoosting);
    if (k.boostPuff >= 0) {
      effects.tootBurst(k, 1 + k.boostPuff, false);
      k.boostPuff = -1;
    }
    if (k.airLaunch) {
      k.airLaunch = false;
      if (k === player && k.vy > 4) toast(`🪂 launched at ${Math.round(Math.abs(k.speed) * 3)} km/h`);
    }
  }
  flight.update(player, dt);
  effects.update(dt);
  cur.track.raceTime += dt;
  if (cur.world && cur.sceneryOn) cur.world.update(cur.track.raceTime, dt, player.position);
}

function telemetry() {
  const k = player;
  const held = [];
  if (k.shieldTimer > 0) held.push(`🛡️ ${k.shieldTimer.toFixed(1)}s`);
  if (k.triShots > 0) held.push(`🐾 ×${k.triShots}`);
  if (k.catnipTimer > 0) held.push(`🌿 ${k.catnipTimer.toFixed(1)}s`);
  if (k.yarnShots > 0) held.push("🧶");
  if (k.milkBottles > 0) held.push("🥛");
  if (k.lives > 0) held.push(`😻 ×${k.lives}`);
  itemsHud.innerHTML = held.map((h) => `<span>${h}</span>`).join("");
  const l = flight.last;
  const moving = cur.props ? cur.props._props.filter((p) => !p.asleep && !p.dormant && !p.broken).length : 0;
  teleEl.innerHTML =
    `speed    <b>${String(Math.round(Math.abs(k.speed) * 3)).padStart(3)}</b> km/h   boost ${Math.round(k.boostMeter * 100)}%\n` +
    `air      <b>${flight.air ? flight.t.toFixed(2) : "0.00"}</b> s     height ${k.y.toFixed(2)} m\n` +
    `last jump ${l ? `${l.air.toFixed(2)}s · ${l.peak.toFixed(1)}m up · ${l.dist.toFixed(1)}m @ ${Math.round(l.speed * 3)}km/h` : "—"}\n` +
    `smashed  <b>${smashed}</b>   pieces moving ${moving}\n` +
    `lap t    ${(k.trackT || 0).toFixed(3)}   slope ${((k.slopePitch * 180) / Math.PI).toFixed(1)}°\n` +
    `edge     ${k._proj ? cur.track.barrierAt(k._proj)?.name || cur.track.barrierAt(k._proj)?.kind || "—" : "—"}${k.onVerge ? "   ⚠ on verge" : ""}\n` +
    `fps      ${fps.toFixed(0)}   ${renderer.backend?.isWebGPUBackend ? "WebGPU" : "WebGL2"}${slowMo ? "   🐢 slow-mo" : ""}`;
}

renderer.setAnimationLoop((now) => {
  let dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  fpsAcc += dt;
  fpsN++;
  if (fpsAcc > 0.5) {
    fps = fpsN / fpsAcc;
    fpsAcc = 0;
    fpsN = 0;
  }
  if (!cur) return;
  if (slowMo) dt *= 0.3;
  if (!frozen) step(dt);
  if (!pinned) updateCamera(dt);
  // Sky + stars ride with the eye; toon rim light tracks the sun in view space.
  skyMesh.position.copy(camera.position);
  starField.position.copy(camera.position);
  _sunTravel.copy(sunDir).negate().transformDirection(camera.matrixWorldInverse);
  uSunViewNode.value.copy(_sunTravel);
  setWindClock(now / 1000);
  if (soundOn) {
    audio.setListener(player.position.x, player.position.z, Math.sin(player.heading), Math.cos(player.heading));
    audio.setEngine(Math.min(1, Math.abs(player.speed) / player.maxSpeed), player.boosting);
  }
  telemetry();
  drawMap();
  renderer.render(scene, camera);
});

resize();
setCamMode(0);
await setArea(params.get("area") || AREAS[0].id);
if (params.has("autoplay")) setAutoplay(true);
statusEl.textContent = `${renderer.backend?.isWebGPUBackend ? "WebGPU" : "WebGL2"} · ${AREAS.length} areas`;
console.log(`[zoomies] feature playground: ${AREAS.length} areas · ${statusEl.textContent}`);

// Debug hook for headless checks + quick console poking.
window.__playground = {
  AREAS,
  get area() {
    return cur;
  },
  player,
  dummy,
  karts,
  input,
  camera,
  scene,
  renderer,
  effects,
  setArea,
  placeKart: (t, lateral = 0, back = 0) => placeKart(player, t, lateral, back),
  teleport: (i) => {
    const tg = cur.targets[i];
    if (tg) placeKart(player, tg.t, tg.lateral, 34);
    return tg;
  },
  resetArea,
  setDummy,
  setCamMode,
  setSlowMo,
  setScenery,
  setAutoplay,
  get autoplay() {
    return autoplay;
  },
  grantItem,
  fireShot,
  flight,
  get smashed() {
    return smashed;
  },
  // Deterministic stepping for probes: freeze the live loop and advance by hand.
  freeze(on = true) {
    frozen = on;
  },
  pin(on = true) {
    pinned = on;
  },
  step(dt = 1 / 60, frames = 1) {
    for (let i = 0; i < frames; i++) step(dt);
    updateCamera(dt * frames);
  },
  drive(throttle = 1, steer = 0) {
    autoplay = false;
    input.throttle = throttle;
    input._steerTarget = steer;
    input._keyboardThrottle = false;
    input._keyboardSteering = false;
  },
};
