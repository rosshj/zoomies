import * as THREE from "three";
import { createScene } from "./scene.js";
import { Track } from "./track.js";
import { Kart } from "./kart.js";
import { Input } from "./input.js";
import { HairballManager } from "./hairball.js";
import { HUD, ordinal } from "./hud.js";
import { buildWorld } from "./scenery.js";
import { EffectsManager } from "./effects.js";

// Boost recharges over time instead of being a fixed count.
const BOOST_COST = 0.34; // fraction of the meter spent per boost (~3 when full)
const BOOST_RECHARGE = 1 / 9; // meter refills fully in ~9s

const TOTAL_LAPS = 3;

const { renderer, scene, camera } = createScene();

const track = new Track();
track.totalLaps = TOTAL_LAPS;
track.raceTime = 0;
scene.add(track.group);

const world = buildWorld(scene, track);

// Steering indicator + recalibrate button
const steerDot = document.getElementById("steer-dot");
document.getElementById("calibrate").addEventListener("click", () => input.calibrate());

const input = new Input();
const hairballs = new HairballManager(scene);
const effects = new EffectsManager(scene);
const hud = new HUD();

// Boost (fart) meter — recharges over time.
let boostMeter = 1;
const boostBtn = document.getElementById("btn-boost");
const boostFill = document.getElementById("boost-fill");
function updateBoostUI() {
  boostFill.style.height = `${Math.round(boostMeter * 100)}%`;
  boostBtn.classList.toggle("disabled", boostMeter < BOOST_COST);
}

// --- Karts: 1 player + 5 AI rivals ---
const ROSTER = [
  { name: "You", color: 0xe53935, catColor: 0xf0a830, isPlayer: true, skill: 1.0 },
  { name: "Mittens", color: 0x1e88e5, catColor: 0x9e9e9e, skill: 0.97 },
  { name: "Whiskers", color: 0x43a047, catColor: 0x3e2723, skill: 0.99 },
  { name: "Pumpkin", color: 0xfb8c00, catColor: 0xffffff, skill: 0.95 },
  { name: "Shadow", color: 0x8e24aa, catColor: 0x212121, skill: 1.0 },
  { name: "Biscuit", color: 0xfdd835, catColor: 0xd7a86e, skill: 0.96 },
];

let karts = [];
let player = null;

function buildKarts() {
  for (const k of karts) scene.remove(k.group);
  karts = [];
  ROSTER.forEach((cfg, i) => {
    const kart = new Kart(cfg);
    const slot = track.gridSlot(i);
    kart.placeAt(slot.position, slot.heading, track);
    kart._aiShootTimer = 1 + Math.random() * 3;
    kart._aiBoostTimer = 4 + Math.random() * 6;
    scene.add(kart.group);
    karts.push(kart);
    if (cfg.isPlayer) player = kart;
  });
}

// --- Game state ---
const State = { MENU: 0, COUNTDOWN: 1, RACING: 2, FINISHED: 3 };
let state = State.MENU;
let countdown = 0;
let raceTime = 0;
let countdownCalibrated = false;

// --- Force-landscape stage ---
// Rather than fight the OS auto-rotate (which iOS won't let web pages disable),
// we counter-rotate a wrapper so the game always *appears* in landscape no
// matter which orientation the OS chooses. Steering stays continuous because
// the gravity reading is in the device frame and we don't re-zero on rotation.
const stage = document.getElementById("stage");
let stageState = { iw: 1, ih: 1, W: 1, H: 1, rot: 0 };

function layoutStage() {
  const iw = window.innerWidth;
  const ih = window.innerHeight;
  const rawAngle =
    (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0;
  const a = ((rawAngle % 360) + 360) % 360;

  // Only counter-rotate when the viewport is actually portrait (e.g. the OS
  // rotated us because the player over-tilted). A landscape viewport is already
  // correct in either landscape, so leave it alone — this also avoids wrongly
  // rotating desktop monitors, which report angle 0 while being landscape.
  const portrait = ih > iw;
  const rot = portrait ? (a === 180 ? 270 : 90) : 0;
  const W = Math.max(iw, ih);
  const H = Math.min(iw, ih);
  stageState = { iw, ih, W, H, rot };

  stage.style.width = W + "px";
  stage.style.height = H + "px";
  stage.style.left = (iw - W) / 2 + "px";
  stage.style.top = (ih - H) / 2 + "px";
  stage.style.transform = `rotate(${rot}deg)`;

  renderer.setSize(W, H);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
}

// Inverse of the stage transform: viewport point -> stage-local point.
function stageToLocal(clientX, clientY) {
  const { iw, ih, W, H, rot } = stageState;
  const dx = clientX - iw / 2;
  const dy = clientY - ih / 2;
  const r = (-rot * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: dx * cos - dy * sin + W / 2, y: dx * sin + dy * cos + H / 2 };
}

input.setStageMapper(stageToLocal);
window.addEventListener("resize", layoutStage);
window.addEventListener("orientationchange", layoutStage);
layoutStage();

// On Android, also try a real orientation lock (best-effort; iOS ignores it).
function lockLandscape() {
  try {
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock("landscape").catch(() => {});
    }
  } catch (e) {
    /* unsupported */
  }
}
function enterFullscreenLandscape() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  try {
    if (req) {
      Promise.resolve(req.call(el)).then(lockLandscape, lockLandscape);
    } else {
      lockLandscape();
    }
  } catch (e) {
    lockLandscape();
  }
}

// --- Menu wiring ---
document.getElementById("start-btn").addEventListener("click", startRace);
document.getElementById("restart-btn").addEventListener("click", startRace);

function startRace() {
  // These need the user-gesture from the click, so fire them synchronously.
  enterFullscreenLandscape();
  input.enableMotion();
  input.calibrate();

  document.getElementById("menu").classList.add("hidden");
  document.getElementById("results").classList.add("hidden");
  document.getElementById("hud").classList.remove("hidden");

  buildKarts();
  boostMeter = 1;
  updateBoostUI();
  raceTime = 0;
  track.raceTime = 0;
  countdown = 3.999;
  countdownCalibrated = false;
  state = State.COUNTDOWN;
}

// --- Camera follow ---
const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3();
function updateCamera(dt, snap = false) {
  const fwd = new THREE.Vector3(Math.sin(player.heading), 0, Math.cos(player.heading));
  const desired = new THREE.Vector3()
    .copy(player.position)
    .addScaledVector(fwd, -13)
    .add(new THREE.Vector3(0, 7 + player.y * 0.5, 0));
  const look = new THREE.Vector3()
    .copy(player.position)
    .addScaledVector(fwd, 6)
    .add(new THREE.Vector3(0, 1.5 + player.y, 0));

  const lerp = snap ? 1 : 1 - Math.pow(0.001, dt);
  camPos.lerp(desired, lerp);
  camTarget.lerp(look, lerp);
  camera.position.copy(camPos);
  camera.lookAt(camTarget);
}

// --- Kart-vs-kart bumper collisions ---
// Heavier karts (the player) shove lighter ones aside and barely slow down, so
// you can push your way through traffic. Impulses go into each kart's decaying
// `knock` velocity for a springy bumper-car feel.
function resolveCollisions() {
  for (let i = 0; i < karts.length; i++) {
    for (let j = i + 1; j < karts.length; j++) {
      const a = karts[i];
      const b = karts[j];
      const dx = b.position.x - a.position.x;
      const dz = b.position.z - a.position.z;
      const distSq = dx * dx + dz * dz;
      const min = 4.4;
      if (distSq <= 0.0001 || distSq >= min * min) continue;

      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const nz = dz / dist;
      const overlap = min - dist;

      const ima = 1 / a.mass;
      const imb = 1 / b.mass;
      const inv = ima + imb;
      const sa = ima / inv; // a's share of the push (lighter moves more)
      const sb = imb / inv;

      // Separate so they don't overlap.
      a.position.x -= nx * overlap * sa;
      a.position.z -= nz * overlap * sa;
      b.position.x += nx * overlap * sb;
      b.position.z += nz * overlap * sb;

      // Bumper impulse scaled by how fast they're moving.
      const power = 10 + (Math.abs(a.speed) + Math.abs(b.speed)) * 0.4;
      a.knock.x -= nx * power * sa;
      a.knock.z -= nz * power * sa;
      b.knock.x += nx * power * sb;
      b.knock.z += nz * power * sb;

      // Only a tiny speed scrub — you keep your momentum through contact.
      a.speed *= 0.99;
      b.speed *= 0.99;
    }
  }
}

// --- Placement ---
function updatePlacement() {
  const order = [...karts].sort((a, b) => {
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.totalProgress - a.totalProgress;
  });
  order.forEach((k, idx) => (k.place = idx + 1));
}

// --- AI actions: shooting + fart boosts + boost trickle ---
function aiActions(dt) {
  for (const k of karts) {
    if (k.isPlayer) continue;
    if (k.fartTimer > 0) effects.trickle(k);
    if (k.finished || k.spinTimer > 0) continue;

    // Use a fart boost periodically, preferably on a straight.
    k._aiBoostTimer -= dt;
    if (k._aiBoostTimer <= 0) {
      k._aiBoostTimer = 6 + Math.random() * 7;
      if (Math.abs(k.steerInput) < 0.4 && k.speed > 10 && !k.boosting) {
        k.applyBoost(1.4, 1.2, true);
        effects.fartBurst(k);
      }
    }

    // Fire if someone is just ahead and roughly in front.
    k._aiShootTimer -= dt;
    if (k._aiShootTimer > 0) continue;
    k._aiShootTimer = 2.5 + Math.random() * 4;
    const fwd = new THREE.Vector3(Math.sin(k.heading), 0, Math.cos(k.heading));
    for (const other of karts) {
      if (other === k || other.finished) continue;
      const to = new THREE.Vector3().subVectors(other.position, k.position);
      const dist = to.length();
      if (dist > 4 && dist < 34 && to.normalize().dot(fwd) > 0.9) {
        hairballs.spawn(k);
        break;
      }
    }
  }
}

// --- Results ---
function showResults() {
  state = State.FINISHED;
  updatePlacement();
  const order = [...karts].sort((a, b) => a.place - b.place);
  const list = document.getElementById("results-list");
  list.innerHTML = "";
  order.forEach((k) => {
    const li = document.createElement("li");
    const time = k.finished ? ` — ${formatClock(k.finishTime)}` : " — DNF";
    li.textContent = `${ordinal(k.place)}  ${k.name}${time}`;
    if (k.isPlayer) li.className = "you";
    list.appendChild(li);
  });
  document.getElementById("results-title").textContent =
    player.place === 1 ? "🏆 You Win!" : `🏁 ${ordinal(player.place)} Place`;
  document.getElementById("hud").classList.remove("hidden");
  document.getElementById("results").classList.remove("hidden");
}

function formatClock(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

// --- Main loop ---
let last = performance.now();
let prevPlayerLap = -1;

function loop(now) {
  requestAnimationFrame(loop);
  let dt = (now - last) / 1000;
  last = now;
  dt = Math.min(dt, 0.05); // clamp big frame gaps

  world.update(now / 1000); // drift the balloons

  if (state === State.COUNTDOWN) {
    countdown -= dt;
    updateCamera(dt, camPos.lengthSq() === 0);
    const n = Math.ceil(countdown - 1);
    hud.showToast(n > 0 ? `${n}` : "GO!");
    // Re-zero steering near the end of the countdown, once the player has
    // settled into their driving grip.
    if (n === 1 && !countdownCalibrated) {
      input.calibrate();
      countdownCalibrated = true;
    }
    if (countdown <= 0) {
      state = State.RACING;
    }
    renderer.render(scene, camera);
    return;
  }

  if (state === State.RACING) {
    raceTime += dt;
    track.raceTime = raceTime;

    // Player controls
    input.update(dt);
    player.steerInput = input.steer;
    player.throttleInput = input.throttle;
    steerDot.style.transform = `translateX(${input.steer * 80}px)`;
    if (input.consumeJump()) player.jump();
    if (input.consumeShoot() && player.shootCooldown <= 0) {
      hairballs.spawn(player);
      player.shootCooldown = 0.6;
    }
    if (input.consumeBoost() && boostMeter >= BOOST_COST) {
      if (player.fartBoost()) {
        boostMeter -= BOOST_COST;
        effects.fartBurst(player);
      }
    }
    boostMeter = Math.min(1, boostMeter + BOOST_RECHARGE * dt);
    updateBoostUI();

    // Boost trickle + drift sparks for the player.
    if (player.fartTimer > 0) effects.trickle(player);
    if (player.drifting) effects.driftSparks(player);
    effects.update(dt);

    // AI
    for (const k of karts) if (!k.isPlayer) k.driveAI(track);
    aiActions(dt);

    // Step physics
    for (const k of karts) k.update(dt, track);
    resolveCollisions();
    hairballs.update(dt, karts);
    updatePlacement();

    // Lap toast for the player
    if (player.lap !== prevPlayerLap && player.lap >= 1 && !player.finished) {
      const lapNum = player.displayLap(TOTAL_LAPS);
      if (lapNum >= 2) hud.showToast(`Lap ${lapNum}/${TOTAL_LAPS}`);
    }
    prevPlayerLap = player.lap;

    // HUD
    hud.update({
      lapNum: player.displayLap(TOTAL_LAPS),
      totalLaps: TOTAL_LAPS,
      place: player.place,
      totalKarts: karts.length,
      speedKmh: Math.abs(player.speed) * 3.0,
      time: raceTime,
    });

    updateCamera(dt);

    // End the race shortly after the player finishes.
    if (player.finished) {
      hud.showToast("FINISH!");
      setTimeout(showResults, 1500);
      state = State.FINISHED; // freeze input; karts keep coasting in loop below
    }
  }

  if (state === State.FINISHED) {
    // Let karts coast to a stop and keep the camera alive.
    for (const k of karts) k.update(dt, track);
    effects.update(dt);
    updateCamera(dt);
  }

  renderer.render(scene, camera);
}

requestAnimationFrame(loop);
