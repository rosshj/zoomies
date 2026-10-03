// Breakable roadside scenes: market stalls, racks, café seating, pallet stacks,
// tyre piles, luggage carts, scrap heaps, log piles, pot stacks, campsites…
// Unlike a single road prop (one rigid hull that gets flung), a scene is an
// ASSEMBLY — it stands intact as a group of pieces at their rest poses, and a
// kart hit lets every piece go at once as its own PropPhysics body (the roof
// canvas sails, the posts cartwheel, the fruit tumbles and rolls, the tyres
// roll off down the road and become obstacles in their own right). Cosmetic
// bursts (splinters, paper, cloth) come from the shared debris pools on top.
//
// Scenes are PROCEDURAL: a handful of generators (stall, stack, seating, cart,
// heap, pallets, rack) take a recipe's parameters, a size (0 small, 1 medium,
// 2 large) and a seeded rand, so every biome gets its own flavour of each
// (a pumpkin stand in autumn, a coconut stall on the beach, a log pile in the
// forest, a pot stack in the desert) at varying sizes without hand-building
// forty structures. Stacks and piles are built from the shipped road props
// (road-prop-assets.js), so they inherit that art and physics; everything
// else is one vertex-coloured, normal-shaded geometry per piece, boxes /
// cylinders / cones only. Every piece's geometry is built around its OWN
// origin so the physics hull is relative to the point the body integrates at.
//
// props.js owns the runtime (addBreakable / breakStructure / reset there);
// this module is pure data + art so the asset viewer can show each scene
// intact. BIOME_SCENES says which recipes a biome scatters along its road.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { radialProfile, ringHull, makeRoadProp, roadPropArt, ROAD_PROPS } from "./road-prop-assets.js";

const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
material.userData.shared = true;
const sheetMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide });
sheetMaterial.userData.shared = true;

// Physics profile for a piece — same fields PropPhysics reads for road props.
const P = (sound, extra = {}) => ({
  sound,
  launch: 0.65,
  lift: 1,
  restitution: 0.28,
  friction: 6,
  angularDrag: 7,
  ...extra,
});
const WOOD = P("wood", { launch: 0.75, lift: 1.2, restitution: 0.22 });
const PLANK = P("wood", { launch: 0.95, lift: 1.5, restitution: 0.25, angularDrag: 5 });
const HEAVY_WOOD = P("wood", { launch: 0.42, lift: 0.8, restitution: 0.15, friction: 8 });
const CANVAS = P("rustle", { launch: 0.9, lift: 1.9, restitution: 0.05, airDrag: 1.5, gravity: 18, friction: 9 });
const METAL = P("metal", { launch: 0.55, lift: 1.0, restitution: 0.3, friction: 5 });
const HEAVY_METAL = P("metal", { launch: 0.3, lift: 0.45, restitution: 0.1, friction: 8, angularDrag: 8 });
const PLASTIC = P("plastic", { launch: 1.0, lift: 1.4, restitution: 0.35, friction: 5 });
const PAPER = P("rustle", { launch: 1.0, lift: 1.7, restitution: 0.05, airDrag: 1.3, gravity: 20, friction: 10 });
const FRUIT = P("fruit", { shape: "sphere", launch: 0.8, lift: 1.1, restitution: 0.42, friction: 2.2, angularDrag: 3 });
const FISH = P("fruit", { launch: 0.85, lift: 1.3, restitution: 0.08, friction: 9, angularDrag: 9 });
const CASE = P("plastic", { launch: 0.9, lift: 1.3, restitution: 0.22, friction: 6 });
const BARREL = P("metal", {
  shape: "cylinder",
  launch: 0.5,
  lift: 0.9,
  restitution: 0.25,
  friction: 3,
  angularDrag: 4,
});
const STONE = P("stone", { launch: 0.4, lift: 0.6, restitution: 0.12, friction: 8, angularDrag: 8 });

// ---- Tiny vertex-coloured part builder (one merged geometry per piece) --------
class Parts {
  constructor() {
    this.geos = [];
    this._tint = new THREE.Color();
  }
  add(geo, color, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
    geo.rotateX(rx).rotateY(ry).rotateZ(rz).translate(x, y, z);
    const p = geo.attributes.position,
      n = geo.attributes.normal;
    this._tint.set(color);
    const t = this._tint;
    const values = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const shade = 0.83 + 0.17 * Math.max(0, n.getY(i) * 0.8 + n.getX(i) * 0.3 + n.getZ(i) * 0.2);
      values.set([t.r * shade, t.g * shade, t.b * shade], i * 3);
    }
    geo.setAttribute("color", new THREE.BufferAttribute(values, 3));
    geo.deleteAttribute("uv");
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    this.geos.push(g);
    return this;
  }
  box(w, h, d, col, x = 0, y = 0, z = 0, ry = 0, rz = 0, rx = 0) {
    return this.add(new THREE.BoxGeometry(w, h, d), col, x, y, z, rx, ry, rz);
  }
  cyl(rTop, rBot, h, col, x = 0, y = 0, z = 0, seg = 10, rx = 0, ry = 0, rz = 0) {
    return this.add(new THREE.CylinderGeometry(rTop, rBot, h, seg), col, x, y, z, rx, ry, rz);
  }
  ball(r, col, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) {
    return this.add(new THREE.IcosahedronGeometry(r, 1).scale(sx, sy, sz), col, x, y, z);
  }
  finish() {
    const geo = mergeGeometries(this.geos);
    for (const g of this.geos) g.dispose();
    geo.computeBoundingBox();
    return geo;
  }
}

// Hull from a geometry: the 8 bbox corners (boxy things), or a ring hull
// around its radial silhouette (round things that should roll/wobble).
function boxHull(geo) {
  const b = geo.boundingBox,
    out = [];
  for (const x of [b.min.x, b.max.x])
    for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) out.push(new THREE.Vector3(x, y, z));
  return out;
}
function radialHull(geo) {
  const p = geo.attributes.position,
    pts = [];
  for (let i = 0; i < p.count; i += 3) pts.push(new THREE.Vector3().fromBufferAttribute(p, i));
  return ringHull(radialProfile(pts, false));
}

// Scenes are authored at 1u ≈ 1m; the kart is ~2u per real metre, so each
// recipe scales itself up (recipe.scale) to sit against the kart — the scale
// is applied here, to the geometry AND the rest poses, so hulls stay exact.
// Shipped road props (stacks, piles) are already kart-scale and stay as they are.
let _scale = 1;

// One piece of a scene: its mesh (a Group holding the single draw, like
// makeRoadProp), physics hull, rest height and profile, plus its rest pose
// INSIDE the scene. `scatter` biases its launch (roof pieces fly higher).
function piece(name, geo, profile, local, opts = {}) {
  if (_scale !== 1) {
    geo.scale(_scale, _scale, _scale);
    geo.computeBoundingBox();
  }
  const hull = opts.hull === "radial" ? radialHull(geo) : boxHull(geo);
  const mesh = new THREE.Group();
  const draw = new THREE.Mesh(geo, opts.sheet ? sheetMaterial : material);
  mesh.add(draw); // no castShadow: pieces fly, and the sun map is baked once (blob shadows instead)
  const quat = new THREE.Quaternion();
  if (local.yaw || local.roll || local.pitch)
    quat.setFromEuler(new THREE.Euler(local.pitch || 0, local.yaw || 0, local.roll || 0, "YXZ"));
  return {
    name,
    mesh,
    hull,
    rest: -geo.boundingBox.min.y,
    profile,
    local: { pos: new THREE.Vector3(local.x || 0, local.y || 0, local.z || 0).multiplyScalar(_scale), quat },
    scatter: { up: 1, out: 1, spin: 1, ...(opts.scatter || {}) },
  };
}
// A shipped road prop (tyre, hay bale, pot…) as a piece: same art + hull the
// game uses. `local` is in SCENE units (scaled like everything else), but the
// art itself is not scaled.
function roadPiece(kind, local, opts = {}) {
  const built = makeRoadProp(kind);
  built.mesh.rotation.set(0, 0, 0); // pose comes from `local`, not the stand default
  const quat = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(local.pitch || 0, local.yaw || 0, local.roll || 0, "YXZ"),
  );
  return {
    name: kind,
    mesh: built.mesh,
    hull: built.hull,
    rest: built.rest,
    profile: built.profile,
    local: { pos: new THREE.Vector3(local.x || 0, local.y || 0, local.z || 0), quat },
    scatter: { up: 1, out: 1, spin: 1, ...(opts.scatter || {}) },
  };
}
// Footprint of a shipped prop for stacking: half-length along its own axis
// (`rest`), cross radius, and whether it lies on its side when at rest.
function propDims(kind) {
  const art = roadPropArt(kind),
    spec = ROAD_PROPS[kind];
  let cross = 0;
  for (const v of art.hull) cross = Math.max(cross, Math.hypot(v.x, v.z));
  return { half: art.rest, cross, lying: !!spec.stand, sphere: spec.sphereRadius || 0 };
}

const C = {
  wood: 0x9a6b3f,
  woodDark: 0x6d4a2a,
  woodPale: 0xc9a06a,
  weathered: 0x8d8372,
  steel: 0x8e959c,
  steelDark: 0x4d545b,
  rust: 0x7d4b2c,
  brass: 0xc9a24a,
  white: 0xf2f0ea,
  cream: 0xeadfc8,
  red: 0xd8463c,
  blue: 0x3b78c2,
  navy: 0x27456f,
  green: 0x4d9a4a,
  yellow: 0xf0c330,
  orange: 0xf0962c,
  teal: 0x3aa6a0,
  pink: 0xe0729a,
  purple: 0x8e6bc0,
  lavender: 0xb49ddc,
  black: 0x2b2b2b,
  rubber: 0x2e2f33,
  ice: 0xdcecf4,
  fish: 0x9fc3d8,
  fishDark: 0x5d7f99,
  leather: 0x6b3f2a,
  fridge: 0xdfe3e6,
  stone: 0x7d7a74,
  lava: 0x4a3a38,
};
const pick = (rand, list) => list[Math.floor(rand() * list.length) % list.length];
const jit = (rand, k) => (rand() - 0.5) * k;

// Striped canvas sheet: alternating bands along x, tinted per vertex.
function canvasSheet(w, d, colA, colB, bands = 6) {
  const geo = new THREE.BoxGeometry(w, 0.06, d, bands, 1, 1);
  const p = geo.attributes.position,
    n = geo.attributes.normal,
    a = new THREE.Color(colA),
    b = new THREE.Color(colB),
    values = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const band = Math.floor(((p.getX(i) + w / 2) / w) * bands - 1e-4);
    const c = band % 2 === 0 ? a : b;
    const shade = 0.86 + 0.14 * Math.max(0, n.getY(i));
    values.set([c.r * shade, c.g * shade, c.b * shade], i * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(values, 3));
  geo.deleteAttribute("uv");
  const g = geo.toNonIndexed();
  geo.dispose();
  g.computeBoundingBox();
  return g;
}

// ---- Goods: what a stall sells (per biome) -------------------------------------
// Each returns pieces for `n` items around (cx, cy, cz) on a counter.
const GOODS = {
  fruit: (pieces, rand, cx, cy, cz, n) => {
    const cols = [C.red, C.green, C.orange, C.yellow];
    for (let i = 0; i < n; i++)
      pieces.push(
        piece(
          "fruit",
          new Parts()
            .ball(0.26, pick(rand, cols), 0, 0, 0, 1, 0.95, 1)
            .cyl(0.03, 0.03, 0.12, C.woodDark, 0, 0.28, 0, 6)
            .finish(),
          { ...FRUIT, sphereRadius: 0.26 },
          { x: cx + jit(rand, 1.1), y: cy + 0.27, z: cz + jit(rand, 0.6) },
          { scatter: { up: 1.1, out: 1.4, spin: 2 } },
        ),
      );
  },
  fish: (pieces, rand, cx, cy, cz, n) => {
    pieces.push(
      piece(
        "ice tray",
        new Parts().box(1.3, 0.26, 1.2, C.steel).box(1.2, 0.2, 1.1, C.ice, 0, 0.1, 0).finish(),
        METAL,
        { x: cx, y: cy + 0.13, z: cz },
        { scatter: { up: 0.8, out: 0.8, spin: 0.6 } },
      ),
    );
    for (let i = 0; i < n; i++)
      pieces.push(
        piece(
          "fish",
          new Parts()
            .ball(0.3, i % 3 === 0 ? C.fishDark : C.fish, 0, 0, 0, 1.3, 0.35, 0.5)
            .box(0.2, 0.03, 0.28, C.fishDark, 0.42, 0, 0)
            .finish(),
          FISH,
          { x: cx + jit(rand, 1.0), y: cy + 0.38, z: cz + jit(rand, 0.7), yaw: jit(rand, 1.2) },
          { scatter: { up: 1.0, out: 1.3, spin: 1.5 } },
        ),
      );
  },
  flowers: (pieces, rand, cx, cy, cz, n) => {
    const cols = [C.lavender, C.purple, C.pink, C.white];
    for (let i = 0; i < n; i++)
      pieces.push(
        piece(
          "bouquet",
          new Parts()
            .cyl(0.09, 0.07, 0.4, C.green, 0, 0.2, 0, 6)
            .ball(0.22, pick(rand, cols), 0, 0.5, 0, 1, 0.8, 1)
            .ball(0.16, pick(rand, cols), 0.12, 0.56, 0.08)
            .finish(),
          { ...PAPER, launch: 0.9, lift: 1.5 },
          { x: cx + jit(rand, 1.1), y: cy, z: cz + jit(rand, 0.6), yaw: rand() * 6 },
          { scatter: { up: 1.3, out: 1.2, spin: 1.8 } },
        ),
      );
  },
  lanterns: (pieces, rand, cx, cy, cz, n) => {
    const cols = [C.red, C.orange, C.pink, C.yellow];
    for (let i = 0; i < n; i++)
      pieces.push(
        piece(
          "lantern",
          new Parts()
            .ball(0.28, pick(rand, cols), 0, 0, 0, 1, 0.85, 1)
            .cyl(0.1, 0.1, 0.06, C.black, 0, 0.26, 0, 6)
            .finish(),
          { ...PAPER, launch: 0.9, lift: 1.6, restitution: 0.3 },
          { x: cx + jit(rand, 1.1), y: cy + 0.26, z: cz + jit(rand, 0.6) },
          { scatter: { up: 1.5, out: 1.1, spin: 1.3 } },
        ),
      );
  },
  // Shipped props as goods: pumpkins, coconuts, pots, snowballs, mangoes…
  road: (kind) => (pieces, rand, cx, cy, cz, n) => {
    const d = propDims(kind);
    for (let i = 0; i < n; i++)
      pieces.push(
        roadPiece(kind, {
          x: (cx + jit(rand, 1.0)) * _scale,
          y: cy * _scale + d.half,
          z: (cz + jit(rand, 0.5)) * _scale,
          yaw: rand() * 6,
          pitch: d.lying ? Math.PI / 2 : 0,
        }),
      );
  },
};

// ---- Generators -------------------------------------------------------------
// Each: (p, rand, size) -> { pieces, hitPoints, height, radius } in scene units.

// A market stall: counter, posts, striped awning, battens, goods on top. Size
// 0 is a narrow single bay, 1 the standard stall, 2 a double stall with
// crates of extra goods on the ground beside it.
function stall(p, rand, size) {
  const W = [3.0, 4.0, 7.2][size];
  const bays = size === 2 ? 2 : 1;
  const pieces = [];
  pieces.push(
    piece(
      "counter",
      new Parts()
        .box(W, 0.14, 1.6, C.woodPale, 0, 0.83, 0)
        .box(W - 0.1, 0.7, 1.45, p.wood || C.wood, 0, 0.4, 0)
        .box(W, 0.08, 1.6, C.woodDark, 0, 0.04, 0)
        .finish(),
      HEAVY_WOOD,
      { x: 0, y: 0, z: 0 },
      { scatter: { up: 0.6, out: 0.7, spin: 0.5 } },
    ),
  );
  const px = W / 2 - 0.1;
  const posts = [
    [-px, -0.72],
    [px, -0.72],
    [-px, 0.72],
    [px, 0.72],
  ];
  if (bays === 2) posts.push([0, -0.72], [0, 0.72]);
  for (const [x, z] of posts)
    pieces.push(
      piece(
        "post",
        new Parts().box(0.14, 2.5, 0.14, C.woodDark).finish(),
        PLANK,
        { x, y: 1.25, z },
        {
          scatter: { up: 1.3, out: 1.2, spin: 1.6 },
        },
      ),
    );
  pieces.push(
    piece(
      "awning",
      canvasSheet(W + 0.8, 2.3, p.canvas[0], p.canvas[1], Math.round((W + 0.8) * 1.7)),
      CANVAS,
      { x: 0, y: 2.58, z: 0, pitch: -0.12 },
      { sheet: true, scatter: { up: 2.2, out: 1.0, spin: 1.2 } },
    ),
  );
  for (const bz of [-1.1, 1.1])
    pieces.push(
      piece(
        "batten",
        new Parts().box(W + 0.4, 0.08, 0.08, C.wood).finish(),
        PLANK,
        { x: 0, y: 2.5, z: bz },
        {
          scatter: { up: 1.6, out: 1.0, spin: 1.8 },
        },
      ),
    );
  // Crates on the counter, goods on/around them.
  const crates = size === 0 ? 2 : size === 1 ? 3 : 5;
  for (let i = 0; i < crates; i++) {
    const cx = -W / 2 + 0.75 + (i * (W - 1.5)) / Math.max(1, crates - 1);
    pieces.push(
      piece(
        "crate",
        new Parts()
          .box(1.0, 0.42, 0.9, i % 2 ? C.woodPale : C.wood)
          .box(0.9, 0.05, 0.8, C.woodDark, 0, 0.19, 0)
          .finish(),
        WOOD,
        { x: cx, y: 1.11, z: 0.05 },
      ),
    );
  }
  const goods = typeof p.goods === "string" ? GOODS[p.goods] : p.goods;
  goods(pieces, rand, 0, 1.33, 0, [5, 8, 13][size]);
  // Large: a couple of full crates on the ground beside the stall.
  if (size === 2)
    for (const gx of [-W / 2 - 0.8, W / 2 + 0.8]) {
      pieces.push(
        piece("crate", new Parts().box(1.1, 0.5, 1.0, C.woodPale).finish(), WOOD, {
          x: gx,
          y: 0.25,
          z: 0.3,
          yaw: jit(rand, 0.5),
        }),
      );
      goods(pieces, rand, gx, 0.5, 0.3, 3);
    }
  const hitPoints = [];
  for (let x = -W / 2; x <= W / 2 + 0.01; x += Math.max(1.4, W / 3)) hitPoints.push([x, 0]);
  return { pieces, hitPoints, height: 2.7, radius: W / 2 + 1.4 };
}

// A stack / pile of a shipped road prop: a pyramid of lying cylinders (hay,
// logs, bamboo), columns of upright things (tyres, cases, pots, canisters),
// or a loose pile of spheres (snowballs, coconuts, beach balls). Sizes grow
// the count; `pattern` overrides the automatic choice.
function stack(p, rand, size) {
  const kind = p.kind,
    d = propDims(kind);
  const pattern = p.pattern || (d.sphere ? "pile" : d.lying ? "pyramid" : "columns");
  const pieces = [];
  const n = (p.counts || [3, 6, 10])[size];
  const r = d.sphere || d.cross;
  let radius = 0,
    height = 0;
  const put = (x, y, z, extra = {}) => {
    pieces.push(
      roadPiece(
        kind,
        { x, y, z, yaw: extra.yaw ?? 0, pitch: extra.pitch ?? 0 },
        { scatter: { up: 0.8 + y * 0.25, out: 1.1, spin: 1.4 } },
      ),
    );
    radius = Math.max(radius, Math.hypot(x, z) + Math.max(r, d.half));
    height = Math.max(height, y + r);
  };
  if (pattern === "pyramid") {
    // Lying cylinders, axis across the scene's X (so they roll off down the
    // road when a kart hits the stack side-on). Rows of n-k, nested.
    let left = n,
      row = 0;
    const per = Math.ceil((Math.sqrt(8 * n + 1) - 1) / 2);
    for (let k = per; k >= 1 && left > 0; k--) {
      const m = Math.min(k, left);
      for (let i = 0; i < m; i++)
        // Axis ACROSS the scene (pitch only), rows side by side along the
        // scene's X: a real pyramid, not bales end to end that read as one
        // column; each course sits in the hollows of the one below.
        put((i - (m - 1) / 2) * r * 2.02 + jit(rand, 0.06), r + row * r * 1.74, jit(rand, 0.15), {
          yaw: jit(rand, 0.08),
          pitch: Math.PI / 2,
        });
      left -= m;
      row++;
    }
  } else if (pattern === "pile") {
    // Spheres, close packed like fruit on a market floor: the base is a
    // triangular lattice (each ball touching its neighbours), and the few on
    // top sit in the hollows between three base balls (height r·(1+√(8/3))).
    // `single` (beach balls, floats: too light to stack) keeps one layer.
    for (const spot of closePack(n, r, !!p.single, rand)) put(spot.x, spot.y, spot.z, { yaw: rand() * 6 });
  } else {
    // Columns of upright things, side by side, heights varied.
    const h = d.lying ? d.cross * 2 : d.half * 2; // tyres etc. stacked FLAT
    const cols = size === 0 ? 1 : size === 1 ? 2 : 3;
    let left = n;
    for (let c = 0; c < cols && left > 0; c++) {
      const m = Math.min(left, Math.ceil(n / cols) + (c === 0 ? 1 : 0));
      const cx = (c - (cols - 1) / 2) * (r * 2.3),
        cz = (c % 2) * r * 0.9;
      for (let k = 0; k < m; k++)
        put(cx + jit(rand, 0.06), (d.lying ? d.cross : d.half) + k * h * 1.02, cz + jit(rand, 0.06), {
          yaw: rand() * 6,
          pitch: 0,
        });
      left -= m;
    }
  }
  const hitPoints = [[0, 0]];
  if (radius > 1.6) hitPoints.push([-radius * 0.55, 0], [radius * 0.55, 0]);
  return { pieces, hitPoints, height: height + 0.3, radius: radius + 0.4 };
}

// Close-packed positions for `n` spheres of radius r: a triangular lattice
// base filled outward from the centre (so the footprint stays round), then
// the remainder nestled in the hollows of three touching base spheres. Each
// spot is jittered a hair so the pile reads as dropped, not machined.
function closePack(n, r, single, rand) {
  const d = r * 2.02;
  const lattice = [];
  for (let q = -4; q <= 4; q++) for (let w = -4; w <= 4; w++) lattice.push({ x: (q + w * 0.5) * d, z: w * d * 0.866 });
  lattice.sort((a, b) => a.x * a.x + a.z * a.z - (b.x * b.x + b.z * b.z));
  const baseN = single ? n : Math.max(3, Math.ceil(n * 0.7));
  const base = lattice.slice(0, baseN);
  const out = base.map((s) => ({ x: s.x + jit(rand, 0.08), y: r, z: s.z + jit(rand, 0.08) }));
  if (single) return out;
  // Hollows: centroids of touching triples, nearest the centre first.
  const hollows = [];
  for (let i = 0; i < base.length; i++)
    for (let j = i + 1; j < base.length; j++)
      for (let k = j + 1; k < base.length; k++) {
        const a = base[i],
          b = base[j],
          c = base[k];
        const dd = (p, q) => Math.hypot(p.x - q.x, p.z - q.z);
        if (dd(a, b) > d * 1.1 || dd(b, c) > d * 1.1 || dd(a, c) > d * 1.1) continue;
        hollows.push({ x: (a.x + b.x + c.x) / 3, z: (a.z + b.z + c.z) / 3 });
      }
  hollows.sort((a, b) => a.x * a.x + a.z * a.z - (b.x * b.x + b.z * b.z));
  const h2 = r * (1 + Math.sqrt(8 / 3));
  for (let i = 0; i < n - baseN && i < hollows.length; i++) out.push({ x: hollows[i].x, y: h2, z: hollows[i].z });
  return out;
}

// Tables, chairs and parasols. Size 0 is one table and two chairs, 1 two
// tables with a parasol, 2 three tables with two parasols. `theme` picks the
// furniture: "cafe" (plastic bistro), "picnic" (wooden benches), "beach"
// (loungers), "tea" (low lacquered tables).
function seating(p, rand, size) {
  const pieces = [];
  const tables = [1, 2, 3][size];
  const theme = p.theme || "cafe";
  const chairCols = p.chairs || [C.white, C.teal, C.white, C.red, C.white, C.yellow];
  let ci = 0;
  const tableX = (i) => (i - (tables - 1) / 2) * 4.2;
  for (let t = 0; t < tables; t++) {
    const tx = tableX(t);
    if (theme === "picnic") {
      const yaw = jit(rand, 0.3);
      pieces.push(
        piece(
          "picnic table",
          new Parts()
            .box(2.2, 0.08, 0.9, C.woodPale, 0, 0.75, 0)
            .box(0.08, 0.75, 0.8, C.woodDark, -0.8, 0.375, 0)
            .box(0.08, 0.75, 0.8, C.woodDark, 0.8, 0.375, 0)
            .box(1.6, 0.06, 0.08, C.woodDark, 0, 0.3, 0)
            .finish(),
          HEAVY_WOOD,
          { x: tx, y: 0, z: 0, yaw },
          { scatter: { up: 0.8, out: 0.8, spin: 0.7 } },
        ),
      );
      for (const bz of [-0.8, 0.8])
        pieces.push(
          piece(
            "bench",
            new Parts()
              .box(2.0, 0.07, 0.35, C.wood, 0, 0.45, 0)
              .box(0.07, 0.45, 0.3, C.woodDark, -0.75, 0.225, 0)
              .box(0.07, 0.45, 0.3, C.woodDark, 0.75, 0.225, 0)
              .finish(),
            WOOD,
            { x: tx - Math.sin(yaw) * bz, y: 0, z: Math.cos(yaw) * bz, yaw },
            { scatter: { up: 1.2, out: 1.2, spin: 1.5 } },
          ),
        );
    } else if (theme === "beach") {
      for (const dz of [-1.1, 1.1])
        pieces.push(
          piece(
            "lounger",
            new Parts()
              .box(0.7, 0.06, 1.6, pick(rand, chairCols), 0, 0.35, 0.2)
              .box(0.7, 0.9, 0.06, pick(rand, chairCols), 0, 0.75, -0.65, 0, 0, -0.5)
              .box(0.05, 0.35, 1.5, C.wood, -0.33, 0.17, 0.2)
              .box(0.05, 0.35, 1.5, C.wood, 0.33, 0.17, 0.2)
              .finish(),
            PLASTIC,
            { x: tx + dz * 0.9, y: 0, z: dz * 0.3, yaw: jit(rand, 0.4) },
            { scatter: { up: 1.2, out: 1.2, spin: 1.5 } },
          ),
        );
      pieces.push(
        piece(
          "cooler",
          new Parts().box(0.8, 0.55, 0.5, C.blue).box(0.8, 0.06, 0.5, C.white, 0, 0.3, 0).finish(),
          CASE,
          {
            x: tx,
            y: 0.28,
            z: 1.4,
            yaw: jit(rand, 0.6),
          },
        ),
      );
    } else {
      const low = theme === "tea";
      pieces.push(
        piece(
          "table",
          new Parts()
            .cyl(0.9, 0.9, 0.07, low ? C.red : C.cream, 0, low ? 0.42 : 0.74, 0, 14)
            .cyl(0.07, 0.09, low ? 0.4 : 0.7, low ? C.black : C.steelDark, 0, low ? 0.2 : 0.37, 0, 8)
            .cyl(0.42, 0.46, 0.05, low ? C.black : C.steelDark, 0, 0.025, 0, 10)
            .finish(),
          { ...METAL, launch: 0.6, lift: 1.1 },
          { x: tx, y: 0, z: 0 },
          { hull: "radial", scatter: { up: 1.1, out: 0.9, spin: 1.1 } },
        ),
      );
      const chairs = size === 0 ? 2 : 3;
      for (let k = 0; k < chairs; k++) {
        const a = (k / chairs) * Math.PI * 2 + (t % 2 ? 0.6 : 0.1);
        const cx = tx + Math.cos(a) * 1.45,
          cz = Math.sin(a) * 1.45;
        const col = chairCols[ci++ % chairCols.length];
        const chair = low
          ? new Parts().box(0.5, 0.06, 0.5, col, 0, 0.22, 0).box(0.5, 0.2, 0.05, C.black, 0, 0.32, -0.23)
          : new Parts().box(0.5, 0.05, 0.5, col, 0, 0.45, 0).box(0.5, 0.5, 0.05, col, 0, 0.72, -0.23);
        for (const [lx, lz] of [
          [-0.21, -0.21],
          [0.21, -0.21],
          [-0.21, 0.21],
          [0.21, 0.21],
        ])
          chair.box(0.04, low ? 0.22 : 0.45, 0.04, col, lx, low ? 0.11 : 0.225, lz);
        pieces.push(
          piece(
            "chair",
            chair.finish(),
            PLASTIC,
            { x: cx, y: 0, z: cz, yaw: -a + Math.PI / 2 + jit(rand, 0.4) },
            {
              scatter: { up: 1.3, out: 1.3, spin: 1.8 },
            },
          ),
        );
      }
    }
  }
  // Parasols: one between/over the tables at size 1, two at size 2.
  const parasols = size === 0 ? 0 : size === 1 ? 1 : 2;
  const pc = p.parasol || [C.red, C.cream];
  for (let i = 0; i < parasols; i++) {
    const px = parasols === 1 ? 0 : (i - 0.5) * 4.2;
    const umb = new Parts()
      .cyl(0.33, 0.38, 0.12, C.steelDark, 0, 0.06, 0, 10)
      .cyl(0.045, 0.045, 2.7, C.steel, 0, 1.4, 0, 8)
      .cyl(0.04, 0.04, 0.2, C.brass, 0, 2.95, 0, 6);
    const canopy = new THREE.CylinderGeometry(0.02, 1.7, 0.55, 8, 1, true);
    const cp = canopy.attributes.position,
      cn = canopy.attributes.normal;
    const colA = new THREE.Color(pc[0]),
      colB = new THREE.Color(pc[1]),
      cv = new Float32Array(cp.count * 3);
    for (let k = 0; k < cp.count; k++) {
      const ang = Math.atan2(cp.getX(k), cp.getZ(k)) + Math.PI;
      const panel = Math.floor((ang / (Math.PI * 2)) * 8 + 1e-3) % 8;
      const c = panel % 2 ? colA : colB;
      const shade = 0.84 + 0.16 * Math.max(0, cn.getY(k) * 0.8 + cn.getX(k) * 0.3);
      cv.set([c.r * shade, c.g * shade, c.b * shade], k * 3);
    }
    canopy.setAttribute("color", new THREE.BufferAttribute(cv, 3));
    canopy.deleteAttribute("uv");
    canopy.translate(0, 2.62, 0);
    umb.geos.push(canopy.toNonIndexed());
    canopy.dispose();
    pieces.push(
      piece(
        "parasol",
        umb.finish(),
        {
          ...CANVAS,
          shape: "cylinder",
          launch: 0.75,
          lift: 1.5,
          airDrag: 0.8,
          gravity: 22,
          friction: 6,
          angularDrag: 5,
        },
        { x: px, y: 0, z: 0.3 },
        { hull: "radial", sheet: true, scatter: { up: 1.6, out: 0.8, spin: 1.4 } },
      ),
    );
  }
  const hitPoints = [];
  for (let t = 0; t < tables; t++) hitPoints.push([tableX(t), 0], [tableX(t) + 1.4, 0.8]);
  const span = tables === 1 ? 2.4 : (tables - 1) * 2.1 + 2.4;
  return { pieces, hitPoints, height: parasols ? 3.2 : 1.2, radius: span + 0.4 };
}

// Wheeled carts: a hotel baggage trolley piled with cases ("luggage"), a
// wooden market barrow of produce ("barrow"), or a desert wagon of pots and
// barrels ("wagon"). Size grows the load; 2 adds a second cart.
function cart(p, rand, size) {
  const pieces = [];
  const theme = p.theme || "luggage";
  const carts = size === 2 ? 2 : 1;
  const hitPoints = [];
  for (let c = 0; c < carts; c++) {
    const ox = (c - (carts - 1) / 2) * 3.6,
      oy = 0;
    if (theme === "luggage") {
      const cartP = new Parts()
        .box(2.2, 0.08, 1.1, C.leather, 0, 0.5, 0)
        .box(2.2, 0.04, 1.1, C.brass, 0, 0.56, 0)
        .box(0.08, 0.08, 1.1, C.brass, -1.05, 2.45, 0)
        .box(0.08, 0.08, 1.1, C.brass, 1.05, 2.45, 0)
        .box(2.2, 0.06, 0.06, C.brass, 0, 2.45, -0.5)
        .box(2.2, 0.06, 0.06, C.brass, 0, 2.45, 0.5);
      for (const [ux, uz] of [
        [-1.05, -0.5],
        [1.05, -0.5],
        [-1.05, 0.5],
        [1.05, 0.5],
      ])
        cartP.cyl(0.04, 0.04, 1.9, C.brass, ux, 1.5, uz, 8);
      for (const [wx, wz] of [
        [-0.8, -0.45],
        [0.8, -0.45],
        [-0.8, 0.45],
        [0.8, 0.45],
      ])
        cartP.cyl(0.17, 0.17, 0.1, C.rubber, wx, 0.17, wz, 10, Math.PI / 2);
      pieces.push(
        piece(
          "cart",
          cartP.finish(),
          { ...METAL, launch: 0.5, lift: 0.9 },
          { x: ox, y: oy, z: 0 },
          { scatter: { up: 0.8, out: 0.8, spin: 0.7 } },
        ),
      );
      const cols = [C.red, C.navy, C.leather, C.teal, C.yellow, C.pink, C.green, C.purple, C.orange, C.black];
      const n = [4, 7, 7][size];
      for (let i = 0; i < n; i++) {
        const w = 0.9 - i * 0.05,
          h = 0.32 - i * 0.015,
          dd = 0.65 - i * 0.03;
        pieces.push(
          piece(
            "suitcase",
            new Parts()
              .box(w, h, dd, cols[(i + c * 3) % cols.length])
              .box(w * 0.3, h * 0.4, 0.05, C.black, 0, 0, dd / 2)
              .box(w + 0.02, 0.03, dd + 0.02, C.black, 0, h * 0.1, 0)
              .finish(),
            CASE,
            {
              x: ox + (i % 2 ? 0.5 : -0.55) + jit(rand, 0.1),
              y: 0.7 + Math.floor(i / 2) * 0.3,
              z: jit(rand, 0.2),
              yaw: jit(rand, 0.5),
            },
            { scatter: { up: 1.3, out: 1.3, spin: 1.8 } },
          ),
        );
      }
      pieces.push(
        piece(
          "duffel",
          new Parts().cyl(0.26, 0.26, 0.8, C.orange, 0, 0, 0, 10, 0, 0, Math.PI / 2).finish(),
          { ...CASE, shape: "cylinder", restitution: 0.1, friction: 7 },
          { x: ox + 0.1, y: 0.7 + Math.ceil(n / 2) * 0.3 + 0.1, z: 0.05, yaw: 0.2 },
          { hull: "radial", scatter: { up: 1.5, out: 1.2, spin: 1.5 } },
        ),
      );
    } else {
      // Barrow / wagon: a wooden bed on two big wheels, handles, a load.
      const wagon = theme === "wagon";
      const bed = new Parts()
        .box(2.4, 0.1, 1.3, C.wood, 0, 0.75, 0)
        .box(2.4, 0.45, 0.08, C.woodPale, 0, 1.0, -0.65)
        .box(2.4, 0.45, 0.08, C.woodPale, 0, 1.0, 0.65)
        .box(0.08, 0.45, 1.3, C.woodPale, -1.2, 1.0, 0)
        .box(0.08, 0.45, 1.3, C.woodPale, 1.2, 1.0, 0)
        .box(0.08, 0.08, 1.6, C.woodDark, 1.5, 0.85, 0)
        .box(0.08, 0.08, 1.6, C.woodDark, -1.5, 0.85, 0)
        .box(0.12, 0.12, 1.7, C.woodDark, wagon ? -0.8 : 0, 0.65, 0) // axle beam
        .box(2.0, 0.1, 0.12, C.woodDark, 0, 0.65, 0); // spine
      if (!wagon)
        bed.box(0.07, 0.7, 0.07, C.woodDark, 0.9, 0.35, -0.5).box(0.07, 0.7, 0.07, C.woodDark, 0.9, 0.35, 0.5);
      pieces.push(
        piece(
          "barrow",
          bed.finish(),
          HEAVY_WOOD,
          { x: ox, y: oy, z: 0 },
          { scatter: { up: 0.7, out: 0.8, spin: 0.6 } },
        ),
      );
      for (const wz of [-0.85, 0.85])
        pieces.push(
          roadPiece(
            "wagonWheel",
            { x: (ox - (wagon ? 0.8 : 0)) * _scale, y: 0.75, z: wz * _scale, pitch: Math.PI / 2 },
            { scatter: { up: 1.0, out: 1.3, spin: 1.6 } },
          ),
        );
      if (wagon)
        for (const wz of [-0.85, 0.85])
          pieces.push(roadPiece("wagonWheel", { x: (ox + 0.9) * _scale, y: 0.75, z: wz * _scale, pitch: Math.PI / 2 }));
      const goods = typeof p.goods === "string" ? GOODS[p.goods] : p.goods;
      goods(pieces, rand, ox, 0.82, 0, [4, 7, 7][size]);
    }
    hitPoints.push([ox - 0.8, 0], [ox + 0.8, 0]);
  }
  return { pieces, hitPoints, height: 2.5, radius: carts === 2 ? 4.0 : 2.0 };
}

// A heap of heavy junk: scrap (fridge, washer, drums, car door, tyres), rocks
// ("rock": pumice / stone boulders), or a woodpile ("logs"). Size adds items.
function heap(p, rand, size) {
  const pieces = [];
  const theme = p.theme || "scrap";
  const n = [5, 8, 12][size];
  const drum = (tint) =>
    new Parts()
      .cyl(0.42, 0.42, 1.2, tint, 0, 0, 0, 12)
      .cyl(0.44, 0.44, 0.06, C.rust, 0, 0.35, 0, 12)
      .cyl(0.44, 0.44, 0.06, C.rust, 0, -0.35, 0, 12)
      .finish();
  const items = {
    scrap: [
      () =>
        piece(
          "fridge",
          new Parts()
            .box(0.9, 1.9, 0.8, C.fridge, 0, 0.95, 0)
            .box(0.86, 0.02, 0.02, C.steelDark, 0, 1.25, 0.41)
            .box(0.06, 0.5, 0.05, C.steelDark, 0.32, 1.5, 0.42)
            .finish(),
          HEAVY_METAL,
          { x: -1.5, y: 0, z: 0.2, yaw: 0.35 },
          { scatter: { up: 0.5, out: 0.6, spin: 0.5 } },
        ),
      () =>
        piece(
          "washer",
          new Parts()
            .box(0.8, 0.9, 0.8, C.white, 0, 0.45, 0)
            .cyl(0.26, 0.26, 0.06, C.steelDark, 0, 0.5, 0.41, 14, Math.PI / 2)
            .cyl(0.2, 0.2, 0.08, C.navy, 0, 0.5, 0.42, 14, Math.PI / 2)
            .finish(),
          HEAVY_METAL,
          { x: -0.3, y: 0, z: -0.6, yaw: -0.5 },
          { scatter: { up: 0.6, out: 0.7, spin: 0.6 } },
        ),
      () => piece("drum", drum(C.rust), BARREL, { x: 0.9, y: 0.6, z: 0.4 }, { hull: "radial" }),
      () =>
        piece(
          "drum",
          drum(C.steelDark),
          BARREL,
          { x: 1.7, y: 0.42, z: -0.5, pitch: Math.PI / 2, yaw: 0.4 },
          { hull: "radial" },
        ),
      () =>
        piece(
          "car door",
          new Parts().box(1.4, 1.0, 0.1, C.blue, 0, 0, 0).box(1.3, 0.42, 0.04, C.ice, 0, 0.26, 0.04).finish(),
          { ...METAL, launch: 0.7, lift: 1.3, airDrag: 0.6 },
          { x: -0.2, y: 0.55, z: 0.95, roll: 0.55, yaw: 0.2 },
          { scatter: { up: 1.3, out: 1.1, spin: 1.5 } },
        ),
      () => roadPiece("tire", { x: 1.1 * _scale, y: 0.25, z: 1.4 * _scale, yaw: 0.5 }),
      () =>
        piece(
          "drum",
          drum(C.red),
          BARREL,
          { x: 0.9, y: 1.62, z: 0.4, pitch: Math.PI / 2, yaw: 1.2 },
          { hull: "radial" },
        ),
      () => roadPiece("tire", { x: 1.9 * _scale, y: 0.75, z: 1.1 * _scale, pitch: Math.PI / 2, yaw: 0.9, roll: 0.25 }),
      () =>
        piece(
          "exhaust",
          new Parts()
            .cyl(0.07, 0.07, 1.6, C.rust, 0, 0, 0, 8)
            .cyl(0.16, 0.16, 0.5, C.steelDark, 0, -0.3, 0, 10)
            .finish(),
          { ...METAL, shape: "cylinder", launch: 0.9, lift: 1.4, angularDrag: 4 },
          { x: 0.2, y: 0.17, z: -1.3, pitch: Math.PI / 2, yaw: 0.9 },
          { hull: "radial" },
        ),
      () =>
        piece(
          "hubcap",
          new Parts().cyl(0.3, 0.3, 0.05, C.steel, 0, 0, 0, 12).finish(),
          { ...METAL, shape: "cylinder", launch: 1.0, lift: 1.5, restitution: 0.4, angularDrag: 3 },
          { x: 1.9, y: 0.03, z: 0.9 },
          { hull: "radial" },
        ),
      () =>
        piece(
          "hubcap",
          new Parts().cyl(0.3, 0.3, 0.05, C.steel, 0, 0, 0, 12).finish(),
          { ...METAL, shape: "cylinder", launch: 1.0, lift: 1.5, restitution: 0.4, angularDrag: 3 },
          { x: 2.0, y: 0.09, z: 1.2, yaw: 1 },
          { hull: "radial" },
        ),
      () => roadPiece("canister", { x: -2.2 * _scale, y: 0.6, z: -0.6 * _scale, yaw: 0.3 }),
    ],
  };
  if (theme === "rock") {
    // A heap of rubble: close packed like the fruit piles (big rocks at the
    // base, a few nestled in the hollows on top), each rock its own lump.
    const col = p.color || C.stone;
    const R = 0.62;
    const spots = closePack(n, R, false, rand);
    spots.forEach((sp, i) => {
      const top = sp.y > R * 1.5;
      const r = (top ? 0.46 : 0.58) + rand() * 0.14;
      pieces.push(
        piece(
          "boulder",
          new Parts().ball(r, col, 0, 0, 0, 1 + jit(rand, 0.4), 0.78 + jit(rand, 0.25), 1 + jit(rand, 0.4)).finish(),
          { ...STONE, launch: 0.5 - r * 0.2, lift: 0.9 - r * 0.3 },
          { x: sp.x, y: top ? sp.y - (R - r) * 0.6 : r * 0.78, z: sp.z, yaw: rand() * 6 },
          { hull: "radial", scatter: { up: 0.8, out: 1.0, spin: 1.2 } },
        ),
      );
    });
    return {
      pieces,
      hitPoints: [
        [0, 0],
        [-1.2, 0.6],
        [1.2, -0.6],
      ],
      height: 2.2,
      radius: 2.6,
    };
  }
  const list = items[theme] || items.scrap;
  for (let i = 0; i < Math.min(n, list.length); i++) pieces.push(list[i]());
  return {
    pieces,
    hitPoints: [
      [-1.4, 0.2],
      [0.3, -0.4],
      [1.4, 0.6],
    ],
    height: 2.1,
    radius: 3.0,
  };
}

// Stacked shipping pallets (+ loose planks at size 2).
function pallets(p, rand, size) {
  const pieces = [];
  const pallet = (tint) => {
    const q = new Parts();
    for (const z of [-0.6, 0, 0.6]) q.box(1.8, 0.09, 0.12, C.woodDark, 0, 0.045, z);
    for (let k = 0; k < 5; k++) q.box(1.78, 0.035, 0.22, tint, 0, 0.11, -0.6 + k * 0.3);
    for (const z of [-0.65, 0.65]) q.box(1.8, 0.035, 0.18, tint, 0, -0.02, z);
    return q.finish();
  };
  const stacks = [
    [{ x: 0, z: 0, n: 3 }],
    [
      { x: -1.6, z: 0, n: 5 },
      { x: 0.75, z: 0.25, n: 3 },
    ],
    [
      { x: -2.2, z: 0, n: 6 },
      { x: 0.1, z: 0.3, n: 4 },
      { x: 2.3, z: -0.2, n: 2 },
    ],
  ][size];
  for (const s of stacks)
    for (let k = 0; k < s.n; k++)
      pieces.push(
        piece(
          "pallet",
          pallet([C.weathered, C.woodPale, C.wood][k % 3]),
          { ...HEAVY_WOOD, launch: 0.55 + k * 0.08, lift: 0.9 + k * 0.12, angularDrag: 6 },
          { x: s.x + jit(rand, 0.12), y: 0.04 + k * 0.17, z: s.z + jit(rand, 0.12), yaw: jit(rand, 0.12) },
          { scatter: { up: 0.8 + k * 0.25, out: 0.9, spin: 1.2 } },
        ),
      );
  if (size === 2)
    for (let k = 0; k < 4; k++)
      pieces.push(
        piece(
          "plank",
          new Parts().box(0.16, 1.9, 0.04, k % 2 ? C.woodPale : C.wood).finish(),
          PLANK,
          { x: -3.25 + k * 0.17, y: 0.9, z: -0.5 + k * 0.3, roll: 0.42, yaw: 0.1 * k },
          {
            scatter: { up: 1.8, out: 1.2, spin: 2.2 },
          },
        ),
      );
  return { pieces, hitPoints: stacks.map((s) => [s.x, s.z]), height: 1.2, radius: [1.4, 2.9, 3.6][size] };
}

// A storefront wire rack of magazines (+ a coin box at size 1, two racks at 2).
function rack(p, rand, size) {
  const pieces = [];
  const racks = size === 2 ? 2 : 1;
  const covers = [C.red, C.yellow, C.teal, C.pink, C.blue, C.green, C.orange, C.white];
  const hitPoints = [];
  for (let r = 0; r < racks; r++) {
    const ox = (r - (racks - 1) / 2) * 2.4;
    const rk = new Parts();
    for (const px of [-0.8, 0.8])
      rk.box(0.05, 1.9, 0.05, C.steelDark, px, 0.95, -0.2).box(0.05, 0.05, 0.6, C.steelDark, px, 0.03, 0);
    const shelves = size === 0 ? 4 : 5;
    for (let s = 0; s < shelves; s++) {
      const y = 0.35 + s * 0.38;
      rk.box(1.66, 0.04, 0.04, C.steel, 0, y, -0.2 + s * 0.03);
      rk.box(1.66, 0.04, 0.04, C.steel, 0, y + 0.02, 0.22 - s * 0.03);
      for (let k = -3; k <= 3; k++) rk.box(0.03, 0.03, 0.44, C.steel, k * 0.26, y + 0.01, 0.01);
    }
    pieces.push(
      piece("rack", rk.finish(), METAL, { x: ox, y: 0, z: 0 }, { scatter: { up: 0.9, out: 0.9, spin: 0.8 } }),
    );
    for (let s = 0; s < shelves; s++)
      for (let k = -1; k <= 1; k++)
        pieces.push(
          piece(
            "magazine",
            new Parts()
              .box(0.44, 0.07, 0.58, C.white)
              .box(0.44, 0.012, 0.58, covers[(s * 3 + k + 7 + r) % covers.length], 0, 0.04, 0)
              .finish(),
            PAPER,
            { x: ox + k * 0.52, y: 0.42 + s * 0.38, z: 0.02 + s * 0.01, pitch: -0.25, yaw: jit(rand, 0.15) },
            { scatter: { up: 1.4, out: 1.3, spin: 2.2 } },
          ),
        );
    hitPoints.push([ox, 0]);
  }
  if (size >= 1) {
    const bx = racks === 2 ? 2.9 : 1.45;
    pieces.push(
      piece(
        "news box",
        new Parts()
          .box(0.7, 1.2, 0.6, C.blue, 0, 0.6, 0)
          .box(0.56, 0.5, 0.04, C.ice, 0, 0.85, 0.31)
          .box(0.5, 0.06, 0.08, C.steel, 0, 0.45, 0.32)
          .finish(),
        PLASTIC,
        { x: bx, y: 0, z: 0.1 },
      ),
    );
    pieces.push(
      piece(
        "newspapers",
        new Parts().box(0.5, 0.18, 0.4, C.cream).box(0.5, 0.02, 0.4, C.white, 0, 0.1, 0).finish(),
        PAPER,
        { x: bx, y: 1.29, z: 0.05, yaw: 0.2 },
        {
          scatter: { up: 1.6, out: 1.4, spin: 2.4 },
        },
      ),
    );
    hitPoints.push([bx, 0]);
  }
  return { pieces, hitPoints, height: 2.0, radius: racks === 2 ? 3.6 : size >= 1 ? 2.4 : 1.4 };
}

const GEN = { stall, stack, seating, cart, heap, pallets, rack };

// ---- Recipes ------------------------------------------------------------------
// name/blurb for the UI; gen + params for the generator; scale; sound, debris
// and slow (the pace a kart loses breaking it) for the runtime.
const R = (name, gen, params, extra) => ({
  name,
  gen,
  params,
  scale: 1.3,
  sound: "wood",
  debris: ["splinter"],
  slow: 0.25,
  ...extra,
});
export const BREAKABLES = {
  // --- the playground's originals ---
  marketStall: R(
    "Market stand (fruit)",
    "stall",
    { canvas: [0xd8463c, 0xf2f0ea], goods: "fruit" },
    {
      blurb: "Wooden fruit stand: the canvas sails, posts cartwheel, apples and oranges roll everywhere.",
      debris: ["splinter", "apple", "orange"],
      slow: 0.3,
    },
  ),
  fishStall: R(
    "Fish stall",
    "stall",
    { canvas: [0x3b78c2, 0xf2f0ea], goods: "fish", wood: 0x6d4a2a },
    {
      blurb: "Iced fish counter: the tray goes, and a dozen fish slap across the tarmac and stay put.",
      debris: ["fish", "splinter"],
      slow: 0.3,
    },
  ),
  newsRack: R(
    "Newspaper rack",
    "rack",
    {},
    {
      scale: 1.5,
      sound: "metal",
      debris: ["paper", "paper"],
      slow: 0.08,
      blurb: "Storefront wire rack and a coin box: the frame goes over, magazines and papers fly loose.",
    },
  ),
  cafeSeating: R(
    "Café seating",
    "seating",
    { theme: "cafe" },
    {
      scale: 1.45,
      sound: "plastic",
      debris: ["cloth", "splinter"],
      slow: 0.18,
      blurb: "Bistro tables, plastic chairs and a parasol: chairs scatter, the parasol flips.",
    },
  ),
  palletStack: R(
    "Pallet stack",
    "pallets",
    {},
    {
      debris: ["splinter", "splinter"],
      slow: 0.3,
      blurb: "Stacked shipping pallets: they snap apart under the wheels and loose planks shoot into the air.",
    },
  ),
  tireStack: R(
    "Tyre pile",
    "stack",
    { kind: "tire", counts: [4, 8, 14] },
    {
      scale: 1,
      sound: "rubber",
      debris: ["dust"],
      slow: 0.25,
      blurb: "Columns of loose tyres: they topple and roll off down the road as live obstacles.",
    },
  ),
  luggageCart: R(
    "Luggage cart",
    "cart",
    { theme: "luggage" },
    {
      scale: 1.35,
      sound: "metal",
      debris: ["cloth", "paper"],
      slow: 0.2,
      blurb: "A hotel baggage trolley piled with suitcases: the cart tips and the cases burst open.",
    },
  ),
  scrapHeap: R(
    "Scrap heap",
    "heap",
    { theme: "scrap" },
    {
      sound: "metal",
      debris: ["rust", "dust"],
      slow: 0.32,
      blurb: "A fridge, a washer, rusty drums, a car door and a few tyres: heavy junk that shifts, slides and bounces.",
    },
  ),
  // --- biome flavours ---
  pumpkinStand: R(
    "Pumpkin stand",
    "stall",
    { canvas: [0xf0962c, 0x6d4a2a], goods: GOODS.road("pumpkin"), wood: 0x8d8372 },
    { debris: ["splinter", "orange"], slow: 0.3 },
  ),
  coconutStall: R(
    "Coconut stall",
    "stall",
    { canvas: [0x3aa6a0, 0xf2f0ea], goods: GOODS.road("coconut") },
    { debris: ["splinter"], slow: 0.3 },
  ),
  mangoStand: R(
    "Mango stand",
    "stall",
    { canvas: [0x4d9a4a, 0xf0c330], goods: GOODS.road("tropicalFruit") },
    { debris: ["splinter", "mango"], slow: 0.3 },
  ),
  flowerStand: R(
    "Flower stand",
    "stall",
    { canvas: [0xb49ddc, 0xf2f0ea], goods: "flowers", wood: 0xc9a06a },
    { debris: ["splinter", "cloth"], slow: 0.28 },
  ),
  lanternStall: R(
    "Lantern stall",
    "stall",
    { canvas: [0xd8463c, 0xf0c330], goods: "lanterns", wood: 0x2b2b2b },
    { debris: ["splinter", "paper"], slow: 0.28 },
  ),
  potStall: R(
    "Pottery stall",
    "stall",
    { canvas: [0xc9a06a, 0x7d4b2c], goods: GOODS.road("clayPot") },
    { debris: ["splinter", "clay"], slow: 0.3 },
  ),
  snowballStand: R(
    "Snowball stand",
    "stall",
    { canvas: [0x3b78c2, 0xdcecf4], goods: GOODS.road("snowball"), wood: 0x8d8372 },
    { debris: ["splinter", "snow"], slow: 0.3 },
  ),
  hayStack: R(
    "Hay bale stack",
    "stack",
    { kind: "hayBale", counts: [3, 6, 10] },
    { scale: 1, sound: "hay", debris: ["dust"], slow: 0.35 },
  ),
  logPile: R(
    "Log pile",
    "stack",
    { kind: "log", counts: [3, 6, 10] },
    { scale: 1, debris: ["splinter", "splinter"], slow: 0.4 },
  ),
  bambooStack: R(
    "Bamboo stack",
    "stack",
    { kind: "bambooBundle", counts: [3, 6, 10] },
    { scale: 1, debris: ["splinter"], slow: 0.3 },
  ),
  potStack: R(
    "Clay pot stack",
    "stack",
    { kind: "clayPot", counts: [3, 6, 9] },
    { scale: 1, sound: "pot", debris: ["clay", "clay"], slow: 0.2 },
  ),
  supplyStack: R(
    "Supply crate stack",
    "stack",
    { kind: "supplyCase", counts: [3, 6, 9] },
    { scale: 1, sound: "plastic", debris: ["splinter"], slow: 0.3 },
  ),
  canisterStack: R(
    "Canister stack",
    "stack",
    { kind: "canister", counts: [3, 6, 10] },
    { scale: 1, sound: "metal", debris: ["rust", "dust"], slow: 0.3 },
  ),
  snowballPile: R(
    "Snowball pile",
    "stack",
    { kind: "snowball", counts: [4, 7, 12] },
    { scale: 1, sound: "snow", debris: ["snow", "snow"], slow: 0.1 },
  ),
  iceBlocks: R(
    "Ice blocks",
    "stack",
    { kind: "iceChunk", counts: [3, 6, 9], pattern: "columns" },
    { scale: 1, sound: "ice", debris: ["snow"], slow: 0.3 },
  ),
  coconutPile: R(
    "Coconut pile",
    "stack",
    { kind: "coconut", counts: [5, 9, 14] },
    { scale: 1, sound: "coconut", debris: ["dust"], slow: 0.15 },
  ),
  ballPile: R(
    "Beach ball pile",
    "stack",
    { kind: "beachBall", counts: [3, 5, 8], single: true },
    { scale: 1, sound: "rubber", debris: [], slow: 0.05 },
  ),
  floatPile: R(
    "Fishing float pile",
    "stack",
    { kind: "fishingFloat", counts: [4, 7, 11], single: true },
    { scale: 1, sound: "plastic", debris: [], slow: 0.1 },
  ),
  basketStack: R(
    "Apple basket stack",
    "stack",
    { kind: "fruitBasket", counts: [2, 4, 6], pattern: "columns" },
    { scale: 1, debris: ["apple", "splinter"], slow: 0.2 },
  ),
  coneRow: R(
    "Cone cluster",
    "stack",
    { kind: "trafficCone", counts: [3, 5, 8], pattern: "columns" },
    { scale: 1, sound: "plastic", debris: [], slow: 0.05 },
  ),
  campRolls: R(
    "Bedroll stack",
    "stack",
    { kind: "campRoll", counts: [3, 6, 9] },
    { scale: 1, sound: "hay", debris: ["cloth"], slow: 0.15 },
  ),
  picnic: R(
    "Picnic tables",
    "seating",
    { theme: "picnic", parasol: [0x4d9a4a, 0xf2f0ea] },
    { scale: 1.4, debris: ["splinter", "cloth"], slow: 0.25 },
  ),
  beachChairs: R(
    "Beach loungers",
    "seating",
    { theme: "beach", chairs: [0xf0c330, 0x3aa6a0, 0xf2f0ea, 0xe0729a], parasol: [0xf0c330, 0xf2f0ea] },
    { scale: 1.4, sound: "plastic", debris: ["cloth"], slow: 0.15 },
  ),
  teaHouse: R(
    "Tea house seating",
    "seating",
    { theme: "tea", chairs: [0xd8463c, 0x2b2b2b, 0xd8463c], parasol: [0xe0729a, 0xf2f0ea] },
    { scale: 1.4, debris: ["cloth", "paper"], slow: 0.18 },
  ),
  marketBarrow: R(
    "Market barrow",
    "cart",
    { theme: "barrow", goods: "fruit" },
    { debris: ["splinter", "apple"], slow: 0.25 },
  ),
  pumpkinBarrow: R(
    "Pumpkin barrow",
    "cart",
    { theme: "barrow", goods: GOODS.road("pumpkin") },
    { debris: ["splinter", "orange"], slow: 0.25 },
  ),
  potWagon: R(
    "Pot wagon",
    "cart",
    { theme: "wagon", goods: GOODS.road("clayPot") },
    { debris: ["splinter", "clay"], slow: 0.3 },
  ),
  rockPile: R(
    "Rock pile",
    "heap",
    { theme: "rock", color: 0x7d7a74 },
    { sound: "stone", debris: ["dust", "dust"], slow: 0.4 },
  ),
  lavaRocks: R(
    "Pumice heap",
    "heap",
    { theme: "rock", color: 0x4a3a38 },
    { sound: "stone", debris: ["dust", "rust"], slow: 0.35 },
  ),
};
export const BREAKABLE_KINDS = Object.keys(BREAKABLES);

// Which recipes a biome scatters along its road (props.js picks per slot).
export const BIOME_SCENES = {
  meadow: ["marketStall", "hayStack", "picnic", "marketBarrow"],
  forest: ["logPile", "campRolls", "picnic", "supplyStack"],
  alpine: ["supplyStack", "iceBlocks", "logPile", "campRolls"],
  autumn: ["pumpkinStand", "basketStack", "pumpkinBarrow", "hayStack"],
  beach: ["coconutStall", "beachChairs", "ballPile", "coconutPile"],
  desert: ["potStack", "potWagon", "potStall", "rockPile"],
  mesa: ["potStack", "potWagon", "rockPile", "canisterStack"],
  tundra: ["snowballPile", "supplyStack", "iceBlocks", "snowballStand"],
  city: ["newsRack", "cafeSeating", "luggageCart", "tireStack", "scrapHeap", "palletStack", "coneRow"],
  jungle: ["bambooStack", "mangoStand", "supplyStack", "coconutPile"],
  wetlands: ["fishStall", "floatPile", "bambooStack", "logPile"],
  volcanic: ["canisterStack", "scrapHeap", "lavaRocks", "palletStack"],
  savanna: ["potStack", "potWagon", "logPile", "hayStack"],
  blossom: ["teaHouse", "lanternStall", "basketStack", "flowerStand"],
  lavender: ["flowerStand", "hayStack", "picnic", "marketBarrow"],
};
export const SIZE_LABELS = ["S", "M", "L"];

// Build a scene's pieces assembled at rest in one Group (the intact look),
// plus the data props.js needs to let it go. `size` is 0 small, 1 medium,
// 2 large; `rand` seeds the per-piece jitter so a layout rebuilds the same way.
export function makeBreakable(kind, rand = Math.random, size = 1) {
  const spec = BREAKABLES[kind];
  if (!spec) throw new Error(`unknown breakable "${kind}"`);
  _scale = spec.scale || 1;
  const built = GEN[spec.gen](spec.params, rand, Math.max(0, Math.min(2, size | 0)));
  const s = _scale;
  _scale = 1;
  built.hitPoints = built.hitPoints.map(([x, z]) => [x * s, z * s]);
  built.height *= s;
  built.radius *= s;
  const group = new THREE.Group();
  for (const pc of built.pieces) {
    pc.mesh.position.copy(pc.local.pos);
    pc.mesh.quaternion.copy(pc.local.quat);
    group.add(pc.mesh);
  }
  return {
    kind,
    spec,
    size,
    group,
    pieces: built.pieces,
    hitPoints: built.hitPoints,
    height: built.height,
    radius: built.radius,
  };
}
