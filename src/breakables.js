// Breakable road structures: market stalls, news racks, café seating, pallet
// stacks, tyre piles, luggage carts and scrap heaps. Unlike a single road prop
// (one rigid hull that gets flung), a structure is an ASSEMBLY — it stands
// intact as a group of pieces at their rest poses, and a kart hit lets every
// piece go at once as its own PropPhysics body (the roof canvas sails, the
// posts cartwheel, the fruit tumbles and rolls, the tyres roll off down the
// road and become obstacles in their own right). Cosmetic bursts (splinters,
// paper, cloth) come from the shared debris pools on top.
//
// Art here follows road-prop-assets.js: one vertex-coloured, normal-shaded
// geometry per piece, boxes/cylinders/cones only (nothing here is a molded
// organic surface). Every piece's geometry is built around its OWN origin so
// the physics hull (bbox corners, or a radial ring hull for round things) is
// relative to the point the body is integrated at.
//
// props.js owns the runtime (see addBreakable / breakStructure there); this
// module is pure data + art so the asset viewer can show each one intact.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { radialProfile, ringHull, makeRoadProp } from "./road-prop-assets.js";

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

// Structures are authored at 1u ≈ 1m; the kart is ~2u per real metre, so each
// spec scales itself up (spec.scale) to sit against the kart — the scale is
// applied here, to the geometry AND the rest poses, so hulls stay exact.
let _scale = 1;

// One piece of a structure: its mesh (a Group holding the single draw, like
// makeRoadProp), physics hull, rest height and profile, plus its rest pose
// INSIDE the structure. `scatter` biases its launch (roof pieces fly higher).
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
// A shipped road prop (tyre, etc.) as a piece: same art + hull the game uses.
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
    local: { pos: new THREE.Vector3(local.x || 0, local.y || 0, local.z || 0).multiplyScalar(_scale), quat },
    scatter: { up: 1, out: 1, spin: 1, ...(opts.scatter || {}) },
  };
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
  black: 0x2b2b2b,
  rubber: 0x2e2f33,
  ice: 0xdcecf4,
  fish: 0x9fc3d8,
  fishDark: 0x5d7f99,
  leather: 0x6b3f2a,
  fridge: 0xdfe3e6,
};

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

// ---- Shared sub-assemblies -------------------------------------------------
// A stall frame: counter, four posts, a canvas roof. `fill` adds what's for sale.
function stallPieces(rand, canvasA, canvasB, fill) {
  const pieces = [];
  pieces.push(
    piece(
      "counter",
      new Parts()
        .box(4.0, 0.14, 1.6, C.woodPale, 0, 0.83, 0)
        .box(3.9, 0.7, 1.45, C.wood, 0, 0.4, 0)
        .box(4.0, 0.08, 1.6, C.woodDark, 0, 0.04, 0)
        .finish(),
      HEAVY_WOOD,
      { x: 0, y: 0, z: 0 },
      { scatter: { up: 0.6, out: 0.7, spin: 0.5 } },
    ),
  );
  for (const [px, pz] of [
    [-1.9, -0.72],
    [1.9, -0.72],
    [-1.9, 0.72],
    [1.9, 0.72],
  ])
    pieces.push(
      piece(
        "post",
        new Parts().box(0.14, 2.5, 0.14, C.woodDark).finish(),
        PLANK,
        { x: px, y: 1.25, z: pz },
        {
          scatter: { up: 1.3, out: 1.2, spin: 1.6 },
        },
      ),
    );
  // Roof canvas: a striped sheet (it carries its own per-band colours).
  const roofGeo = canvasSheet(4.8, 2.3, canvasA, canvasB, 8);
  pieces.push(
    piece(
      "awning",
      roofGeo,
      CANVAS,
      { x: 0, y: 2.58, z: 0, pitch: -0.12 },
      {
        sheet: true,
        scatter: { up: 2.2, out: 1.0, spin: 1.2 },
      },
    ),
  );
  // Two roof battens the canvas hung on.
  for (const bz of [-1.1, 1.1])
    pieces.push(
      piece(
        "batten",
        new Parts().box(4.4, 0.08, 0.08, C.wood).finish(),
        PLANK,
        { x: 0, y: 2.5, z: bz },
        {
          scatter: { up: 1.6, out: 1.0, spin: 1.8 },
        },
      ),
    );
  fill(pieces, rand);
  return pieces;
}

// ---- The structures ----------------------------------------------------------
// Each build(rand) returns { pieces, hitPoints: [[lx, lz]...], height, radius }.
// hitPoints are the spots (structure-local XZ) a kart's swept path must pass
// within HIT_R of to set the whole thing off — one per ~3u of footprint.
export const BREAKABLES = {
  marketStall: {
    name: "Market stand (fruit)",
    scale: 1.3,
    blurb: "Wooden fruit stand: the canvas sails, posts cartwheel, apples and oranges roll everywhere.",
    sound: "wood",
    debris: ["splinter", "apple", "orange"],
    slow: 0.3,
    build: (rand) => ({
      pieces: stallPieces(rand, C.red, C.white, (pieces) => {
        for (const [cx, col] of [
          [-1.2, C.woodPale],
          [0.1, C.woodPale],
          [1.35, C.wood],
        ])
          pieces.push(
            piece(
              "crate",
              new Parts().box(1.0, 0.42, 0.9, col).box(0.9, 0.05, 0.8, C.woodDark, 0, 0.19, 0).finish(),
              WOOD,
              { x: cx, y: 1.11, z: 0.05 },
            ),
          );
        const fruits = [C.red, C.green, C.orange, C.red, C.orange, C.green, C.red, C.orange, C.yellow];
        fruits.forEach((col, i) => {
          const cx = -1.4 + (i % 3) * 1.25 + (rand() - 0.5) * 0.4;
          pieces.push(
            piece(
              "fruit",
              new Parts()
                .ball(0.26, col, 0, 0, 0, 1, 0.95, 1)
                .cyl(0.03, 0.03, 0.12, C.woodDark, 0, 0.28, 0, 6)
                .finish(),
              { ...FRUIT, sphereRadius: 0.26 },
              { x: cx, y: 1.6 + Math.floor(i / 3) * 0.02, z: (rand() - 0.5) * 0.5 },
              { scatter: { up: 1.1, out: 1.4, spin: 2 } },
            ),
          );
        });
      }),
      hitPoints: [
        [-1.6, 0],
        [0, 0],
        [1.6, 0],
      ],
      height: 2.7,
      radius: 3.2,
    }),
  },

  fishStall: {
    name: "Fish stall",
    scale: 1.3,
    blurb: "Iced fish counter: the tray goes, and a dozen fish slap across the tarmac and stay put.",
    sound: "wood",
    debris: ["fish", "splinter"],
    slow: 0.3,
    build: (rand) => ({
      pieces: stallPieces(rand, C.blue, C.white, (pieces) => {
        pieces.push(
          piece(
            "ice tray",
            new Parts().box(3.6, 0.28, 1.3, C.steel).box(3.4, 0.2, 1.15, C.ice, 0, 0.1, 0).finish(),
            METAL,
            { x: 0, y: 1.04, z: 0 },
            { scatter: { up: 0.8, out: 0.8, spin: 0.6 } },
          ),
        );
        for (let i = 0; i < 12; i++) {
          const cx = -1.5 + (i % 6) * 0.6 + (rand() - 0.5) * 0.15;
          const cz = i < 6 ? -0.3 : 0.3;
          pieces.push(
            piece(
              "fish",
              new Parts()
                .ball(0.3, i % 3 === 0 ? C.fishDark : C.fish, 0, 0, 0, 1.3, 0.35, 0.5)
                .box(0.2, 0.03, 0.28, C.fishDark, 0.42, 0, 0)
                .finish(),
              FISH,
              { x: cx, y: 1.3, z: cz, yaw: (rand() - 0.5) * 0.9 },
              { scatter: { up: 1.0, out: 1.3, spin: 1.5 } },
            ),
          );
        }
      }),
      hitPoints: [
        [-1.6, 0],
        [0, 0],
        [1.6, 0],
      ],
      height: 2.7,
      radius: 3.2,
    }),
  },

  newsRack: {
    name: "Newspaper rack",
    scale: 1.5,
    blurb: "Storefront wire rack and a coin box: the frame goes over, magazines and papers fly loose.",
    sound: "metal",
    debris: ["paper", "paper"],
    slow: 0.08,
    build: (rand) => {
      const pieces = [];
      // Wire rack: uprights, five shelves of thin bars, slanted back.
      const rack = new Parts();
      for (const px of [-0.8, 0.8])
        rack.box(0.05, 1.9, 0.05, C.steelDark, px, 0.95, -0.2).box(0.05, 0.05, 0.6, C.steelDark, px, 0.03, 0);
      for (let s = 0; s < 5; s++) {
        const y = 0.35 + s * 0.38;
        rack.box(1.66, 0.04, 0.04, C.steel, 0, y, -0.2 + s * 0.03);
        rack.box(1.66, 0.04, 0.04, C.steel, 0, y + 0.02, 0.22 - s * 0.03);
        for (let k = -3; k <= 3; k++) rack.box(0.03, 0.03, 0.44, C.steel, k * 0.26, y + 0.01, 0.01);
      }
      pieces.push(
        piece("rack", rack.finish(), METAL, { x: 0, y: 0, z: 0 }, { scatter: { up: 0.9, out: 0.9, spin: 0.8 } }),
      );
      // Magazines: a stack per shelf, bright covers.
      const covers = [C.red, C.yellow, C.teal, C.pink, C.blue, C.green, C.orange, C.white];
      for (let s = 0; s < 5; s++)
        for (let k = -1; k <= 1; k++) {
          const col = covers[(s * 3 + k + 7) % covers.length];
          pieces.push(
            piece(
              "magazine",
              new Parts().box(0.44, 0.07, 0.58, C.white).box(0.44, 0.012, 0.58, col, 0, 0.04, 0).finish(),
              PAPER,
              { x: k * 0.52, y: 0.42 + s * 0.38, z: 0.02 + s * 0.01, pitch: -0.25, yaw: (rand() - 0.5) * 0.15 },
              { scatter: { up: 1.4, out: 1.3, spin: 2.2 } },
            ),
          );
        }
      // Coin-op newspaper box beside the rack.
      pieces.push(
        piece(
          "news box",
          new Parts()
            .box(0.7, 1.2, 0.6, C.blue, 0, 0.6, 0)
            .box(0.56, 0.5, 0.04, C.ice, 0, 0.85, 0.31)
            .box(0.5, 0.06, 0.08, C.steel, 0, 0.45, 0.32)
            .finish(),
          PLASTIC,
          { x: 1.45, y: 0, z: 0.1 },
          { scatter: { up: 1.0, out: 1.0, spin: 1.0 } },
        ),
      );
      pieces.push(
        piece(
          "newspapers",
          new Parts().box(0.5, 0.18, 0.4, C.cream).box(0.5, 0.02, 0.4, C.white, 0, 0.1, 0).finish(),
          PAPER,
          { x: 1.45, y: 1.29, z: 0.05, yaw: 0.2 },
          { scatter: { up: 1.6, out: 1.4, spin: 2.4 } },
        ),
      );
      return {
        pieces,
        hitPoints: [
          [0, 0],
          [1.5, 0],
        ],
        height: 2.0,
        radius: 2.4,
      };
    },
  },

  cafeSeating: {
    name: "Café seating",
    scale: 1.45,
    blurb: "Two bistro tables, six plastic chairs and a big parasol: chairs scatter, the parasol flips.",
    sound: "plastic",
    debris: ["cloth", "splinter"],
    slow: 0.18,
    build: (rand) => {
      const pieces = [];
      const chairCols = [C.white, C.teal, C.white, C.red, C.white, C.yellow];
      let ci = 0;
      for (const tx of [-2.1, 2.1]) {
        pieces.push(
          piece(
            "table",
            new Parts()
              .cyl(0.9, 0.9, 0.07, C.cream, 0, 0.74, 0, 14)
              .cyl(0.07, 0.09, 0.7, C.steelDark, 0, 0.37, 0, 8)
              .cyl(0.42, 0.46, 0.05, C.steelDark, 0, 0.025, 0, 10)
              .finish(),
            { ...METAL, launch: 0.6, lift: 1.1 },
            { x: tx, y: 0, z: 0 },
            { hull: "radial", scatter: { up: 1.1, out: 0.9, spin: 1.1 } },
          ),
        );
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * Math.PI * 2 + (tx > 0 ? 0.6 : 0.1);
          const cx = tx + Math.cos(a) * 1.45,
            cz = Math.sin(a) * 1.45;
          const col = chairCols[ci++ % chairCols.length];
          const chair = new Parts().box(0.5, 0.05, 0.5, col, 0, 0.45, 0).box(0.5, 0.5, 0.05, col, 0, 0.72, -0.23);
          for (const [lx, lz] of [
            [-0.21, -0.21],
            [0.21, -0.21],
            [-0.21, 0.21],
            [0.21, 0.21],
          ])
            chair.box(0.04, 0.45, 0.04, col, lx, 0.225, lz);
          pieces.push(
            piece(
              "chair",
              chair.finish(),
              PLASTIC,
              { x: cx, y: 0, z: cz, yaw: -a + Math.PI / 2 + (rand() - 0.5) * 0.4 },
              {
                scatter: { up: 1.3, out: 1.3, spin: 1.8 },
              },
            ),
          );
        }
      }
      // Parasol: pole + an 8-panel canopy (cone) + a weighted base.
      const umb = new Parts()
        .cyl(0.33, 0.38, 0.12, C.steelDark, 0, 0.06, 0, 10)
        .cyl(0.045, 0.045, 2.7, C.steel, 0, 1.4, 0, 8)
        .cyl(0.04, 0.04, 0.2, C.brass, 0, 2.95, 0, 6);
      const canopy = new THREE.CylinderGeometry(0.02, 1.7, 0.55, 8, 1, true);
      canopy.computeBoundingBox();
      // Alternate the panels: paint per triangle pair from the panel index.
      const cp = canopy.attributes.position,
        cn = canopy.attributes.normal;
      const colA = new THREE.Color(C.red),
        colB = new THREE.Color(C.cream),
        cv = new Float32Array(cp.count * 3);
      for (let i = 0; i < cp.count; i++) {
        const ang = Math.atan2(cp.getX(i), cp.getZ(i)) + Math.PI;
        const panel = Math.floor((ang / (Math.PI * 2)) * 8 + 1e-3) % 8;
        const c = panel % 2 ? colA : colB;
        const shade = 0.84 + 0.16 * Math.max(0, cn.getY(i) * 0.8 + cn.getX(i) * 0.3);
        cv.set([c.r * shade, c.g * shade, c.b * shade], i * 3);
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
          { x: 0, y: 0, z: 0.3 },
          { hull: "radial", sheet: true, scatter: { up: 1.6, out: 0.8, spin: 1.4 } },
        ),
      );
      return {
        pieces,
        hitPoints: [
          [-3.2, 0],
          [-1.4, 0.8],
          [0, 0],
          [1.4, -0.8],
          [3.2, 0],
        ],
        height: 3.2,
        radius: 4.4,
      };
    },
  },

  palletStack: {
    name: "Pallet stack",
    scale: 1.3,
    blurb: "Stacked shipping pallets: they snap apart under the wheels and loose planks shoot into the air.",
    sound: "wood",
    debris: ["splinter", "splinter"],
    slow: 0.3,
    build: (rand) => {
      const pieces = [];
      const pallet = (tint) => {
        const p = new Parts();
        for (const z of [-0.6, 0, 0.6]) p.box(1.8, 0.09, 0.12, C.woodDark, 0, 0.045, z);
        for (let k = 0; k < 5; k++) p.box(1.8 - 0.02, 0.035, 0.22, tint, 0, 0.11, -0.6 + k * 0.3);
        for (const z of [-0.65, 0.65]) p.box(1.8, 0.035, 0.18, tint, 0, -0.02, z);
        return p.finish();
      };
      const stacks = [
        { x: -1.6, z: 0, n: 5 },
        { x: 0.75, z: 0.25, n: 3 },
      ];
      for (const s of stacks)
        for (let k = 0; k < s.n; k++)
          pieces.push(
            piece(
              "pallet",
              pallet([C.weathered, C.woodPale, C.wood][k % 3]),
              { ...HEAVY_WOOD, launch: 0.55 + k * 0.08, lift: 0.9 + k * 0.12, angularDrag: 6 },
              {
                x: s.x + (rand() - 0.5) * 0.12,
                y: 0.04 + k * 0.17,
                z: s.z + (rand() - 0.5) * 0.12,
                yaw: (rand() - 0.5) * 0.12,
              },
              { scatter: { up: 0.8 + k * 0.25, out: 0.9, spin: 1.2 } },
            ),
          );
      // Loose planks leaning on the tall stack.
      for (let k = 0; k < 4; k++)
        pieces.push(
          piece(
            "plank",
            new Parts().box(0.16, 1.9, 0.04, k % 2 ? C.woodPale : C.wood).finish(),
            PLANK,
            { x: -2.65 + k * 0.17, y: 0.9, z: -0.5 + k * 0.3, roll: 0.42, yaw: 0.1 * k },
            { scatter: { up: 1.8, out: 1.2, spin: 2.2 } },
          ),
        );
      return {
        pieces,
        hitPoints: [
          [-1.6, 0],
          [0.75, 0.25],
        ],
        height: 1.2,
        radius: 2.9,
      };
    },
  },

  tireStack: {
    name: "Tyre pile",
    blurb: "Columns of loose tyres: they topple and roll off down the road as live obstacles.",
    sound: "rubber",
    debris: ["dust"],
    slow: 0.25,
    build: (rand) => {
      const pieces = [];
      const columns = [
        { x: -1.9, z: -0.2, n: 5 },
        { x: 0.3, z: -0.9, n: 3 },
        { x: 1.3, z: 1.1, n: 4 },
        { x: -1.0, z: 1.9, n: 2 },
      ];
      for (const c of columns)
        for (let k = 0; k < c.n; k++)
          pieces.push(
            roadPiece(
              "tire",
              {
                x: c.x + (rand() - 0.5) * 0.08,
                y: 0.25 + k * 0.46,
                z: c.z + (rand() - 0.5) * 0.08,
                yaw: rand() * Math.PI,
              },
              { scatter: { up: 0.9 + k * 0.2, out: 1.2, spin: 1.6 } },
            ),
          );
      return {
        pieces,
        hitPoints: [
          [-1.8, 0],
          [0.6, -0.5],
          [0.2, 1.5],
        ],
        height: 2.1,
        radius: 3.4,
      };
    },
  },

  luggageCart: {
    name: "Luggage cart",
    scale: 1.35,
    blurb: "A hotel baggage trolley piled with suitcases: the cart tips and the cases burst open.",
    sound: "metal",
    debris: ["cloth", "paper"],
    slow: 0.2,
    build: (rand) => {
      const pieces = [];
      const cart = new Parts()
        .box(2.2, 0.08, 1.1, C.leather, 0, 0.5, 0)
        .box(2.2, 0.04, 1.1, C.brass, 0, 0.56, 0)
        .cyl(0.04, 0.04, 1.9, C.brass, -1.05, 1.5, -0.5, 8)
        .cyl(0.04, 0.04, 1.9, C.brass, 1.05, 1.5, -0.5, 8)
        .cyl(0.04, 0.04, 1.9, C.brass, -1.05, 1.5, 0.5, 8)
        .cyl(0.04, 0.04, 1.9, C.brass, 1.05, 1.5, 0.5, 8)
        .box(0.08, 0.08, 1.1, C.brass, -1.05, 2.45, 0)
        .box(0.08, 0.08, 1.1, C.brass, 1.05, 2.45, 0)
        .box(2.2, 0.06, 0.06, C.brass, 0, 2.45, -0.5)
        .box(2.2, 0.06, 0.06, C.brass, 0, 2.45, 0.5);
      for (const [wx, wz] of [
        [-0.8, -0.45],
        [0.8, -0.45],
        [-0.8, 0.45],
        [0.8, 0.45],
      ])
        cart.cyl(0.17, 0.17, 0.1, C.rubber, wx, 0.17, wz, 10, Math.PI / 2);
      pieces.push(
        piece(
          "cart",
          cart.finish(),
          { ...METAL, launch: 0.5, lift: 0.9 },
          { x: 0, y: 0, z: 0 },
          { scatter: { up: 0.8, out: 0.8, spin: 0.7 } },
        ),
      );
      const cases = [
        { w: 0.9, h: 0.32, d: 0.65, col: C.red, x: -0.6, y: 0.7, z: -0.1 },
        { w: 0.85, h: 0.3, d: 0.6, col: C.navy, x: 0.5, y: 0.7, z: 0.05, yaw: 0.1 },
        { w: 0.8, h: 0.28, d: 0.55, col: C.leather, x: -0.55, y: 1.0, z: 0, yaw: -0.08 },
        { w: 0.75, h: 0.26, d: 0.5, col: C.teal, x: 0.45, y: 0.99, z: 0.1 },
        { w: 0.7, h: 0.24, d: 0.5, col: C.yellow, x: -0.2, y: 1.26, z: -0.05, yaw: 0.3 },
        { w: 0.55, h: 0.2, d: 0.4, col: C.pink, x: 0.6, y: 1.24, z: -0.15 },
        { w: 0.5, h: 0.18, d: 0.35, col: C.green, x: -0.1, y: 1.49, z: 0.1, yaw: -0.4 },
      ];
      for (const s of cases)
        pieces.push(
          piece(
            "suitcase",
            new Parts()
              .box(s.w, s.h, s.d, s.col)
              .box(s.w * 0.3, s.h * 0.4, 0.05, C.black, 0, 0, s.d / 2)
              .box(s.w + 0.02, 0.03, s.d + 0.02, C.black, 0, s.h * 0.1, 0)
              .finish(),
            CASE,
            { x: s.x, y: s.y, z: s.z, yaw: s.yaw || 0 },
            { scatter: { up: 1.3, out: 1.3, spin: 1.8 } },
          ),
        );
      // A soft duffel on top (a short fat cylinder that rolls a little).
      pieces.push(
        piece(
          "duffel",
          new Parts().cyl(0.26, 0.26, 0.8, C.orange, 0, 0, 0, 10, 0, 0, Math.PI / 2).finish(),
          { ...CASE, shape: "cylinder", restitution: 0.1, friction: 7 },
          { x: 0.1, y: 1.85, z: 0.05, yaw: 0.2 },
          { hull: "radial", scatter: { up: 1.5, out: 1.2, spin: 1.5 } },
        ),
      );
      return {
        pieces,
        hitPoints: [
          [-0.7, 0],
          [0.7, 0],
        ],
        height: 2.5,
        radius: 2.0,
      };
    },
  },

  scrapHeap: {
    name: "Scrap heap",
    scale: 1.3,
    blurb: "A fridge, a washer, rusty drums, a car door and a few tyres: heavy junk that shifts, slides and bounces.",
    sound: "metal",
    debris: ["rust", "dust"],
    slow: 0.32,
    build: (rand) => {
      const pieces = [];
      pieces.push(
        piece(
          "fridge",
          new Parts()
            .box(0.9, 1.9, 0.8, C.fridge, 0, 0.95, 0)
            .box(0.86, 0.02, 0.02, C.steelDark, 0, 1.25, 0.41)
            .box(0.06, 0.5, 0.05, C.steelDark, 0.32, 1.5, 0.42)
            .box(0.06, 0.3, 0.05, C.steelDark, 0.32, 0.8, 0.42)
            .finish(),
          HEAVY_METAL,
          { x: -1.5, y: 0, z: 0.2, yaw: 0.35, roll: 0.0 },
          { scatter: { up: 0.5, out: 0.6, spin: 0.5 } },
        ),
      );
      pieces.push(
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
      );
      const drum = (tint) =>
        new Parts()
          .cyl(0.42, 0.42, 1.2, tint, 0, 0, 0, 12)
          .cyl(0.44, 0.44, 0.06, C.rust, 0, 0.35, 0, 12)
          .cyl(0.44, 0.44, 0.06, C.rust, 0, -0.35, 0, 12)
          .finish();
      pieces.push(
        piece(
          "drum",
          drum(C.rust),
          BARREL,
          { x: 0.9, y: 0.6, z: 0.4 },
          { hull: "radial", scatter: { up: 0.7, out: 1.0, spin: 1.0 } },
        ),
      );
      pieces.push(
        piece(
          "drum",
          drum(C.steelDark),
          BARREL,
          { x: 1.7, y: 0.42, z: -0.5, pitch: Math.PI / 2, yaw: 0.4 },
          {
            hull: "radial",
            scatter: { up: 0.7, out: 1.2, spin: 1.3 },
          },
        ),
      );
      pieces.push(
        piece(
          "drum",
          drum(C.red),
          BARREL,
          { x: 0.9, y: 1.62, z: 0.4, pitch: Math.PI / 2, yaw: 1.2 },
          {
            hull: "radial",
            scatter: { up: 1.0, out: 1.3, spin: 1.5 },
          },
        ),
      );
      pieces.push(
        piece(
          "car door",
          new Parts()
            .box(1.4, 1.0, 0.1, C.blue, 0, 0, 0)
            .box(1.3, 0.42, 0.04, C.ice, 0, 0.26, 0.04)
            .box(0.3, 0.05, 0.06, C.steel, 0.4, -0.1, 0.07)
            .finish(),
          { ...METAL, launch: 0.7, lift: 1.3, airDrag: 0.6 },
          { x: -0.2, y: 0.55, z: 0.95, roll: 0.55, yaw: 0.2 },
          { scatter: { up: 1.3, out: 1.1, spin: 1.5 } },
        ),
      );
      pieces.push(
        roadPiece("tire", { x: 1.1, y: 0.25, z: 1.4, yaw: 0.5 }, { scatter: { up: 0.9, out: 1.2, spin: 1.6 } }),
      );
      pieces.push(
        roadPiece(
          "tire",
          { x: 1.9, y: 0.75, z: 1.1, pitch: Math.PI / 2, yaw: 0.9, roll: 0.25 },
          { scatter: { up: 1.1, out: 1.3, spin: 1.8 } },
        ),
      );
      pieces.push(
        piece(
          "exhaust",
          new Parts()
            .cyl(0.07, 0.07, 1.6, C.rust, 0, 0, 0, 8)
            .cyl(0.16, 0.16, 0.5, C.steelDark, 0, -0.3, 0, 10)
            .finish(),
          { ...METAL, shape: "cylinder", launch: 0.9, lift: 1.4, angularDrag: 4 },
          { x: 0.2, y: 0.17, z: -1.3, pitch: Math.PI / 2, yaw: 0.9 },
          { hull: "radial", scatter: { up: 1.4, out: 1.3, spin: 2.0 } },
        ),
      );
      for (let k = 0; k < 2; k++)
        pieces.push(
          piece(
            "hubcap",
            new Parts().cyl(0.3, 0.3, 0.05, C.steel, 0, 0, 0, 12).finish(),
            { ...METAL, shape: "cylinder", launch: 1.0, lift: 1.5, restitution: 0.4, angularDrag: 3 },
            { x: 1.9 + k * 0.1, y: 0.03 + k * 0.06, z: 0.9 + k * 0.3, yaw: k },
            { hull: "radial", scatter: { up: 1.5, out: 1.5, spin: 2.5 } },
          ),
        );
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
    },
  },
};
export const BREAKABLE_KINDS = Object.keys(BREAKABLES);

// Build a structure's pieces assembled at rest in one Group (the intact look),
// plus the data props.js needs to let it go. `rand` seeds the small per-piece
// jitter so a layout rebuilds the same way.
export function makeBreakable(kind, rand = Math.random) {
  const spec = BREAKABLES[kind];
  if (!spec) throw new Error(`unknown breakable "${kind}"`);
  _scale = spec.scale || 1;
  const built = spec.build(rand);
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
    group,
    pieces: built.pieces,
    hitPoints: built.hitPoints,
    height: built.height,
    radius: built.radius,
  };
}
