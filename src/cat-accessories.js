import * as THREE from "three";
import { accessoryMaterial, paintUV } from "./accessory-paint.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// Appended ids preserve every existing saved accessory and picker order.
export const EXTRA_ACCESSORIES = {
  propeller: ["Propeller Beanie", 0xe84b51],
  catEye: ["Cat-Eye Goggles", 0xef589b],
  space: ["Space Helmet", 0xe8edf2],
  dragon: ["Dragon Hood", 0x55a679],
  shark: ["Shark Fin", 0x638aab],
  unicorn: ["Unicorn Horn", 0xf6c9eb],
  sombrero: ["Sombrero", 0xe5b761],
  rain: ["Rain Hat", 0xffcf38],
  cone: ["Tiny Traffic Cone", 0xff7733],
  bee: ["Bee Antennae", 0xffcb35],
  mustache: ["Oversized Mustache", 0x51382c],
  duck: ["Rubber-duck Hat", 0xffd840],
  frog: ["Frog Hood", 0x71b95d],
  mushroom: ["Mushroom Cap", 0xd94b52],
  straw: ["Straw Sunhat", 0xdcb978],
  ski: ["Ski Goggles", 0x36a9cb],
  lei: ["Flower Lei", 0xf270ad],
  detective: ["Safari Hat", 0x956f4a],
  shells: ["Shell Necklace", 0xe4cdb0],
};
export const EXTRA_ACCESSORY_COLORS = Object.fromEntries(
  Object.entries(EXTRA_ACCESSORIES).map(([id, [, color]]) => [
    id,
    [...new Set([color, 0xe84b51, 0x4393dc, 0x6ab967, 0xffca42, 0xbd77d4, 0xf4ede1, 0x343a49])],
  ]),
);

const shared = (m) => {
  m.userData.shared = true;
  return m;
};
const fabric = shared(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72 }));
const glass = shared(
  new THREE.MeshBasicMaterial({
    color: 0xb5e7f2,
    transparent: true,
    opacity: 0.105,
    depthWrite: false,
    side: THREE.FrontSide,
  }),
);
const lights = shared(new THREE.MeshBasicMaterial({ vertexColors: true }));
const paintMaterial = () => accessoryMaterial();
const cache = new Map();
const TAU = Math.PI * 2;
function cacheGeometry(key, geometry) {
  if (cache.size >= 96) {
    const oldest = cache.keys().next().value;
    cache.get(oldest).dispose(); // a live cat still holding it re-uploads once on its next draw
    cache.delete(oldest);
  }
  cache.set(key, geometry);
}

// One vertex-colored batch per rigid/moving part, regardless of palette size.
// Cache is bounded like the parent cat cache; all transforms are baked once.
function bake(parts, key, material = fabric, color = 0xffffff) {
  const painted = parts.some((p) => p.userData.paint);
  if (painted) material = paintMaterial(color);
  let geometry = cache.get(key);
  if (!geometry) {
    const geos = parts.map((part) => {
      part.updateMatrix();
      let g = part.geometry.clone().applyMatrix4(part.matrix);
      if (g.index) {
        const indexed = g;
        g = g.toNonIndexed();
        indexed.dispose();
      }
      if (painted) paintUV(g, part.userData.paint || "plain");
      const rgb = new Float32Array(g.attributes.position.count * 3),
        c = part.material.color;
      for (let i = 0; i < rgb.length; i += 3) {
        rgb[i] = c.r;
        rgb[i + 1] = c.g;
        rgb[i + 2] = c.b;
      }
      if (!g.attributes.color) g.setAttribute("color", new THREE.BufferAttribute(rgb, 3));
      return g;
    });
    geometry = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    geometry.userData.shared = true;
    cacheGeometry(key, geometry);
  }
  for (const part of parts) {
    part.geometry.dispose();
    part.material.dispose();
  }
  return new THREE.Mesh(geometry, material);
}

export function createExtraAccessory(id, color, helpers) {
  if (!EXTRA_ACCESSORIES[id]) return null;
  const {
    latheDeform: lathe,
    taperedTube,
    accessoryPlaque: plaque,
    cutAccessoryEarSlots: earSlots,
    neckBandGeo: neck,
  } = helpers;
  // The legacy tube helper's side winding faces inward. Correct its sides
  // here so new closed accessories can all use one front-sided material.
  const tube = (points, r0, r1, segs, radial) => {
    const g = taperedTube(points, r0, r1, segs, radial),
      ix = g.index;
    for (let i = 0; i < ix.count - radial * 6; i += 3) {
      const b = ix.getX(i + 1);
      ix.setX(i + 1, ix.getX(i + 2));
      ix.setX(i + 2, b);
    }
    g.computeVertexNormals();
    return g;
  };
  const key = `extra|${id}|${color}|${helpers.fitKey || "classic"}`,
    group = new THREE.Group(),
    parts = [],
    moving = [];
  let target = parts,
    body = false,
    covered = false,
    motion = null,
    dome = null;
  const add = (g, c = color, x = 0, y = 0, z = 0, scale = null) => {
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: c }));
    m.position.set(x, y, z);
    if (scale) m.scale.set(...scale);
    target.push(m);
    return m;
  };
  const ball = (r, c, x, y, z, scale = null) => add(new THREE.SphereGeometry(r, 10, 6), c, x, y, z, scale);
  const ring = (r, t, c, x, y, z, rx = Math.PI / 2) => {
    const m = add(new THREE.TorusGeometry(r, t, 5, 24), c, x, y, z);
    m.rotation.x = rx;
    return m;
  };
  const line = (points, r, c, segments = 12) =>
    add(
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p))),
        segments,
        r,
        5,
        false,
      ),
      c,
    );
  const cap = (profile, c = color, fn = null, segments = 24) => add(lathe(profile, segments, fn), c);
  const shape = (points, depth, c, x = 0, y = 0, z = 0) => {
    const s = new THREE.Shape();
    points.forEach(([a, b], i) => (i ? s.lineTo(a, b) : s.moveTo(a, b)));
    s.closePath();
    return add(new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false }), c, x, y, z - depth / 2);
  };
  const hood = () =>
    cap(
      [
        [0.7, -0.42],
        [0.86, -0.05],
        [0.79, 0.29],
        [0.67, 0.51],
        [0.47, 0.72],
        [0.22, 0.83],
        [0, 0.86],
      ],
      color,
      (v, a, r) => {
        if (v.y < 0.4) {
          const side = 1 - Math.max(0, Math.cos(a)) ** 2;
          v.y += (0.4 - v.y) * (1 - side);
          const fit = (0.7 + (r - 0.7) * side) / r;
          v.x *= fit;
          v.z *= fit;
        }
      },
    );
  const dark = 0x28333f,
    ivory = 0xffedd1;
  const pivot = (kind, x, y, z) => {
    target = moving;
    motion = { kind, phase: 0, base: new THREE.Vector3(x, y, z) };
  };
  switch (id) {
    case "propeller": {
      covered = true;
      // Alternating four cloth panels share one batch, no texture or material per panel.
      for (let i = 0; i < 4; i++)
        add(
          new THREE.SphereGeometry(0.65, 6, 7, (i * TAU) / 4, TAU / 4, 0, Math.PI / 2),
          [color, 0x4ba8dd, 0xffcf42, 0x73c677][i],
          0,
          0.43,
          0,
          [1, 0.73, 1],
        );
      ring(0.63, 0.045, ivory, 0, 0.45, 0);
      add(new THREE.CylinderGeometry(0.04, 0.04, 0.18, 8), dark, 0, 1.0, 0);
      pivot("propeller", 0, 1.1, 0);
      for (let i = 0; i < 3; i++) {
        const a = (i * TAU) / 3,
          m = ball(
            0.22,
            [0xf95870, 0xffd846, 0x62ceec][i],
            Math.sin(a) * 0.26,
            0,
            Math.cos(a) * 0.26,
            [0.55, 0.12, 1.7],
          );
        m.rotation.y = a;
      }
      ball(0.075, ivory, 0, 0.025, 0);
      break;
    }
    case "catEye": {
      line(
        [
          [-0.56, 0.16, 0.875],
          [-0.69, 0.16, 0.63],
          [-0.72, 0.16, 0.36],
          [-0.8, 0.16, 0],
          [-0.55, 0.16, -0.57],
          [0, 0.16, -0.755],
          [0.55, 0.16, -0.57],
          [0.8, 0.16, 0],
          [0.72, 0.16, 0.36],
          [0.69, 0.16, 0.63],
          [0.56, 0.16, 0.875],
        ],
        0.035,
        dark,
        28,
      );
      for (const sx of [-1, 1]) {
        // Overlapping hinges join the curved temples to the outer frame.
        add(plaque(0.13, 0.085, 0.075, 0.025), color, sx * 0.575, 0.16, 0.86);
        shape(
          [
            [-0.23, -0.13],
            [0.17, -0.16],
            [0.29, 0.2],
            [-0.23, 0.15],
          ].map(([x, y]) => [x * sx, y]),
          0.065,
          color,
          sx * 0.34,
          0.12,
          0.87,
        );
        const lens = add(plaque(0.33, 0.23, 0.018, 0.06), 0x63d8ec, sx * 0.34, 0.12, 0.915);
        lens.rotation.z = sx * 0.06;
        const glint = add(plaque(0.07, 0.15, 0.009, 0.02), 0xe6ffff, sx * 0.33 - 0.065, 0.15, 0.933);
        glint.rotation.z = -0.45;
      }
      add(plaque(0.22, 0.07, 0.05, 0.025), color, 0, 0.15, 0.89);
      break;
    }
    case "ski": {
      // One wraparound shield with a nose cutout, deep foam seal and broad
      // elastic strap. Curvature and highlights are baked, not transparent.
      cap(
        [
          [0.79, 0.06],
          [0.835, 0.06],
          [0.835, 0.24],
          [0.79, 0.24],
          [0.79, 0.06],
        ],
        dark,
      ).scale.z = 0.94;
      for (const sx of [-1, 1]) {
        const strap = add(new THREE.BoxGeometry(0.11, 0.17, 0.46), dark, sx * 0.72, 0.15, 0.53);
        strap.rotation.y = -sx * 0.23;
        add(plaque(0.11, 0.19, 0.045, 0.025), color, sx * 0.7, 0.15, 0.755);
      }
      const outline = [
        [-0.69, 0.07],
        [-0.66, 0.26],
        [-0.56, 0.36],
        [-0.32, 0.4],
        [0, 0.38],
        [0.32, 0.4],
        [0.56, 0.36],
        [0.66, 0.26],
        [0.69, 0.07],
        [0.59, -0.14],
        [0.23, -0.16],
        [0.12, -0.05],
        [0, 0.005],
        [-0.12, -0.05],
        [-0.23, -0.16],
        [-0.59, -0.14],
      ];
      const shield = (sx, sy, depth, c, z) => {
        const m = shape(
          outline.map(([x, y]) => [x * sx, (y - 0.12) * sy + 0.12]),
          depth,
          c,
          0,
          0,
          z,
        );
        const p = m.geometry.attributes.position;
        for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) - 0.5 * p.getX(i) ** 2);
        m.geometry.computeVertexNormals();
        return m;
      };
      shield(1.035, 1.1, 0.12, 0x17232d, 0.915);
      shield(1, 1, 0.095, color, 0.978);
      shield(0.87, 0.77, 0.025, 0x263749, 1.04);
      line(
        [
          [-0.49, 0.26, 0.946],
          [-0.29, 0.3, 1.024],
          [-0.08, 0.3, 1.062],
        ],
        0.014,
        0xa1bdce,
        8,
      );
      line(
        [
          [0.35, 0.01, 1.005],
          [0.46, 0.055, 0.96],
        ],
        0.012,
        0x617c93,
        4,
      );
      break;
    }
    case "space": {
      covered = true;
      // Cut the ellipsoid on the neckline: lower under the chin, higher at
      // the nape. The rim and dome share the exact boundary, so no gap opens.
      // y = -.13 - .44 * (z - .04), about 24 degrees from horizontal.
      const domePoint = (u, v, out = new THREE.Vector3()) => {
        const a = u * TAU,
          b = 0.44 * Math.sin(a),
          r = Math.hypot(1.2, b);
        const edge = Math.atan2(b, 1.2) + Math.acos(-0.26 / r),
          p = v * edge;
        return out.set(-1.02 * Math.cos(a) * Math.sin(p), 0.13 + 1.2 * Math.cos(p), 0.04 + Math.sin(a) * Math.sin(p));
      };
      class Neckline extends THREE.Curve {
        getPoint(t, out = new THREE.Vector3()) {
          return domePoint(t, 1, out);
        }
      }
      const neckline = new Neckline();
      add(new THREE.TubeGeometry(neckline, 24, 0.06, 5, true), color);
      add(new THREE.TubeGeometry(neckline, 24, 0.023, 5, true), dark, 0, -0.045, 0);
      // Single right-side communications headset; no antenna stalks.
      ball(0.15, dark, 0.81, 0.13, 0.035, [0.45, 1, 1]);
      ball(0.145, color, 0.865, 0.13, 0.035, [0.4, 1, 1]);
      // Exactly one boom, attached to the right earcup, ends by the mouth.
      line(
        [
          [0.88, 0.1, 0.08],
          [0.88, -0.1, 0.48],
          [0.67, -0.28, 0.78],
          [0.24, -0.3, 0.88],
        ],
        0.025,
        dark,
        12,
      );
      ball(0.08, 0x17232d, 0.19, -0.3, 0.89, [1.35, 0.65, 0.65]);
      // A closer-fitting ellipsoid still clears the anchored ears and muzzle.
      // One front surface, with no transmission/refraction or extra light.
      const g = new THREE.SphereGeometry(1, 24, 14, 0, TAU, 0, 2.12),
        p = g.attributes.position,
        sample = new THREE.Vector3();
      for (let i = 0; i < p.count; i++) {
        domePoint((i % 25) / 24, Math.floor(i / 25) / 14, sample);
        p.setXYZ(i, sample.x, sample.y, sample.z);
      }
      g.computeVertexNormals();
      g.userData.shared = true;
      const domeKey = "extra|space|dome";
      if (!cache.has(domeKey)) cacheGeometry(domeKey, g);
      else g.dispose();
      dome = new THREE.Mesh(cache.get(domeKey), glass);
      dome.renderOrder = 2;
      group.add(dome);
      line(
        [
          [-0.53, 0.9, 0.6],
          [-0.37, 1.04, 0.57],
          [-0.17, 1.1, 0.59],
        ],
        0.016,
        0xe5fbff,
      );
      line(
        [
          [0.996, -0.13, 0.04],
          [1.02, 0.13, 0.04],
          [0.841, 0.81, 0.04],
          [0.5, 1.175, 0.04],
        ],
        0.01,
        0xc4e3eb,
      );
      pivot("blink", 0, 0, 0);
      for (const [u, c] of [
        [1 / 6, 0x7effa9],
        [1 / 3, 0xff6d6d],
      ]) {
        const p = domePoint(u, 1);
        ball(0.04, c, p.x, p.y + 0.045, p.z + 0.018);
      }
      break;
    }
    case "dragon": {
      covered = true;
      hood().userData.paint = "scales";
      for (const sx of [-1, 1]) {
        add(
          tube(
            [
              new THREE.Vector3(sx * 0.27, 0.69, -0.32),
              new THREE.Vector3(sx * 0.4, 1, -0.39),
              new THREE.Vector3(sx * 0.38, 1.14, -0.5),
            ],
            0.12,
            0.015,
            8,
            7,
          ),
          ivory,
        );
      }
      // Bury the broad root in the hood, above the hem. Rotation is about
      // this attached root so flutter cannot open a gap under the hood.
      pivot("tail", 0, 0.12, -0.78);
      add(
        tube(
          [
            new THREE.Vector3(0, 0.1, 0.2),
            new THREE.Vector3(0, -0.3, -0.13),
            new THREE.Vector3(0.06, -0.76, -0.23),
            new THREE.Vector3(0, -1.22, -0.35),
          ],
          0.19,
          0.018,
          12,
          7,
        ),
        color,
      );
      for (let i = 0; i < 4; i++) ball(0.075, 0xefc067, 0, -0.2 - i * 0.24, -0.2 - i * 0.03, [0.4, 1, 1.3]);
      break;
    }
    case "shark": {
      // A curved root follows the scalp and deliberately penetrates it.
      // Do not apply the clothing clearance projection to this root.
      const root = [];
      for (let i = 0; i <= 8; i++) {
        const u = -0.38 + (i * 0.78) / 8,
          z = -u - 0.08;
        root.push([u, 0.7644 * Math.sqrt(1 - (z / 0.7488) ** 2) - 0.075]);
      }
      const fin = shape([...root, [0.24, 0.91], [-0.06, 1.38], [-0.13, 1.03]], 0.12, color);
      fin.geometry.translate(0, 0, -0.06);
      fin.position.z = -0.08;
      fin.rotation.y = Math.PI / 2;
      // A flush vertex tint gives the fin a pale leading face, no overlay.
      const fp = fin.geometry.attributes.position,
        fc = [];
      for (let i = 0; i < fp.count; i++) {
        const c = new THREE.Color(fp.getZ(i) > 0.05 ? 0xa5c3d7 : color);
        fc.push(c.r, c.g, c.b);
      }
      fin.geometry.setAttribute("color", new THREE.Float32BufferAttribute(fc, 3));
      break;
    }
    case "unicorn": {
      cap(
        [
          [0, 0.58],
          [0.17, 0.58],
          [0.14, 0.89],
          [0.085, 1.19],
          [0, 1.53],
        ],
        ivory,
        null,
        14,
      ).position.z = 0.35;
      const pts = [];
      for (let i = 0; i <= 48; i++) {
        const t = i / 48,
          y = 0.62 + t * 0.86;
        const profile = [
          [0.58, 0.17],
          [0.89, 0.14],
          [1.19, 0.085],
          [1.53, 0],
        ];
        let j = 1;
        while (y > profile[j][0]) j++;
        const [ya, ra] = profile[j - 1],
          [yb, rb] = profile[j],
          r = ra + ((rb - ra) * (y - ya)) / (yb - ya) + 0.01;
        pts.push([Math.cos(t * TAU * 3) * r, y, Math.sin(t * TAU * 3) * r + 0.35]);
      }
      line(pts, 0.018, 0xe5b359, 48);
      const rainbow = [0xf477ae, 0xf7c650, 0x78c997, 0x75bce8, 0xb895e5];
      const maneCurve = new THREE.CatmullRomCurve3(
        [
          [0, 0.7, 0.3],
          [0, 0.75, 0.04],
          [0, 0.72, -0.18],
          [0, 0.62, -0.43],
          [0, 0.4, -0.64],
          [0, 0.05, -0.76],
          [0, -0.28, -0.73],
        ].map((p) => new THREE.Vector3(...p)),
      );
      const mane = new THREE.TubeGeometry(maneCurve, 20, 0.115, 6, false),
        rgb = [];
      for (let i = 0; i < mane.attributes.position.count; i++) {
        const t = 1 - mane.attributes.uv.getX(i),
          c = new THREE.Color(rainbow[Math.min(4, Math.floor(t * 5))]);
        rgb.push(c.r, c.g, c.b);
      }
      mane.setAttribute("color", new THREE.Float32BufferAttribute(rgb, 3));
      add(mane, 0xffffff);
      pivot("sparkle", 0, 1.16, 0.4);
      for (const [x, y] of [
        [-0.22, 0.14],
        [0.18, -0.15],
      ])
        shape(
          [
            [0, 0.06],
            [0.016, 0.016],
            [0.06, 0],
            [0.016, -0.016],
            [0, -0.06],
            [-0.016, -0.016],
            [-0.06, 0],
            [-0.016, 0.016],
          ],
          0.012,
          ivory,
          x,
          y,
          0.03,
        );
      break;
    }
    case "sombrero": {
      covered = true;
      cap(
        [
          [0, 0.64],
          [0.5, 0.64],
          [1.13, 0.63],
          [1.16, 0.7],
          [0.98, 0.73],
          [0.42, 0.71],
          [0.31, 1.02],
          [0.24, 1.28],
          [0, 1.34],
        ],
        color,
      );
      ring(1.08, 0.037, 0xe25d61, 0, 0.7, 0);
      ring(0.35, 0.034, 0x48a9ad, 0, 0.87, 0);
      pivot("trim", 0, 0.69, 0);
      for (let i = 0; i < 12; i++) {
        const a = (i * TAU) / 12;
        ball(0.065, [0xe65d6f, ivory, 0x4baab2][i % 3], Math.sin(a) * 1.09, -0.085, Math.cos(a) * 1.09);
      }
      break;
    }
    case "rain": {
      covered = true;
      cap(
        [
          [0, 0.43],
          [0.62, 0.43],
          [0.86, 0.39],
          [0.88, 0.43],
          [0.72, 0.55],
          [0.6, 0.9],
          [0.46, 1.01],
          [0, 1.03],
        ],
        color,
      );
      ring(0.65, 0.024, ivory, 0, 0.69, 0);
      break;
    }
    case "cone": {
      add(new THREE.BoxGeometry(0.54, 0.055, 0.54), dark, 0, 0.73, 0);
      cap(
        [
          [0, 0.75],
          [0.22, 0.75],
          [0.17, 0.95],
          [0.14, 1.05],
          [0.1, 1.23],
          [0.055, 1.4],
          [0, 1.42],
        ],
        color,
        null,
        16,
      );
      cap(
        [
          [0.147, 1.03],
          [0.119, 1.16],
        ],
        ivory,
        null,
        16,
      );
      break;
    }
    case "bee": {
      pivot("feelers", 0, 0.59, 0);
      for (const sx of [-1, 1]) {
        line(
          [
            [sx * 0.26, 0, 0],
            [sx * 0.38, 0.32, -0.04],
            [sx * 0.52, 0.55, 0.015],
          ],
          0.027,
          dark,
        );
        ball(0.11, color, sx * 0.52, 0.55, 0.015);
        ring(0.09, 0.018, dark, sx * 0.52, 0.55, 0.015);
      }
      break;
    }
    case "mustache": {
      pivot("mustache", 0, -0.27, 0.85);
      for (const sx of [-1, 1])
        add(
          tube(
            [
              new THREE.Vector3(sx * 0.015, 0, 0),
              new THREE.Vector3(sx * 0.22, -0.04, 0.03),
              new THREE.Vector3(sx * 0.44, 0.015, 0.02),
              new THREE.Vector3(sx * 0.56, 0.19, 0),
            ],
            0.105,
            0.015,
            10,
            7,
          ),
          color,
        );
      break;
    }
    case "duck": {
      ball(0.2, color, 0, 0.87, 0.02, [1.2, 0.76, 1.2]);
      ball(0.135, color, 0, 1.08, 0.15);
      ball(0.1, 0xff8c36, 0, 1.055, 0.29, [1, 0.36, 0.85]);
      for (const sx of [-1, 1]) {
        ball(0.026, dark, sx * 0.092, 1.105, 0.232);
        ball(0.11, 0xffe997, sx * 0.18, 0.88, 0.015, [0.35, 0.72, 1]);
      }
      ball(0.08, color, 0, 0.93, -0.18, [0.65, 0.8, 1.6]);
      break;
    }
    case "frog": {
      covered = true;
      hood();
      for (const sx of [-1, 1]) {
        ball(0.21, color, sx * 0.33, 0.87, 0.18, [1, 1, 0.8]);
        ball(0.13, ivory, sx * 0.33, 0.92, 0.31, [1, 1, 0.4]);
        ball(0.072, dark, sx * 0.33, 0.93, 0.359, [0.8, 1.15, 0.3]);
        ball(0.024, 0xffffff, sx * 0.33 - 0.02, 0.955, 0.38);
      }
      break;
    }
    case "mushroom": {
      // Narrow stem seats between the ears; the cap clears their tips.
      cap(
        [
          [0, 0.7],
          [0.28, 0.7],
          [0.3, 0.8],
          [0.3, 1.18],
          [0, 1.18],
        ],
        0xfff4de,
      );
      const lift = 0.43;
      const mushroom = cap(
        [
          [0, 0.7],
          [0.42, 0.7],
          [0.83, 0.72],
          [0.93, 0.79],
          [0.91, 0.85],
          [0.77, 1.08],
          [0.5, 1.27],
          [0.22, 1.32],
          [0, 1.33],
        ],
        color,
      );
      mushroom.position.y = lift;
      mushroom.userData.paint = "spots";
      // Project the spots across the cap footprint so they stay round and
      // readable on its slope instead of stretching around lathe UV rings.
      const mp = mushroom.geometry.attributes.position,
        mu = mushroom.geometry.attributes.uv;
      for (let i = 0; i < mp.count; i++) mu.setXY(i, mp.getX(i) / 1.9 + 0.5, mp.getZ(i) / 1.9 + 0.5);
      cap(
        [
          [0.36, 0.7],
          [0.75, 0.705],
          [0.9, 0.765],
        ],
        ivory,
      ).position.y = lift;
      break;
    }
    case "straw": {
      covered = true;
      cap(
        [
          [0, 0.65],
          [0.43, 0.65],
          [0.92, 0.57],
          [1, 0.6],
          [0.94, 0.64],
          [0.5, 0.7],
          [0.44, 0.97],
          [0.34, 1.08],
          [0, 1.1],
        ],
        color,
        (v, a, r) => {
          if (r > 0.55) v.y += 0.04 * Math.sin(a * 3);
        },
      ).userData.paint = "straw";
      cap(
        [
          [0.499, 0.7],
          [0.467, 0.86],
        ],
        0x5b99b9,
      );
      break;
    }
    case "lei": {
      body = true;
      add(neck(0.11), 0x73a171);
      for (let i = 0; i < 9; i++) {
        const a = (i * TAU) / 9,
          y = 1.66 - 0.23 * Math.cos(a),
          r = Math.sqrt(0.81 - Math.max(0, y - 1.39) ** 2) + 0.08,
          x = Math.sin(a) * r,
          z = Math.cos(a) * r;
        const center = new THREE.Vector3(x, y, z),
          normal = new THREE.Vector3(x, 0.22, z).normalize(),
          q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
        for (let j = 0; j < 5; j++) {
          const p = new THREE.Vector3(Math.cos((j * TAU) / 5) * 0.087, Math.sin((j * TAU) / 5) * 0.087, 0)
            .applyQuaternion(q)
            .add(center);
          const m = add(new THREE.SphereGeometry(0.07, 6, 4), i % 2 ? ivory : color, p.x, p.y, p.z, [1, 1, 0.35]);
          m.quaternion.copy(q);
        }
        const p = center.clone().addScaledVector(normal, 0.026);
        add(new THREE.IcosahedronGeometry(0.049, 0), 0xffd64d, p.x, p.y, p.z);
      }
      break;
    }
    case "detective": {
      // Keep the saved id, but replace the deerstalker with a canvas safari
      // hat: a broad drooping brim, low pinched crown and attached leather band.
      covered = true;
      cap(
        [
          [0, 0.55],
          [0.57, 0.55],
          [1.01, 0.47],
          [1.04, 0.51],
          [0.9, 0.6],
          [0.65, 0.64],
          [0, 0.64],
        ],
        color,
        (v) => {
          v.z *= 1.06;
        },
      );
      const crown = cap(
        [
          [0.64, 0.61],
          [0.61, 0.91],
          [0.48, 1.1],
          [0.23, 1.15],
          [0, 1.13],
        ],
        color,
        (v, a) => {
          v.z *= 1.06;
          if (v.y > 0.85) v.x *= 1 - 0.1 * Math.max(0, Math.cos(a)) ** 4;
        },
      );
      crown.userData.paint = "seams";
      // Evenly sized stitches only on the crown, not stretched over the brim.
      const cp = crown.geometry.attributes.position,
        cu = crown.geometry.attributes.uv;
      for (let i = 0; i < cp.count; i++) cu.setY(i, (cp.getY(i) - 0.61) / 0.54);
      cap(
        [
          [0.652, 0.64],
          [0.634, 0.76],
          [0.621, 0.85],
        ],
        0x604633,
        (v) => {
          v.z *= 1.06;
        },
      );
      add(plaque(0.14, 0.1, 0.025, 0.025), 0xdab667, 0, 0.75, 0.678);
      break;
    }
    case "shells": {
      body = true;
      add(neck(0.09), 0x8d765b);
      for (let i = -2; i <= 2; i++) {
        const a = i * 0.36,
          y = 1.66 - 0.23 * Math.cos(a),
          r = Math.sqrt(0.81 - Math.max(0, y - 1.39) ** 2) + 0.08,
          x = Math.sin(a) * r,
          z = Math.cos(a) * r;
        const outline = [[-0.025, -0.09]];
        for (let j = 0; j <= 12; j++) {
          const angle = Math.PI - (j * Math.PI) / 12,
            r = 0.13 * (1 + 0.065 * (j % 2 ? 1 : -1));
          outline.push([Math.cos(angle) * r, Math.sin(angle) * r - 0.04]);
        }
        outline.push([0.025, -0.09]);
        const shell = shape(outline, 0.027, i % 2 ? ivory : color, x, y, z);
        shell.rotation.y = a;
        for (let j = -1; j <= 1; j++) {
          const dx = j * 0.045,
            point = (u, v) => [
              x + u * Math.cos(a) + 0.017 * Math.sin(a),
              y + v,
              z - u * Math.sin(a) + 0.017 * Math.cos(a),
            ];
          line([point(dx * 0.3, 0.075), point(dx, -0.035)], 0.006, 0xb89c7c);
        }
      }
      break;
    }
  }
  const fitted = covered || ["mushroom", "cone", "duck", "unicorn", "shark", "bee", "catEye", "ski"].includes(id);
  if (body) for (const p of parts) helpers.fitBodyPart(p);
  else if (fitted && !["space", "shark", "unicorn"].includes(id))
    for (const p of parts) {
      p.userData.fitLow = id === "catEye" || id === "ski";
      helpers.fitHeadwear(p);
    }
  if (covered && !["space", "rain", "detective"].includes(id)) for (const p of parts) earSlots(p);
  if (parts.length) group.add(bake(parts, key + "|fixed", fabric, color));
  if (moving.length) {
    const child = bake(moving, key + "|moving", id === "space" ? lights : fabric);
    const pivotGroup = new THREE.Group();
    pivotGroup.position.copy(motion.base);
    pivotGroup.add(child);
    group.add(pivotGroup);
    motion.object = pivotGroup;
  }
  group.userData.keepResources = true;
  group.userData.accessoryId = id;
  return { group, body, covered, motion };
}

// Bounded per-accessory transforms reuse the parent's filtered turn response.
// No particle emitters, constraints, scene searches, or allocations per frame.
export function updateExtraAccessory(motion, dt, turn, speed = 0) {
  if (!motion) return;
  const t = (motion.phase = (motion.phase + dt) % (Math.PI * 200)),
    o = motion.object;
  switch (motion.kind) {
    case "propeller":
      o.rotation.y = (o.rotation.y + dt * (2 + Math.min(55, Math.abs(speed)) * 0.4)) % TAU;
      break;
    case "blink":
      o.visible = Math.sin(t * 4) > -0.35;
      break;
    case "tail":
      o.rotation.z = Math.sin(t * 7) * (0.03 + Math.min(40, Math.abs(speed)) * 0.002) - turn * 0.12;
      o.rotation.x = Math.sin(t * 5) * 0.045;
      break;
    case "trim":
      o.rotation.z = turn * 0.025;
      o.position.y = motion.base.y + Math.abs(turn) * 0.015 * Math.sin(t * 9);
      break;
    case "feelers":
      o.rotation.z = -turn * 0.2 + Math.sin(t * 4) * 0.025;
      break;
    case "mustache":
      o.rotation.z = turn * 0.08;
      o.position.y = motion.base.y + Math.sin(t * 10) * Math.min(0.035, Math.abs(speed) * 0.001);
      break;
    case "sparkle":
      o.scale.setScalar(0.8 + Math.sin(t * 5) * 0.2);
      break;
  }
}
