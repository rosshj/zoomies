// Battle arena: "THE COURTYARD".
//
// The previous maps failed for one measurable reason: they were far too big.
// Whisker Junction was 230x200 with a kart that does ~34 u/s, so features sat
// seconds apart and the space read as a plane with objects on it. Arena combat
// lives on DENSITY — a few strong shapes, close together, all connected.
//
// The Courtyard is 116x116 (about a fifth of the area) built from the same
// data-driven kit, and designed around four rules:
//   1. ONE hero structure — a central podium with a drivable roof. It's the
//      high ground, the duel spot, and the thing you orbit.
//   2. FOUR wide, shallow ramps onto it (16u wide, ~17°) at N/E/S/W. Wide and
//      shallow means you take them from ANY angle — never a magic approach.
//   3. A perimeter ring that always flows. No dead ends, no traps: from
//      anywhere you can always keep driving.
//   4. Every corner has one distinct job (launch, cover, shade, terrain) and
//      an item box is never more than ~2 seconds away.
//
// The kit: `solids` (rotated boxes) and `ramps` (wedges) join the ground by
// MAX-composition — crisp drivable tops, vertical sides that collide as real
// boxes with sliding, and a ballistic ledge off any top edge. `decks` are
// elevated slabs you can drive under, resolved by the level-aware
// heightNear(x, z, y). Air/landing physics live in battlephysics.js — this
// file no longer owns any launch heuristics.
import * as THREE from "three";

const HALF = 58; // playable half-extent (walls sit here)
const R = 400; // radial fail-safe only — containment is the rectangle in collide()
const WALL_GRADE = 1.05; // organic ground rising faster than ~46° ahead = wall

// Central podium: the hero structure.
const POD = { x: 0, z: 0, w: 26, d: 26, h: 5, skirt: 17 };
// The shade deck (SE corner): drive under it or over it.
const DECK = { x: 44, z: 44, hw: 8, hd: 8, h: 4.6 };

const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

function makeLayout() {
  const solids = [
    // Boundary walls. Scenery + sightline blockers; the hard edge is in collide().
    { x: 0, z: -HALF - 1.5, yaw: 0, w: (HALF + 2) * 2, d: 3, h: 4.5, kind: "stone" },
    { x: 0, z: HALF + 1.5, yaw: 0, w: (HALF + 2) * 2, d: 3, h: 4.5, kind: "stone" },
    { x: HALF + 1.5, z: 0, yaw: 0, w: 3, d: (HALF + 2) * 2, h: 4.5, kind: "stone" },
    { x: -HALF - 1.5, z: 0, yaw: 0, w: 3, d: (HALF + 2) * 2, h: 4.5, kind: "stone" },
    // (The podium is NOT a block — it's an analytic square frustum in
    // _terrainH, so its skirt is continuous on every side and corner.)
    // NE corner: chunky crates for cover. Deliberately NOT long thin walls —
    // those snag karts along their faces and pocket them against the map
    // corner (the audit logged it every run). Squat blocks with wide lanes
    // between them break sightlines without ever wedging anyone.
    { x: 32, z: -38, yaw: 0.3, w: 9, d: 9, h: 3.4, kind: "crate" },
    { x: 47, z: -24, yaw: -0.5, w: 9, d: 9, h: 3.4, kind: "crate" },
    { x: 30, z: -20, yaw: 0.9, w: 8, d: 8, h: 3.0, kind: "crate" },
  ];
  const ramps = [
    // NW corner: the big launch ramp, firing diagonally at the podium — clear
    // the gap and you land on its far shoulder.
    { x: -48, z: -48, yaw: Math.PI / 4, L: 18, W: 12, h0: "auto", h1: 4.2, kind: "mega" },
    // SE corner: the ramp up onto the shade deck — full deck width, so its
    // south face is all ramp and there's no side wall to grind along.
    { x: DECK.x, z: 26, yaw: 0, L: 12, W: DECK.hw * 2, h0: "auto", h1: DECK.h, kind: "wood" },
  ];
  const decks = [{ x: DECK.x, z: DECK.z, yaw: 0, hw: DECK.hw, hd: DECK.hd, h: DECK.h, kind: "wood" }];
  const boostPads = [
    // Ring: one per side, pointing along the flow.
    { x: 0, z: 48, r: 4, yaw: -Math.PI / 2 },
    { x: 0, z: -48, r: 4, yaw: Math.PI / 2 },
    { x: 48, z: 0, r: 4, yaw: Math.PI },
    { x: -48, z: 0, r: 4, yaw: 0 },
    // Run-up to the NW launch ramp.
    { x: -54, z: -54, r: 4, yaw: Math.PI / 4 },
    // On the podium roof, aimed at the two open edges — jump off the top.
    { x: -7, z: 0, r: 3.6, yaw: -Math.PI / 2, y: POD.h },
    { x: 7, z: 0, r: 3.6, yaw: Math.PI / 2, y: POD.h },
  ];
  const obstacles = [
    // Corner landmarks. Kept OFF the ring and off every ramp mouth.
    { x: -38, z: 30, r: 3.2, h: 5, kind: "yarn", color: 0xe4607a },
    { x: 40, z: -46, r: 3.2, h: 5, kind: "yarn", color: 0x6fa8dc },
    { x: -30, z: 44, r: 1.7, h: 8, kind: "post" },
    { x: -44, z: 44, r: 1.7, h: 8, kind: "post" },
    { x: 20, z: -50, r: 2.9, h: 2.4, kind: "box", yawv: 0.3 },
    { x: 28, z: -52, r: 2.9, h: 2.4, kind: "box", yawv: -0.4 },
  ];
  // Deck pillars (tops below the slab so deck traffic clears them).
  for (const [dx, dz] of [[-6.5, -6.5], [6.5, -6.5], [-6.5, 6.5], [6.5, 6.5]]) {
    obstacles.push({ x: DECK.x + dx, z: DECK.z + dz, r: 1.1, h: DECK.h - 0.9, kind: "pillar" });
  }
  // Boxes: podium roof + a ring of them, so you're always seconds from ammo.
  const itemSpots = [
    { x: 0, z: 0, y: POD.h, mode: "float" }, // the prize on the high ground
    { x: 0, z: 37, mode: "float" }, // clear of the start grid
    { x: 0, z: -42, mode: "float" },
    { x: 42, z: 0, mode: "float" },
    { x: -42, z: 0, mode: "float" },
    { x: DECK.x, z: DECK.z, y: DECK.h, mode: "float" }, // on the shade deck
    { x: -34, z: -44, mode: "float" }, // beside the launch ramp
    { x: 52, z: -40, mode: "float" }, // in the cover gallery, clear of crates + toys
    { x: -50, z: 34, mode: "float" }, // by the mound, clear of the posts
    { x: 24, z: 8, mode: "float" }, // tucked against the pyramid's east flank
    // Promotion pool (ground crates that rise to replace grabbed boxes).
    { x: -20, z: -20, mode: "ground" },
    { x: 14, z: -30, mode: "ground" },
    { x: -20, z: 20, mode: "ground" },
    { x: 54, z: 30, mode: "ground" },
    { x: -50, z: 20, mode: "ground" },
    { x: 50, z: -50, mode: "ground" },
  ];
  // Respawns sit clear of the boost pads and item boxes — dropping a fresh
  // kart on top of a contested pickup just makes another scrum.
  const respawns = [
    { x: 14, z: 44 }, { x: 46, z: 18 }, { x: 46, z: -30 }, { x: 14, z: -48 },
    { x: -22, z: -46 }, { x: -48, z: -22 }, { x: -48, z: 26 }, { x: -18, z: 46 },
  ];
  return { solids, ramps, decks, boostPads, obstacles, itemSpots, respawns };
}

function prep(b) {
  b.sin = Math.sin(b.yaw || 0);
  b.cos = Math.cos(b.yaw || 0);
  const hw = b.w != null ? b.w / 2 : b.hw != null ? b.hw : b.W / 2;
  const hd = b.d != null ? b.d / 2 : b.hd != null ? b.hd : b.L / 2;
  b.bound = Math.hypot(hw, hd) + 1;
  return b;
}

export class Arena {
  constructor() {
    this.isArena = true;
    this.radius = R;
    this.halfWidth = R;
    this.length = Math.PI * 2 * R;
    this.samples = 128;
    this.totalLaps = 3;
    this.raceTime = 0;
    this.features = { runs: [] };
    this.podium = POD;
    this.deck = DECK;
    this.half = HALF;

    const L = makeLayout();
    this.solids = L.solids.map(prep);
    this.ramps = L.ramps.map(prep);
    this.decks = L.decks.map(prep);
    this.kickers = []; // the launch ramp is a kit wedge now — no molded kickers
    this.boostPads = L.boostPads;
    this.obstacles = L.obstacles;
    this._itemSpots = L.itemSpots;
    this.respawns = L.respawns;
    for (const rp of this.ramps) if (rp.h0 === "auto") rp.h0 = this._terrainH(rp.x, rp.z);

    // Map outline for the minimap + sun-shadow fit: the boundary square.
    this._pts = [];
    this._tans = [];
    const C = [[-HALF, -HALF], [HALF, -HALF], [HALF, HALF], [-HALF, HALF]];
    for (let e = 0; e < 4; e++) {
      const [ax, az] = C[e], [bx, bz] = C[(e + 1) % 4];
      for (let i = 0; i < 32; i++) {
        const t = i / 32;
        this._pts.push(new THREE.Vector3(ax + (bx - ax) * t, 4.5, az + (bz - az) * t));
        this._tans.push(new THREE.Vector3(Math.sign(bx - ax), 0, Math.sign(bz - az)));
      }
    }

    this.group = new THREE.Group();
    this._build();
  }

  // ---- Ground -------------------------------------------------------------

  // Organic relief under the architecture: gentle, rolling, never steep enough
  // to fight. The shapes come from the kit; this keeps the floor alive.
  _terrainH(x, z) {
    let h = 0.55 * Math.sin(x * 0.055) * Math.sin(z * 0.06); // rolling waves
    h -= 0.9 * smooth01((34 - Math.hypot(x, z)) / 26); // shallow dish around the podium

    // THE PODIUM — a square frustum: flat roof, and a skirt that is continuous
    // on every side AND corner. Built analytically rather than from ramp
    // blocks because rectangular ramps around a square podium always leave
    // wedge-shaped gaps at the diagonals, and the audit found karts wedging in
    // them every single run. As one surface there is no approach angle that
    // isn't a ramp, and no vertical face to catch on.
    const cheb = Math.max(Math.abs(x - POD.x) - POD.w / 2, Math.abs(z - POD.z) - POD.d / 2);
    let pod = POD.h * Math.max(0, Math.min(1, 1 - cheb / POD.skirt));
    // Roof COPING: the outer 1.2u of the roof kicks up a little. A pure
    // frustum has no lip anywhere, so leaving it just means driving down a
    // shallow slope — you can never jump off your own hero structure. The rim
    // rises at the same gradient as the skirt, so climbing up is unchanged,
    // but rolling over it at speed launches you in ANY direction.
    if (cheb < 0 && cheb > -1.2) pod += 0.35 * (1 + cheb / 1.2);
    if (pod > h) h = pod;

    h -= 1.6 * smooth01((16 - Math.hypot(x - DECK.x, z - DECK.z)) / 14); // SE hollow (under the deck)
    h += 2.4 * smooth01((20 - Math.hypot(x + 38, z - 38)) / 20); // SW mound
    return h;
  }

  heightAt(x, z) {
    let h = this._terrainH(x, z);
    for (const b of this.solids) {
      const dx = x - b.x, dz = z - b.z;
      if (dx * dx + dz * dz > b.bound * b.bound) continue;
      const u = dx * b.sin + dz * b.cos;
      const v = dx * b.cos - dz * b.sin;
      if (Math.abs(v) <= b.w / 2 && Math.abs(u) <= b.d / 2 && b.h > h) h = b.h;
    }
    for (const rp of this.ramps) {
      const dx = x - rp.x, dz = z - rp.z;
      if (dx * dx + dz * dz > (rp.bound + rp.L) * (rp.bound + rp.L)) continue;
      const u = dx * rp.sin + dz * rp.cos;
      const v = dx * rp.cos - dz * rp.sin;
      if (u >= 0 && u <= rp.L && Math.abs(v) <= rp.W / 2) {
        const rh = rp.h0 + (rp.h1 - rp.h0) * (u / rp.L);
        if (rh > h) h = rh;
      }
    }
    return h;
  }

  _deckSurface(x, z) {
    for (const d of this.decks) {
      const dx = x - d.x, dz = z - d.z;
      if (dx * dx + dz * dz > d.bound * d.bound) continue;
      const u = dx * d.sin + dz * d.cos;
      const v = dx * d.cos - dz * d.sin;
      if (Math.abs(v) <= d.hw && Math.abs(u) <= d.hd) return d.h;
    }
    return null;
  }

  // Level-aware ground: the surface nearest the caller's own height.
  heightNear(x, z, y = 0) {
    const base = this.heightAt(x, z);
    const deck = this._deckSurface(x, z);
    if (deck == null) return base;
    return Math.abs(y - deck) < Math.abs(y - base) ? deck : base;
  }

  project(pos) {
    const x = pos.x, z = pos.z;
    const r = Math.hypot(x, z);
    const side = r > 1e-4 ? new THREE.Vector3(x / r, 0, z / r) : new THREE.Vector3(1, 0, 0);
    const tangent = new THREE.Vector3(-side.z, 0, side.x);
    const groundY = this.heightNear(x, z, pos.y || 0);
    return { t: 0, point: new THREE.Vector3(x, groundY, z), tangent, side, lateral: r, distance: r, groundY };
  }

  groundYNear(x, z, y = 0) {
    return this.heightNear(x, z, y);
  }

  groundInfo(x, z) {
    return { y: this.heightAt(x, z), dist: Math.max(0, Math.max(Math.abs(x), Math.abs(z)) - HALF) };
  }

  distanceToCenter(x, z) {
    return Math.hypot(x, z);
  }

  getPointAt(t, target = new THREE.Vector3()) {
    const a = (((t % 1) + 1) % 1) * Math.PI * 2;
    const r = 40; // menu orbit: circle the podium
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    return target.set(x, this.heightAt(x, z), z);
  }

  getTangentAt(t, target = new THREE.Vector3()) {
    const a = (((t % 1) + 1) % 1) * Math.PI * 2;
    return target.set(Math.cos(a), 0, -Math.sin(a));
  }

  itemSpots() {
    return this._itemSpots;
  }

  gridSlot(index) {
    // Spread wide: a tight grid in a small arena is an instant four-way scrum.
    const back = 42 + Math.floor(index / 2) * 9;
    const lateral = (index % 2 === 0 ? -1 : 1) * 9;
    const pos = new THREE.Vector3(lateral, 0, back);
    pos.y = this.heightAt(lateral, back);
    return { position: pos, heading: Math.PI }; // face the podium
  }

  // ---- Collision ----------------------------------------------------------

  // A wall contact that SLIDES: push out along the true normal, scrub only the
  // head-on speed component. Glancing hits keep their pace along the wall.
  _wallContact(k, nx, nz, push, dt) {
    k.position.x += nx * push;
    k.position.z += nz * push;
    const dir = k.speed >= 0 ? 1 : -1;
    const fx = Math.sin(k.heading) * dir, fz = Math.cos(k.heading) * dir;
    const into = Math.max(0, -(fx * nx + fz * nz));
    k.speed *= 1 - Math.min(0.7, into * into * 6 * dt);
    // Airborne: kill the velocity component heading into the wall so a jump
    // slides down the face instead of hovering against it.
    if (!k.grounded) {
      const vn = k.vel.x * nx + k.vel.z * nz;
      if (vn < 0) {
        k.vel.x -= nx * vn;
        k.vel.z -= nz * vn;
      }
    }
    k.knock.multiplyScalar(0.6);
    if (k.drifting && into > 0.4) {
      k.drifting = false;
      k.driftCharge = 0;
      k.driftRamp = 0;
    }
    if (Math.abs(k.speed) > 6 && into > 0.35) {
      k.wallHit = true;
      k.wallHitDir.set(-nx, 0, -nz);
      k.wallHitPulse = 0.12;
    }
  }

  // Rotated-box collision for a solid (constant top) or ramp (top rises along
  // u). No side wall where the top is near the kart's own level — that's what
  // makes a wide shallow ramp enterable from ANY angle.
  _collideBox(k, b, isRamp) {
    const kartY = k.position.y + k.y;
    const dx = k.position.x - b.x, dz = k.position.z - b.z;
    let u = dx * b.sin + dz * b.cos;
    const v = dx * b.cos - dz * b.sin;
    let halfU, halfV;
    if (isRamp) {
      halfU = b.L / 2;
      halfV = b.W / 2;
      u -= b.L / 2;
    } else {
      halfU = b.d / 2;
      halfV = b.w / 2;
    }
    const kr = k.radius;
    if (Math.abs(u) >= halfU + kr || Math.abs(v) >= halfV + kr) return false;
    const top = isRamp
      ? b.h0 + (b.h1 - b.h0) * Math.min(1, Math.max(0, (u + halfU) / b.L))
      : b.h;
    if (kartY > top - 0.9) return false; // on or above it — not a wall
    const pu = halfU + kr - Math.abs(u);
    const pv = halfV + kr - Math.abs(v);
    let nx, nz, push;
    if (pu < pv) {
      const s = u >= 0 ? 1 : -1;
      nx = b.sin * s;
      nz = b.cos * s;
      push = pu;
    } else {
      const s = v >= 0 ? 1 : -1;
      nx = b.cos * s;
      nz = -b.sin * s;
      push = pv;
    }
    // Only a contact when moving INTO the box: leaving a top edge briefly puts
    // the kart inside the margin, and pushing there would swallow the launch.
    const dir = k.speed >= 0 ? 1 : -1;
    const fx = Math.sin(k.heading) * dir, fz = Math.cos(k.heading) * dir;
    if (fx * nx + fz * nz > 0.15) return false;
    this._wallContact(k, nx, nz, push, k._dt || 0.016);
    return true;
  }

  collide(k) {
    let hit = false;
    const dt = k._dt || 0.016;

    // HARD boundary — holds mid-flight too. The walls are scenery; this is the
    // edge of the world.
    {
      const B = HALF - 1;
      if (Math.abs(k.position.x) > B) {
        const s = Math.sign(k.position.x);
        k.position.x = s * B;
        this._wallContact(k, -s, 0, 0, dt);
        hit = true;
      }
      if (Math.abs(k.position.z) > B) {
        const s = Math.sign(k.position.z);
        k.position.z = s * B;
        this._wallContact(k, 0, -s, 0, dt);
        hit = true;
      }
    }

    for (const o of this.obstacles) {
      if (k.position.y + k.y > o.h) continue;
      const dx = k.position.x - o.x;
      const dz = k.position.z - o.z;
      const rr = o.r + k.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      this._wallContact(k, dx / d, dz / d, rr - d, dt);
      hit = true;
    }
    for (const b of this.solids) if (this._collideBox(k, b, false)) hit = true;
    for (const rp of this.ramps) if (this._collideBox(k, rp, true)) hit = true;

    // Steep ORGANIC ground only (the SW mound's flanks); architecture is exact.
    if (k.grounded && Math.abs(k.speed) > 0.5) {
      const dir = k.speed >= 0 ? 1 : -1;
      const fx = Math.sin(k.heading) * dir, fz = Math.cos(k.heading) * dir;
      const hC = this._terrainH(k.position.x, k.position.z);
      const hA = this._terrainH(k.position.x + fx * 1.7, k.position.z + fz * 1.7);
      if (hA - hC > 1.7 * WALL_GRADE) {
        this._wallContact(k, -fx, -fz, Math.abs(k.speed) * dt + 0.12, dt);
        hit = true;
      }
    }
    return hit;
  }

  // ---- Visuals ------------------------------------------------------------

  _build() {
    this._buildGround();
    this._buildBlocks();
    this._buildDecks();
    this._buildProps();
    this._buildPads();
  }

  _buildGround() {
    const N = 150, S = (HALF + 6) * 2;
    const positions = new Float32Array((N + 1) * (N + 1) * 3);
    const colors = new Float32Array((N + 1) * (N + 1) * 3);
    for (let i = 0; i <= N; i++) {
      for (let j = 0; j <= N; j++) {
        const x = -S / 2 + (i / N) * S;
        const z = -S / 2 + (j / N) * S;
        const o = (i * (N + 1) + j) * 3;
        positions[o] = x;
        positions[o + 1] = this._terrainH(x, z);
        positions[o + 2] = z;
        const c = this._colorAt(x, z);
        colors[o] = c.r;
        colors[o + 1] = c.g;
        colors[o + 2] = c.b;
      }
    }
    const idx = [];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const a = i * (N + 1) + j, b = a + 1, c = a + (N + 1), d = c + 1;
        // Winding matters: (a,c,d)/(a,d,b) points every normal DOWN, which
        // renders the whole map as unlit flat white with no visible relief.
        idx.push(a, b, d, a, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 })));

    // Meadow beyond the walls, out past the fog.
    const apron = new THREE.Mesh(
      new THREE.RingGeometry(HALF + 5, 1400, 48, 1),
      new THREE.MeshStandardMaterial({ color: 0x6fae5a, roughness: 1 })
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -0.12;
    this.group.add(apron);
  }

  _colorAt(x, z) {
    const c = new THREE.Color(0xd9c08f); // packed sand
    if (Math.max(Math.abs(x), Math.abs(z)) > HALF) return c.set(0x6fae5a);

    // Cobbled ring road around the podium, with a painted boundary line.
    const r = Math.hypot(x, z);
    if (r > 32 && r < 50) c.lerp(new THREE.Color(0xcbb17f), 0.75);
    if (Math.abs(r - 50) < 1.0) c.lerp(new THREE.Color(0xefe3c0), 0.7);

    // The podium: warm stone skirt, terracotta roof, painted paw on top.
    const cheb = Math.max(Math.abs(x - POD.x) - POD.w / 2, Math.abs(z - POD.z) - POD.d / 2);
    if (cheb < POD.skirt) {
      const up = Math.max(0, Math.min(1, 1 - cheb / POD.skirt));
      c.lerp(new THREE.Color(0xe0cfa8), 0.35 + up * 0.5);
      // Chevrons up the skirt so the climb reads from a distance.
      if (cheb > 0.6 && ((cheb + Math.abs(Math.abs(x) - Math.abs(z)) * 0.35) % 5.5) < 1.3) {
        c.lerp(new THREE.Color(0x39e6a0), 0.55);
      }
      if (cheb <= 0.6) c.lerp(new THREE.Color(0xc4795a), 0.85); // painted roof lip
      if (cheb < -0.6) {
        c.set(0xcf9159);
        const paw = new THREE.Color(0x9a5c32);
        const pex = x / 3.6, pez = (z - 1.0) / 4.2;
        if (pex * pex + pez * pez < 1) c.copy(paw);
        for (const t of [-0.72, -0.26, 0.26, 0.72]) {
          const tx = Math.sin(t) * 6.8, tz = 1.0 + Math.cos(t) * 6.8 * -1;
          if ((x - tx) * (x - tx) + (z - tz) * (z - tz) < 1.9 * 1.9) c.copy(paw);
        }
      }
    }

    // SW mound: grassy.
    const mound = smooth01((20 - Math.hypot(x + 38, z - 38)) / 20);
    if (mound > 0) c.lerp(new THREE.Color(0xa8bb7a), mound * 0.75);

    // SE hollow: damp, shaded ground under the deck.
    const hollow = smooth01((16 - Math.hypot(x - DECK.x, z - DECK.z)) / 14);
    if (hollow > 0) c.lerp(new THREE.Color(0x9b8560), hollow * 0.7);

    // NE gallery: paler paving between the cover walls.
    if (x > 18 && z < -14) c.lerp(new THREE.Color(0xcfc3ae), 0.45);

    return c;
  }

  _buildBlocks() {
    const mats = {
      stone: new THREE.MeshStandardMaterial({ color: 0xb8b0a0, roughness: 0.95 }),
      crate: new THREE.MeshStandardMaterial({ color: 0xb8905f, roughness: 1 }),
      wood: new THREE.MeshStandardMaterial({ color: 0xa9814f, roughness: 0.9 }),
      mega: new THREE.MeshStandardMaterial({ color: 0xc9c4b8, roughness: 0.95 }),
    };
    const trim = new THREE.MeshStandardMaterial({ color: 0x8a8274, roughness: 0.9 });
    const mint = new THREE.MeshStandardMaterial({ color: 0x39e6a0, roughness: 0.6 });
    const hazard = new THREE.MeshStandardMaterial({ color: 0xc4795a, roughness: 0.8 });

    for (const b of this.solids) {
      const g = new THREE.Group();
      g.position.set(b.x, 0, b.z);
      g.rotation.y = b.yaw || 0;
      const box = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h + 2, b.d), mats[b.kind] || mats.stone);
      box.position.y = (b.h + 2) / 2 - 2; // sunk 2u so rolling ground never gaps under it
      g.add(box);
      if (b.kind === "stone") {
        const cap = new THREE.Mesh(new THREE.BoxGeometry(b.w + 0.5, 0.35, b.d + 0.5), trim);
        cap.position.y = b.h + 0.17;
        g.add(cap);
      } else if (b.kind === "crate") {
        // Packing-crate banding so the cover blocks read as objects, not walls.
        const band = new THREE.Mesh(new THREE.BoxGeometry(b.w + 0.12, 0.5, b.d + 0.12), trim);
        band.position.y = b.h * 0.62;
        g.add(band);
        const lid = new THREE.Mesh(new THREE.BoxGeometry(b.w - 1, 0.25, b.d - 1), trim);
        lid.position.y = b.h + 0.12;
        g.add(lid);
      }
      this.group.add(g);
    }

    for (const rp of this.ramps) {
      const g = new THREE.Group();
      g.position.set(rp.x, 0, rp.z);
      g.rotation.y = rp.yaw;
      const w = rp.W / 2;
      const pos = new Float32Array([
        -w, rp.h0, 0, w, rp.h0, 0, w, rp.h1, rp.L,
        -w, rp.h0, 0, w, rp.h1, rp.L, -w, rp.h1, rp.L,
        -w, rp.h0, 0, -w, rp.h1, rp.L, -w, -2, rp.L,
        -w, rp.h0, 0, -w, -2, rp.L, -w, -2, 0,
        w, rp.h0, 0, w, -2, 0, w, -2, rp.L,
        w, rp.h0, 0, w, -2, rp.L, w, rp.h1, rp.L,
        -w, rp.h1, rp.L, w, rp.h1, rp.L, w, -2, rp.L,
        -w, rp.h1, rp.L, w, -2, rp.L, -w, -2, rp.L,
      ]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      g.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: (mats[rp.kind] || mats.stone).color, roughness: 0.95, side: THREE.DoubleSide,
      })));
      // Mint chevrons up every ramp so the routes read at a glance.
      const slope = Math.atan2(rp.h1 - rp.h0, rp.L);
      for (let i = 1; i <= 3; i++) {
        const t = i / 4;
        const strip = new THREE.Mesh(new THREE.BoxGeometry(rp.W - 2.5, 0.08, 1.2), mint);
        strip.position.set(0, rp.h0 + (rp.h1 - rp.h0) * t + 0.08, rp.L * t);
        strip.rotation.x = -slope;
        g.add(strip);
      }
      if (rp.kind === "mega") {
        const lip = new THREE.Mesh(new THREE.BoxGeometry(rp.W - 0.5, 0.1, 1.0), hazard);
        lip.position.set(0, rp.h1 + 0.08, rp.L - 0.5);
        g.add(lip);
      }
      this.group.add(g);
    }
  }

  _buildDecks() {
    const wood = new THREE.MeshStandardMaterial({ color: 0xa9814f, roughness: 0.9 });
    const cream = new THREE.MeshStandardMaterial({ color: 0xefe3c0, roughness: 0.8 });
    for (const d of this.decks) {
      const g = new THREE.Group();
      g.position.set(d.x, 0, d.z);
      g.rotation.y = d.yaw;
      const slab = new THREE.Mesh(new THREE.BoxGeometry(d.hw * 2, 0.8, d.hd * 2), wood);
      slab.position.y = d.h - 0.4;
      g.add(slab);
      for (const s of [-1, 1]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.9, d.hd * 2), cream);
        rail.position.set(s * (d.hw - 0.2), d.h + 0.45, 0);
        g.add(rail);
      }
      this.group.add(g);
    }
  }

  _buildProps() {
    const dark = new THREE.MeshStandardMaterial({ color: 0x9a958a, roughness: 0.95 });
    for (const o of this.obstacles) {
      const gy = this.heightAt(o.x, o.z);
      if (o.kind === "yarn") {
        const g = new THREE.Group();
        const ball = new THREE.Mesh(
          new THREE.SphereGeometry(2.9, 20, 14),
          new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.85 })
        );
        const band = new THREE.Mesh(
          new THREE.TorusGeometry(2.9, 0.4, 8, 20),
          new THREE.MeshStandardMaterial({ color: new THREE.Color(o.color).multiplyScalar(0.7), roughness: 0.85 })
        );
        band.rotation.x = Math.PI / 2.6;
        const band2 = band.clone();
        band2.rotation.y = 1.1;
        g.add(ball, band, band2);
        g.position.set(o.x, gy + 2.3, o.z);
        this.group.add(g);
      } else if (o.kind === "post") {
        const g = new THREE.Group();
        const pole = new THREE.Mesh(
          new THREE.CylinderGeometry(1.15, 1.25, 7, 12),
          new THREE.MeshStandardMaterial({ color: 0xc9a96e, roughness: 0.95 })
        );
        pole.position.y = 3.5;
        g.add(pole);
        const wrapMat = new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.95 });
        for (const y of [1.5, 3.2, 4.9]) {
          const wrap = new THREE.Mesh(new THREE.TorusGeometry(1.18, 0.22, 6, 16), wrapMat);
          wrap.rotation.x = Math.PI / 2;
          wrap.position.y = y;
          g.add(wrap);
        }
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
      } else if (o.kind === "pillar") {
        const hgt = Math.max(1, o.h - gy);
        const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.0, hgt, 10), dark);
        pillar.position.set(o.x, gy + hgt / 2, o.z);
        this.group.add(pillar);
      }
    }
  }

  _buildPads() {
    const mat = new THREE.MeshStandardMaterial({ color: 0x39e6a0, roughness: 0.6 });
    const pale = new THREE.MeshStandardMaterial({ color: 0xbef2dc, roughness: 0.6 });
    const armGeo = new THREE.PlaneGeometry(3.0, 1.1).rotateX(-Math.PI / 2);
    for (const p of this.boostPads) {
      const g = new THREE.Group();
      for (let i = 0; i < 3; i++) {
        for (const side of [-1, 1]) {
          const arm = new THREE.Mesh(armGeo, i === 1 ? pale : mat);
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
}
