// Extra habitat silhouettes. Every asset is one painted mesh; structures join
// the world's existing static batches and animals use its bounded amble loop.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { bakeScenery } from "./baked-lighting.js";
import { paintSurface } from "./scenery-art.js";
import { dressingFor } from "./biome-dressing.js";

export const HABITAT_ASSETS = {
  fox: { name: "Fox", biome: "forest", animal: true },
  hare: { name: "Hare", biome: "tundra", animal: true },
  tortoise: { name: "Tortoise", biome: "desert", animal: true },
  seal: { name: "Seal", biome: "beach", animal: true },
  antelope: { name: "Antelope", biome: "savanna", animal: true },
  boar: { name: "Boar", biome: "jungle", animal: true },
  frog: { name: "Frog", biome: "wetlands", animal: true },
  lifeguard: { name: "Lifeguard tower", biome: "beach" },
  birdHide: { name: "Bird hide", biome: "wetlands" },
  lookout: { name: "Forest lookout", biome: "forest" },
  well: { name: "Desert well", biome: "desert" },
  trough: { name: "Water trough", biome: "savanna" },
  apiary: { name: "Bee hives", biome: "lavender" },
  cairn: { name: "Stone cairn", biome: "alpine" },
};

export function makeHabitatAsset(kind, biome, material) {
  const spec = HABITAT_ASSETS[kind];
  if (!spec) throw new Error(`Unknown habitat asset: ${kind}`);
  const parts = [],
    theme = dressingFor(biome.name);
  const add = (geo, tint) => {
    if (geo.index) {
      const old = geo;
      geo = geo.toNonIndexed();
      old.dispose();
    }
    paintSurface(geo, { low: 0.82, faces: 0.05 });
    const c = new THREE.Color(tint),
      colors = geo.attributes.color;
    for (let i = 0; i < colors.count; i++)
      colors.setXYZ(i, colors.getX(i) * c.r, colors.getY(i) * c.g, colors.getZ(i) * c.b);
    parts.push(geo);
  };
  const oval = (x, y, z, sx, sy, sz, c) =>
    add(new THREE.SphereGeometry(1, 8, 5).scale(sx, sy, sz).translate(x, y, z), c);
  const box = (x, y, z, w, h, d, c) => add(new THREE.BoxGeometry(w, h, d).translate(x, y, z), c);
  const beam = (a, b, r, c, rEnd = r) => {
    const start = new THREE.Vector3(...a),
      end = new THREE.Vector3(...b),
      dir = end.clone().sub(start);
    const geo = new THREE.CylinderGeometry(rEnd, r, dir.length(), 6);
    geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
    add(geo.translate(...start.add(end).multiplyScalar(0.5).toArray()), c);
  };
  // Continuous tapered, curved silhouette for tails/horns; colour changes are
  // painted on the same surface, so a pale tail tip has no overlapping seam.
  const sweep = (points, radii, c, tip = c) => {
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
    const geo = new THREE.TubeGeometry(curve, 8, 1, 6, false),
      p = geo.attributes.position;
    for (let i = 0; i <= 8; i++) {
      const t = i / 8,
        center = curve.getPointAt(t),
        j = t * (radii.length - 1),
        k = Math.min(radii.length - 2, Math.floor(j));
      const r = THREE.MathUtils.lerp(radii[k], radii[k + 1], j - k);
      for (let n = 0; n <= 6; n++) {
        const v = i * 7 + n;
        p.setXYZ(
          v,
          center.x + (p.getX(v) - center.x) * r,
          center.y + (p.getY(v) - center.y) * r,
          center.z + (p.getZ(v) - center.z) * r,
        );
      }
    }
    geo.computeVertexNormals();
    add(geo, c);
    if (tip !== c) {
      const g = parts.at(-1),
        col = g.attributes.color,
        uv = g.attributes.uv,
        color = new THREE.Color(tip);
      for (let i = 0; i < col.count; i++) if (uv.getX(i) > 0.7) col.setXYZ(i, color.r, color.g, color.b);
    }
  };
  const eyes = (x, y, z) => {
    for (const s of [-1, 1]) oval(x, y, s * z, 0.055, 0.065, 0.035, 0x202b2c);
  };
  const legs = (x, y, z, h, c) => {
    for (const dx of [-x, x]) for (const dz of [-z, z]) beam([dx, 0.1, dz], [dx, y, dz], h, c);
  };
  const roof = (y, w, d, c) => {
    for (const s of [-1, 1])
      add(new THREE.BoxGeometry(w, 0.18, d * 0.61).rotateX(s * 0.48).translate(0, y, s * d * 0.23), c);
  };
  const posts = (top, w, d, c) => {
    for (const x of [-w, w]) for (const z of [-d, d]) beam([x, 0, z], [x, top, z], 0.16, c);
  };
  const dark = 0x343432,
    cream = 0xefe4c4;

  if (kind === "fox" || kind === "boar" || kind === "antelope") {
    const boar = kind === "boar",
      antelope = kind === "antelope";
    const fur = boar ? 0x675447 : antelope ? 0xc89450 : 0xc57436,
      y = antelope ? 1.75 : boar ? 1.0 : 0.9;
    oval(0, y, 0, boar ? 1.25 : 1.1, boar ? 0.68 : 0.49, boar ? 0.64 : 0.43, fur);
    legs(0.7, y, 0.32, antelope ? 0.095 : 0.13, dark);
    if (antelope) beam([-0.8, 1.7, 0], [-1.17, 2.65, 0], 0.23, fur, 0.19);
    oval(-1.1, antelope ? 2.6 : y + 0.22, 0, 0.48, 0.38, 0.34, fur);
    oval(-1.48, antelope ? 2.46 : y + 0.12, 0, boar ? 0.25 : 0.36, 0.2, 0.22, boar ? 0x9c7970 : cream);
    eyes(-1.3, antelope ? 2.73 : y + 0.35, 0.3);
    for (const s of [-1, 1]) {
      add(
        new THREE.ConeGeometry(0.18, 0.42, 4).rotateX(s * 0.3).translate(-1.03, antelope ? 2.95 : y + 0.66, s * 0.24),
        fur,
      );
      if (antelope)
        sweep(
          [
            [-1.0, 2.87, s * 0.19],
            [-0.94, 3.28, s * 0.24],
            [-0.65, 3.58, s * 0.28],
          ],
          [0.095, 0.075, 0],
          dark,
        );
      if (boar)
        sweep(
          [
            [-1.49, y - 0.01, s * 0.2],
            [-1.68, y + 0.02, s * 0.28],
            [-1.72, y + 0.25, s * 0.28],
          ],
          [0.08, 0.065, 0],
          cream,
        );
    }
    if (kind === "fox")
      sweep(
        [
          [0.8, 0.9, 0],
          [1.5, 0.8, 0.12],
          [2.0, 0.48, 0.25],
          [2.3, 0.64, 0.3],
        ],
        [0.2, 0.35, 0.27, 0],
        fur,
        cream,
      );
    else
      sweep(
        [
          [0.95, y + 0.15, 0],
          [1.36, y + 0.08, 0],
          [1.45, y - 0.2, 0.1],
        ],
        [0.09, 0.06, 0],
        dark,
      );
  } else if (kind === "hare") {
    const fur = ["tundra", "alpine"].includes(biome.name) ? 0xe8e8df : 0xb2a18b;
    oval(0, 0.62, 0, 0.65, 0.58, 0.42, fur);
    oval(-0.52, 1.04, 0, 0.35, 0.38, 0.29, fur);
    for (const s of [-1, 1]) {
      oval(-0.4, 1.64, s * 0.16, 0.13, 0.51, 0.105, fur);
      oval(-0.5, 1.67, s * 0.16, 0.035, 0.35, 0.073, 0xc99c97);
      oval(0.35, 0.26, s * 0.35, 0.39, 0.25, 0.18, fur);
      oval(-0.43, 0.16, s * 0.22, 0.32, 0.12, 0.13, fur);
    }
    oval(0.66, 0.65, 0, 0.19, 0.21, 0.21, cream);
    eyes(-0.73, 1.12, 0.235);
  } else if (kind === "tortoise") {
    oval(0, 0.36, 0, 0.95, 0.24, 0.66, 0xb59f65);
    const shell = new THREE.SphereGeometry(1, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2)
      .scale(0.96, 0.78, 0.7)
      .translate(0, 0.35, 0);
    add(shell, 0x6e8051);
    // Alternate shell facets are baked pigment, not additional plates.
    const g = parts.at(-1),
      p = g.attributes.position,
      c = g.attributes.color;
    for (let i = 0; i < p.count; i++) {
      const shade = Math.floor(((Math.atan2(p.getZ(i), p.getX(i)) + Math.PI) * 5) / Math.PI) % 2 ? 0.82 : 1;
      c.setXYZ(i, c.getX(i) * shade, c.getY(i) * shade, c.getZ(i) * shade);
    }
    for (const s of [-1, 1]) for (const x of [-0.6, 0.6]) oval(x, 0.23, s * 0.55, 0.29, 0.2, 0.2, 0xb59f65);
    oval(-1.02, 0.49, 0, 0.35, 0.25, 0.25, 0xb59f65);
    eyes(-1.14, 0.59, 0.22);
  } else if (kind === "seal") {
    // One sculpted torso tapers into the rear, with broad flippers at ground.
    const body = new THREE.SphereGeometry(1, 10, 6),
      p = body.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i),
        t = (x + 1) / 2;
      p.setXYZ(i, x * 1.45, 0.64 + p.getY(i) * (0.72 - 0.42 * t), p.getZ(i) * (0.67 - 0.4 * t));
    }
    body.computeVertexNormals();
    add(body, 0x84989b);
    oval(-1.0, 1.06, 0, 0.48, 0.48, 0.43, 0x84989b);
    oval(-1.37, 0.96, 0, 0.19, 0.19, 0.3, 0xc5ceca);
    for (const s of [-1, 1]) {
      oval(-0.4, 0.29, s * 0.48, 0.5, 0.19, 0.4, 0x657d83);
      oval(1.19, 0.42, s * 0.18, 0.42, 0.16, 0.3, 0x657d83);
    }
    eyes(-1.24, 1.19, 0.35);
    oval(-1.55, 1.07, 0, 0.08, 0.07, 0.11, dark);
  } else if (kind === "frog") {
    oval(0, 0.43, 0, 0.57, 0.38, 0.48, 0x668b43);
    oval(-0.39, 0.53, 0, 0.42, 0.31, 0.41, 0x7d9e4a);
    for (const s of [-1, 1]) {
      oval(0.29, 0.26, s * 0.47, 0.43, 0.24, 0.24, 0x4f793b);
      oval(-0.43, 0.22, s * 0.33, 0.34, 0.18, 0.2, 0x7d9e4a);
      oval(-0.44, 0.81, s * 0.27, 0.17, 0.18, 0.16, 0xbac67a);
      oval(-0.56, 0.83, s * 0.3, 0.07, 0.095, 0.075, dark);
    }
  } else if (["lifeguard", "lookout", "birdHide"].includes(kind)) {
    const hide = kind === "birdHide",
      life = kind === "lifeguard",
      deck = hide ? 1.0 : life ? 2.5 : 3.8,
      top = deck + 2.4;
    posts(top - 0.28, 1.65, 1.35, theme.wood);
    box(0, deck, 0, 3.8, 0.25, 3.2, theme.wood);
    // Continuous boards and viewing slot; interior remains visibly open.
    for (const z of [-1.35, 1.35]) box(0, deck + 0.7, z, 3.5, 1.2, 0.16, life ? 0xe9dfb6 : theme.wood);
    if (hide) {
      for (const z of [-1.35, 1.35]) box(0, top - 0.55, z, 3.5, 0.55, 0.16, theme.wood);
    }
    for (const x of [-1.65, 1.65]) box(x, deck + 0.7, 0, 0.16, 1.2, 2.7, theme.wood);
    roof(top, 4.3, 3.9, life ? 0x559ba9 : 0x58644c);
    for (const s of [-1, 1]) beam([s * 0.55, 0, 2.6], [s * 0.55, deck, 1.6], 0.1, theme.wood);
    for (let i = 1; i <= 5; i++) box(0, (deck * i) / 6, 2.6 - i / 6, 1.2, 0.12, 0.22, theme.wood);
    if (life) {
      box(0, deck + 0.8, 1.45, 1.2, 0.22, 0.08, 0xc1644c);
      box(0, deck + 0.8, 1.5, 0.22, 0.9, 0.08, 0xc1644c);
    } else if (!hide)
      for (const s of [-1, 1]) beam([-1.65, 0.3, s * 1.35], [1.65, deck - 0.15, s * 1.35], 0.12, theme.wood);
  } else if (kind === "well") {
    // A hollow stone ring, with an opaque recessed water disc.
    add(new THREE.CylinderGeometry(1.35, 1.45, 1.05, 10, 1, true).translate(0, 0.525, 0), theme.stone);
    const inside = new THREE.CylinderGeometry(1.12, 1.12, 1.05, 10, 1, true);
    const ix = inside.index.array,
      n = inside.attributes.normal;
    for (let i = 0; i < ix.length; i += 3) [ix[i], ix[i + 2]] = [ix[i + 2], ix[i]];
    for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
    add(inside.translate(0, 0.525, 0), theme.stone);
    add(new THREE.RingGeometry(1.12, 1.35, 10).rotateX(-Math.PI / 2).translate(0, 1.05, 0), theme.stone);
    add(new THREE.CircleGeometry(1.12, 10).rotateX(-Math.PI / 2).translate(0, 0.22, 0), 0x476f78);
    for (const x of [-1.6, 1.6]) beam([x, 0, 0], [x, 3.3, 0], 0.14, theme.wood);
    beam([-1.6, 2.6, 0], [1.6, 2.6, 0], 0.1, theme.wood);
    beam([0, 2.6, 0], [0, 0.65, 0], 0.025, 0x9b895c);
    roof(3.35, 3.8, 2.5, 0xa77754);
  } else if (kind === "trough") {
    box(0, 0.35, 0, 3, 0.35, 1.1, theme.wood);
    for (const z of [-0.6, 0.6]) box(0, 0.65, z, 3.3, 0.65, 0.18, theme.wood);
    for (const x of [-1.55, 1.55]) box(x, 0.65, 0, 0.18, 0.65, 1.2, theme.wood);
    box(0, 0.76, 0, 2.95, 0.05, 1.03, 0x5c8e94);
    for (const x of [-1, 1]) box(x, 0.16, 0, 0.25, 0.3, 1.3, theme.wood);
  } else if (kind === "apiary") {
    for (const x of [-0.95, 0.95]) {
      box(x, 0.35, 0, 1.2, 0.22, 1.3, theme.wood);
      for (const z of [-0.4, 0.4]) box(x, 0.18, z, 0.85, 0.35, 0.14, theme.wood);
      box(x, 1.05, 0, 1.05, 1.2, 1.05, 0xd8bd78);
      for (const y of [0.7, 1.05, 1.4]) box(x, y, 0.535, 1.05, 0.045, 0.025, 0x927144);
      box(x, 0.55, 0.56, 0.45, 0.09, 0.04, 0x3d3830);
      add(new THREE.ConeGeometry(0.95, 0.55, 4).rotateY(Math.PI / 4).translate(x, 1.86, 0), 0x7d8270);
    }
  } else if (kind === "cairn") {
    for (let i = 0; i < 4; i++)
      add(
        new THREE.IcosahedronGeometry(1, 0)
          .scale(1.0 - i * 0.2, 0.35 - i * 0.035, 0.8 - i * 0.14)
          .rotateY(i * 1.8)
          .translate(Math.sin(i) * 0.1, 0.28 + i * 0.37, 0),
        theme.stone,
      );
  }
  const geo = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  const group = new THREE.Group(),
    mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  if (spec.animal)
    group.userData.wander = {
      range: kind === "frog" ? 2 : 4,
      speed: kind === "tortoise" ? 0.35 : kind === "seal" ? 0.55 : 1.1,
      bob: kind === "hare" ? 0.12 : 0.025,
    };
  else group.userData.staticProp = true;
  return spec.animal ? group : bakeScenery(group);
}
