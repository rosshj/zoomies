// Battle arena v2: "WHISKER JUNCTION" — an AUTHORED map built from a level
// kit, replacing the old procedural bowl entirely.
//
// The verdict on v1 was fair: an analytic circle with features scattered on it
// reads as terrain, not a place. v2 is a walled village square composed from
// modular blocks the way real battle maps are built:
//
//   LEVEL KIT (all data-driven from the LAYOUT object below):
//   - solids: rotated boxes (buildings, walls) and wedges (ramps). They join
//     the ground function by MAX-composition, so their tops are drivable, their
//     sides are vertical (the steep-wall rule makes them real walls), and
//     driving off any top edge is a ballistic ledge.
//   - decks: elevated slabs you can drive UNDER as well as on (awnings, the
//     parkade deck, the stream bridge). Ground queries are level-aware:
//     heightNear(x,z,y) picks the surface nearest the caller's height.
//   - obstacles: circle colliders (fountain, toys, pillars, crates).
//   - kickers/pads/spots/respawns: gameplay placements, all authored.
//
//   THE MAP: a ~230x200 walled compound (the boundary is the wall blocks, not
//   a radial fence — the map shape is finally not a circle):
//   - NORTH: the Cat Café — a drivable roof (two side ramps up), an awning
//     porch you drive under, and a back street along the north wall.
//   - EAST: the parkade — the two-storey deck, rebuilt from kit pieces.
//   - WEST: the alley — a staggered two-wall corridor (cover + chokepoint)
//     with milk-crate clutter; a kicker jumps you clean over it.
//   - SOUTH: the garden — moguls, a sunken stream with a bridge you can
//     drive OVER or duck UNDER, the spiral tower, and the mega-ramp.
//   - CENTRE: the plaza — fountain, painted paw, open dueling ground.
//
//   AIR, MADE HONEST: take-off velocity is now pure ballistics — vertical
//   speed = ground speed x sin(slope) sampled from the surface behind the lip,
//   with NO boost multiplier, NO minimum pop and NO float assist. Fast hits
//   fly far, slow rolls barely hop, gravity is gravity. (main.js adds the
//   presentation: nose follows the arc, air steering authority drops,
//   landings thump.)
import * as THREE from "three";

const R = 175; // radial fail-safe only — the WALLS are the real boundary
const KICK_H = 3.8;
const KICK_BACK = 18;
const KICK_LIP = 5;
const KICK_HALF = 9;
const LAUNCH_SLOPE = 0.26; // ground falling faster than this grade → airborne
const WALL_GRADE = 1.05; // rising faster than ~46° one kart-length ahead = wall

// Stream (garden): a sunken arc channel south-east of the plaza.
const STREAM = { r: 59, half: 8, a0: 0.5, a1: 1.55, depth: 2.0 };
// Spiral tower (the one round structure — round + rectangular is the mix).
const BUTTE = { x: -62, z: 62, core: 8.5, band: 15.5, h: 9, entry: -0.6, sweep: 5.24 };
// Parkade pose (kit-built below; exposed for probes).
const PK = { x: 78, z: 8, yaw: 0.35, hu: 17, hv: 13, h: 8.2, rampL: 24, rampW: 7 };
// Café podium (top is ABSOLUTE height: terrace 3.2 + one storey).
const CAFE = { x: 0, z: -72, w: 56, d: 34, h: 9.4 };
// Mega-ramp (a solid wedge now — crisp geometry, not molded ground).
const MEGA = { x: 52, z: 74, yaw: Math.atan2(-52, -74), L: 24, W: 11, H: 4.6 };

const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const wrapPi = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

// ---- The layout ------------------------------------------------------------
// Everything placeable lives here. Coordinates: spawn side +z (south), café
// north (-z), parkade east, alley west.
function makeLayout() {
  const solids = [
    // Boundary walls (stone). Tall enough to read on the terrace; actual
    // containment is the hard boundary clamp in collide(), which even a
    // ballistic jump cannot clear.
    { x: 0, z: -101.5, yaw: 0, w: 232, d: 3, h: 7, kind: "stone" },
    { x: 0, z: 101.5, yaw: 0, w: 232, d: 3, h: 4, kind: "stone" },
    { x: 116.5, z: 0, yaw: 0, w: 3, d: 206, h: 5.5, kind: "stone" },
    { x: -116.5, z: 0, yaw: 0, w: 3, d: 206, h: 5.5, kind: "stone" },
    // Café podium (drivable roof).
    { x: CAFE.x, z: CAFE.z, yaw: 0, w: CAFE.w, d: CAFE.d, h: CAFE.h, kind: "cafe" },
    // Alley: staggered corridor walls.
    { x: -70, z: -10, yaw: 0, w: 3, d: 70, h: 3.4, kind: "stone" },
    { x: -88, z: 6, yaw: 0, w: 3, d: 70, h: 3.4, kind: "stone" },
  ];
  // Ramp feet use h0: "auto" — resolved to the terrain height at the foot, so
  // ramps meet the ground flush wherever the terrain now rolls. Wider than v2:
  // oblique entries slide on and up instead of demanding a square hit.
  const ramps = [
    // Café roof access, east + west faces (feet on the terrace).
    { x: 40, z: -72, yaw: -Math.PI / 2, L: 24, W: 14, h0: "auto", h1: CAFE.h, kind: "cafe" },
    { x: -40, z: -72, yaw: Math.PI / 2, L: 24, W: 14, h0: "auto", h1: CAFE.h, kind: "cafe" },
    // Parkade access.
    {
      x: PK.x + (PK.hu + PK.rampL) * Math.sin(PK.yaw), z: PK.z + (PK.hu + PK.rampL) * Math.cos(PK.yaw),
      yaw: PK.yaw + Math.PI, L: PK.rampL, W: 9, h0: "auto", h1: PK.h, kind: "concrete",
    },
    // Mega-ramp: the big garden launch wedge.
    { x: MEGA.x, z: MEGA.z, yaw: MEGA.yaw, L: MEGA.L, W: 12, h0: "auto", h1: MEGA.H, kind: "mega" },
    // Bridge approach wedges — heads overlap the deck so there's no gap-dip.
    { x: 42.3, z: 27.2, yaw: 1.0, L: 6.5, W: 7.2, h0: "auto", h1: 1.6, kind: "wood" },
    { x: 65.4, z: 42.0, yaw: 1.0 + Math.PI, L: 6.5, W: 7.2, h0: "auto", h1: 1.6, kind: "wood" },
  ];
  const decks = [
    // Café awning: the porch you drive under (flush with the roof).
    { x: 0, z: -50, yaw: 0, hw: 20, hd: 5, h: CAFE.h, kind: "awning" },
    // Parkade deck.
    { x: PK.x, z: PK.z, yaw: PK.yaw, hw: PK.hv, hd: PK.hu, h: PK.h, kind: "concrete" },
    // Garden bridge over the stream (duck under it along the stream bed).
    { x: 53.8, z: 34.6, yaw: 1.0, hw: 3.6, hd: 8.5, h: 1.6, kind: "wood" },
  ];
  const kickers = [
    { x: -44, z: -16, yaw: -Math.PI / 2 }, // plaza edge → clean over the alley walls
    { x: 30, z: -92, yaw: -Math.PI / 2 }, // the back street speed-line
  ];
  for (const k of kickers) {
    k.sin = Math.sin(k.yaw);
    k.cos = Math.cos(k.yaw);
  }
  const boostPads = [
    { x: 0, z: 40, r: 4, yaw: Math.PI }, // spawn straight into the plaza
    { x: -16, z: -16, r: 4, yaw: -Math.PI / 2 }, // run-up to the alley jump
    { x: 39.2, z: 55.9, r: 4, yaw: MEGA.yaw }, // mega-ramp run-up
    { x: 62, z: -72, r: 4, yaw: -Math.PI / 2 }, // café east ramp approach
    { x: 50, z: -92, r: 4, yaw: -Math.PI / 2 }, // back street, into its kicker
  ];
  // Parkade deck runway pads (local frame → world).
  const pkS = Math.sin(PK.yaw), pkC = Math.cos(PK.yaw);
  const pkWorld = (u, v) => ({ x: PK.x + u * pkS + v * pkC, z: PK.z + u * pkC - v * pkS });
  for (const [u, v] of [[-6, -4], [-6, 4]]) {
    const p = pkWorld(u, v);
    boostPads.push({ x: p.x, z: p.z, r: 4, yaw: PK.yaw + Math.PI, y: PK.h });
  }
  const obstacles = [
    { x: 0, z: -4, r: 4.2, h: 6, kind: "fountain" },
    { x: 30, z: -40, r: 3.4, h: 5, kind: "yarn", color: 0xe4607a },
    { x: -98, z: 55, r: 3.4, h: 5, kind: "yarn", color: 0x6fa8dc },
    { x: 66, z: 16, r: 3.4, h: 5, kind: "yarn", color: 0x93c47d }, // by the stream bank
    // Garden path posts.
    { x: -20, z: 46, r: 1.7, h: 9, kind: "post" },
    { x: -30, z: 56, r: 1.7, h: 9, kind: "post" },
    { x: -40, z: 66, r: 1.7, h: 9, kind: "post" },
    { x: -50, z: 76, r: 1.7, h: 9, kind: "post" },
    // Milk-crate clutter in the alley.
    { x: -79, z: -6, r: 2.9, h: 2.4, kind: "box", yawv: 0.3 },
    { x: -80, z: 10, r: 2.9, h: 2.4, kind: "box", yawv: -0.4 },
    { x: -78, z: 24, r: 2.9, h: 2.4, kind: "box", yawv: 0.9 },
  ];
  // Parkade pillars (tops BELOW the deck so deck traffic clears them).
  for (const [u, v] of [[-11, -8], [-11, 8], [0, -8], [0, 8], [11, -8], [11, 8]]) {
    const p = pkWorld(u, v);
    obstacles.push({ x: p.x, z: p.z, r: 1.3, h: 7.4, kind: "pillar" });
  }
  // Awning posts (tops just under the raised awning slab).
  for (const [x, z] of [[-17, -46], [17, -46]]) {
    obstacles.push({ x, z, r: 1.0, h: 8.6, kind: "pillar" });
  }
  const itemSpots = [
    { x: 0, z: -72, y: CAFE.h, mode: "float" }, // café roof — the high ground
    { x: 74.5, z: 11.4, y: PK.h, mode: "float" }, // parkade deck
    { x: -62, z: 62, mode: "float" }, // tower top
    { x: 53.8, z: 34.6, y: 1.6, mode: "float" }, // on the bridge
    { x: -79, z: 17, mode: "float" }, // deep in the alley
    { x: 0, z: 16, mode: "float" }, // plaza, by the paw
    { x: 52, z: 47, mode: "float" }, // stream bank
    { x: -40, z: -92, mode: "float" }, // back street west
    { x: 88, z: 74, mode: "float" }, // SE field
    { x: -100, z: -30, mode: "float" }, // W field
    { x: 20, z: 60, mode: "ground" },
    { x: -20, z: -30, mode: "ground" },
    { x: 90, z: -40, mode: "ground" },
    { x: -60, z: 20, mode: "ground" },
    { x: 30, z: 90, mode: "ground" },
    { x: -95, z: 85, mode: "ground" },
  ];
  const respawns = [
    { x: 0, z: 80 }, { x: -90, z: 78 }, { x: 92, z: 66 }, { x: -100, z: -60 },
    { x: 100, z: -55 }, { x: 0, z: -92 }, { x: 56, z: -30 }, { x: -50, z: -60 },
  ];
  return { solids, ramps, decks, kickers, boostPads, obstacles, itemSpots, respawns };
}

// Precompute rotation + bound for a rotated-rect entry.
function prep(b) {
  b.sin = Math.sin(b.yaw || 0);
  b.cos = Math.cos(b.yaw || 0);
  const hw = (b.w != null ? b.w / 2 : b.hw != null ? b.hw : b.W / 2);
  const hd = (b.d != null ? b.d / 2 : b.hd != null ? b.hd : b.L / 2);
  b.bound = Math.hypot(hw, hd) + 1;
  return b;
}

export class Arena {
  constructor() {
    this.isArena = true;
    this.radius = R;
    this.halfWidth = R; // radial fail-safe clamp; the walls contain play
    this.length = Math.PI * 2 * R;
    this.samples = 128;
    this.totalLaps = 3;
    this.raceTime = 0;
    this.features = { runs: [] };
    this.parkade = PK;
    this.megaRamp = MEGA;
    this.butte = BUTTE;
    this.cafe = CAFE;

    const L = makeLayout();
    this.solids = L.solids.map(prep);
    this.ramps = L.ramps.map(prep);
    this.decks = L.decks.map(prep);
    this.kickers = L.kickers;
    this.boostPads = L.boostPads;
    this.obstacles = L.obstacles;
    this._itemSpots = L.itemSpots;
    this.respawns = L.respawns;
    // Ramp feet marked "auto" sit flush on the terrain wherever it rolls.
    // (After ALL layout fields exist — _terrainH reads the kicker list.)
    for (const rp of this.ramps) if (rp.h0 === "auto") rp.h0 = this._terrainH(rp.x, rp.z);

    // Map outline for the minimap / sun-shadow fit: the boundary rectangle.
    this._pts = [];
    this._tans = [];
    const RECT = [[-116, -101], [116, -101], [116, 101], [-116, 101]];
    for (let e = 0; e < 4; e++) {
      const [ax, az] = RECT[e], [bx, bz] = RECT[(e + 1) % 4];
      for (let i = 0; i < 32; i++) {
        const t = i / 32;
        this._pts.push(new THREE.Vector3(ax + (bx - ax) * t, 3.2, az + (bz - az) * t));
        this._tans.push(new THREE.Vector3(Math.sign(bx - ax), 0, Math.sign(bz - az)));
      }
    }

    this.group = new THREE.Group();
    this._build();
  }

  // ---- Ground queries ------------------------------------------------------

  // Organic base: REAL relief now — the flat-plane feel was half the problem.
  // The map is terraced: a raised north terrace carries the café district, an
  // east ridge carries the parkade, the garden sits in a shallow valley, the
  // plaza is a gentle amphitheatre dish, and broad rolling waves keep every
  // straight line alive. The architecture stands on top of all of it.
  _terrainH(x, z) {
    let h = 0.5 * Math.sin(x * 0.045) * Math.sin(z * 0.05); // broad rolling ground

    // Plaza: a soft amphitheatre dish around the fountain.
    h -= 0.8 * smooth01((40 - Math.hypot(x, z + 4)) / 24);

    // North terrace: the café district sits a storey above the plaza.
    h += 3.2 * smooth01((-40 - z) / 18);

    // East ridge under the parkade.
    h += 2.2 * smooth01((48 - Math.hypot(x - 85, z - 10)) / 26);

    // Garden valley.
    h -= 1.2 * smooth01((52 - Math.hypot(x + 40, z - 62)) / 30);

    // Garden moguls (south-west of the plaza; clear of the spawn corridor).
    if (x > -52 && x < -10 && z > 42 && z < 88) {
      const w = smooth01((x + 52) / 8) * smooth01((-10 - x) / 8) * smooth01((z - 42) / 8) * smooth01((88 - z) / 8);
      h += 1.05 * Math.sin(x * 0.33 + 1.0) * Math.sin(z * 0.33) * w;
    }

    // Stream: sunken arc channel.
    {
      const r = Math.hypot(x, z);
      const a = Math.atan2(x, z);
      if (r > STREAM.r - STREAM.half && r < STREAM.r + STREAM.half && a > STREAM.a0 - 0.3 && a < STREAM.a1 + 0.3) {
        const t = (r - STREAM.r) / STREAM.half;
        const w = smooth01((a - STREAM.a0) / 0.25) * smooth01((STREAM.a1 - a) / 0.25);
        h -= STREAM.depth * (0.5 + 0.5 * Math.cos(Math.PI * t)) * w;
      }
    }

    // The spiral tower (round structure).
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

    // Kickers (molded jump bumps — deliberately organic, they're dirt).
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

  // Solid architecture: MAX of block tops over the terrain. Crisp by design.
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
    const out = Math.max(Math.abs(x) - 116, Math.abs(z) - 101);
    return { y: this.heightAt(x, z), dist: Math.max(0, out) };
  }

  distanceToCenter(x, z) {
    return Math.hypot(x, z);
  }

  getPointAt(t, target = new THREE.Vector3()) {
    const a = (((t % 1) + 1) % 1) * Math.PI * 2;
    const r = 56; // menu orbit: sweep the plaza + garden, inside the walls
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
    const back = 74 + Math.floor(index / 2) * 8;
    const lateral = (index % 2 === 0 ? -1 : 1) * 5;
    const pos = new THREE.Vector3(lateral, 0, back);
    pos.y = this.heightAt(lateral, back);
    return { position: pos, heading: Math.PI }; // face the plaza + café
  }

  // ---- Battle physics hooks ------------------------------------------------

  // A wall contact that SLIDES: push out along the wall's true normal and
  // scrub only the head-on speed component. Glancing hits keep most of their
  // pace along the wall — this is what makes architecture feel solid instead
  // of sticky, and kills the clip-into-the-corner artifacts of the old
  // forward-probe pushback.
  _wallContact(k, nx, nz, push, dt) {
    k.position.x += nx * push;
    k.position.z += nz * push;
    const dir = k.speed >= 0 ? 1 : -1;
    const fx = Math.sin(k.heading) * dir, fz = Math.cos(k.heading) * dir;
    const into = Math.max(0, -(fx * nx + fz * nz)); // 1 = square hit, 0 = graze
    k.speed *= 1 - Math.min(0.7, into * into * 6 * dt);
    k.knock.multiplyScalar(0.6);
    k._wallHold = 0.2; // the push isn't a lip — don't let it fake a launch
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

  // Rotated-box collision for one solid (constant top) or ramp (top rises
  // along u). No side walls where the top is near the kart's own level, so a
  // low ramp foot is enterable from ANY angle — you slide on and drive up.
  _collideBox(k, b, isRamp) {
    const kartY = k.position.y + k.y;
    const dx = k.position.x - b.x, dz = k.position.z - b.z;
    let u = dx * b.sin + dz * b.cos;
    let v = dx * b.cos - dz * b.sin;
    let halfU, halfV;
    if (isRamp) {
      halfU = b.L / 2;
      halfV = b.W / 2;
      u -= b.L / 2; // ramp local origin is its foot; recentre
    } else {
      halfU = b.d / 2;
      halfV = b.w / 2;
    }
    const R = k.radius;
    if (Math.abs(u) >= halfU + R || Math.abs(v) >= halfV + R) return false;
    const top = isRamp
      ? b.h0 + (b.h1 - b.h0) * Math.min(1, Math.max(0, (u + halfU) / b.L))
      : b.h;
    if (kartY > top - 0.9) return false; // on/above it — not a wall interaction
    const pu = halfU + R - Math.abs(u);
    const pv = halfV + R - Math.abs(v);
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
    // Only a contact when moving INTO the box. Driving OFF a solid's top edge
    // leaves the kart momentarily inside the box's margin at ground level —
    // pushing there (and arming _wallHold) swallowed the launch, which is why
    // the mega-ramp lip dead-dropped while deck edges flew.
    const dir = k.speed >= 0 ? 1 : -1;
    const fx = Math.sin(k.heading) * dir, fz = Math.cos(k.heading) * dir;
    if (fx * nx + fz * nz > 0.15) return false; // moving away — leaving, not hitting
    this._wallContact(k, nx, nz, push, k._dt || 0.016);
    return true;
  }

  collide(k) {
    let hit = false;
    const dt = k._dt || 0.016;

    // HARD boundary: a rectangle clamp that holds even mid-flight — the walls
    // are scenery, this is the actual edge of the world.
    {
      const BX = 114, BZ = 99;
      if (Math.abs(k.position.x) > BX) {
        const s = Math.sign(k.position.x);
        k.position.x = s * BX;
        this._wallContact(k, -s, 0, 0, dt);
        hit = true;
      }
      if (Math.abs(k.position.z) > BZ) {
        const s = Math.sign(k.position.z);
        k.position.z = s * BZ;
        this._wallContact(k, 0, -s, 0, dt);
        hit = true;
      }
    }

    // Round obstacles (fountain, toys, pillars) — circles slide naturally.
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

    // Architecture: exact box collision with sliding (grounded karts only —
    // an airborne kart above a block's top already passed the height test,
    // and one below it mid-flight should smack it, which this also handles).
    for (const b of this.solids) {
      if (this._collideBox(k, b, false)) hit = true;
    }
    for (const rp of this.ramps) {
      if (this._collideBox(k, rp, true)) hit = true;
    }

    // Steep-wall rule for ORGANIC terrain only (tower cliffs, steep banks) —
    // architecture no longer needs the heuristic.
    if (!k.airborne && k.y <= 0 && Math.abs(k.speed) > 0.5) {
      const dir = k.speed >= 0 ? 1 : -1;
      const fx = Math.sin(k.heading) * dir, fz = Math.cos(k.heading) * dir;
      const hC = this._terrainH(k.position.x, k.position.z);
      const hA = this._terrainH(k.position.x + fx * 1.7, k.position.z + fz * 1.7);
      if (hA - hC > 1.7 * WALL_GRADE) {
        const back = Math.abs(k.speed) * dt + 0.12;
        this._wallContact(k, -fx, -fz, back, dt);
        hit = true;
      }
    }
    return hit;
  }

  // Crest launches + airborne ground continuity. Take-off is PURE BALLISTICS:
  // vy = ground speed x sin(up-face slope behind the lip). No boost, no
  // minimum pop, no float — the honest arc.
  airTransfer(k, dt) {
    const gy = k.groundY;
    const prevGy = k._agy;
    k._agy = gy;
    const px = k._apx, pz = k._apz;
    k._apx = k.position.x;
    k._apz = k.position.z;
    const moved = px === undefined ? 0 : Math.hypot(k.position.x - px, k.position.z - pz);
    if (k._wallHold > 0) k._wallHold -= dt;
    if (prevGy === undefined) return false;

    const drop = prevGy - gy;
    if (drop === 0) return false;
    if (moved > 6 || Math.abs(drop) > 12) return false; // teleport — resync only
    if (k.airborne || k.y > 0) {
      k.y += drop; // world-height continuity while terrain moves below
      if (k.y <= 0) {
        k.y = 0;
        if (k.vy < -2) k._squash = Math.min(1, -k.vy / 14);
        k.vy = 0;
        k.airborne = false;
      }
      return true;
    }
    if (!(k._wallHold > 0) && drop > Math.max(0.05, Math.abs(k.speed) * dt * LAUNCH_SLOPE)) {
      k.y = drop;
      const dir = k.speed >= 0 ? 1 : -1;
      const fx = Math.sin(k.heading) * dir, fz = Math.cos(k.heading) * dir;
      const lipY = k.position.y + drop; // the surface we just left
      // Take-off grade, sampled behind the PREVIOUS grounded position — that
      // point is guaranteed to be on the surface the kart actually drove
      // (sampling behind the current position reads past the lip at large
      // dts, and a stray sample on a wall face made rocket launches). Capped
      // at a real ramp angle either way.
      const bx = (px !== undefined ? px : k.position.x) - fx * 4;
      const bz = (pz !== undefined ? pz : k.position.z) - fz * 4;
      const grade = Math.min(0.55, Math.max(0, (lipY - this.heightNear(bx, bz, lipY)) / 4));
      k.vy = grade > 0.02
        ? Math.abs(k.speed) * grade / Math.sqrt(1 + grade * grade)
        : 0; // ledges drop clean
      k.airborne = true;
      return true;
    }
    return false;
  }

  // ---- Visual build --------------------------------------------------------

  _build() {
    this._buildTerrain();
    this._buildBlocks();
    this._buildDecks();
    this._buildProps();
    this._buildPads();
  }

  // Ground mesh: organic base only (blocks are their own crisp meshes).
  _buildTerrain() {
    const SEG = 220, RINGS = 110;
    const vertCount = 1 + RINGS * SEG;
    const positions = new Float32Array(vertCount * 3);
    const colors = new Float32Array(vertCount * 3);
    const setVert = (i, x, z) => {
      const y = this._terrainH(x, z);
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      const c = this._colorAt(x, z);
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

    // Meadow apron beyond the grid, out past the fog.
    const apron = new THREE.Mesh(
      new THREE.RingGeometry(R - 1, 1400, 64, 1),
      new THREE.MeshStandardMaterial({ color: 0x6fae5a, roughness: 1 })
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -0.06;
    this.group.add(apron);
  }

  _colorAt(x, z) {
    const c = new THREE.Color(0xd9c08f); // packed sand

    // Outside the walls: meadow.
    const out = Math.max(Math.abs(x) - 116, Math.abs(z) - 101);
    if (out > 0) {
      c.set(0x6fae5a);
      return c;
    }

    // Plaza: warm cobble ring around the fountain, with the paw signature.
    {
      const r = Math.hypot(x, z + 4);
      if (r < 36) c.lerp(new THREE.Color(0xcbb17f), 0.7 * smooth01((36 - r) / 8));
      if (Math.abs(r - 33) < 1.2) c.lerp(new THREE.Color(0xefe3c0), 0.6);
      const paw = new THREE.Color(0x9a5c32);
      const pex = x / 4.4, pez = (z - 16) / 5.2;
      if (pex * pex + pez * pez < 1) c.copy(paw);
      for (const t of [-0.72, -0.26, 0.26, 0.72]) {
        const tx = Math.sin(t) * 8.4, tz = 16 + Math.cos(t) * 8.4 * -1;
        if ((x - tx) * (x - tx) + (z - tz) * (z - tz) < 2.1 * 2.1) c.copy(paw);
      }
    }

    // Garden: grassy cast + mogul shading.
    if (x > -62 && x < -6 && z > 38 && z < 92) {
      const w = smooth01((x + 62) / 10) * smooth01((-6 - x) / 10) * smooth01((z - 38) / 8) * smooth01((92 - z) / 8);
      c.lerp(new THREE.Color(0xa8bb7a), w * 0.45);
      const bump = Math.sin(x * 0.33 + 1.0) * Math.sin(z * 0.33);
      if (bump > 0) c.lerp(new THREE.Color(0xe4d4a4), bump * w * 0.5);
      else c.lerp(new THREE.Color(0xa2946e), -bump * w * 0.4);
    }

    // Stream: water!
    {
      const r = Math.hypot(x, z);
      const a = Math.atan2(x, z);
      if (r > STREAM.r - STREAM.half && r < STREAM.r + STREAM.half && a > STREAM.a0 - 0.3 && a < STREAM.a1 + 0.3) {
        const t = (r - STREAM.r) / STREAM.half;
        const w = smooth01((a - STREAM.a0) / 0.25) * smooth01((STREAM.a1 - a) / 0.25);
        const d = (0.5 + 0.5 * Math.cos(Math.PI * t)) * w;
        c.lerp(new THREE.Color(0x9b8560), d * 0.7); // damp banks
        if (d > 0.6) c.lerp(new THREE.Color(0x6fa8c9), (d - 0.6) * 2.0); // wet middle
      }
    }

    // Back street behind the café: paler paving.
    if (z < -86 && z > -100 && Math.abs(x) < 114) c.lerp(new THREE.Color(0xcfc3ae), 0.55);

    // Tower: pale stone ramp + warm deck (painted on the molded round form).
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

    // Kickers: cream face, red lip.
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

  // Solid blocks + ramps: crisp box/wedge meshes matching the physics exactly.
  _buildBlocks() {
    const mats = {
      stone: new THREE.MeshStandardMaterial({ color: 0xb8b0a0, roughness: 0.95 }),
      cafe: new THREE.MeshStandardMaterial({ color: 0xe8d9b8, roughness: 0.9 }),
      concrete: new THREE.MeshStandardMaterial({ color: 0xb9b4a8, roughness: 0.95 }),
      wood: new THREE.MeshStandardMaterial({ color: 0xa9814f, roughness: 0.9 }),
      mega: new THREE.MeshStandardMaterial({ color: 0xc9c4b8, roughness: 0.95 }),
    };
    const trim = new THREE.MeshStandardMaterial({ color: 0x8a8274, roughness: 0.9 });
    const mint = new THREE.MeshStandardMaterial({ color: 0x39e6a0, roughness: 0.6 });
    const hazard = new THREE.MeshStandardMaterial({ color: 0xc4795a, roughness: 0.8 });
    const terra = new THREE.MeshStandardMaterial({ color: 0xcf9159, roughness: 0.95 });

    for (const b of this.solids) {
      const g = new THREE.Group();
      g.position.set(b.x, 0, b.z);
      g.rotation.y = b.yaw || 0;
      const box = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), mats[b.kind] || mats.stone);
      box.position.y = b.h / 2;
      g.add(box);
      // Wall cap trim for the stone pieces; terracotta roof pad for the café.
      if (b.kind === "stone") {
        const cap = new THREE.Mesh(new THREE.BoxGeometry(b.w + 0.5, 0.35, b.d + 0.5), trim);
        cap.position.y = b.h + 0.17;
        g.add(cap);
      } else if (b.kind === "cafe") {
        const roof = new THREE.Mesh(new THREE.BoxGeometry(b.w - 2, 0.12, b.d - 2), terra);
        roof.position.y = b.h + 0.06;
        g.add(roof);
        const edge = new THREE.Mesh(new THREE.BoxGeometry(b.w - 2, 0.08, 1.0), hazard);
        edge.position.set(0, b.h + 0.13, b.d / 2 - 1.4); // south lip: the plaza drop
        g.add(edge);
        // Café face: door + windows on the south wall (flat panels).
        // Door + windows sit on the TERRACE the café stands on, not on y=0.
        const face = new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.9 });
        const door = new THREE.Mesh(new THREE.BoxGeometry(5, 4.4, 0.3), face);
        door.position.set(0, 3.1 + 2.2, b.d / 2 + 0.16);
        g.add(door);
        for (const wx of [-12, 12]) {
          const win = new THREE.Mesh(new THREE.BoxGeometry(7, 2.8, 0.3), new THREE.MeshStandardMaterial({ color: 0xbcd9e8, roughness: 0.4 }));
          win.position.set(wx, 3.1 + 3.1, b.d / 2 + 0.16);
          g.add(win);
        }
      }
      this.group.add(g);
    }

    for (const rp of this.ramps) {
      const g = new THREE.Group();
      g.position.set(rp.x, 0, rp.z);
      g.rotation.y = rp.yaw;
      const w = rp.W / 2;
      const pos = new Float32Array([
        // top surface (u: 0 at foot → L at head; local +z = u)
        -w, rp.h0, 0,  w, rp.h0, 0,  w, rp.h1, rp.L,
        -w, rp.h0, 0,  w, rp.h1, rp.L,  -w, rp.h1, rp.L,
        // skirts
        -w, rp.h0, 0,  -w, rp.h1, rp.L,  -w, 0, rp.L,
        w, rp.h0, 0,  w, 0, rp.L,  w, rp.h1, rp.L,
        // head face
        -w, rp.h1, rp.L,  w, rp.h1, rp.L,  w, 0, rp.L,
        -w, rp.h1, rp.L,  w, 0, rp.L,  -w, 0, rp.L,
      ]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      g.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: (mats[rp.kind] || mats.concrete).color, roughness: 0.95, side: THREE.DoubleSide,
      })));
      // Chevrons up the big launch ramp; a lip stripe on all of them.
      const slope = Math.atan2(rp.h1 - rp.h0, rp.L);
      if (rp.kind === "mega") {
        for (let i = 1; i <= 3; i++) {
          const t = i / 4;
          const strip = new THREE.Mesh(new THREE.BoxGeometry(rp.W - 1.5, 0.08, 1.3), mint);
          strip.position.set(0, rp.h0 + (rp.h1 - rp.h0) * t + 0.08, rp.L * t);
          strip.rotation.x = -slope;
          g.add(strip);
        }
        const lip = new THREE.Mesh(new THREE.BoxGeometry(rp.W - 0.5, 0.1, 1.0), hazard);
        lip.position.set(0, rp.h1 + 0.08, rp.L - 0.5);
        g.add(lip);
      }
      this.group.add(g);
    }
  }

  _buildDecks() {
    const mats = {
      awning: new THREE.MeshStandardMaterial({ color: 0xc95f4e, roughness: 0.85 }),
      concrete: new THREE.MeshStandardMaterial({ color: 0xb9b4a8, roughness: 0.95 }),
      wood: new THREE.MeshStandardMaterial({ color: 0xa9814f, roughness: 0.9 }),
    };
    const cream = new THREE.MeshStandardMaterial({ color: 0xefe3c0, roughness: 0.8 });
    for (const d of this.decks) {
      const g = new THREE.Group();
      g.position.set(d.x, 0, d.z);
      g.rotation.y = d.yaw;
      const slab = new THREE.Mesh(new THREE.BoxGeometry(d.hw * 2, 0.8, d.hd * 2), mats[d.kind] || mats.concrete);
      slab.position.y = d.h - 0.4;
      g.add(slab);
      if (d.kind === "awning") {
        // Striped café awning skirt.
        for (let i = 0; i < 8; i++) {
          const strip = new THREE.Mesh(
            new THREE.BoxGeometry(d.hw * 2 / 8, 0.6, 0.25),
            i % 2 ? cream : mats.awning
          );
          strip.position.set(-d.hw + (i + 0.5) * (d.hw * 2 / 8), d.h - 0.3, d.hd + 0.1);
          g.add(strip);
        }
      } else if (d.kind === "wood") {
        // Bridge rails.
        for (const side of [-1, 1]) {
          const rail = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.9, d.hd * 2), cream);
          rail.position.set(side * (d.hw - 0.2), d.h + 0.45, 0);
          g.add(rail);
        }
      } else if (d.kind === "concrete") {
        // Parkade dressing: stripes + hazard edge on the open end.
        for (const zu of [-10, -5, 0, 5, 10]) {
          const stripe = new THREE.Mesh(new THREE.BoxGeometry(8, 0.06, 0.35), cream);
          stripe.position.set(4.5, d.h + 0.03, zu);
          g.add(stripe);
        }
        const edge = new THREE.Mesh(new THREE.BoxGeometry(d.hw * 2, 0.07, 1.0), new THREE.MeshStandardMaterial({ color: 0xc4795a, roughness: 0.8 }));
        edge.position.set(0, d.h + 0.03, -d.hd + 0.5);
        g.add(edge);
      }
      this.group.add(g);
    }
  }

  _buildProps() {
    const concreteDark = new THREE.MeshStandardMaterial({ color: 0x9a958a, roughness: 0.95 });
    for (const o of this.obstacles) {
      const gy = this.heightAt(o.x, o.z);
      if (o.kind === "fountain") {
        const g = new THREE.Group();
        const basin = new THREE.Mesh(
          new THREE.CylinderGeometry(o.r, o.r + 0.4, 1.6, 20),
          new THREE.MeshStandardMaterial({ color: 0xb8b0a0, roughness: 0.9 })
        );
        basin.position.y = 0.8;
        g.add(basin);
        const water = new THREE.Mesh(
          new THREE.CylinderGeometry(o.r - 0.5, o.r - 0.5, 0.2, 20),
          new THREE.MeshStandardMaterial({ color: 0x6fa8c9, roughness: 0.3 })
        );
        water.position.y = 1.5;
        g.add(water);
        const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.0, 3.4, 12), concreteDark);
        spout.position.y = 3.0;
        g.add(spout);
        const cat = new THREE.Mesh(
          new THREE.SphereGeometry(1.1, 12, 10),
          new THREE.MeshStandardMaterial({ color: 0xcf9159, roughness: 0.9 })
        );
        cat.position.y = 5.1;
        g.add(cat);
        g.position.set(o.x, gy, o.z);
        this.group.add(g);
      } else if (o.kind === "yarn") {
        const g = new THREE.Group();
        const ball = new THREE.Mesh(
          new THREE.SphereGeometry(3.0, 20, 14),
          new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.85 })
        );
        const band = new THREE.Mesh(
          new THREE.TorusGeometry(3.0, 0.4, 8, 20),
          new THREE.MeshStandardMaterial({ color: new THREE.Color(o.color).multiplyScalar(0.7), roughness: 0.85 })
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
      } else if (o.kind === "pillar") {
        // From the local ground up to the collider top (terrain-aware).
        const hgt = Math.max(1, o.h - 0.2 - gy);
        const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.0, hgt, 10), concreteDark);
        pillar.position.set(o.x, gy + hgt / 2, o.z);
        this.group.add(pillar);
      }
    }

    // Tower supports (visual).
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
}
