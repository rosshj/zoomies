// Imported hero models (GLB) — the artist/AI-authored replacements for the
// procedural cat/kart, loaded via glTF. Each loader normalizes the model into
// the game's conventions (feet on y=0, centred, facing +z, procedural-model
// size) and returns a template Group that callers CLONE per use.
//
// Current status: the Tripo cat export is an untextured clay mesh (no UVs),
// so it gets an interim single fur tint. The kart export is textured and
// arrives in parts (4 wheels + steering wheel + chassis), which the loader
// tags in userData so callers can spin/steer them.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// Feet-on-ground, centred, sized: the shared normalization every import gets.
// axis: which bbox axis the target size measures.
function normalize(root, { size, axis = "y" }) {
  const box = new THREE.Box3().setFromObject(root);
  const dims = box.getSize(new THREE.Vector3());
  root.scale.setScalar(size / dims[axis]);
  const box2 = new THREE.Box3().setFromObject(root);
  const c = box2.getCenter(new THREE.Vector3());
  root.position.set(-c.x, -box2.min.y, -c.z);
}

let _catPromise = null;
export function loadCatGLB(url = "./assets/models/cat.glb") {
  if (!_catPromise) {
    _catPromise = new GLTFLoader().loadAsync(url).then((gltf) => {
      const root = gltf.scene;
      // Match the procedural sitting cat: ~3.3 tall, seat base at the origin.
      root.rotation.y = Math.PI; // Tripo exports facing -z; the game's forward is +z
      normalize(root, { size: 3.3, axis: "y" });
      root.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = false; // karts/cats ride the blob shadow, not the sun map
        // Clay (no texture/UVs) → interim fur tint so it reads in previews.
        if (!o.material?.map) {
          o.material = new THREE.MeshStandardMaterial({ color: 0xf0a830, roughness: 0.92 });
        }
      });
      const holder = new THREE.Group();
      holder.add(root);
      return holder;
    });
  }
  return _catPromise;
}

// Plane normal of a flat-ish mesh (a steering wheel disc): the least-spread
// PCA axis of its vertex positions. Power iteration on (trace(C)·I − C) —
// its dominant eigenvector is C's smallest — avoids a full eigen solve.
function discNormal(geometry) {
  // Read through the attribute API — GLTFLoader often loads positions
  // INTERLEAVED with normals/uvs, so indexing .array with stride 3 reads
  // garbage (that bug pointed the steering axis 40° off its column).
  const attr = geometry.getAttribute("position");
  const n = attr.count;
  let mx = 0, my = 0, mz = 0;
  for (let i = 0; i < n; i++) { mx += attr.getX(i); my += attr.getY(i); mz += attr.getZ(i); }
  mx /= n; my /= n; mz /= n;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < n; i++) {
    const x = attr.getX(i) - mx, y = attr.getY(i) - my, z = attr.getZ(i) - mz;
    xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
  }
  const tr = xx + yy + zz;
  // M = tr·I − C
  const m = [tr - xx, -xy, -xz, -xy, tr - yy, -yz, -xz, -yz, tr - zz];
  const v = new THREE.Vector3(0.577, 0.577, 0.577);
  for (let it = 0; it < 32; it++) {
    v.set(
      m[0] * v.x + m[1] * v.y + m[2] * v.z,
      m[3] * v.x + m[4] * v.y + m[5] * v.z,
      m[6] * v.x + m[7] * v.y + m[8] * v.z,
    ).normalize();
  }
  return v;
}

let _kartPromise = null;
export function loadKartGLB(url = "./assets/models/kart.glb") {
  if (!_kartPromise) {
    _kartPromise = new GLTFLoader().loadAsync(url).then((gltf) => {
      const root = gltf.scene;

      // Identify the parts from their pivots, in the source space (the Tripo
      // kart faces +x; axles run along z). No name matching — Tripo's part ids
      // change per generation, but the layout is stable: the steering wheel
      // pivots highest, the four road wheels pivot low in ±z pairs, and
      // whatever remains is chassis.
      const parts = [];
      root.traverse((o) => { if (o.isMesh) parts.push(o); });
      const steering = parts.reduce((a, b) => (b.position.y > a.position.y ? b : a));
      const wheels = parts
        .filter((n) => n !== steering && Math.abs(n.position.z) > 0.05)
        .sort((a, b) => b.position.x - a.position.x) // front pair (near the steering wheel, +x) first
        .slice(0, 4);

      root.rotation.y = -Math.PI / 2; // source +x (nose) → game +z
      normalize(root, { size: 4.1, axis: "z" }); // match the procedural kart footprint

      root.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = false;
        // The retopologized shell can have hairline tears (nose cowl);
        // double-sided fill hides them for a trivial cost on one hero model.
        if (o.material) o.material.side = THREE.DoubleSide;
        // Anisotropic filtering: the baked atlas packs unrelated surface
        // patches into adjacent cells, so deep mips blend across cells and
        // fringe grazing-angle silhouettes with neighbours' paint. Higher
        // anisotropy keeps sampling in shallow mips along the stretched axis.
        if (o.material?.map) o.material.map.anisotropy = 8;
      });

      const holder = new THREE.Group();
      holder.add(root);
      // Wheel spin axis is the source-space z (axle), steering is y — order
      // "YZX" keeps steer as the outer rotation, roll inner. Same contract as
      // the procedural kart's wheels array: fronts first.
      for (const w of wheels) w.rotation.order = "YZX";
      holder.userData.wheels = wheels;
      holder.userData.steering = steering;
      holder.userData.chassis = parts.find((p) => p !== steering && !wheels.includes(p));
      // Anchor for the nose number roundel: drop a ray onto the cowl's top
      // face (just ahead of the steering wheel) and remember the hit point +
      // surface orientation. Instances mount their own crisp canvas-number
      // decal here, covering the fuzzy "7" baked into the texture.
      holder.updateMatrixWorld(true);
      const ray = new THREE.Raycaster(new THREE.Vector3(0, 3, 1.18), new THREE.Vector3(0, -1, 0));
      const hit = ray.intersectObject(holder.userData.chassis, false)[0];
      if (hit) {
        const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
        // Shrink-wrap a subdivided disc onto the cowl: every vertex is
        // dropped along the anchor normal onto the chassis surface, then
        // lifted a hair — the decal follows the curve like a real sticker
        // instead of a flat plate slapped on at one angle. Built once here;
        // instances share the geometry and swap only the number texture.
        const R = 0.27;
        // RingGeometry lays vertices ring-major (phi rings x theta spokes);
        // walking rings inward->outward lets a spoke whose ray misses the
        // cowl (past the silhouette) reuse its last projected point instead
        // of falling back to the anchor plane — which sat BELOW the surface
        // and let the chassis paint poke through the sticker.
        const THETA = 32, PHI = 10;
        const disc = new THREE.RingGeometry(R * 0.001, R, THETA, PHI); // hole must be sub-pixel — it shows the chassis paint through the sticker's centre
        const pos = disc.getAttribute("position");
        const v = new THREE.Vector3(), radial = new THREE.Vector3();
        const lastGood = new Array(THETA + 1).fill(null);
        const hn = new THREE.Vector3();
        for (let ring = 0; ring <= PHI; ring++) {
          for (let jTheta = 0; jTheta <= THETA; jTheta++) {
            const i = ring * (THETA + 1) + jTheta;
            v.set(pos.getX(i), pos.getY(i), 0).applyQuaternion(q).add(hit.point).addScaledVector(n, 0.5);
            ray.set(v, n.clone().negate());
            // The chassis material is double-sided, so the raycaster reports
            // INNER-shell backfaces too; landing on one buries the sticker
            // under the paint. Accept only outer hits facing the anchor.
            // Accept only outer hits facing the anchor AND near the cowl's
            // own surface (origin sits 0.5 above it) — rays past the cowl
            // silhouette otherwise land on the bumper far below and wrap the
            // sticker over the edge like a melted flap.
            const h = ray.intersectObject(holder.userData.chassis, false).find((c) => {
              if (c.distance > 0.68) return false;
              hn.copy(c.face.normal).transformDirection(c.object.matrixWorld);
              return hn.dot(n) > 0.2;
            });
            if (h) {
              hn.copy(h.face.normal).transformDirection(h.object.matrixWorld);
              // Sit the sticker just off the paint — polygonOffset handles the
              // z-fight, so this only needs to clear the cowl's facet bumps. A
              // bigger lift (was 0.035) read as a coin floating above the nose.
              v.copy(h.point).addScaledVector(hn, 0.012);
              lastGood[jTheta] = v.clone();
            } else if (lastGood[jTheta]) {
              v.copy(lastGood[jTheta]); // off the silhouette: collapse the rim
            } else {
              v.addScaledVector(n, -0.5 + 0.012);
            }
            pos.setXYZ(i, v.x, v.y, v.z);
          }
        }
        void radial;
        disc.computeVertexNormals();
        holder.userData.roundelGeometry = disc; // already in holder space
      }
      // The steering wheel must turn about its own tilted column, not a world
      // axis. The column axis is the disc's plane normal: the direction of
      // least positional spread (smallest PCA axis) of the rim geometry,
      // in the part's local space. Sign: toward the driver (-x, +y source
      // space), so a positive angle turns the wheel the way the road wheels
      // turn for a left steer.
      holder.userData.steeringAxis = discNormal(steering.geometry).normalize();
      if (holder.userData.steeringAxis.x > 0) holder.userData.steeringAxis.negate();
      return holder;
    });
  }
  return _kartPromise;
}

// --- Procedural livery for the GLB kart -------------------------------------
// The baked chassis texture's paint is the ONLY saturated hue on the part
// (frame, seat, roundel and trims are all greys), so recoloring is a
// selective hue swap: red-dominant texels are re-lit in the target color
// (target * relative luminance), everything else passes through. Done once
// per color on a canvas and cached — no extra shader work per frame.
const _tintCache = new Map();
function tintedChassisMaterial(template, colorHex) {
  const key = colorHex ?? "base";
  if (_tintCache.has(key)) return _tintCache.get(key);
  const base = template.userData.chassis.material;
  let mat = base;
  if (colorHex != null) {
    const img = base.map.image;
    const S = 1024; // variants are AI-racer karts; 1K is plenty at race distance
    const c = document.createElement("canvas");
    c.width = c.height = S;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, S, S);
    const d = ctx.getImageData(0, 0, S, S);
    const p = d.data;
    const tint = new THREE.Color(colorHex);
    // Luminance of the baked flat red — the divisor that turns each painted
    // texel into a shading factor for the replacement color.
    const RED_LUMA = 0.30;
    for (let i = 0; i < p.length; i += 4) {
      const r = p[i], g = p[i + 1], b = p[i + 2];
      const m = Math.min(1, Math.max(0, (r - Math.max(g, b)) / 40)); // red-dominance mask
      if (m <= 0) continue;
      const f = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 / RED_LUMA;
      p[i] = r + (Math.min(255, tint.r * 255 * f) - r) * m;
      p[i + 1] = g + (Math.min(255, tint.g * 255 * f) - g) * m;
      p[i + 2] = b + (Math.min(255, tint.b * 255 * f) - b) * m;
    }
    ctx.putImageData(d, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.flipY = false; // match glTF texture orientation
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = base.map.anisotropy; // same grazing-mip fix as the base
    mat = base.clone();
    mat.map = tex;
  }
  _tintCache.set(key, mat);
  return mat;
}

// A ready-to-show GLB kart: cloned from the template, painted `color`
// (null = the baked red), wearing a crisp procedural number roundel on the
// nose. Returns the same contract the template exposes (wheels, steering,
// steeringAxis in userData) with part references remapped into the clone.
// numberTexture: pass models.js's makeNumberTexture (kept as a parameter so
// this module doesn't pull the whole procedural-model file in).
export function makeKartGLBInstance(template, { number = 7, color = null, numberTexture } = {}) {
  const obj = template.clone();
  const find = (part) => obj.getObjectByName(part.name);
  const chassis = find(template.userData.chassis);
  chassis.material = tintedChassisMaterial(template, color);
  if (template.userData.roundelGeometry && numberTexture) {
    const decal = new THREE.Mesh(
      template.userData.roundelGeometry, // conformed to the cowl, holder space
      new THREE.MeshStandardMaterial({
        map: numberTexture(number, 512), // decal is a big sticker; 128px stairs
        transparent: true,
        roughness: 0.5,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      }),
    );
    obj.add(decal);
  }
  obj.userData.wheels = template.userData.wheels.map(find);
  obj.userData.steering = find(template.userData.steering);
  obj.userData.steeringAxis = template.userData.steeringAxis;
  obj.userData.keepResources = true; // parts borrow the template's buffers
  return obj;
}
