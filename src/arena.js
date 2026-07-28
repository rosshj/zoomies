// Battle arena (phase 2): "The Backyard" — a big open battle map with real
// terrain, obstacles and jumps, still answering the same three geometric
// questions the Track answered (containment + ground height under the wheels),
// so `Kart` runs unchanged.
//
// What phase 2 adds over the bowl:
//   - heightAt(x, z): a full 2D analytic heightfield (the radial profile
//     couldn't hold a ramp or a hill). ONE function feeds both the physics
//     probes and the terrain mesh, so wheels always sit on what's rendered.
//   - collide(kart): static circle colliders for the obstacles — the first
//     hard obstacle collision in the game (track barriers aside). Mirrors the
//     wall-scrape feel: radial push-out, speed scrub, spark latch, drift kill.
//   - airTransfer(kart, dt): crest-launch physics. The kart is normally glued
//     to the ground (position.y = groundY every frame); when the ground falls
//     away faster than a wheels-down descent could follow, convert the motion
//     to ballistic (kart.y/vy) with the vertical speed it carried up the
//     slope — so kickers and mesa edges give real air instead of a snap-down.
//     It also keeps an airborne kart's WORLD height continuous while the
//     ground moves underneath it (kart.y is ground-relative), which the glued
//     racing tracks never needed.
//
// The map (radius 140, spawn at azimuth 0 / +z, facing the centre):
//   - CENTRE MESA: a flat-topped hill (h 5.5) wearing a painted paw print.
//     Two gentle ramp lanes (the spawn side and its opposite) are the fast
//     ways up; everywhere else the skirt is steep — climbable but slow, and a
//     genuine launch ramp on the way DOWN.
//   - DRY CREEK: a sunken arc across the west half — drive it, or clear it
//     off the kicker aimed over it.
//   - MOGUL MEADOW: a field of rolling bumps in the north-east.
//   - KICKERS: cream-painted launch bumps (gentle up-face, steep drop) — hit
//     one at speed and airTransfer does the rest.
//   - CAT TOYS: giant yarn balls, a scratching-post slalom, and a cardboard
//     box cluster (low enough to clear off a kicker) — all circle colliders.
//   - The banked rim + fence from phase 1, scaled up.
import * as THREE from "three";

const MESA_H = 5.5;
const MESA_TOP = 20; // plateau radius
const CREEK_R = 66; // creek band centreline radius
const CREEK_HALF = 9; // band half-width
const CREEK_DEPTH = 2.0;
const KICK_H = 2.6; // kicker crest height
const LAUNCH_SLOPE = 0.3; // ground falling faster than this grade → airborne

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

    // Launch kickers: pos + the yaw they fire you along. Each one has a job:
    // clear the creek, clear the box cluster, or keep a fast outer lap alive.
    this.kickers = [
      { x: -82, z: -12, yaw: Math.atan2(82, 12) }, // aimed inward: throws you across the creek
      { x: 44, z: 58, yaw: 2.39 }, // aimed at the cardboard boxes — they're low enough to clear
      { x: 49, z: -81, yaw: -2.11 }, // tangential, on the outer counter-clockwise line
    ];
    for (const k of this.kickers) {
      k.sin = Math.sin(k.yaw);
      k.cos = Math.cos(k.yaw);
    }

    // Cat-toy obstacles: {x, z, r (collider), h (clearable-over height), kind}.
    // Kept off the spawn corridor (azimuth ~0) and the mesa lanes.
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
  // The single source of truth: physics probes, the terrain mesh, obstacle
  // placement and the camera clamp all sample this one function.
  heightAt(x, z) {
    const R = this.radius;
    const r = Math.hypot(x, z);
    const a = Math.atan2(x, z); // azimuth: 0 at +z (the spawn side)

    // Saucer + banked rim (phase 1's bones, stretched to the new radius). The
    // bank clamps at the fence so the camera's ground samples beyond it don't
    // keep climbing.
    let h = 1.8 * (r * r) / (R * R);
    const s = Math.min(1, Math.max(0, (r - R * 0.72) / (R * 0.28)));
    h += 5.5 * s * s;

    // Centre mesa: flat plateau, steep skirt, two gentle ramp lanes at the
    // spawn azimuth and its opposite (lane skirt stretches 12 → 26u wide).
    if (r < MESA_TOP + 30) {
      const lane = Math.max(
        1 - smooth01((Math.abs(wrapPi(a)) - 0.3) / 0.25),
        1 - smooth01((Math.abs(wrapPi(a - Math.PI)) - 0.3) / 0.25)
      );
      const skirt = 12 + 14 * lane;
      h += MESA_H * smooth01((MESA_TOP + skirt - r) / skirt);
    }

    // Dry creek: a sunken cosine channel arcing the west half.
    if (r > CREEK_R - CREEK_HALF && r < CREEK_R + CREEK_HALF && a < 0) {
      const t = (r - CREEK_R) / CREEK_HALF;
      const w = smooth01((a + 2.6) / 0.35) * smooth01((-0.6 - a) / 0.35);
      h -= CREEK_DEPTH * (0.5 + 0.5 * Math.cos(Math.PI * t)) * w;
    }

    // Mogul meadow: rolling ±1.15u bumps windowed to a north-east wedge.
    if (a > 0.5 && a < 1.8 && r > 46 && r < 100) {
      const w =
        smooth01((a - 0.5) / 0.3) * smooth01((1.8 - a) / 0.3) *
        smooth01((r - 46) / 8) * smooth01((100 - r) / 8);
      h += 1.15 * Math.sin(x * 0.33 + 1.0) * Math.sin(z * 0.33) * w;
    }

    // Dune waves: low concentric washboard ridges filling the south-west
    // field — rhythm underwheel, gentle enough (≤12°) to never launch.
    if (a > -0.55 && a < -0.12 && r > 42 && r < 95) {
      const w =
        smooth01((a + 0.55) / 0.1) * smooth01((-0.12 - a) / 0.1) *
        smooth01((r - 42) / 8) * smooth01((95 - r) / 8);
      h += 0.8 * (0.5 + 0.5 * Math.sin(r * 0.55)) * w;
    }

    // Kickers: a long gentle up-face, then a steep drop off the lip — the drop
    // is what airTransfer converts into flight.
    for (const k of this.kickers) {
      const dx = x - k.x, dz = z - k.z;
      const u = dx * k.sin + dz * k.cos; // along the launch direction
      if (u < -16 || u > 5) continue;
      const v = dx * k.cos - dz * k.sin; // across
      if (v < -6 || v > 6) continue;
      const lat = smooth01((6 - Math.abs(v)) / 2.5);
      const rise = u <= 0 ? smooth01((u + 16) / 16) : 1 - smooth01(u / 5);
      h += KICK_H * rise * lat;
    }

    return h;
  }

  // Same contract as Track.project, in radial terms: `side` points outward from
  // the arena centre and `lateral` is the centre distance, so the kart's wall
  // clamp holds it inside the fence and shoves radially on a scrape.
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

  // A circle at mid-floor stands in for the centreline: the menu orbit anchors
  // sweep it, and any t-space consumer gets sensible world points.
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

  // Static obstacle collision: push the kart out of any toy it overlaps, with
  // the same feel as a wall scrape (speed scrub, spark latch, drift forfeit).
  // Returns true when it moved the kart (caller re-syncs the mesh).
  collide(k) {
    let hit = false;
    for (const o of this.obstacles) {
      if (k.y > o.h) continue; // flying clean over it (kickers make this real)
      const dx = k.position.x - o.x;
      const dz = k.position.z - o.z;
      const rr = o.r + k.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d, nz = dz / d;
      k.position.x = o.x + nx * rr;
      k.position.z = o.z + nz * rr;
      k.speed *= 1 - Math.min(0.4, 1.6 * (k._dt || 0.016));
      k.knock.multiplyScalar(0.5);
      if (k.drifting) {
        k.drifting = false;
        k.driftCharge = 0;
        k.driftRamp = 0;
      }
      if (Math.abs(k.speed) > 6) {
        k.wallHit = true;
        k.wallHitDir.set(-nx, 0, -nz); // toward the obstacle (matches wall semantics)
        k.wallHitPulse = 0.12;
      }
      hit = true;
    }
    return hit;
  }

  // Crest launches + airborne ground-height continuity. kart.y is measured
  // ABOVE the local ground, so terrain moving under an airborne kart would
  // teleport it; and grounded karts are glued to groundY, so a drop-off would
  // snap them down. Both become ballistic here. Returns true when it changed
  // the kart (caller re-syncs the mesh).
  airTransfer(k, dt) {
    const gy = k.groundY;
    const prevGy = k._agy;
    const prevSlope = k._aslope || 0;
    k._agy = gy;
    k._aslope = k.slopePitch;
    if (prevGy === undefined) return false;
    const drop = prevGy - gy; // + when the ground fell away this frame
    if (drop === 0) return false;
    if (Math.abs(drop) > 3) return false; // teleport (respawn/probe) — resync only
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
    // descent could follow. Carry the vertical speed the slope was giving us
    // (slopePitch is negative climbing → -sin is + going up).
    if (drop > Math.max(0.05, Math.abs(k.speed) * dt * LAUNCH_SLOPE)) {
      k.y = drop; // world height continuity at the lip
      k.vy = -Math.sin(prevSlope) * Math.abs(k.speed);
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
  }

  // Terrain: a polar grid displaced by heightAt (the SAME function physics
  // reads), vertex-coloured by feature so the map reads at a glance.
  _buildTerrain() {
    const R = this.radius;
    const SEG = 160, RINGS = 100;
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

  // Per-vertex ground paint. Priorities: kicker faces > creek bed > mesa >
  // moguls tint > worn boundary ring > rim edge zone > sand.
  _colorAt(x, z, h) {
    const R = this.radius;
    const r = Math.hypot(x, z);
    const a = Math.atan2(x, z);
    const c = new THREE.Color(0xd9c08f); // packed sand

    // Mogul meadow: light the crests, shade the dips, so the washboard reads
    // from the chase cam AND the overview.
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

    // Worn boundary ring at r=100 (where the rim bank begins) + rim edge zone.
    if (Math.abs(r - 100) < 1.6) c.lerp(new THREE.Color(0xefe3c0), 0.55);
    if (r > R * 0.93) c.lerp(new THREE.Color(0xc4795a), smooth01((r - R * 0.93) / (R * 0.05)));

    // Mesa: skirt grades sand → terracotta with height; plateau is terracotta
    // and wears the paw print.
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
        // Paw print, toes toward the spawn (+z).
        const paw = new THREE.Color(0x9a5c32);
        const pex = x / 4.4, pez = (z - 1.2) / 5.2;
        if (pex * pex + pez * pez < 1) c.copy(paw);
        for (const t of [-0.72, -0.26, 0.26, 0.72]) {
          const tx = Math.sin(t) * 8.4, tz = 1.2 + Math.cos(t) * 8.4;
          if ((x - tx) * (x - tx) + (z - tz) * (z - tz) < 2.1 * 2.1) c.copy(paw);
        }
      }
    }

    // Creek bed: darker, damper sand by depth.
    if (r > CREEK_R - CREEK_HALF && r < CREEK_R + CREEK_HALF && a < 0) {
      const t = (r - CREEK_R) / CREEK_HALF;
      const w = smooth01((a + 2.6) / 0.35) * smooth01((-0.6 - a) / 0.35);
      c.lerp(new THREE.Color(0x9b8560), (0.5 + 0.5 * Math.cos(Math.PI * t)) * w);
    }

    // Kickers: cream up-face so they read as "hit me", red lip band.
    for (const k of this.kickers) {
      const dx = x - k.x, dz = z - k.z;
      const u = dx * k.sin + dz * k.cos;
      if (u < -16 || u > 5) continue;
      const v = dx * k.cos - dz * k.sin;
      if (Math.abs(v) > 6) continue;
      const lat = smooth01((6 - Math.abs(v)) / 2.5);
      if (u <= 0) c.lerp(new THREE.Color(0xefe3c0), smooth01((u + 16) / 16) * lat * 0.85);
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

  // The cat toys. Each is a few plain primitives — these are discrete props
  // (like trees), not molded curved surfaces, so primitives are fine.
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
        g.position.set(o.x, gy + 2.4, o.z); // sunk a little into the sand
        g.rotation.y = (o.x * 13.7 + o.z * 7.1) % Math.PI; // deterministic variety
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
}
