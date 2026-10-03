// Raised surface features that sit ON the road: launch ramps, kickers,
// tabletops, whoops and speed bumps. Each is a straight slab in the road's
// local frame at a lap fraction `t` — a height profile h(u) along the road
// (u = metres from the feature's centre) across a fixed width — and the set
// hangs off `track.surface`, whose liftAt(x, z) the track adds to every
// projection's groundY. The kart's wheel probes therefore pitch up the ramp
// face and, at the lip, the ground falls away faster than gravity could pull
// the kart down, so Kart._integrate throws it (see the ramp-launch block there).
//
// The mesh is built from the same h(u), sitting on the actual road height
// under each vertex, so what you see is exactly what the physics feels. Prop
// physics (crates, breakable pieces) reads the road triangles and ignores
// these — keep props off the ramps.
import * as THREE from "three";

const UP = new THREE.Vector3(0, 1, 0);
const smooth01 = (t) => {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
};

// Height profiles. `s` is 0..1 along the feature (entry → exit), H its height,
// L its length. Each returns metres above the asphalt.
const PROFILES = {
  // Straight launch ramp: a soft toe, then a flat face rising to H at the lip.
  ramp: (s, H) => H * Math.min(1, s / 0.92) * smooth01(s / 0.18 + 0.4),
  // Kicker: the face curves UP toward the lip (quarter-cosine), so the launch
  // is steeper than a ramp of the same height — more hang, less distance.
  kicker: (s, H) => H * (1 - Math.cos((Math.PI / 2) * Math.min(1, s / 0.95))),
  // Tabletop: ramp up over the first 30%, a flat deck, ramp down the last 30%.
  // Hit it fast enough to clear the deck and you land on the down-ramp.
  tabletop: (s, H) => (s < 0.3 ? H * smooth01(s / 0.3) : s > 0.7 ? H * smooth01((1 - s) / 0.3) : H),
  // Hump: one smooth cosine bump. Big + short = a whoop that throws the kart;
  // long + low = a crest you ride over.
  hump: (s, H) => (H / 2) * (1 - Math.cos(2 * Math.PI * s)),
  // Speed bumps: `count` little humps in a row (a rumble that unsettles the
  // kart without launching it at sane speeds).
  bumps: (s, H, count = 3) => (H / 2) * (1 - Math.cos(2 * Math.PI * s * count)),
  // Drop-off: a plateau at H that ends in a sheer edge (the step down).
  drop: (s, H) => (s < 0.12 ? H * smooth01(s / 0.12) : H),
};
export const SURFACE_TYPES = Object.keys(PROFILES);

// Default dimensions per type (metres) — the playground's presets override them.
const DEFAULTS = {
  ramp: { length: 12, width: 8, height: 2.2, paint: "wood" },
  kicker: { length: 7, width: 6, height: 1.8, paint: "wood" },
  tabletop: { length: 22, width: 9, height: 2.4, paint: "wood" },
  hump: { length: 10, width: 14, height: 1.2, paint: "asphalt" },
  bumps: { length: 9, width: 14, height: 0.22, paint: "asphalt", count: 3 },
  drop: { length: 10, width: 8, height: 1.6, paint: "wood" },
};

const PAINT = {
  wood: { deck: 0x9a7247, stripe: 0xf2c230, skirt: 0x5a4026, stripeDark: 0x2b2b2b },
  asphalt: { deck: 0x4e4e56, stripe: 0xf2c230, skirt: 0x3c3c42, stripeDark: 0x4e4e56 },
};

const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide });
material.userData.shared = true;

export class SurfaceFeatures {
  constructor(track) {
    this.track = track;
    this.items = [];
    this.group = new THREE.Group();
    this.group.name = "surface-features";
    track.surface = this;
  }

  // spec: { type, t, lateral = 0, length, width, height, count, paint, yaw = 0, reverse }
  // `t` is the lap fraction of the feature's centre; `lateral` offsets it across
  // the road (+ = the track's right-hand side); `yaw` skews it off the tangent.
  add(spec) {
    const d = DEFAULTS[spec.type];
    if (!d) throw new Error(`unknown surface feature "${spec.type}"`);
    const o = { ...d, lateral: 0, yaw: 0, ...spec };
    const track = this.track;
    const c = track.getPointAt(o.t, new THREE.Vector3());
    const tan = track.getTangentAt(o.t, new THREE.Vector3());
    tan.y = 0;
    tan.normalize();
    if (o.yaw) tan.applyAxisAngle(UP, o.yaw);
    const side = new THREE.Vector3().crossVectors(tan, UP).normalize();
    c.addScaledVector(side, o.lateral);
    const item = {
      ...o,
      cx: c.x,
      cz: c.z,
      fx: tan.x,
      fz: tan.z,
      sx: side.x,
      sz: side.z,
      halfL: o.length / 2,
      halfW: o.width / 2,
      r2: (o.length * o.length + o.width * o.width) / 4 + 1,
      profile: PROFILES[o.type],
    };
    item.mesh = this._buildMesh(item);
    this.group.add(item.mesh);
    this.items.push(item);
    return item;
  }

  // Height of the feature surface at (u, v) in the feature's frame, 0 outside.
  _h(item, u, v) {
    if (Math.abs(v) > item.halfW || u < -item.halfL || u > item.halfL) return 0;
    let s = (u + item.halfL) / item.length;
    if (item.reverse) s = 1 - s; // e.g. a reversed ramp is a landing ramp
    // Soft shoulders across the width so a wheel at the edge doesn't see a wall.
    const edge = smooth01((item.halfW - Math.abs(v)) / 0.6);
    return item.profile(s, item.height, item.count) * edge;
  }

  // Lift (metres) above the asphalt at world (x, z). Hot path: one AABB-ish
  // reject per feature, a handful of features per track.
  liftAt(x, z) {
    let lift = 0;
    const items = this.items;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const dx = x - it.cx,
        dz = z - it.cz;
      if (dx * dx + dz * dz > it.r2) continue;
      const u = dx * it.fx + dz * it.fz;
      const v = dx * it.sx + dz * it.sz;
      const h = this._h(it, u, v);
      if (h > lift) lift = h;
    }
    return lift;
  }

  // Raw road height (no surface lift) under a world point — the mesh must sit
  // on the asphalt, not on itself.
  _roadY(x, z) {
    const track = this.track;
    return track._projectArr(track._pts, x, z).y;
  }

  _buildMesh(item) {
    const paint = PAINT[item.paint] || PAINT.wood;
    const nu = Math.max(12, Math.ceil(item.length * 3)); // along
    const nv = 6; // across (edge stripes need their own columns)
    const pos = [],
      col = [],
      idx = [];
    const c = new THREE.Color();
    const world = (u, v) => [item.cx + item.fx * u + item.sx * v, item.cz + item.fz * u + item.sz * v];
    // Deck: a grid of rows along u.
    const top = (i, j) => i * (nv + 1) + j;
    for (let i = 0; i <= nu; i++) {
      const u = -item.halfL + (i / nu) * item.length;
      for (let j = 0; j <= nv; j++) {
        const v = -item.halfW + (j / nv) * item.width;
        const [x, z] = world(u, v);
        const h = this._h(item, u, v);
        pos.push(x, this._roadY(x, z) + h + 0.03, z);
        // Paint: hazard stripes along the outer columns; on asphalt humps the
        // stripes run ACROSS instead (speed-bump chevrons).
        const edgeCol = j === 0 || j === nv || j === 1 || j === nv - 1;
        let s = (u + item.halfL) / item.length;
        if (item.reverse) s = 1 - s;
        let stripe = false;
        if (item.paint === "asphalt") stripe = Math.floor(s * (item.count ? item.count * 4 : 8)) % 2 === 0;
        else if (edgeCol) stripe = Math.floor(s * Math.max(4, item.length / 1.2)) % 2 === 0;
        const base = item.paint === "asphalt" ? paint.deck : edgeCol ? paint.stripeDark : paint.deck;
        c.set(stripe ? paint.stripe : base);
        // A little along-grain shading so a flat deck still reads as planks.
        if (item.paint === "wood" && !edgeCol) c.multiplyScalar(0.92 + 0.08 * Math.sin(v * 2.1 + u * 0.3));
        col.push(c.r, c.g, c.b);
      }
    }
    for (let i = 0; i < nu; i++)
      for (let j = 0; j < nv; j++)
        idx.push(top(i, j), top(i + 1, j), top(i, j + 1), top(i, j + 1), top(i + 1, j), top(i + 1, j + 1));
    // Skirts: close the slab down to the road along both long sides and the
    // two ends, so the ramp reads as a solid block rather than a floating sheet.
    const skirt = (u0, v0, u1, v1) => {
      const [xa, za] = world(u0, v0),
        [xb, zb] = world(u1, v1);
      const ya = this._roadY(xa, za),
        yb = this._roadY(xb, zb);
      const ha = this._h(item, u0, v0),
        hb = this._h(item, u1, v1);
      const n = pos.length / 3;
      pos.push(xa, ya - 0.25, za, xb, yb - 0.25, zb, xb, yb + hb + 0.03, zb, xa, ya + ha + 0.03, za);
      c.set(paint.skirt);
      for (let k = 0; k < 4; k++) col.push(c.r, c.g, c.b);
      idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
    };
    for (let i = 0; i < nu; i++) {
      const u0 = -item.halfL + (i / nu) * item.length,
        u1 = -item.halfL + ((i + 1) / nu) * item.length;
      skirt(u0, -item.halfW, u1, -item.halfW);
      skirt(u0, item.halfW, u1, item.halfW);
    }
    for (let j = 0; j < nv; j++) {
      const v0 = -item.halfW + (j / nv) * item.width,
        v1 = -item.halfW + ((j + 1) / nv) * item.width;
      skirt(-item.halfL, v0, -item.halfL, v1);
      skirt(item.halfL, v0, item.halfL, v1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.surfaceFeature = item.type;
    return mesh;
  }

  clear() {
    for (const it of this.items) {
      this.group.remove(it.mesh);
      it.mesh.geometry.dispose();
    }
    this.items.length = 0;
  }
}
