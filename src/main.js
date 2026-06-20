import * as THREE from "three";
import { createScene } from "./scene.js";
import { Track } from "./track.js";
import { Kart } from "./kart.js";
import { Input } from "./input.js";
import { HairballManager } from "./hairball.js";
import { HUD, ordinal } from "./hud.js";

const TOTAL_LAPS = 3;

const { renderer, scene, camera } = createScene();

const track = new Track();
track.totalLaps = TOTAL_LAPS;
track.raceTime = 0;
scene.add(track.group);

const input = new Input();
const hairballs = new HairballManager(scene);
const hud = new HUD();

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

// --- Orientation gate ---
const rotateEl = document.getElementById("rotate");
function checkOrientation() {
  const isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  const portrait = window.innerHeight > window.innerWidth;
  rotateEl.classList.toggle("hidden", !(isTouch && portrait));
}
window.addEventListener("resize", checkOrientation);
window.addEventListener("orientationchange", checkOrientation);
checkOrientation();

// --- Menu wiring ---
document.getElementById("start-btn").addEventListener("click", startRace);
document.getElementById("restart-btn").addEventListener("click", startRace);

async function startRace() {
  await input.enableMotion();
  input.calibrate();

  document.getElementById("menu").classList.add("hidden");
  document.getElementById("results").classList.add("hidden");
  document.getElementById("hud").classList.remove("hidden");

  buildKarts();
  raceTime = 0;
  track.raceTime = 0;
  countdown = 3.999;
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

// --- Kart-vs-kart separation ---
function resolveCollisions() {
  for (let i = 0; i < karts.length; i++) {
    for (let j = i + 1; j < karts.length; j++) {
      const a = karts[i];
      const b = karts[j];
      const dx = b.position.x - a.position.x;
      const dz = b.position.z - a.position.z;
      const distSq = dx * dx + dz * dz;
      const min = 4.2;
      if (distSq > 0.0001 && distSq < min * min) {
        const dist = Math.sqrt(distSq);
        const overlap = (min - dist) / 2;
        const nx = dx / dist;
        const nz = dz / dist;
        a.position.x -= nx * overlap;
        a.position.z -= nz * overlap;
        b.position.x += nx * overlap;
        b.position.z += nz * overlap;
        a.speed *= 0.92;
        b.speed *= 0.92;
      }
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

// --- AI shooting ---
function aiShoot(dt) {
  for (const k of karts) {
    if (k.isPlayer || k.finished || k.spinTimer > 0) continue;
    k._aiShootTimer -= dt;
    if (k._aiShootTimer > 0) continue;
    k._aiShootTimer = 2.5 + Math.random() * 4;

    // Fire if someone is just ahead and roughly in front.
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

  if (state === State.COUNTDOWN) {
    countdown -= dt;
    updateCamera(dt, camPos.lengthSq() === 0);
    const n = Math.ceil(countdown - 1);
    hud.showToast(n > 0 ? `${n}` : "GO!");
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
    input.update();
    player.steerInput = input.steer;
    player.throttleInput = input.throttle;
    if (input.consumeJump()) player.jump();
    if (input.consumeShoot() && player.shootCooldown <= 0) {
      hairballs.spawn(player);
      player.shootCooldown = 0.6;
    }

    // AI
    for (const k of karts) if (!k.isPlayer) k.driveAI(track);
    aiShoot(dt);

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
    updateCamera(dt);
  }

  renderer.render(scene, camera);
}

requestAnimationFrame(loop);
