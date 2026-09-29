// Procedural road toys: one cached, vertex-coloured draw per object. Shared art
// is independent of a world's seed; placement/yaw supply the regional variety.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const profile = (name, sound, extra = {}) => ({
  name,
  sound,
  launch: 0.65,
  lift: 1,
  restitution: 0.28,
  friction: 6,
  angularDrag: 7,
  ...extra,
});
export const ROAD_PROPS = {
  hayBale: profile("Round hay bale", "hay", {
    shape: "cylinder",
    launch: 0.35,
    friction: 2.4,
    angularDrag: 3,
    stand: true,
  }),
  pumpkin: profile("Pumpkin", "fruit", { launch: 0.6, friction: 3, angularDrag: 4 }),
  fruitBasket: profile("Apple basket", "wood", {
    burst: "apple",
    depleted: true,
    anchors: ["barn", "farmhouse", "stall", "apiary"],
  }),
  beachBall: profile("Beach ball", "rubber", {
    shape: "sphere",
    sphereRadius: 1.02,
    restitution: 0.78,
    gravity: 16,
    airDrag: 0.6,
    friction: 1.2,
    angularDrag: 2,
    lift: 1.7,
    wind: true,
  }),
  coconut: profile("Coconut", "coconut", {
    shape: "sphere",
    sphereRadius: 0.68,
    restitution: 0.46,
    friction: 2.2,
    angularDrag: 3,
    anchors: ["palm"],
  }),
  sandBucket: profile("Sand bucket", "plastic", { launch: 0.9, lift: 1.4 }),
  log: profile("Short fallen log", "wood", {
    shape: "cylinder",
    stand: true,
    launch: 0.4,
    friction: 2.4,
    angularDrag: 3,
    anchors: ["tree", "cabin"],
  }),
  pinecone: profile("Pinecone", "wood", { launch: 0.85, lift: 1.25 }),
  campRoll: profile("Camping bedroll", "hay", {
    shape: "cylinder",
    stand: true,
    launch: 0.5,
    anchors: ["cabin", "lookout", "chalet"],
  }),
  leafBundle: profile("Leaf bundle", "rustle", { burst: "leaf", vanish: true, wind: true }),
  tumbleweed: profile("Tumbleweed", "rustle", {
    shape: "sphere",
    sphereRadius: 0.88,
    restitution: 0.5,
    gravity: 16,
    airDrag: 1.2,
    friction: 2,
    angularDrag: 3,
    wind: true,
    lift: 1.5,
  }),
  clayPot: profile("Clay pot", "pot", { burst: "clay", vanish: true, anchors: ["adobe", "well", "hut"] }),
  wagonWheel: profile("Wagon wheel", "wood", {
    shape: "cylinder",
    stand: true,
    launch: 0.55,
    friction: 1.8,
    angularDrag: 2.4,
  }),
  snowball: profile("Snowball", "snow", { shape: "sphere", sphereRadius: 0.85, burst: "snow", vanish: true }),
  iceChunk: profile("Ice chunk", "ice", { friction: 0.65, angularDrag: 2.5, restitution: 0.17 }),
  supplyCase: profile("Supply case", "plastic", { launch: 0.48, anchors: ["chalet", "lookout"] }),
  trafficCone: profile("Traffic cone", "plastic", {
    deform: true,
    launch: 0.85,
    lift: 1.2,
    anchors: ["lamp", "hydrant", "sign"],
  }),
  cardboardBox: profile("Cardboard carton", "rustle", {
    deform: true,
    launch: 0.95,
    lift: 1.45,
    airDrag: 1.2,
    wind: true,
    anchors: ["store", "stall"],
  }),
  tire: profile("Loose tire", "rubber", {
    shape: "cylinder",
    stand: true,
    launch: 0.7,
    restitution: 0.65,
    friction: 1.6,
    angularDrag: 2.5,
    lift: 1.3,
  }),
  tropicalFruit: profile("Fallen mangoes", "fruit", { burst: "mango", vanish: true, anchors: ["tree", "palm", "hut"] }),
  bambooBundle: profile("Bamboo bundle", "wood", {
    shape: "cylinder",
    stand: true,
    launch: 0.5,
    friction: 2.8,
    angularDrag: 4,
  }),
  fishingFloat: profile("Fishing float", "plastic", {
    shape: "sphere",
    sphereRadius: 0.81,
    restitution: 0.62,
    gravity: 22,
    friction: 2,
    lift: 1.3,
    anchors: ["stiltHut", "birdHide", "hut"],
  }),
  pumice: profile("Pumice rock", "stone", { launch: 0.55, restitution: 0.4, burst: "dust" }),
  canister: profile("Metal canister", "metal", { shape: "cylinder", launch: 0.6, friction: 3, angularDrag: 4 }),
};
export const ROAD_PROP_BIOMES = {
  meadow: ["hayBale", "pumpkin", "fruitBasket"],
  forest: ["log", "pinecone", "campRoll"],
  alpine: ["log", "pinecone", "campRoll", "supplyCase"],
  autumn: ["pumpkin", "fruitBasket", "leafBundle"],
  beach: ["beachBall", "coconut", "sandBucket"],
  desert: ["tumbleweed", "clayPot", "wagonWheel"],
  mesa: ["clayPot", "wagonWheel", "tumbleweed"],
  tundra: ["snowball", "iceChunk", "supplyCase"],
  city: ["trafficCone", "cardboardBox", "tire"],
  jungle: ["tropicalFruit", "bambooBundle", "log"],
  wetlands: ["fishingFloat", "bambooBundle", "log"],
  volcanic: ["pumice", "canister"],
  savanna: ["tumbleweed", "clayPot", "campRoll"],
  blossom: ["fruitBasket", "leafBundle", "clayPot"],
  lavender: ["hayBale", "fruitBasket", "leafBundle"],
};
const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
material.userData.shared = true;
const cache = new Map();
const C = { wood: 0x936137, end: 0xd6aa65, rope: 0x594732, dark: 0x343c45, straw: 0xd8b753, green: 0x688e49 };

function buildGeometry(kind, used) {
  const parts = [],
    tint = new THREE.Color();
  const add = (geo, color, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    geo.rotateX(rx).rotateY(ry).rotateZ(rz).translate(x, y, z);
    const p = geo.attributes.position,
      n = geo.attributes.normal;
    tint.set(color);
    const values = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const shade = 0.83 + 0.17 * Math.max(0, n.getY(i) * 0.8 + n.getX(i) * 0.3 + n.getZ(i) * 0.2);
      values.set([tint.r * shade, tint.g * shade, tint.b * shade], i * 3);
    }
    geo.setAttribute("color", new THREE.BufferAttribute(values, 3));
    // Keep every part compatible and preserve a single opaque batch.
    geo.deleteAttribute("uv");
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    parts.push(g);
  };
  const box = (w, h, d, col, x = 0, y = 0, z = 0, rz = 0) =>
    add(new THREE.BoxGeometry(w, h, d), col, x, y, z, 0, 0, rz);
  const cyl = (r1, r2, h, col, x = 0, y = 0, z = 0, segments = 10) =>
    add(new THREE.CylinderGeometry(r1, r2, h, segments), col, x, y, z);
  const ring = (r, t, col, y = 0) => add(new THREE.TorusGeometry(r, t, 4, 12), col, 0, y, 0, Math.PI / 2);
  const ball = (r, col, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) =>
    add(new THREE.IcosahedronGeometry(r, 1).scale(sx, sy, sz), col, x, y, z);
  const lathe = (points, col) =>
    add(
      new THREE.LatheGeometry(
        points.map((p) => new THREE.Vector2(...p)),
        10,
      ),
      col,
    );
  switch (kind) {
    case "hayBale":
      cyl(1, 1, 1.6, C.straw);
      for (const y of [-0.55, 0.55]) ring(1.01, 0.035, C.rope, y);
      for (const y of [-0.81, 0.81]) {
        for (const r of [0.25, 0.52, 0.78]) ring(r, 0.025, 0xb5913d, y);
      }
      break;
    case "pumpkin":
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        ball(0.5, i % 2 ? 0xe58a27 : 0xcf6a1e, Math.sin(a) * 0.42, 0, Math.cos(a) * 0.42, 0.8, 1.45, 0.8);
      }
      cyl(0.1, 0.16, 0.27, 0x5e6b33, 0, 0.8);
      break;
    case "fruitBasket":
      lathe(
        [
          [0, -0.5],
          [0.65, -0.5],
          [0.82, 0.35],
          [0.73, 0.35],
          [0.57, -0.4],
          [0, -0.4],
        ],
        C.wood,
      );
      for (const y of [-0.4, -0.1, 0.2, 0.36]) ring(0.65 + (y + 0.5) * 0.2, 0.035, C.end, y);
      if (!used)
        for (let i = 0; i < 5; i++) {
          const a = i * 2.4;
          ball(0.29, i % 2 ? 0x9bbf49 : 0xd64632, Math.sin(a) * 0.46, 0.39 + (i === 4 ? 0.2 : 0), Math.cos(a) * 0.46);
        }
      break;
    case "beachBall": {
      const colors = [0xef5e4a, 0xfaf1d6, 0xf9d656, 0xfaf1d6, 0x60c0d3, 0xfaf1d6];
      const indexed = new THREE.SphereGeometry(1, 18, 8),
        sphere = indexed.toNonIndexed();
      indexed.dispose();
      // Longitude UVs keep each panel boundary on a mesh edge, including poles.
      const uv = sphere.attributes.uv;
      add(sphere, 0xffffff);
      const g = parts.at(-1),
        a = g.attributes.position,
        c = g.attributes.color;
      for (let i = 0; i < a.count; i += 3) {
        const longitude = (uv.getX(i) + uv.getX(i + 1) + uv.getX(i + 2)) / 3;
        tint.set(colors[Math.min(5, Math.floor(longitude * 6))]);
        for (let j = 0; j < 3; j++) c.setXYZ(i + j, tint.r, tint.g, tint.b);
      }
      break;
    }
    case "coconut":
      ball(0.66, 0x876044);
      for (const [x, z] of [
        [-0.16, 0],
        [0.16, 0],
        [0, 0.2],
      ])
        ball(0.065, 0x3b3028, x, 0.6, z);
      break;
    case "sandBucket":
      lathe(
        [
          [0, -0.6],
          [0.49, -0.6],
          [0.66, 0.52],
          [0.56, 0.52],
          [0.41, -0.48],
          [0, -0.48],
        ],
        0x53bcc4,
      );
      ring(0.63, 0.065, 0xf4d353, 0.53);
      add(new THREE.TorusGeometry(0.68, 0.035, 4, 12, Math.PI), 0xf4d353, 0, 0.45, 0);
      break;
    case "log":
      cyl(0.64, 0.68, 2.25, C.wood);
      for (const y of [-1.135, 1.135]) {
        cyl(0.57, 0.57, 0.018, C.end, 0, y);
        for (const r of [0.18, 0.37, 0.53]) ring(r, 0.018, 0xae7b44, y);
      }
      for (let i = 0; i < 5; i++) {
        const a = i * Math.PI * 0.4;
        box(0.08, 1.9, 0.08, 0x694831, Math.sin(a) * 0.64, 0, Math.cos(a) * 0.64);
      }
      break;
    case "pinecone":
      ball(0.48, 0x69452c, 0, 0, 0, 0.8, 1.3, 0.8);
      cyl(0.06, 0.09, 0.2, 0x63412b, 0, 0.68);
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 6; i++) {
          const a = ((i + j * 0.5) * Math.PI) / 3,
            r = 0.34 * (1 - j * 0.13);
          add(
            new THREE.OctahedronGeometry(0.21).scale(1, 0.65, 1.4),
            j % 2 ? 0x9d7449 : 0x805333,
            Math.sin(a) * r,
            -0.34 + j * 0.24,
            Math.cos(a) * r,
            0.45,
            a,
          );
        }
      break;
    case "campRoll":
      cyl(0.61, 0.61, 1.8, 0x648369);
      for (const y of [-0.6, 0.6]) ring(0.62, 0.05, 0x3d4d46, y);
      for (const y of [-0.91, 0.91]) {
        ring(0.39, 0.04, 0x354f47, y);
        ring(0.18, 0.03, 0x98b58f, y);
      }
      break;
    case "leafBundle":
      for (let i = 0; i < 13; i++) {
        const a = i * 2.4;
        add(
          new THREE.OctahedronGeometry(0.4).scale(0.7, 0.2, 1.4),
          [0xd79035, 0xb95736, 0x9a793d][i % 3],
          Math.sin(a) * 0.48,
          (i % 3) * 0.16 - 0.2,
          Math.cos(a) * 0.48,
          0,
          a,
          0.15,
        );
      }
      break;
    case "tumbleweed":
      for (let i = 0; i < 7; i++)
        add(
          new THREE.TorusGeometry(0.73 + (i % 3) * 0.06, 0.023, 3, 10),
          i % 2 ? 0xa2824f : 0xc5a46a,
          0,
          0,
          0,
          i * 0.72,
          i * 0.41,
          i * 0.65,
        );
      break;
    case "clayPot":
      lathe(
        [
          [0, -0.7],
          [0.4, -0.7],
          [0.75, -0.2],
          [0.7, 0.35],
          [0.45, 0.62],
          [0.46, 0.74],
          [0.34, 0.74],
          [0.34, 0.59],
          [0.58, 0.25],
          [0.61, -0.2],
          [0.31, -0.55],
          [0, -0.55],
        ],
        0xc78459,
      );
      ring(0.46, 0.055, 0xf0bf7f, 0.69);
      ring(0.72, 0.025, 0x744f3c, 0.18);
      break;
    case "wagonWheel":
      ring(0.93, 0.105, C.wood);
      ring(0.98, 0.035, C.dark);
      cyl(0.18, 0.18, 0.38, C.wood);
      for (let i = 0; i < 6; i++) add(new THREE.BoxGeometry(0.1, 0.16, 1.72), C.end, 0, 0, 0, 0, (i * Math.PI) / 6);
      break;
    case "snowball":
      ball(0.84, 0xe3eef0);
      break;
    case "iceChunk":
      add(new THREE.DodecahedronGeometry(1, 0).scale(0.9, 0.58, 0.73), 0x9dcedd);
      break;
    case "supplyCase":
      box(1.75, 1.05, 1.2, 0x68818e);
      for (const x of [-0.67, 0.67]) box(0.1, 1.1, 1.24, C.dark, x);
      box(0.45, 0.15, 0.14, 0xddd6b2, 0, 0.18, 0.65);
      box(0.7, 0.12, 0.25, C.dark, 0, 0.6);
      break;
    case "trafficCone":
      box(1.25, 0.14, 1.25, C.dark, 0, -0.65);
      if (used) {
        add(new THREE.ConeGeometry(0.47, 1.2, 10), 0xf17838, 0, -0.32, 0.36, Math.PI * 0.36);
        add(new THREE.CylinderGeometry(0.2, 0.32, 0.22, 10), 0xf2e7c5, 0, -0.16, 0.59, Math.PI * 0.36);
      } else {
        cyl(0.09, 0.48, 1.36, 0xf17838);
        cyl(0.21, 0.28, 0.23, 0xf5eddb, 0, 0.16);
      }
      break;
    case "cardboardBox": {
      const h = used ? 0.45 : 1.2;
      box(1.35, h, 1.3, 0xbd935f, 0, -0.6 + h / 2);
      box(0.2, h + 0.02, 1.32, 0xe2c393, 0, -0.6 + h / 2);
      box(0.66, 0.045, 1.28, 0xd2b07c, -0.4, -0.6 + h, 0.0, used ? 0.15 : -0.25);
      box(0.66, 0.045, 1.28, 0xb88c55, 0.4, -0.6 + h, 0, used ? -0.2 : 0.28);
      break;
    }
    case "tire":
      ring(0.67, 0.25, 0x343b42);
      ring(0.71, 0.19, 0x23292e, 0.04);
      for (let i = 0; i < 12; i++) {
        const a = (i * Math.PI) / 6;
        add(new THREE.BoxGeometry(0.1, 0.42, 0.15), 0x30363b, Math.sin(a) * 0.86, 0, Math.cos(a) * 0.86, 0, a);
      }
      break;
    case "tropicalFruit":
      for (let i = 0; i < 4; i++) {
        const a = i * 2.4;
        ball(
          0.38,
          i % 2 ? 0xe6bc45 : 0xc68b2d,
          Math.sin(a) * 0.38,
          -0.05 + (i === 3 ? 0.25 : 0),
          Math.cos(a) * 0.38,
          0.75,
          1,
          1.2,
        );
      }
      break;
    case "bambooBundle":
      for (const [x, z] of [
        [-0.2, -0.16],
        [0.2, -0.16],
        [0, 0.2],
      ]) {
        cyl(0.22, 0.22, 2.2, 0x8aab58, x, 0, z, 8);
        for (const y of [-0.8, 0, 0.8]) cyl(0.235, 0.235, 0.07, 0xd7c787, x, y, z, 8);
      }
      for (const y of [-0.65, 0.65]) ring(0.4, 0.045, C.rope, y);
      break;
    case "fishingFloat":
      ball(0.76, 0xe7dfbc);
      cyl(0.8, 0.8, 0.25, 0xdf6645, 0, 0, 0, 12);
      cyl(0.12, 0.12, 0.13, C.dark, 0, 0.75);
      break;
    case "pumice": {
      const geo = new THREE.IcosahedronGeometry(0.8, 1).scale(1.1, 0.8, 0.9),
        p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const v = Math.sin(p.getX(i) * 81 + p.getY(i) * 57 + p.getZ(i) * 93);
        if (v > 0.5) p.setXYZ(i, p.getX(i) * 0.92, p.getY(i) * 0.92, p.getZ(i) * 0.92);
      }
      geo.computeVertexNormals();
      add(geo, 0x817a78);
      const g = parts.at(-1),
        c = g.attributes.color,
        a = g.attributes.position;
      for (let i = 0; i < a.count; i++)
        if (Math.sin(a.getX(i) * 81 + a.getY(i) * 57 + a.getZ(i) * 93) > 0.35)
          c.setXYZ(i, c.getX(i) * 0.65, c.getY(i) * 0.65, c.getZ(i) * 0.65);
      break;
    }
    case "canister":
      cyl(0.58, 0.58, 1.7, 0x809093);
      for (const y of [-0.75, 0.75]) ring(0.58, 0.065, C.dark, y);
      box(0.68, 0.4, 0.1, 0xe2bb56, 0, 0, 0.57);
      cyl(0.18, 0.18, 0.15, C.dark, 0.2, 0.92);
      box(0.5, 0.08, 0.14, C.dark, -0.1, 0.95);
      break;
    default:
      throw Error(`Unknown road prop ${kind}`);
  }
  const geometry = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  geometry.computeBoundingBox();
  geometry.userData.shared = true;
  const points = new Map(),
    p = geometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(p, i);
    points.set(
      v
        .toArray()
        .map((n) => n.toFixed(5))
        .join(","),
      v,
    );
  }
  let hull = [...points.values()];
  // Physics transforms and height-samples EVERY hull point of an awake prop each
  // substep, so a hull is a few rings of extreme points, never the art's vertex
  // cloud (a fruit basket has 460 unique vertices). Cylinders keep their exact
  // level profile; other dense shapes (baskets, pumpkins, pots, cones) are all
  // round enough that a banded radial envelope encloses them conservatively.
  const spec = ROAD_PROPS[kind];
  if (spec.shape === "cylinder" || (!spec.sphereRadius && hull.length > HULL_LIMIT))
    hull = ringHull(radialProfile(hull, spec.shape === "cylinder"));
  return { geometry, hull, rest: -geometry.boundingBox.min.y };
}
// The (height, radius) silhouette of a point cloud as an upper convex profile:
// exact per vertex level for true cylinders, or over BANDS bands with each band
// edge carrying the larger neighbouring radius, so the profile always encloses
// the art. Pruned to its convex hull so dominated levels cost nothing.
export const HULL_LIMIT = 64;
const BANDS = 6;
export function radialProfile(points, exact) {
  const levels = new Map();
  if (exact) {
    for (const v of points) {
      const y = Number(v.y.toFixed(5));
      levels.set(y, Math.max(levels.get(y) || 0, Math.hypot(v.x, v.z)));
    }
  } else {
    let minY = Infinity,
      maxY = -Infinity;
    for (const v of points) {
      minY = Math.min(minY, v.y);
      maxY = Math.max(maxY, v.y);
    }
    const step = (maxY - minY) / BANDS || 1,
      radius = new Array(BANDS).fill(0);
    for (const v of points) {
      const band = Math.min(BANDS - 1, Math.floor((v.y - minY) / step));
      radius[band] = Math.max(radius[band], Math.hypot(v.x, v.z));
    }
    for (let k = 0; k <= BANDS; k++)
      levels.set(minY + k * step, Math.max(radius[Math.max(0, k - 1)], radius[Math.min(BANDS - 1, k)]));
  }
  const profile = [];
  for (const point of [...levels].sort((a, b) => a[0] - b[0])) {
    while (profile.length > 1) {
      const a = profile.at(-2),
        b = profile.at(-1);
      if ((b[0] - a[0]) * (point[1] - b[1]) - (b[1] - a[1]) * (point[0] - b[0]) < -1e-7) break;
      profile.pop();
    }
    profile.push(point);
  }
  return profile;
}
// Rings of points around a radial profile, inflated so the polygon's flats still
// enclose the circle. Twelve sides, or eight when the profile has many levels
// (a hay bale's rounded edges), so every hull stays within HULL_LIMIT points.
export function ringHull(profile) {
  const sides = profile.length * 12 > HULL_LIMIT ? 8 : 12,
    inflate = 1 / Math.cos(Math.PI / sides),
    hull = [];
  for (const [y, r] of profile)
    for (let k = 0; k < sides; k++)
      hull.push(
        new THREE.Vector3(
          Math.sin((k * 2 * Math.PI) / sides) * r * inflate,
          y,
          Math.cos((k * 2 * Math.PI) / sides) * r * inflate,
        ),
      );
  return hull;
}
export function makeRoadProp(kind, used = false) {
  const key = kind + (used ? ":used" : "");
  let art = cache.get(key);
  if (!art) {
    art = buildGeometry(kind, used);
    cache.set(key, art);
  }
  if (!used && (ROAD_PROPS[kind].depleted || ROAD_PROPS[kind].deform) && !cache.has(kind + ":used"))
    cache.set(kind + ":used", buildGeometry(kind, true));
  const mesh = new THREE.Group();
  mesh.add(new THREE.Mesh(art.geometry, material));
  if (ROAD_PROPS[kind].stand) mesh.rotation.x = Math.PI / 2;
  return { mesh, hull: art.hull, rest: art.rest, profile: ROAD_PROPS[kind] };
}
