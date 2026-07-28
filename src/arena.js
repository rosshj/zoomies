// Battle arena (phase 3): "The Backyard" grows verticality — a spiral butte,
// a raised platform with a boost-pad runway into an edge jump, boost pads,
// and air you actually feel. Still one analytic heightfield feeding both the
// physics probes and the terrain mesh, so wheels always sit on what's drawn,
// and `Kart` still runs unchanged.
//
// The three phase-2 engine pieces, upgraded:
//   - heightAt(x, z): now holds cliffs, a helical ramp and plateaus. Design
//     rule: every surface is either DRIVABLE (< ~30°) or a WALL (> ~46°,
//     blocked by the steep-wall rule below) — nothing in between, so there is
//     no slope you can tediously crawl up.
//   - collide(kart): circle colliders for the toys PLUS the steep-wall rule:
//     a probe one kart-length ahead samples the ground; rising faster than
//     ~46° reads as a wall (push-back, scrub, sparks). It only ever looks
//     UPHILL, so ledges stay droppable from above — the cliff blocks you at
//     its foot, never at its lip.
//   - airTransfer(kart, dt): crest launches got a punch-up (vy boost at the
//     lip) and airborne karts get an upward float assist — arena gravity
//     feels ~2/3 of track gravity, so a kicker is a genuine flight, not a
//     hop. Ground-height continuity for airborne karts as before.
//
// The map (radius 140, spawn at azimuth 0 / +z, facing the centre):
//   - CENTRE MESA (h 5.5): paw-print plateau, two gentle ramp lanes, steep
//     launchable skirt everywhere else.
//   - SPIRAL BUTTE (h 9, SW of the mesa): a 300° helical ramp winds up to
//     the highest deck in the arena; the last 60° is a sheer cliff — drop
//     off it, or get walled at its foot.
//   - PATIO PLATFORM (h 4.2, NE): a stone deck with a two-pad boost runway
//     firing you off an edge kicker, out over the box cluster.
//   - DRY CREEK (west), MOGUL MEADOW (NE), DUNE WAVES (SW): ground rhythm.
//   - KICKERS with curled ski-jump lips; BOOST PADS (the racing pad logic in
//     main.js consumes track.boostPads — the arena just supplies them).
//   - CAT TOYS (yarn balls / scratching-post slalom / cardboard boxes) as
//     circle colliders inside the banked rim + fence.
import * as THREE from "three";

const MESA_H = 5.5;
const MESA_TOP = 20; // plateau radius
const CREEK_R = 66; // creek band centreline radius
const CREEK_HALF = 9; // band half-width
const CREEK_DEPTH = 2.0;
const KICK_H = 3.4; // kicker crest height
const KICK_BACK = 18; // up-face length
const KICK_LIP = 5; // drop-face length
const LAUNCH_SLOPE = 0.26; // ground falling faster than this grade → airborne
const LAUNCH_BOOST = 1.25; // lip vy multiplier — launches read as jumps, not stumbles
const AIR_FLOAT = 9; // upward assist while airborne (30 gravity feels like 21)
const WALL_GRADE = 1.05; // ground rising faster than this (≈46°) ahead = wall

// Spiral butte.
const BUTTE = { x: -32, z: 30, core: 8.5, band: 15.5, h: 9, entry: -0.6, sweep: 5.24 };
// Patio platform.
const PATIO = { x: 55, z: -48, top: 17, h: 4.2 };

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

    // Launch kickers: pos + the yaw they fire you along. Each one has a job.
    this.kickers = [
      { x: -82, z: -12, yaw: Math.atan2(82, 12) }, // aimed inward: throws you across the creek
      { x: 44, z: 58, yaw: 2.39 }, // aimed at the cardboard boxes — low enough to clear
      { x: 49, z: -81, yaw: -2.11 }, // tangential, keeps the outer counter-clockwise lap alive
      { x: 57.2, z: -33.2, yaw: 0.148 }, // the patio edge jump: pads → lip → over the boxes
    ];
    for (const k of this.kickers) {
      k.sin = Math.sin(k.yaw);
      k.cos = Math.cos(k.yaw);
    }

    // Boost pads — main.js's applyBoostPads already consumes this shape.
    // Placed to set up a jump or a climb, not as random candy.
    this.boostPads = [
      { x: 0, z: 62, r: 4, yaw: Math.PI }, // spawn straight, into the mesa lane climb
      { x: -103.8, z: -15.2, r: 4, yaw: Math.atan2(82, 12) }, // run-up to the creek jump
      { x: 69.6, z: -68.7, r: 4, yaw: -2.11 }, // outer lap, into the tangential kicker
      { x: -42.7, z: 45.7, r: 4, yaw: Math.atan2(32 - 42.7, 30 - 45.7) + Math.PI }, // butte spiral entry
      { x: 52, z: -62, r: 4, yaw: 0.148 }, // patio runway pad 1
      { x: 54.5, z: -48, r: 4, yaw: 0.148 }, // patio runway pad 2
    ];

    // Cat-toy obstacles: {x, z, r (collider), h (clearable-over height), kind}.
    this.obstacles = [
      { x: 38, z: -40, r: 3.4, h: 5, kind: "yarn", color: 0xe4607a },
      { x: -66, z: -2, r: 3.4, h: 5, kind: "yarn", color: 0x6fa8dc }, // sitting in the dry creek bed
      { x: 24, z: 54, r: 3.4, h: 5, kind: "yarn", color: 0x93c47d },
      // Scratching-post slalom on the far (north) side.
      { x: 12, z: -52, r: 1.7, h: 9, kind: "post" },
      { x: -2, z: -56, r: 1.7, h: 9, kind: "post" },
      { x: -16, z: -52, r: 1.7, h: 9, kind: "post" },
      { x: -28, z: -44, r: 1.7, h: 9, kind: "post" },
      // Cardboard box cluster east — LOW (2.4): clearable off the kickers aimed at them.
      { x: 74, z: 26, r: 2.9, h: 2.4, kind: "box", yawv: 0.4 },
      { x: 66, z: 36, r: 2.9, h: 2.4, kind: "box", yawv: -0.2 },
      { x: 78, z: 16, r: 2.9, h: 2.4, kind: "box", yawv: 1.1 },
    ];

    // Fence outline in Track._pts form: the minimap draws it as the map bounds
    // and fitSunShadow fits the light frustum around it.
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

  // ---- The heightfield -----------------------------------------------------
  // The single source of truth: physics probes, the terrain mesh, prop
  // placement and the camera clamp all sample this one function.
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

    // Spiral butte: a 300° helical ramp climbing to the arena's highest deck.
    // Ramp grade ≈ 8°; the core wall and the 60° gap sector are sheer (the
    // steep-wall rule turns them into real walls from below, and the gap lip
    // is the drop-off from above).
    {
      const dx = x - BUTTE.x, dz = z - BUTTE.z;
      const rho = Math.hypot(dx, dz);
      if (rho < BUTTE.band + 6) {
        const phi = Math.atan2(dx, dz);
        let u = BUTTE.entry - phi;
        while (u < 0) u += Math.PI * 2;
        while (u >= Math.PI * 2) u -= Math.PI * 2;
        // Core deck (flat top) rises over a sheer 2.5u wall...
        const core = BUTTE.h * smooth01((BUTTE.core + 2.5 - rho) / 2.5);
        // ...and the ramp band wraps it, fading to grade over a 4.5u outer
        // skirt. Past the 300° sweep the ramp sheers off over 0.35 rad — a
        // sub-guard-height-per-frame LEDGE, so driving off the end launches
        // ballistic instead of reading as a teleport snap.
        let ramp = 0;
        if (u <= BUTTE.sweep + 0.35) {
          const p = Math.min(1, u / BUTTE.sweep);
          const lat = smooth01((BUTTE.band + 4.5 - rho) / 4.5);
          const endFade = smooth01((BUTTE.sweep + 0.35 - u) / 0.35);
          ramp = BUTTE.h * (0.08 + 0.92 * p) * lat * endFade; // starts 0.7u proud so the entry reads
        }
        h += Math.max(core, ramp);
      }
    }

    // Patio platform: a stone deck with one drivable lane facing the arena
    // centre; the rest of the skirt is steep. The runway pads + edge kicker
    // live on top.
    {
      const dx = x - PATIO.x, dz = z - PATIO.z;
      const rho = Math.hypot(dx, dz);
      if (rho < PATIO.top + 22) {
        const toCentre = Math.atan2(-PATIO.x, -PATIO.z);
        const local = Math.abs(wrapPi(Math.atan2(dx, dz) - toCentre));
        const lane = 1 - smooth01((local - 0.45) / 0.3);
        const skirt = 8 + 12 * lane; // 28° cliffish → 12° lane
        h += PATIO.h * smooth01((PATIO.top + skirt - rho) / skirt);
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

    // Kickers: long gentle up-face with a CURLED lip (power curve steepens
    // the last metres to ~24°), then a steep drop — the launch moment.
    for (const k of this.kickers) {
      const dx = x - k.x, dz = z - k.z;
      const u = dx * k.sin + dz * k.cos; // along the launch direction
      if (u < -KICK_BACK || u > KICK_LIP) continue;
      const v = dx * k.cos - dz * k.sin; // across
      if (v < -6 || v > 6) continue;
      const lat = smooth01((6 - Math.abs(v)) / 2.5);
      const rise = u <= 0
        ? Math.pow(smooth01((u + KICK_BACK) / KICK_BACK), 1.6)
        : 1 - smooth01(u / KICK_LIP);
      h += KICK_H * rise * lat;
    }

    return h;
  }

  // Same contract as Track.project, in radial terms: `side` points outward
  // from the arena centre and `lateral` is the centre distance, so the kart's
  // wall clamp holds it inside the fence and shoves radially on a scrape.
  project(pos) {
    const x = pos.x, z = pos.z;
    const r = Math.hypot(x, z);
    const side = r > 1e-4 ? new THREE.Vector3(x / r, 0, z / r) : new THREE.Vector3(1, 0, 0);
    const tangent = new THREE.Vector3(-side.z, 0, side.x);
    const groundY = this.heightAt(x, z);
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

  groundYNear(x, z) {
    return this.heightAt(x, z);
  }

  // Scenery-style sampler: y = ground height, dist = how far OUTSIDE the play
  // area (0 anywhere in the bowl), mirroring "distance from the road corridor".
  groundInfo(x, z) {
    const r = Math.hypot(x, z);
    return { y: this.heightAt(x, z), dist: Math.max(0, r - this.radius) };
  }

  // A circle at mid-floor stands in for the centreline: the menu orbit
  // anchors sweep it, and any t-space consumer gets sensible world points.
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

  // Start cluster on the spawn side, facing the mesa — rows-of-2 like the
  // Track grid, on the flat ground short of the rim bank.
  gridSlot(index) {
    const back = 80 + Math.floor(index / 2) * 8;
    const lateral = (index % 2 === 0 ? -1 : 1) * 5;
    const pos = new THREE.Vector3(lateral, 0, back);
    pos.y = this.heightAt(lateral, back);
    return { position: pos, heading: Math.PI }; // forward = (0,-1): toward the mesa
  }

  // ---- Battle physics hooks (called from the main loop after kart.update) --

  // Obstacle circles + the steep-wall rule. Returns true when it moved the
  // kart (caller re-syncs the mesh).
  collide(k) {
    let hit = false;
    const dt = k._dt || 0.016;
    for (const o of this.obstacles) {
      if (k.y > o.h) continue; // flying clean over it
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

    // Steep-wall rule: sample the ground one kart-length ahead (in the travel
    // direction); rising steeper than ~46° means cliff face, not hill — hold
    // the kart off it like a wall. Looking only UPHILL is what keeps every
    // ledge droppable from above.
    if (!k.airborne && k.y <= 0 && Math.abs(k.speed) > 0.5) {
      const dir = k.speed >= 0 ? 1 : -1;
      const fx = Math.sin(k.heading) * dir, fz = Math.cos(k.heading) * dir;
      const hC = this.heightAt(k.position.x, k.position.z);
      const hA = this.heightAt(k.position.x + fx * 1.7, k.position.z + fz * 1.7);
      if (hA - hC > 1.7 * WALL_GRADE) {
        // Push back MORE than this frame's advance, or a fast kart forces
        // through the wall band frame by frame and crests the cliff. No cap:
        // at big clamped dts (slow devices) the advance itself exceeds any
        // fixed cap, and the pushback must always win.
        const back = Math.abs(k.speed) * dt + 0.12;
        // ...and hold the launch rule off for a beat: the pushback lands on
        // lower ground, which would otherwise read as "ground fell away" and
        // CATAPULT the kart up the very wall that stopped it (vy comes from
        // the wall's own climbing slope).
        k._wallHold = 0.25;
        k.position.x -= fx * back;
        k.position.z -= fz * back;
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
  // Returns true when it changed the kart (caller re-syncs the mesh).
  airTransfer(k, dt) {
    const gy = k.groundY;
    const prevGy = k._agy;
    const prevPrevGy = k._agy2;
    k._agy2 = prevGy;
    k._agy = gy;
    if (k._wallHold > 0) k._wallHold -= dt;
    if (prevGy === undefined) return false;

    // Float assist: arena air hangs — gravity reads ~2/3 while ballistic.
    if (k.airborne && k.y > 0) k.vy += AIR_FLOAT * dt;

    const drop = prevGy - gy; // + when the ground fell away this frame
    if (drop === 0) return false;
    if (Math.abs(drop) > 4.5) return false; // teleport (respawn/probe) — resync only
    if (k.airborne || k.y > 0) {
      // Mid-air: keep WORLD height continuous while the ground moves below.
      k.y += drop;
      if (k.y <= 0) {
        // Rising ground caught us: land.
        k.y = 0;
        if (k.vy < -2) k._squash = Math.min(1, -k.vy / 14);
        k.vy = 0;
        k.airborne = false;
      }
      return true;
    }
    // Grounded: launch when the surface drops faster than a wheels-down
    // descent could follow — unless a wall pushback just moved us (that drop
    // is the pushback itself, not a lip). vy carries the MEASURED ground-climb
    // rate of the frame before the lip (dt-robust where the smoothed
    // slopePitch straddles the crest), punched up so a lip reads as a jump.
    if (!(k._wallHold > 0) && drop > Math.max(0.05, Math.abs(k.speed) * dt * LAUNCH_SLOPE)) {
      k.y = drop; // world height continuity at the lip
      const climbRate = prevPrevGy !== undefined ? (prevGy - prevPrevGy) / Math.max(dt, 0.001) : 0;
      k.vy = Math.max(-18, Math.min(26, climbRate * LAUNCH_BOOST));
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
  }

  // Terrain: a polar grid displaced by heightAt (the SAME function physics
  // reads), vertex-coloured by feature so the map reads at a glance.
  _buildTerrain() {
    const R = this.radius;
    const SEG = 200, RINGS = 120; // dense enough for the butte wall + kicker lips
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
    for (let j = 0; j < SEG; j++) idx.push(0, 1 + j, 1 + ((j + 1) % SEG)); // centre fan
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

  // Per-vertex ground paint. Priorities: kicker faces > butte/patio decks >
  // creek bed > mesa > mogul/dune shading > boundary ring > rim zone > sand.
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

    // Dune waves: lighter crests over the south-west washboard.
    if (a > -0.55 && a < -0.12 && r > 42 && r < 95) {
      const w =
        smooth01((a + 0.55) / 0.1) * smooth01((-0.12 - a) / 0.1) *
        smooth01((r - 42) / 8) * smooth01((95 - r) / 8);
      c.lerp(new THREE.Color(0xe4d4a4), (0.5 + 0.5 * Math.sin(r * 0.55)) * w * 0.55);
    }

    // Worn boundary ring at r=100 + rim edge zone.
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
        else if (u <= BUTTE.sweep && rho < BUTTE.band + 4.5) {
          const lat = smooth01((BUTTE.band + 4.5 - rho) / 4.5);
          c.lerp(new THREE.Color(0xe0cfa8), lat * 0.85);
          if (rho > BUTTE.band - 1.2 && rho < BUTTE.band + 1.2) c.lerp(new THREE.Color(0xc4795a), 0.6);
        }
      }
    }

    // Patio platform: cool stone deck with a cream edge ring.
    {
      const dx = x - PATIO.x, dz = z - PATIO.z;
      const rho = Math.hypot(dx, dz);
      if (rho < PATIO.top + 22) {
        const toCentre = Math.atan2(-PATIO.x, -PATIO.z);
        const local = Math.abs(wrapPi(Math.atan2(dx, dz) - toCentre));
        const lane = 1 - smooth01((local - 0.45) / 0.3);
        const skirt = 8 + 12 * lane;
        const f = smooth01((PATIO.top + skirt - rho) / skirt);
        if (f > 0.96) {
          c.set(0xcfc3ae);
          if (rho > PATIO.top - 3.4) c.lerp(new THREE.Color(0xefe3c0), 0.7);
        } else if (f > 0) {
          c.lerp(new THREE.Color(0xbfae94), f * 0.8);
        }
      }
    }

    // Creek bed: darker, damper sand by depth.
    if (r > CREEK_R - CREEK_HALF && r < CREEK_R + CREEK_HALF && a < 0) {
      const t = (r - CREEK_R) / CREEK_HALF;
      const w = smooth01((a + 2.6) / 0.35) * smooth01((-0.8 - a) / 0.35);
      c.lerp(new THREE.Color(0x9b8560), (0.5 + 0.5 * Math.cos(Math.PI * t)) * w);
    }

    // Kickers: cream up-face so they read as "hit me", red lip band.
    for (const k of this.kickers) {
      const dx = x - k.x, dz = z - k.z;
      const u = dx * k.sin + dz * k.cos;
      if (u < -KICK_BACK || u > KICK_LIP) continue;
      const v = dx * k.cos - dz * k.sin;
      if (Math.abs(v) > 6) continue;
      const lat = smooth01((6 - Math.abs(v)) / 2.5);
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
    wall.position.y = rimY + 1.45; // 0.5u buried
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

    // Apron: flat meadow from just outside the fence to past the fog.
    const apron = new THREE.Mesh(
      new THREE.RingGeometry(R + 0.7, 1400, 128, 1),
      new THREE.MeshStandardMaterial({ color: 0x6fae5a, roughness: 1 })
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = rimY - 0.35;
    this.group.add(apron);
  }

  // The cat toys. Discrete props (like trees), not molded curved surfaces —
  // primitives are fine.
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
    }
  }

  // Boost pads: mint chevron decals laid on the ground, pointing along the
  // pad's launch direction (the gameplay logic lives in main.js's
  // applyBoostPads, which already consumes track.boostPads).
  _buildPads() {
    const mat = new THREE.MeshStandardMaterial({ color: 0x39e6a0, roughness: 0.6 });
    const matPale = new THREE.MeshStandardMaterial({ color: 0xbef2dc, roughness: 0.6 });
    const armGeo = new THREE.PlaneGeometry(3.0, 1.1).rotateX(-Math.PI / 2); // flat, long axis X
    for (const p of this.boostPads) {
      const g = new THREE.Group();
      for (let i = 0; i < 3; i++) {
        for (const side of [-1, 1]) {
          const arm = new THREE.Mesh(armGeo, i === 1 ? matPale : mat);
          arm.rotation.y = side * 0.62; // the two arms angle to a ">" point
          arm.position.set(side * 1.2, 0, -2.2 + i * 2.2 + Math.abs(side) * 0);
          g.add(arm);
        }
      }
      g.position.set(p.x, this.heightAt(p.x, p.z) + 0.09, p.z);
      g.rotation.y = p.yaw; // chevrons march along the launch direction
      this.group.add(g);
    }
  }
}
