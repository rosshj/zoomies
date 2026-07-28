// Battle arena (phase 4.5): ARCHITECTURE — the Backyard gains real structures
// you can drive UNDER as well as on: a rectangular two-storey PARKADE on
// pillars, a free-standing MEGA-RAMP, and bolder kickers. Plus the feel fix
// that matters most: launches are now computed analytically from the
// heightfield, so you catch air at any frame rate.
//
// The multi-level trick: the kart's ground queries carry the kart's own y
// (kart.position.y IS its current ground height), so heightNear(x, z, y)
// returns the surface NEAREST that y — base terrain under the deck, the deck
// on top of it. Selection is stable mid-hop because position.y stays the
// ground height while kart.y carries the jump. (The Track does the same for
// its crossover strands.)
//
// Design rules that survived playtesting and probes:
//   - Every slope is either DRIVABLE (< ~30°) or a WALL (> ~46°). The
//     steep-wall rule in collide() probes one kart-length ahead and only ever
//     looks UPHILL — so cliffs block you at the foot but every deck edge and
//     lip stays droppable from above.
//   - Launch vy comes from the heightfield's own up-face slope behind the
//     lip, NOT from frame history: at 60fps the wheelbase-averaged groundY
//     starts falling before the kart's centre crosses the lip, so measured
//     climb rates read ~0 on real devices and jumps died. Analytic slope +
//     a minimum pop = air you can feel at any speed and any dt.
//   - Wall pushback exceeds speed*dt (uncapped) and suppresses the launch
//     rule for a beat, or fast karts tunnel/catapult (see phase-3 history).
import * as THREE from "three";

const MESA_H = 5.5;
const MESA_TOP = 20; // plateau radius
const CREEK_R = 66; // creek band centreline radius
const CREEK_HALF = 9; // band half-width
const CREEK_DEPTH = 2.0;
const KICK_H = 3.8; // kicker crest height
const KICK_BACK = 18; // up-face length
const KICK_LIP = 5; // drop-face length
const KICK_HALF = 9; // half-width — wide enough that you hit them on purpose
const LAUNCH_SLOPE = 0.26; // ground falling faster than this grade → airborne
const LAUNCH_BOOST = 1.25; // lip vy multiplier
const LAUNCH_MIN_VY = 5.5; // any real up-face lip gives at least this pop
const AIR_FLOAT = 9; // upward assist while airborne (30 gravity feels like 21)
const WALL_GRADE = 1.05; // ground rising faster than this (≈46°) ahead = wall

// Spiral butte (round structure, high deck).
const BUTTE = { x: -32, z: 30, core: 8.5, band: 15.5, h: 9, entry: -0.6, sweep: 5.24 };
// The Parkade: a rectangular two-storey deck on pillars. Local frame: u runs
// along yaw (the long axis), v across. One straight access ramp continues off
// the +u end; the -u edge is the open drive-off.
const PK = {
  x: 57, z: -46, yaw: -0.85,
  hu: 17, hv: 13, h: 8.2,
  rampL: 24, rampW: 7,
  sin: Math.sin(-0.85), cos: Math.cos(-0.85),
};
// Mega-ramp: a big geometric launch wedge in the open south field, firing you
// into the dune bowl.
const MEGA = {
  x: 30, z: 78, yaw: -1.97, L: 24, W: 5.5, H: 4.6,
  sin: Math.sin(-1.97), cos: Math.cos(-1.97),
};

const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const wrapPi = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

export class Arena {
  constructor({ radius = 140 } = {}) {
    this.isArena = true;
    this.radius = radius;
    this.halfWidth = radius; // kart containment: |lateral| clamps at halfWidth - kart.radius
    this.length = Math.PI * 2 * radius; // nominal arc length for t-space consumers
    this.samples = 128;
    this.totalLaps = 3; // overwritten by main.js like the Track's; unused (t never advances)
    this.raceTime = 0;
    this.features = { runs: [] }; // no tunnels/bridges: camera clamps + glyphs no-op
    this.parkade = PK; // exposed for probes
    this.megaRamp = MEGA;

    // Launch kickers: pos + the yaw they fire you along.
    this.kickers = [
      { x: -82, z: -12, yaw: Math.atan2(82, 12) }, // aimed inward: throws you across the creek
      { x: 44, z: 58, yaw: 2.39 }, // aimed at the cardboard boxes — low enough to clear
      { x: 49, z: -81, yaw: -2.11 }, // tangential, keeps the outer counter-clockwise lap alive
    ];
    for (const k of this.kickers) {
      k.sin = Math.sin(k.yaw);
      k.cos = Math.cos(k.yaw);
    }

    // Boost pads — main.js's applyBoostPads consumes this shape (pads with a
    // `y` only fire at that level: deck pads don't trigger under the deck).
    const pkWorld = (u, v) => ({ x: PK.x + u * PK.sin + v * PK.cos, z: PK.z + u * PK.cos - v * PK.sin });
    const padA = pkWorld(-9, -4), padB = pkWorld(-9, 4);
    this.boostPads = [
      { x: 0, z: 62, r: 4, yaw: Math.PI }, // spawn straight, into the mesa lane climb
      { x: -103.8, z: -15.2, r: 4, yaw: Math.atan2(82, 12) }, // run-up to the creek jump
      { x: 69.6, z: -68.7, r: 4, yaw: -2.11 }, // outer lap, into the tangential kicker
      { x: -42.7, z: 45.7, r: 4, yaw: Math.atan2(32 - 42.7, 30 - 45.7) + Math.PI }, // butte spiral entry
      { x: padA.x, z: padA.z, r: 4, yaw: PK.yaw + Math.PI, y: PK.h }, // parkade runway →
      { x: padB.x, z: padB.z, r: 4, yaw: PK.yaw + Math.PI, y: PK.h }, // → the open deck edge
      { x: 39.2, z: 81.9, r: 4, yaw: MEGA.yaw }, // mega-ramp run-up
    ];

    // Cat-toy obstacles + parkade pillars: {x, z, r (collider), h, kind}.
    this.obstacles = [
      { x: 38, z: -40, r: 3.4, h: 5, kind: "yarn", color: 0xe4607a },
      { x: -66, z: -2, r: 3.4, h: 5, kind: "yarn", color: 0x6fa8dc }, // sitting in the dry creek bed
      { x: 24, z: 54, r: 3.4, h: 5, kind: "yarn", color: 0x93c47d },
      // Scratching-post slalom on the far (north) side.
      { x: 12, z: -52, r: 1.7, h: 9, kind: "post" },
      { x: -2, z: -56, r: 1.7, h: 9, kind: "post" },
      { x: -16, z: -52, r: 1.7, h: 9, kind: "post" },
      { x: -28, z: -44, r: 1.7, h: 9, kind: "post" },
      // Cardboard box cluster east — LOW (2.4): clearable off the kicker aimed at them.
      { x: 74, z: 26, r: 2.9, h: 2.4, kind: "box", yawv: 0.4 },
      { x: 66, z: 36, r: 2.9, h: 2.4, kind: "box", yawv: -0.2 },
      { x: 78, z: 16, r: 2.9, h: 2.4, kind: "box", yawv: 1.1 },
    ];
    // Parkade pillars hold the deck up AND stop you (they're full-height).
    // Pillar tops stop BELOW the deck: a kart driving the deck (abs height
    // 8.2) must clear them, a kart underneath must not.
    for (const [u, v] of [[-11, -8], [-11, 8], [0, -8], [0, 8], [11, -8], [11, 8]]) {
      const p = pkWorld(u, v);
      this.obstacles.push({ x: p.x, z: p.z, r: 1.3, h: 7.4, kind: "pillar" });
    }

    // Fence outline in Track._pts form (minimap + sun-shadow fitting).
    this._pts = [];
    this._tans = [];
    const rimY = this.heightAt(0, radius);
    for (let i = 0; i < this.samples; i++) {
      const a = (i / this.samples) * Math.PI * 2;
      this._pts.push(new THREE.Vector3(Math.sin(a) * radius, rimY, Math.cos(a) * radius));
      this._tans.push(new THREE.Vector3(Math.cos(a), 0, -Math.sin(a)));
    }

    this.group = new THREE.Group();
    this._build();
  }

  // ---- The heightfield (BASE surface: terrain + molded features) -----------
  heightAt(x, z) {
    const R = this.radius;
    const r = Math.hypot(x, z);
    const a = Math.atan2(x, z); // azimuth: 0 at +z (the spawn side)

    // Saucer + banked rim, clamped at the fence.
    let h = 1.8 * (r * r) / (R * R);
    const s = Math.min(1, Math.max(0, (r - R * 0.72) / (R * 0.28)));
    h += 5.5 * s * s;

    // Centre mesa: flat plateau, steep (launchable) skirt, two gentle ramp
    // lanes at the spawn azimuth and its opposite.
    if (r < MESA_TOP + 30) {
      const lane = Math.max(
        1 - smooth01((Math.abs(wrapPi(a)) - 0.3) / 0.25),
        1 - smooth01((Math.abs(wrapPi(a - Math.PI)) - 0.3) / 0.25)
      );
      const skirt = 12 + 14 * lane;
      h += MESA_H * smooth01((MESA_TOP + skirt - r) / skirt);
    }

    // Spiral butte: a 300° helical ramp to the arena's highest deck. Crisper
    // edges than v1 (2.5u side falloff) so it reads built, not molded.
    {
      const dx = x - BUTTE.x, dz = z - BUTTE.z;
      const rho = Math.hypot(dx, dz);
      if (rho < BUTTE.band + 6) {
        const phi = Math.atan2(dx, dz);
        let u = BUTTE.entry - phi;
        while (u < 0) u += Math.PI * 2;
        while (u >= Math.PI * 2) u -= Math.PI * 2;
        const core = BUTTE.h * smooth01((BUTTE.core + 2.5 - rho) / 2.5);
        let ramp = 0;
        if (u <= BUTTE.sweep + 0.35) {
          const p = Math.min(1, u / BUTTE.sweep);
          const lat = smooth01((BUTTE.band + 2.5 - rho) / 2.5);
          const endFade = smooth01((BUTTE.sweep + 0.35 - u) / 0.35);
          ramp = BUTTE.h * (0.08 + 0.92 * p) * lat * endFade;
        }
        h += Math.max(core, ramp);
      }
    }

    // Mega-ramp: a crisp geometric wedge — long climb, hard lip, nothing past
    // it (the drop IS the point).
    {
      const dx = x - MEGA.x, dz = z - MEGA.z;
      const u = dx * MEGA.sin + dz * MEGA.cos;
      if (u >= 0 && u <= MEGA.L) {
        const v = dx * MEGA.cos - dz * MEGA.sin;
        if (Math.abs(v) < MEGA.W + 1.5) {
          const lat = smooth01((MEGA.W + 1.5 - Math.abs(v)) / 1.5); // near-vertical sides = walls
          h += MEGA.H * (u / MEGA.L) * smooth01(u / 4) * lat;
        }
      }
    }

    // Dry creek: a sunken cosine channel arcing the west half.
    if (r > CREEK_R - CREEK_HALF && r < CREEK_R + CREEK_HALF && a < 0) {
      const t = (r - CREEK_R) / CREEK_HALF;
      const w = smooth01((a + 2.6) / 0.35) * smooth01((-0.8 - a) / 0.35);
      h -= CREEK_DEPTH * (0.5 + 0.5 * Math.cos(Math.PI * t)) * w;
    }

    // Mogul meadow: rolling ±1.15u bumps windowed to a north-east wedge.
    if (a > 0.5 && a < 1.8 && r > 46 && r < 100) {
      const w =
        smooth01((a - 0.5) / 0.3) * smooth01((1.8 - a) / 0.3) *
        smooth01((r - 46) / 8) * smooth01((100 - r) / 8);
      h += 1.15 * Math.sin(x * 0.33 + 1.0) * Math.sin(z * 0.33) * w;
    }

    // Dune waves: low concentric washboard ridges in the south-west field.
    if (a > -0.55 && a < -0.12 && r > 42 && r < 95) {
      const w =
        smooth01((a + 0.55) / 0.1) * smooth01((-0.12 - a) / 0.1) *
        smooth01((r - 42) / 8) * smooth01((95 - r) / 8);
      h += 0.8 * (0.5 + 0.5 * Math.sin(r * 0.55)) * w;
    }

    // Kickers: long up-face, curled lip, steep drop.
    for (const k of this.kickers) {
      const dx = x - k.x, dz = z - k.z;
      const u = dx * k.sin + dz * k.cos;
      if (u < -KICK_BACK || u > KICK_LIP) continue;
      const v = dx * k.cos - dz * k.sin;
      if (v < -KICK_HALF || v > KICK_HALF) continue;
      const lat = smooth01((KICK_HALF - Math.abs(v)) / 3);
      const rise = u <= 0
        ? Math.pow(smooth01((u + KICK_BACK) / KICK_BACK), 1.6)
        : 1 - smooth01(u / KICK_LIP);
      h += KICK_H * rise * lat;
    }

    return h;
  }

  // The parkade's elevated surface (deck + access ramp) where one exists.
  _deckSurface(x, z) {
    const dx = x - PK.x, dz = z - PK.z;
    const u = dx * PK.sin + dz * PK.cos;
    const v = dx * PK.cos - dz * PK.sin;
    if (Math.abs(v) <= PK.hv && Math.abs(u) <= PK.hu) return PK.h;
    if (Math.abs(v) <= PK.rampW / 2 && u > PK.hu && u <= PK.hu + PK.rampL) {
      const h = PK.h * (1 - (u - PK.hu) / PK.rampL);
      return h > this.heightAt(x, z) + 0.3 ? h : null; // hand off to grade at the foot
    }
    return null;
  }

  // Multi-level ground query: the surface nearest the caller's own height.
  // kart.position.y IS its current ground height, so a kart under the deck
  // stays on base terrain and a kart on top stays on the deck — stable even
  // mid-hop (jump height lives in kart.y, not position.y).
  heightNear(x, z, y = 0) {
    const base = this.heightAt(x, z);
    const deck = this._deckSurface(x, z);
    if (deck == null) return base;
    return Math.abs(y - deck) < Math.abs(y - base) ? deck : base;
  }

  // Same contract as Track.project, in radial terms: `side` points outward
  // from the arena centre and `lateral` is the centre distance (fence clamp).
  project(pos) {
    const x = pos.x, z = pos.z;
    const r = Math.hypot(x, z);
    const side = r > 1e-4 ? new THREE.Vector3(x / r, 0, z / r) : new THREE.Vector3(1, 0, 0);
    const tangent = new THREE.Vector3(-side.z, 0, side.x);
    const groundY = this.heightNear(x, z, pos.y || 0);
    return {
      t: 0, // constant: no arc coordinate, no laps
      point: new THREE.Vector3(x, groundY, z),
      tangent,
      side,
      lateral: r,
      distance: r,
      groundY,
    };
  }

  groundYNear(x, z, y = 0) {
    return this.heightNear(x, z, y);
  }

  groundInfo(x, z) {
    const r = Math.hypot(x, z);
    return { y: this.heightAt(x, z), dist: Math.max(0, r - this.radius) };
  }

  // Track's is "distance from the road centreline"; the arena's centreline is
  // a point — knocked crates reflect off halfWidth (the fence).
  distanceToCenter(x, z) {
    return Math.hypot(x, z);
  }

  getPointAt(t, target = new THREE.Vector3()) {
    const a = (((t % 1) + 1) % 1) * Math.PI * 2;
    const r = this.radius * 0.5;
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    return target.set(x, this.heightAt(x, z), z);
  }

  getTangentAt(t, target = new THREE.Vector3()) {
    const a = (((t % 1) + 1) % 1) * Math.PI * 2;
    return target.set(Math.cos(a), 0, -Math.sin(a));
  }

  // Power-up box spots for props.js — decks pay for the climb, the creek pays
  // for the exposure. `y` pins a box to an elevated surface.
  itemSpots() {
    return [
      { x: 0, z: -8, mode: "float" }, // mesa plateau (north of the paw)
      { x: -32, z: 30, mode: "float" }, // spiral butte deck — the prize for the climb
      { x: 54, z: -43.4, y: PK.h, mode: "float" }, // parkade deck, on the runway
      { x: -63, z: -25, mode: "float" }, // down in the dry creek bed
      { x: 70, z: 40, mode: "float" }, // mogul meadow
      { x: -45, z: 70, mode: "float" }, // dune field
      { x: -8, z: -54, mode: "float" }, // threaded through the post slalom
      { x: 0, z: -110, mode: "float" }, // far-north outer field
      { x: 40, z: 100, mode: "float" }, // south-east outer field
      { x: -34, z: -34, mode: "float" }, // open west field
      // Promotion pool (plain ground crates; they tumble until they rise).
      { x: 18, z: 30, mode: "ground" },
      { x: -15, z: 60, mode: "ground" },
      { x: 30, z: -70, mode: "ground" },
      { x: -50, z: 40, mode: "ground" },
      { x: 80, z: -20, mode: "ground" },
      { x: 12, z: -80, mode: "ground" },
    ];
  }

  gridSlot(index) {
    const back = 80 + Math.floor(index / 2) * 8;
    const lateral = (index % 2 === 0 ? -1 : 1) * 5;
    const pos = new THREE.Vector3(lateral, 0, back);
    pos.y = this.heightAt(lateral, back);
    return { position: pos, heading: Math.PI }; // forward = (0,-1): toward the mesa
  }

  // ---- Battle physics hooks (called from the main loop after kart.update) --

  collide(k) {
    let hit = false;
    const dt = k._dt || 0.016;
    for (const o of this.obstacles) {
      if (k.position.y + k.y > o.h) continue; // above it (deck level over a pillar's top, or flying)
      const dx = k.position.x - o.x;
      const dz = k.position.z - o.z;
      const rr = o.r + k.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d, nz = dz / d;
      k.position.x = o.x + nx * rr;
      k.position.z = o.z + nz * rr;
      k.speed *= 1 - Math.min(0.4, 1.6 * dt);
      k.knock.multiplyScalar(0.5);
      if (k.drifting) {
        k.drifting = false;
        k.driftCharge = 0;
        k.driftRamp = 0;
      }
      if (Math.abs(k.speed) > 6) {
        k.wallHit = true;
        k.wallHitDir.set(-nx, 0, -nz);
        k.wallHitPulse = 0.12;
      }
      hit = true;
    }

    // Steep-wall rule (uphill-only probe = ledges stay droppable from above).
    if (!k.airborne && k.y <= 0 && Math.abs(k.speed) > 0.5) {
      const dir = k.speed >= 0 ? 1 : -1;
      const fx = Math.sin(k.heading) * dir, fz = Math.cos(k.heading) * dir;
      const hC = this.heightNear(k.position.x, k.position.z, k.position.y);
      const hA = this.heightNear(k.position.x + fx * 1.7, k.position.z + fz * 1.7, k.position.y);
      if (hA - hC > 1.7 * WALL_GRADE) {
        // Push back MORE than this frame's advance (uncapped — big clamped
        // dts advance further than any fixed cap) or fast karts tunnel.
        const back = Math.abs(k.speed) * dt + 0.12;
        k.position.x -= fx * back;
        k.position.z -= fz * back;
        // ...and hold the launch rule off a beat: the pushback lands on lower
        // ground, which would otherwise read as a lip and CATAPULT the kart
        // up the very wall that stopped it.
        k._wallHold = 0.25;
        k.speed *= 1 - Math.min(0.55, 4 * dt);
        if (k.drifting) {
          k.drifting = false;
          k.driftCharge = 0;
          k.driftRamp = 0;
        }
        if (Math.abs(k.speed) > 6) {
          k.wallHit = true;
          k.wallHitDir.set(fx, 0, fz);
          k.wallHitPulse = 0.12;
        }
        hit = true;
      }
    }
    return hit;
  }

  // Crest launches, float assist, and airborne ground-height continuity.
  airTransfer(k, dt) {
    const gy = k.groundY;
    const prevGy = k._agy;
    k._agy = gy;
    // Teleport guard is about the KART moving, not the ground: a respawn jumps
    // metres of XZ in a frame; a deck edge doesn't move you at all.
    const px = k._apx, pz = k._apz;
    k._apx = k.position.x;
    k._apz = k.position.z;
    const moved = px === undefined ? 0 : Math.hypot(k.position.x - px, k.position.z - pz);
    if (k._wallHold > 0) k._wallHold -= dt;
    if (prevGy === undefined) return false;

    // Float assist: arena air hangs — gravity reads ~2/3 while ballistic.
    if (k.airborne && k.y > 0) k.vy += AIR_FLOAT * dt;

    const drop = prevGy - gy; // + when the ground fell away this frame
    if (drop === 0) return false;
    if (moved > 6 || Math.abs(drop) > 12) return false; // teleport — resync only
    if (k.airborne || k.y > 0) {
      // Mid-air: keep WORLD height continuous while the ground moves below.
      k.y += drop;
      if (k.y <= 0) {
        k.y = 0;
        if (k.vy < -2) k._squash = Math.min(1, -k.vy / 14);
        k.vy = 0;
        k.airborne = false;
      }
      return true;
    }
    // Grounded: launch when the surface drops faster than a wheels-down
    // descent could follow. vy comes from the heightfield's OWN up-face slope
    // just behind the lip — frame-rate independent (see file comment) — with
    // a minimum pop so even a slow roll off a kicker visibly jumps.
    if (!(k._wallHold > 0) && drop > Math.max(0.05, Math.abs(k.speed) * dt * LAUNCH_SLOPE)) {
      k.y = drop; // world height continuity at the lip
      const dir = k.speed >= 0 ? 1 : -1;
      const fx = Math.sin(k.heading) * dir, fz = Math.cos(k.heading) * dir;
      const lipY = k.position.y + drop; // the surface we just left
      const h1 = this.heightNear(k.position.x - fx * 2, k.position.z - fz * 2, lipY);
      const h2 = this.heightNear(k.position.x - fx * 6, k.position.z - fz * 6, lipY);
      const slopeUp = (h1 - h2) / 4;
      k.vy = slopeUp > 0.06
        ? Math.min(26, Math.max(LAUNCH_MIN_VY, slopeUp * Math.abs(k.speed) * LAUNCH_BOOST))
        : 0; // pure ledge (deck edge, creek bank): clean ballistic drop
      k.airborne = true;
      return true;
    }
    return false;
  }

  // ---- Visual build --------------------------------------------------------

  _build() {
    this._buildTerrain();
    this._buildFence();
    this._buildToys();
    this._buildPads();
    this._buildStructures();
  }

  _buildTerrain() {
    const R = this.radius;
    const SEG = 200, RINGS = 120;
    const vertCount = 1 + RINGS * SEG;
    const positions = new Float32Array(vertCount * 3);
    const colors = new Float32Array(vertCount * 3);
    const setVert = (i, x, z) => {
      const y = this.heightAt(x, z);
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      const c = this._colorAt(x, z, y);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    };
    setVert(0, 0, 0);
    for (let i = 1; i <= RINGS; i++) {
      const r = (i / RINGS) * R;
      for (let j = 0; j < SEG; j++) {
        const a = (j / SEG) * Math.PI * 2;
        setVert(1 + (i - 1) * SEG + j, Math.sin(a) * r, Math.cos(a) * r);
      }
    }
    const idx = [];
    for (let j = 0; j < SEG; j++) idx.push(0, 1 + j, 1 + ((j + 1) % SEG));
    for (let i = 1; i < RINGS; i++) {
      const a0 = 1 + (i - 1) * SEG;
      const b0 = 1 + i * SEG;
      for (let j = 0; j < SEG; j++) {
        const j1 = (j + 1) % SEG;
        idx.push(a0 + j, b0 + j, b0 + j1, a0 + j, b0 + j1, a0 + j1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 })));
  }

  _colorAt(x, z, h) {
    const R = this.radius;
    const r = Math.hypot(x, z);
    const a = Math.atan2(x, z);
    const c = new THREE.Color(0xd9c08f); // packed sand

    // Mogul meadow: light the crests, shade the dips.
    if (a > 0.5 && a < 1.8 && r > 46 && r < 100) {
      const w =
        smooth01((a - 0.5) / 0.3) * smooth01((1.8 - a) / 0.3) *
        smooth01((r - 46) / 8) * smooth01((100 - r) / 8);
      const bump = Math.sin(x * 0.33 + 1.0) * Math.sin(z * 0.33);
      if (bump > 0) c.lerp(new THREE.Color(0xe4d4a4), bump * w * 0.7);
      else c.lerp(new THREE.Color(0xb9a06b), -bump * w * 0.55);
    }

    // Dune waves: lighter crests.
    if (a > -0.55 && a < -0.12 && r > 42 && r < 95) {
      const w =
        smooth01((a + 0.55) / 0.1) * smooth01((-0.12 - a) / 0.1) *
        smooth01((r - 42) / 8) * smooth01((95 - r) / 8);
      c.lerp(new THREE.Color(0xe4d4a4), (0.5 + 0.5 * Math.sin(r * 0.55)) * w * 0.55);
    }

    // Worn boundary ring + rim edge zone.
    if (Math.abs(r - 100) < 1.6) c.lerp(new THREE.Color(0xefe3c0), 0.55);
    if (r > R * 0.93) c.lerp(new THREE.Color(0xc4795a), smooth01((r - R * 0.93) / (R * 0.05)));

    // Mesa: skirt grades sand → terracotta; plateau wears the paw print.
    if (r < MESA_TOP + 30) {
      const lane = Math.max(
        1 - smooth01((Math.abs(wrapPi(a)) - 0.3) / 0.25),
        1 - smooth01((Math.abs(wrapPi(a - Math.PI)) - 0.3) / 0.25)
      );
      const skirt = 12 + 14 * lane;
      const f = smooth01((MESA_TOP + skirt - r) / skirt);
      if (f > 0) c.lerp(new THREE.Color(0xcf9a63), f * 0.85);
      if (f > 0.96) {
        c.set(0xcf9159);
        const paw = new THREE.Color(0x9a5c32);
        const pex = x / 4.4, pez = (z - 1.2) / 5.2;
        if (pex * pex + pez * pez < 1) c.copy(paw);
        for (const t of [-0.72, -0.26, 0.26, 0.72]) {
          const tx = Math.sin(t) * 8.4, tz = 1.2 + Math.cos(t) * 8.4;
          if ((x - tx) * (x - tx) + (z - tz) * (z - tz) < 2.1 * 2.1) c.copy(paw);
        }
      }
    }

    // Spiral butte: pale stone ramp with an edge stripe; warm top deck.
    {
      const dx = x - BUTTE.x, dz = z - BUTTE.z;
      const rho = Math.hypot(dx, dz);
      if (rho < BUTTE.band + 6) {
        const phi = Math.atan2(dx, dz);
        let u = BUTTE.entry - phi;
        while (u < 0) u += Math.PI * 2;
        while (u >= Math.PI * 2) u -= Math.PI * 2;
        if (rho < BUTTE.core + 2) c.lerp(new THREE.Color(0xb97a4a), smooth01((BUTTE.core + 2 - rho) / 2));
        else if (u <= BUTTE.sweep && rho < BUTTE.band + 2.5) {
          const lat = smooth01((BUTTE.band + 2.5 - rho) / 2.5);
          c.lerp(new THREE.Color(0xe0cfa8), lat * 0.85);
          if (rho > BUTTE.band - 1.2 && rho < BUTTE.band + 1.2) c.lerp(new THREE.Color(0xc4795a), 0.6);
        }
      }
    }

    // Under the parkade: shaded ground so the deck reads as OVERHEAD.
    {
      const dx = x - PK.x, dz = z - PK.z;
      const u = dx * PK.sin + dz * PK.cos;
      const v = dx * PK.cos - dz * PK.sin;
      if (Math.abs(u) < PK.hu + 1 && Math.abs(v) < PK.hv + 1) c.lerp(new THREE.Color(0x8f7f66), 0.5);
    }

    // Mega-ramp: concrete face, mint chevrons marching up, red lip.
    {
      const dx = x - MEGA.x, dz = z - MEGA.z;
      const u = dx * MEGA.sin + dz * MEGA.cos;
      const v = dx * MEGA.cos - dz * MEGA.sin;
      if (u >= 0 && u <= MEGA.L && Math.abs(v) < MEGA.W + 1.5) {
        c.lerp(new THREE.Color(0xc9c4b8), 0.9);
        const chev = ((u - Math.abs(v) * 0.7) % 7 + 7) % 7;
        if (chev < 1.8 && u > 3) c.lerp(new THREE.Color(0x39e6a0), 0.85);
        if (u > MEGA.L - 1.6) c.lerp(new THREE.Color(0xc4795a), 0.9);
      }
    }

    // Creek bed: darker, damper sand by depth.
    if (r > CREEK_R - CREEK_HALF && r < CREEK_R + CREEK_HALF && a < 0) {
      const t = (r - CREEK_R) / CREEK_HALF;
      const w = smooth01((a + 2.6) / 0.35) * smooth01((-0.8 - a) / 0.35);
      c.lerp(new THREE.Color(0x9b8560), (0.5 + 0.5 * Math.cos(Math.PI * t)) * w);
    }

    // Kickers: cream up-face, red lip band.
    for (const k of this.kickers) {
      const dx = x - k.x, dz = z - k.z;
      const u = dx * k.sin + dz * k.cos;
      if (u < -KICK_BACK || u > KICK_LIP) continue;
      const v = dx * k.cos - dz * k.sin;
      if (Math.abs(v) > KICK_HALF) continue;
      const lat = smooth01((KICK_HALF - Math.abs(v)) / 3);
      if (u <= 0) c.lerp(new THREE.Color(0xefe3c0), Math.pow(smooth01((u + KICK_BACK) / KICK_BACK), 1.6) * lat * 0.85);
      else c.lerp(new THREE.Color(0xc4795a), lat * 0.9);
    }

    return c;
  }

  _buildFence() {
    const R = this.radius;
    const rimY = this.heightAt(0, R);
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(R + 0.35, R + 0.35, 3.9, 128, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x9a6a45, roughness: 0.9, side: THREE.DoubleSide })
    );
    wall.position.y = rimY + 1.45;
    this.group.add(wall);

    const rail = new THREE.Mesh(
      new THREE.TorusGeometry(R + 0.35, 0.3, 10, 128),
      new THREE.MeshStandardMaterial({ color: 0xefe3c0, roughness: 0.8 })
    );
    rail.rotation.x = Math.PI / 2;
    rail.position.y = rimY + 3.4;
    this.group.add(rail);

    const POSTS = 36;
    const postGeo = new THREE.CylinderGeometry(0.42, 0.5, 4.4, 8);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x7c5236, roughness: 0.95 });
    const posts = new THREE.InstancedMesh(postGeo, postMat, POSTS);
    const m = new THREE.Matrix4();
    for (let i = 0; i < POSTS; i++) {
      const a = (i / POSTS) * Math.PI * 2;
      m.makeTranslation(Math.sin(a) * (R + 0.35), rimY + 1.7, Math.cos(a) * (R + 0.35));
      posts.setMatrixAt(i, m);
    }
    this.group.add(posts);

    const apron = new THREE.Mesh(
      new THREE.RingGeometry(R + 0.7, 1400, 128, 1),
      new THREE.MeshStandardMaterial({ color: 0x6fae5a, roughness: 1 })
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = rimY - 0.35;
    this.group.add(apron);
  }

  _buildToys() {
    for (const o of this.obstacles) {
      const gy = this.heightAt(o.x, o.z);
      if (o.kind === "yarn") {
        const g = new THREE.Group();
        const ball = new THREE.Mesh(
          new THREE.SphereGeometry(3.0, 20, 14),
          new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.85 })
        );
        const band = new THREE.Mesh(
          new THREE.TorusGeometry(3.0, 0.4, 8, 20),
          new THREE.MeshStandardMaterial({
            color: new THREE.Color(o.color).multiplyScalar(0.7),
            roughness: 0.85,
          })
        );
        band.rotation.x = Math.PI / 2.6;
        const band2 = band.clone();
        band2.rotation.y = 1.1;
        g.add(ball, band, band2);
        g.position.set(o.x, gy + 2.4, o.z);
        g.rotation.y = (o.x * 13.7 + o.z * 7.1) % Math.PI;
        this.group.add(g);
      } else if (o.kind === "post") {
        const g = new THREE.Group();
        const pole = new THREE.Mesh(
          new THREE.CylinderGeometry(1.15, 1.25, 7.5, 12),
          new THREE.MeshStandardMaterial({ color: 0xc9a96e, roughness: 0.95 })
        );
        pole.position.y = 3.75;
        g.add(pole);
        const wrapMat = new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.95 });
        for (const y of [1.6, 3.4, 5.2]) {
          const wrap = new THREE.Mesh(new THREE.TorusGeometry(1.18, 0.22, 6, 16), wrapMat);
          wrap.rotation.x = Math.PI / 2;
          wrap.position.y = y;
          g.add(wrap);
        }
        const cap = new THREE.Mesh(
          new THREE.CylinderGeometry(1.7, 1.7, 0.5, 12),
          new THREE.MeshStandardMaterial({ color: 0x9a6a45, roughness: 0.9 })
        );
        cap.position.y = 7.7;
        g.add(cap);
        g.position.set(o.x, gy, o.z);
        this.group.add(g);
      } else if (o.kind === "box") {
        const g = new THREE.Group();
        const box = new THREE.Mesh(
          new THREE.BoxGeometry(4.6, 2.4, 4.6),
          new THREE.MeshStandardMaterial({ color: 0xb8905f, roughness: 1 })
        );
        box.position.y = 1.2;
        const tape = new THREE.Mesh(
          new THREE.BoxGeometry(0.9, 0.06, 4.7),
          new THREE.MeshStandardMaterial({ color: 0x8f6b43, roughness: 1 })
        );
        tape.position.y = 2.42;
        g.add(box, tape);
        g.position.set(o.x, gy, o.z);
        g.rotation.y = o.yawv || 0;
        this.group.add(g);
      }
      // "pillar" visuals are built with the parkade in _buildStructures.
    }
  }

  _buildPads() {
    const mat = new THREE.MeshStandardMaterial({ color: 0x39e6a0, roughness: 0.6 });
    const matPale = new THREE.MeshStandardMaterial({ color: 0xbef2dc, roughness: 0.6 });
    const armGeo = new THREE.PlaneGeometry(3.0, 1.1).rotateX(-Math.PI / 2);
    for (const p of this.boostPads) {
      const g = new THREE.Group();
      for (let i = 0; i < 3; i++) {
        for (const side of [-1, 1]) {
          const arm = new THREE.Mesh(armGeo, i === 1 ? matPale : mat);
          arm.rotation.y = side * 0.62;
          arm.position.set(side * 1.2, 0, -2.2 + i * 2.2);
          g.add(arm);
        }
      }
      g.position.set(p.x, (p.y != null ? p.y : this.heightAt(p.x, p.z)) + 0.09, p.z);
      g.rotation.y = p.yaw;
      this.group.add(g);
    }
  }

  // The built things: parkade (slab, ramp, pillars, paint) + butte supports.
  _buildStructures() {
    const concrete = new THREE.MeshStandardMaterial({ color: 0xb9b4a8, roughness: 0.95 });
    const concreteDark = new THREE.MeshStandardMaterial({ color: 0x9a958a, roughness: 0.95 });
    const cream = new THREE.MeshStandardMaterial({ color: 0xefe3c0, roughness: 0.8 });
    const hazard = new THREE.MeshStandardMaterial({ color: 0xc4795a, roughness: 0.8 });
    const mint = new THREE.MeshStandardMaterial({ color: 0x39e6a0, roughness: 0.6 });

    // Parkade group in its local frame (+z = local u, +x = local v).
    const pk = new THREE.Group();
    pk.position.set(PK.x, 0, PK.z);
    pk.rotation.y = PK.yaw;

    const slab = new THREE.Mesh(new THREE.BoxGeometry(PK.hv * 2, 1, PK.hu * 2), concrete);
    slab.position.y = PK.h - 0.5;
    pk.add(slab);

    // Parking stripes on the deck + a hazard band along the open (-u) edge.
    for (const zu of [-10, -5, 0, 5, 10]) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(8, 0.06, 0.35), cream);
      stripe.position.set(4.5, PK.h + 0.03, zu);
      pk.add(stripe);
    }
    const edge = new THREE.Mesh(new THREE.BoxGeometry(PK.hv * 2, 0.07, 1.0), hazard);
    edge.position.set(0, PK.h + 0.03, -PK.hu + 0.5);
    pk.add(edge);

    // Pillars (visuals for the colliders registered in the constructor).
    const pillarGeo = new THREE.CylinderGeometry(0.9, 1.0, PK.h - 0.9, 10);
    for (const [u, v] of [[-11, -8], [-11, 8], [0, -8], [0, 8], [11, -8], [11, 8]]) {
      const pillar = new THREE.Mesh(pillarGeo, concreteDark);
      pillar.position.set(v, (PK.h - 0.9) / 2, u);
      pk.add(pillar);
    }

    // Access ramp: one molded prism from deck lip to grade.
    {
      const w = PK.rampW / 2;
      const y0 = 0.15, u0 = PK.hu, u1 = PK.hu + PK.rampL;
      const pos = new Float32Array([
        // top surface
        -w, PK.h, u0,  w, PK.h, u0,  w, y0, u1,
        -w, PK.h, u0,  w, y0, u1,  -w, y0, u1,
        // left skirt
        -w, PK.h, u0,  -w, y0, u1,  -w, 0, u0,
        // right skirt
        w, PK.h, u0,  w, 0, u0,  w, y0, u1,
      ]);
      const rampGeo = new THREE.BufferGeometry();
      rampGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      rampGeo.computeVertexNormals();
      const ramp = new THREE.Mesh(rampGeo, new THREE.MeshStandardMaterial({ color: 0xb9b4a8, roughness: 0.95, side: THREE.DoubleSide }));
      pk.add(ramp);
      // Mint chevron strips up the ramp face.
      const slope = Math.atan2(PK.h - y0, PK.rampL);
      for (let i = 1; i <= 3; i++) {
        const t = i / 4;
        const strip = new THREE.Mesh(new THREE.BoxGeometry(PK.rampW - 1, 0.06, 1.1), mint);
        strip.position.set(0, PK.h + (y0 - PK.h) * t + 0.06, u0 + PK.rampL * t);
        strip.rotation.x = slope;
        pk.add(strip);
      }
    }
    this.group.add(pk);

    // Butte supports: stubby stone columns under the helical band, so the
    // spiral reads as a built ramp rather than molded ground.
    for (const p of [0.35, 0.6, 0.85]) {
      const u = BUTTE.sweep * p;
      const phi = BUTTE.entry - u;
      const rho = 12;
      const x = BUTTE.x + Math.sin(phi) * rho, z = BUTTE.z + Math.cos(phi) * rho;
      const top = BUTTE.h * (0.08 + 0.92 * p) - 0.4;
      if (top < 1) continue;
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.0, top, 10), concreteDark);
      col.position.set(x, top / 2, z);
      this.group.add(col);
    }
  }
}
