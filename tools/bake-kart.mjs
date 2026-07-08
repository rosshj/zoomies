// Decimate-and-rebake pipeline: turns a full-res Tripo GLB export into the
// game's flat cel-toy asset. This is the standing recipe for hero models:
// generate high-poly in Tripo (in parts), export GLB to a GitHub release
// (repo bloat-free), run this, commit the small output.
//
//   npm i --no-save @gltf-transform/core @gltf-transform/extensions \
//         @gltf-transform/functions meshoptimizer three three-mesh-bvh sharp
//   node --max-old-space-size=6144 tools/bake-kart.mjs go-kart-hi.glb assets/models/kart.glb
//
// Why rebake: Tripo's UV atlas is thousands of micro-charts, so carrying
// source UVs onto simplified triangles smears unrelated atlas regions across
// the surface — and its painterly texture is fuzzy up close anyway. Steps:
//   1. simplify each part on positionally-welded topology (meshopt, borders
//      locked) — pure geometry, no UV constraints
//   2. unwrap the simplified part into a fresh atlas: adjacent triangle pairs
//      share a square cell (their shared edge = the diagonal, so filtering is
//      continuous across it), cells packed in a grid with gutters
//   3. bake each texel: cell UV -> point on the simplified surface ->
//      normal-guided raycast into the ORIGINAL surface (rejects interior
//      shells) -> 5-tap smoothed sample of the original basecolor ->
//      CLASSIFY into the flat toy palette (red paint / white trim / frame
//      grey / dark) — crisp lines, zero painterly streaking
//   3b. per-cell mode filter cleans in-cell threshold noise
//   3c. GEOMETRIC LIVERY: Tripo's airbrushed paint boundaries threshold into
//      ragged red/white mottle no local filter can fix (they're features, not
//      noise). Instead the livery is re-authored clean on the real geometry:
//      a normal-aware 3D voxel-cell majority vote hardens every surface to
//      its dominant class (paint classes only allowed in authorized zones),
//      then hard geometric overrides stamp the design: solid red cowl, white
//      crown band / dark outer face / red inner wall on the bumper (normal +
//      silhouette-depth contours), red pods with a white inset side panel,
//      and rotational profile snapping makes the wheels perfectly
//      axisymmetric. The baked nose "7" is erased outright (the game mounts
//      a crisp procedural decal there).
//   4. dilate cell edges into the gutters; lossless palette PNG output
//
// Output: same 6-node layout (names + pivots preserved for loadKartGLB),
// wheel/steering pivots recentered on their true axes, basecolor-only
// materials. See src/glbmodels.js for the runtime side (liveries, decal).
import { NodeIO, Document } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptSimplifier } from "meshoptimizer";
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import sharp from "sharp";

const [src, dst] = process.argv.slice(2);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const hi = await io.read(src);
await MeshoptSimplifier.ready;

const BUDGET = {
  tripo_part_19: { tris: 17000, tex: 2048 }, // chassis
  tripo_part_2: { tris: 2600, tex: 768 }, // steering wheel
  tripo_part_16: { tris: 2400, tex: 640 }, // wheels
  tripo_part_3: { tris: 2400, tex: 640 },
  tripo_part_41: { tris: 2400, tex: 640 },
  tripo_part_7: { tris: 2400, tex: 640 },
};

// ---------------------------------------------------------------------------
function simplifyCanonical(pos, idx, targetTris) {
  const nVerts = pos.length / 3;
  const canonByKey = new Map();
  const canonOf = new Uint32Array(nVerts);
  const rep = []; // canonical -> a representative original vertex
  for (let v = 0; v < nVerts; v++) {
    const key = `${Math.round(pos[v * 3] * 1e5)},${Math.round(pos[v * 3 + 1] * 1e5)},${Math.round(pos[v * 3 + 2] * 1e5)}`;
    let c = canonByKey.get(key);
    if (c === undefined) { c = rep.length; canonByKey.set(key, c); rep.push(v); }
    canonOf[v] = c;
  }
  const canonPos = new Float32Array(rep.length * 3);
  rep.forEach((r, c) => {
    canonPos[c * 3] = pos[r * 3]; canonPos[c * 3 + 1] = pos[r * 3 + 1]; canonPos[c * 3 + 2] = pos[r * 3 + 2];
  });
  const canonIdx = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) canonIdx[i] = canonOf[idx[i]];
  const [simpIdx, err] = MeshoptSimplifier.simplify(canonIdx, canonPos, 3, targetTris * 3, 1, ["LockBorder"]);
  // Compact
  const remap = new Map();
  const order = [];
  for (const c of simpIdx) if (!remap.has(c)) { remap.set(c, order.length); order.push(c); }
  const outPos = new Float32Array(order.length * 3);
  order.forEach((c, i) => {
    outPos[i * 3] = canonPos[c * 3]; outPos[i * 3 + 1] = canonPos[c * 3 + 1]; outPos[i * 3 + 2] = canonPos[c * 3 + 2];
  });
  const outIdx = new Uint32Array(simpIdx.length);
  for (let i = 0; i < simpIdx.length; i++) outIdx[i] = remap.get(simpIdx[i]);
  return { pos: outPos, idx: outIdx, err };
}

function smoothNormals(pos, idx) {
  const n = new Float32Array(pos.length);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az;
    const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; // area-weighted
    for (const v of [a, b, c]) { n[v * 3] += nx; n[v * 3 + 1] += ny; n[v * 3 + 2] += nz; }
  }
  for (let v = 0; v < n.length; v += 3) {
    const l = Math.hypot(n[v], n[v + 1], n[v + 2]) || 1;
    n[v] /= l; n[v + 1] /= l; n[v + 2] /= l;
  }
  return n;
}

// Pair adjacent triangles so each square cell holds two tris sharing its
// diagonal (continuous filtering across that edge). Returns array of
// {a, b|null} triangle-index pairs.
function pairTriangles(idx) {
  const triCount = idx.length / 3;
  const edgeMap = new Map();
  const pairedWith = new Int32Array(triCount).fill(-1);
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const a = idx[t * 3 + e], b = idx[t * 3 + ((e + 1) % 3)];
      const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      const other = edgeMap.get(key);
      if (other !== undefined && other !== t && pairedWith[other] === -1 && pairedWith[t] === -1) {
        pairedWith[t] = other; pairedWith[other] = t;
      } else if (other === undefined) {
        edgeMap.set(key, t);
      }
    }
  }
  const pairs = [];
  const used = new Uint8Array(triCount);
  for (let t = 0; t < triCount; t++) {
    if (used[t]) continue;
    const o = pairedWith[t];
    if (o >= 0 && !used[o]) { pairs.push([t, o]); used[t] = 1; used[o] = 1; }
    else { pairs.push([t, -1]); used[t] = 1; }
  }
  return pairs;
}

// For a pair sharing an edge, rotate each triangle's indices (cyclic shifts
// ONLY — arbitrary permutations flip the winding, which culls the triangle or
// negates its shading normal) so the apex comes last and the shared edge is
// (v0, v1) in each triangle's own winding direction. On a manifold mesh the
// two triangles traverse the shared edge in opposite directions, so their v0
// and v1 are swapped relative to each other — writeTri assigns UV diagonal
// corners per-vertex, keeping the seam continuous.
function orientPair(idx, tA, tB) {
  const rotToApexLast = (T, apex) => {
    const k = T.indexOf(apex);
    return [T[(k + 1) % 3], T[(k + 2) % 3], T[k]];
  };
  const A = [idx[tA * 3], idx[tA * 3 + 1], idx[tA * 3 + 2]];
  if (tB < 0) return { A, B: null };
  const B = [idx[tB * 3], idx[tB * 3 + 1], idx[tB * 3 + 2]];
  const shared = A.filter((v) => B.includes(v));
  if (shared.length !== 2) return { A, B: null, spill: B };
  const apexA = A.find((v) => !shared.includes(v));
  const apexB = B.find((v) => !shared.includes(v));
  return { A: rotToApexLast(A, apexA), B: rotToApexLast(B, apexB) };
}

// ---------------------------------------------------------------------------
async function decodeTexture(mat) {
  const tex = mat.getBaseColorTexture();
  const img = tex.getImage();
  const { data, info } = await sharp(Buffer.from(img)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

// NEAREST-texel sampling, deliberately: Tripo's atlas is thousands of
// micro-charts separated by near-black gutters, and bilinear blends those
// gutters into every sample taken near a chart edge (which, with charts a few
// texels wide, is most of them). Point sampling always lands inside a chart.
function sampleBilinear(img, u, v) {
  const x = Math.min(Math.max(Math.floor(u * img.w), 0), img.w - 1);
  const y = Math.min(Math.max(Math.floor(v * img.h), 0), img.h - 1); // glTF v grows downward
  const o = (y * img.w + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
}

// Flat cel-toy palette (medians measured from the source textures). Every
// baked texel snaps to one of these: Tripo's painterly texture is a fuzzy
// watercolor wash up close, and the game's look wants flat toy paint with
// crisp boundaries. Shading comes from the cel pipeline, not the texture.
const PALETTE = {
  red: [212, 58, 42],
  white: [225, 225, 224],
  frame: [92, 92, 96],
  dark: [42, 42, 45],
};
const CLS = [PALETTE.red, PALETTE.white, PALETTE.frame, PALETTE.dark];
const RED = 0, WHITE = 1, FRAME = 2, DARK = 3;
const clsOfRGB = (r, g, b) => {
  // exact palette lookup (every written texel is a palette color)
  for (let i = 0; i < 4; i++) if (CLS[i][0] === r && CLS[i][1] === g && CLS[i][2] === b) return i;
  let best = 0, bd = Infinity;
  for (let i = 0; i < 4; i++) {
    const d = (r - CLS[i][0]) ** 2 + (g - CLS[i][1]) ** 2 + (b - CLS[i][2]) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
};
function classify(rgb, redAllowed = true) {
  const [r, g, b] = rgb;
  if (redAllowed && r - Math.max(g, b) > 25) return PALETTE.red;
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (luma > 140) return PALETTE.white;
  if (luma > 60) return PALETTE.frame;
  return PALETTE.dark;
}

// --- Livery geometry (chassis-local coords, nose +x, measured off the hi-res
// source; the chassis is ~1.0 long). Paint (red/white) is only authorized in
// these zones — everywhere else the surface votes between frame and dark,
// which kills Tripo's paint-spill on the seat, rails and rear boxes.
const LIV = {
  XFRONT: 0.135,      // front region starts (bumper/cowl/plate territory)
  ARC_CX: 0.18,       // plan polar center for the bumper silhouette table
  ARC_RMIN: 0.34,     // silhouette radius that counts as "bumper arc"
  D_TUBE: 0.095,      // bumper tube depth: crown white / rest dark inside this
  NY_UP: 0.3,         // up-facing normal split (crown/plate vs faces)
  W_NY: 0.16,         // crown/face cut anti-alias half-width (in normal.y)
  NY_PLATE: 0.4,      // apron white only on up-facing surfaces (pipe sides stay grey)
  THIN: 0.024,        // surfaces thinner than this (frame pipes) never take paint
  PLATE: { y0: -0.062, y1: 0.008 }, // white plate height band (up-facing)
  ZPAINT: 0.17,       // vote may paint red/white only this close to centre
  COWL: { x0: 0.145, x1: 0.52, z: 0.14, y: 0.008 },
  POD: { z: 0.2, x0: -0.115, x1: 0.155, y0: -0.105, y1: 0.055 },
  // Panel edges sit on the pod's FLAT outer face: a cut that runs along the
  // coarse top-edge roundover tears (the y iso-contour zigzags across bumpy
  // simplified triangles).
  PANEL: { x0: -0.04, x1: 0.13, y0: -0.062, y1: 0.005, nz: 0.45 },
};
const inPod = (x, y, z) =>
  Math.abs(z) >= LIV.POD.z && x >= LIV.POD.x0 && x <= LIV.POD.x1 && y >= LIV.POD.y0 && y <= LIV.POD.y1;
const inCowl = (x, y, z) =>
  Math.abs(z) < LIV.COWL.z && x >= LIV.COWL.x0 && x <= LIV.COWL.x1 && y > LIV.COWL.y;

// ---------------------------------------------------------------------------
const outDoc = new Document();
const buffer = outDoc.createBuffer();
const scene = outDoc.createScene("Scene");
const parent = outDoc.createNode("ParentNode");
scene.addChild(parent);

const _v = new THREE.Vector3();
const _target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };

for (const node of hi.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const name = node.getName();
  const budget = BUDGET[name] ?? { tris: 2500, tex: 512 };
  const prim = mesh.listPrimitives()[0];
  const oPos = prim.getAttribute("POSITION").getArray();
  const oUV = prim.getAttribute("TEXCOORD_0").getArray();
  const oIdx = prim.getIndices().getArray();
  const img = await decodeTexture(prim.getMaterial());
  const isChassis = name === "tripo_part_19";

  // 1) simplify
  const S = simplifyCanonical(oPos, oIdx, budget.tris);

  // (No interior-shell cull: a ray-crossing census of the source chassis
  // showed it's mostly ONE hollow skin, with genuine double walls only where
  // the geometry really is double — seat bucket, hollow pods, frame tubes.
  // The old occlusion cull couldn't tell those from a spurious inner shell,
  // so it punched holes through thin walls while barely denting the fringe.
  // The fringe was never a stray shell anyway — it was the 3D colour vote
  // bleeding across surface gaps, fixed at its source in step 3c below.)
  const nrm = smoothNormals(S.pos, S.idx);

  // 2) unwrap: paired-triangle grid atlas
  const pairs = pairTriangles(S.idx);
  const cells = Math.ceil(Math.sqrt(pairs.length));
  const TEX = budget.tex;
  const cellPx = Math.floor(TEX / cells);
  const gutter = 2 / TEX; // 2px inner margin per cell edge
  const triCount = S.idx.length / 3;

  // Split every vertex per corner: 3 unique verts per triangle.
  const vCount = triCount * 3;
  const fPos = new Float32Array(vCount * 3);
  const fNrm = new Float32Array(vCount * 3);
  const fUV = new Float32Array(vCount * 2);
  const fIdx = new Uint32Array(triCount * 3);
  let cursor = 0; // triangle output cursor

  const writeTri = (verts, uvs) => {
    for (let k = 0; k < 3; k++) {
      const v = verts[k], d = cursor * 3 + k;
      fPos[d * 3] = S.pos[v * 3]; fPos[d * 3 + 1] = S.pos[v * 3 + 1]; fPos[d * 3 + 2] = S.pos[v * 3 + 2];
      fNrm[d * 3] = nrm[v * 3]; fNrm[d * 3 + 1] = nrm[v * 3 + 1]; fNrm[d * 3 + 2] = nrm[v * 3 + 2];
      fUV[d * 2] = uvs[k][0]; fUV[d * 2 + 1] = uvs[k][1];
      fIdx[cursor * 3 + k] = d;
    }
    cursor++;
  };

  pairs.forEach((pair, pi) => {
    const cx = (pi % cells) / cells, cy = Math.floor(pi / cells) / cells;
    const s = 1 / cells;
    const lo = gutter, hiC = s - gutter;
    const { A, B, spill } = orientPair(S.idx, pair[0], pair[1]);
    // Diagonal corners D1=(lo,hi), D2=(hi,lo). A's apex sits at (lo,lo), B's
    // at (hi,hi). Each of B's shared vertices takes the SAME diagonal corner
    // it has in A (windings traverse the edge in opposite directions, so B's
    // v0 is normally A's v1).
    const D1 = [cx + lo, cy + hiC], D2 = [cx + hiC, cy + lo];
    writeTri(A, [D1, D2, [cx + lo, cy + lo]]);
    if (B) writeTri(B, [B[0] === A[0] ? D1 : D2, B[1] === A[1] ? D2 : D1, [cx + hiC, cy + hiC]]);
    if (spill) writeTri(spill, [D1, D2, [cx + hiC, cy + hiC]]);
  });

  // 3) bake — BVH over the ORIGINAL mesh; barycentric UV interp per face.
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(oPos.slice(), 3));
  geo.setIndex(new THREE.BufferAttribute(oIdx.slice(), 1));
  const bvh = new MeshBVH(geo);
  // MeshBVH reorders geo's index buffer in place; faceIndex refers to THAT
  // order, so triangle lookups must go through the post-build array.
  const gIdx = geo.index.array;
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _bc = new THREE.Vector3();
  const _tri = new THREE.Triangle();
  const _fn = new THREE.Vector3(), _n = new THREE.Vector3();
  const _ray = new THREE.Ray();
  const RAY = 0.03; // model is ~1 unit long; shells are far thinner than this
  const uvFromHit = (point, faceIndex) => {
    const f = faceIndex * 3;
    const ia = gIdx[f], ib = gIdx[f + 1], ic = gIdx[f + 2];
    _a.fromArray(oPos, ia * 3); _b.fromArray(oPos, ib * 3); _c.fromArray(oPos, ic * 3);
    _tri.set(_a, _b, _c);
    _tri.getBarycoord(point, _bc);
    const u = oUV[ia * 2] * _bc.x + oUV[ib * 2] * _bc.y + oUV[ic * 2] * _bc.z;
    const v = oUV[ia * 2 + 1] * _bc.x + oUV[ib * 2 + 1] * _bc.y + oUV[ic * 2 + 1] * _bc.z;
    return [u, v];
  };
  const faceNormal = (faceIndex, out) => {
    const f = faceIndex * 3;
    _a.fromArray(oPos, gIdx[f] * 3); _b.fromArray(oPos, gIdx[f + 1] * 3); _c.fromArray(oPos, gIdx[f + 2] * 3);
    _tri.set(_a, _b, _c);
    return _tri.getNormal(out);
  };
  // Bake sample: raycast inward along the simplified surface normal from just
  // above the point, keep the nearest hit whose face normal agrees (outer
  // surface). A plain closest-point query can snap to the model's INTERIOR
  // shell (Tripo bakes it near-black), which peppered the bake with dark
  // triangles. Fallback: closest point, still normal-checked.
  const sampleOriginal = (x, y, z, nx, ny, nz) => {
    _n.set(nx, ny, nz).normalize();
    _ray.origin.set(x + _n.x * RAY, y + _n.y * RAY, z + _n.z * RAY);
    _ray.direction.copy(_n).negate();
    const hits = bvh.raycast(_ray, THREE.DoubleSide);
    let best = null, bestScore = Infinity;
    for (const h of hits) {
      if (h.distance > RAY * 2) continue;
      faceNormal(h.faceIndex, _fn);
      if (_fn.dot(_n) <= 0.1) continue; // interior/backside — skip
      const score = Math.abs(h.distance - RAY); // nearest to the query point
      if (score < bestScore) { bestScore = score; best = h; }
    }
    if (best) {
      const [u, v] = uvFromHit(best.point, best.faceIndex);
      return sampleBilinear(img, u, v);
    }
    _v.set(x, y, z);
    bvh.closestPointToPoint(_v, _target);
    const [u, v] = uvFromHit(_target.point, _target.faceIndex);
    return sampleBilinear(img, u, v);
  };

  // Chassis only: locate the baked nose roundel so its texels can be erased.
  // Ray down onto the cowl top at the same normalized station the loader uses
  // for the decal anchor (z=+1.18 of the 4.1-long kart -> 28.8% of the source
  // length ahead of center; source forward is +x).
  let roundel = null;
  if (name === "tripo_part_19") {
    let xmin = Infinity, xmax = -Infinity;
    for (let i = 0; i < oPos.length; i += 3) {
      xmin = Math.min(xmin, oPos[i]); xmax = Math.max(xmax, oPos[i]);
    }
    const len = xmax - xmin;
    const ax = (xmin + xmax) / 2 + 0.2878 * len;
    _ray.origin.set(ax, 2, 0);
    _ray.direction.set(0, -1, 0);
    const top = bvh.raycast(_ray, THREE.DoubleSide)
      .filter((h) => faceNormal(h.faceIndex, _fn) && _fn.y > 0.3)
      .sort((a, b) => a.distance - b.distance)[0];
    if (top) {
      const r = 0.34 * (len / 4.1); // erase disc slightly wider than the decal (R=0.27 at runtime)
      roundel = { x: top.point.x, y: top.point.y, z: top.point.z, r2: r * r };
      console.log(`${name}: roundel erase at (${top.point.x.toFixed(3)}, ${top.point.y.toFixed(3)}, 0) r=${r.toFixed(3)}`);
    }
  }

  // Chassis: bumper silhouette table — farthest surface point per plan angle
  // around (ARC_CX, 0). Where that silhouette exceeds ARC_RMIN the front arc
  // is the bumper tube; the white band / dark face / red inner wall rules key
  // off depth inward from it.
  const ARC_TB = 256;
  let arcOuter = null;
  const arcBinOf = (x, z) =>
    Math.min(ARC_TB - 1, Math.max(0, Math.floor((Math.atan2(z, x - LIV.ARC_CX) + Math.PI) / (2 * Math.PI) * ARC_TB)));
  if (isChassis) {
    arcOuter = new Float32Array(ARC_TB).fill(0);
    for (let i = 0; i < oPos.length; i += 3) {
      if (oPos[i] < LIV.XFRONT) continue;
      const r = Math.hypot(oPos[i] - LIV.ARC_CX, oPos[i + 2]);
      const tb = arcBinOf(oPos[i], oPos[i + 2]);
      if (r > arcOuter[tb]) arcOuter[tb] = r;
    }
  }

  const out = new Uint8Array(TEX * TEX * 4); // RGBA, alpha 0 = unbaked
  const recs = []; // [x,y,z, nx,ny,nz, texelIndex] — for the 3D vote + livery overrides
  const texelRec = new Int32Array(TEX * TEX).fill(-1); // texel -> its recs row
  for (let t = 0; t < triCount; t++) {
    const i0 = fIdx[t * 3], i1 = fIdx[t * 3 + 1], i2 = fIdx[t * 3 + 2];
    const u0 = fUV[i0 * 2] * TEX, v0 = fUV[i0 * 2 + 1] * TEX;
    const u1 = fUV[i1 * 2] * TEX, v1 = fUV[i1 * 2 + 1] * TEX;
    const u2 = fUV[i2 * 2] * TEX, v2 = fUV[i2 * 2 + 1] * TEX;
    const minX = Math.max(0, Math.floor(Math.min(u0, u1, u2)) - 1);
    const maxX = Math.min(TEX - 1, Math.ceil(Math.max(u0, u1, u2)) + 1);
    const minY = Math.max(0, Math.floor(Math.min(v0, v1, v2)) - 1);
    const maxY = Math.min(TEX - 1, Math.ceil(Math.max(v0, v1, v2)) + 1);
    const det = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
    if (Math.abs(det) < 1e-9) continue;
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const qx = px + 0.5, qy = py + 0.5;
        let w1 = ((qx - u0) * (v2 - v0) - (qy - v0) * (u2 - u0)) / det;
        let w2 = ((qy - v0) * (u1 - u0) - (qx - u0) * (v1 - v0)) / det;
        let w0 = 1 - w1 - w2;
        // Near-zero tolerance: texels outside the triangle would bake with
        // clamped-extrapolated positions (up to ~3mm of 3D error), which
        // shreds the geometric livery's straight cuts into hairy fringes.
        // Unbaked slivers along cell diagonals are filled by dilation instead.
        if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue;
        w0 = Math.max(w0, 0); w1 = Math.max(w1, 0); w2 = Math.max(w2, 0);
        const wt = w0 + w1 + w2;
        w0 /= wt; w1 /= wt; w2 /= wt;
        const x = fPos[i0 * 3] * w0 + fPos[i1 * 3] * w1 + fPos[i2 * 3] * w2;
        const y = fPos[i0 * 3 + 1] * w0 + fPos[i1 * 3 + 1] * w1 + fPos[i2 * 3 + 1] * w2;
        const z = fPos[i0 * 3 + 2] * w0 + fPos[i1 * 3 + 2] * w1 + fPos[i2 * 3 + 2] * w2;
        const nx = fNrm[i0 * 3] * w0 + fNrm[i1 * 3] * w1 + fNrm[i2 * 3] * w2;
        const ny = fNrm[i0 * 3 + 1] * w0 + fNrm[i1 * 3 + 1] * w1 + fNrm[i2 * 3 + 1] * w2;
        const nz = fNrm[i0 * 3 + 2] * w0 + fNrm[i1 * 3 + 2] * w1 + fNrm[i2 * 3 + 2] * w2;
        let rgb;
        const texelIndex = py * TEX + px;
        if (roundel && (x - roundel.x) ** 2 + (y - roundel.y) ** 2 + (z - roundel.z) ** 2 < roundel.r2) {
          rgb = PALETTE.red; // erase the baked fuzzy "7" — the decal replaces it
        } else {
          // Red is only legitimate in the chassis' authorized paint zones
          // (front region + pods); elsewhere red samples are Tripo's
          // paint-spill smudges, snapped to the luma-matched grey instead.
          // Wheels and the steering wheel are rubber/trim: never red.
          const redOK = isChassis && (x > LIV.XFRONT || inPod(x, y, z));
          // 5-tap surface smoothing before thresholding: Tripo's airbrushed
          // gradients wobble across the class cut and threshold into a noisy
          // red/white dissolve (mips blur it into pink streaks). Averaging a
          // small tangent neighbourhood makes the gradient monotonic, so the
          // threshold lands on ONE clean curve.
          const H = 0.007;
          let t1x = -nz, t1y = 0, t1z = nx; // n x (0,1,0), any tangent works
          const tl = Math.hypot(t1x, t1y, t1z) || 1;
          t1x /= tl; t1z /= tl;
          const t2x = ny * t1z - nz * t1y, t2y = nz * t1x - nx * t1z, t2z = nx * t1y - ny * t1x;
          let sr = 0, sg = 0, sb = 0;
          for (const [du, dv] of [[0, 0], [H, 0], [-H, 0], [0, H], [0, -H]]) {
            const c = sampleOriginal(
              x + t1x * du + t2x * dv, y + t1y * du + t2y * dv, z + t1z * du + t2z * dv,
              nx, ny, nz,
            );
            sr += c[0]; sg += c[1]; sb += c[2];
          }
          rgb = classify([sr / 5, sg / 5, sb / 5], redOK);
        }
        const o = (py * TEX + px) * 4;
        out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; out[o + 3] = 255;
        texelRec[texelIndex] = recs.length / 7;
        recs.push(x, y, z, nx, ny, nz, texelIndex);
      }
    }
  }

  // 3a) POSITION dilation into gutters and diagonal slivers: unbaked texels
  // inherit their nearest baked neighbour's surface position (and a
  // provisional color), so the geometric livery rules later evaluate
  // exactly at the cut lines. Color-copy dilation here would pick an
  // arbitrary side of a cut per texel and shred straight boundaries into
  // texel-scale hair.
  for (let pass = 0; pass < 6; pass++) {
    const prev = out.slice();
    for (let py = 0; py < TEX; py++) {
      for (let px = 0; px < TEX; px++) {
        const ti = py * TEX + px;
        if (prev[ti * 4 + 3]) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= TEX || ny >= TEX) continue;
          const q = ny * TEX + nx;
          if (!prev[q * 4 + 3] || texelRec[q] < 0) continue;
          const r = texelRec[q] * 7;
          texelRec[ti] = recs.length / 7;
          recs.push(recs[r], recs[r + 1], recs[r + 2], recs[r + 3], recs[r + 4], recs[r + 5], ti);
          out[ti * 4] = prev[q * 4]; out[ti * 4 + 1] = prev[q * 4 + 1]; out[ti * 4 + 2] = prev[q * 4 + 2];
          out[ti * 4 + 3] = 255;
          break;
        }
      }
    }
  }

  // 3b) per-cell 3x3 mode filter: majority vote among same-cell neighbours
  //     snaps ragged classification boundaries straight and deletes isolated
  //     flecks (source gradients wobble around the class thresholds).
  for (let mp = 0; mp < 3; mp++) {
    const cw = TEX / cells; // cell width in px (float)
    const prev = out.slice();
    const votes = new Map();
    for (let py = 0; py < TEX; py++) {
      for (let px = 0; px < TEX; px++) {
        const o = (py * TEX + px) * 4;
        if (!prev[o + 3]) continue;
        const cellX = Math.floor(px / cw), cellY = Math.floor(py / cw);
        votes.clear();
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx, ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= TEX || ny >= TEX) continue;
            if (Math.floor(nx / cw) !== cellX || Math.floor(ny / cw) !== cellY) continue;
            const q = (ny * TEX + nx) * 4;
            if (!prev[q + 3]) continue;
            const key = (prev[q] << 16) | (prev[q + 1] << 8) | prev[q + 2];
            votes.set(key, (votes.get(key) ?? 0) + 1);
          }
        }
        let bestKey = -1, bestN = 0;
        for (const [k, n] of votes) if (n > bestN) { bestN = n; bestKey = k; }
        if (bestKey >= 0) {
          out[o] = (bestKey >> 16) & 255; out[o + 1] = (bestKey >> 8) & 255; out[o + 2] = bestKey & 255;
        }
      }
    }
  }

  // 3c) Geometric livery. Two stages:
  //
  //  VOTE — normal-aware 3D majority vote on voxel cells (h=4mm, R=25mm):
  //  every smooth surface region converges to its locally dominant class,
  //  with boundaries settling into smooth curves (curvature-flow-like).
  //  Paint classes are only eligible where the livery authorizes paint —
  //  everywhere else cells vote frame-vs-dark only, so spill can never win.
  //  The normal gate keeps votes from crossing between the outer skin and
  //  Tripo's near-black interior shell, and between perpendicular surfaces.
  //
  //  OVERRIDES — where the design is unambiguous the class is stamped
  //  outright from geometry: solid red cowl; bumper tube split into white
  //  crown band / dark outer face / red inner wall by silhouette depth +
  //  normal contours; pods solid red with a white inset panel on the outer
  //  face. Wheels instead snap to their rotational (radius, axle) profile —
  //  a body of revolution gets a perfectly axisymmetric paint job.
  const nRec = recs.length / 7;
  const texClass = (i) => {
    const o = recs[i * 7 + 6] * 4;
    return clsOfRGB(out[o], out[o + 1], out[o + 2]);
  };
  const writeClass = (i, cls) => {
    const o = recs[i * 7 + 6] * 4;
    out[o] = CLS[cls][0]; out[o + 1] = CLS[cls][1]; out[o + 2] = CLS[cls][2];
  };
  if (isChassis) {
    // Paint (red/white) is stamped PURELY from geometry — solid zones with
    // anti-aliased cut lines — so there is NO per-texel colour vote that can
    // bleed one region into another. Grey frame vs dark seat/engine keep
    // their clean per-texel classification (step 3b already killed in-cell
    // noise). The earlier 3D vote is gone: it dragged frame grey into the
    // seat (and back) wherever two separate surfaces passed within a cell,
    // which was the "hairy" fringing on the seat and rails.
    //
    // Cuts are anti-aliased over ~2 texels: a hard texel-quantised boundary
    // staircases by ±1 texel and grazing views magnify that into visible
    // hairs; a blend band lets bilinear filtering draw one smooth line. The
    // runtime hue-swap recolours blends correctly (red-dominance is
    // continuous).
    const W_AA = 0.0022;       // blend half-width (~2.4 texels)
    const CUT = LIV.PLATE.y1;  // waterline height (== COWL.y)
    const writeMix = (i, a, b, t) => {
      const o = recs[i * 7 + 6] * 4;
      out[o] = Math.round(CLS[a][0] + (CLS[b][0] - CLS[a][0]) * t);
      out[o + 1] = Math.round(CLS[a][1] + (CLS[b][1] - CLS[a][1]) * t);
      out[o + 2] = Math.round(CLS[a][2] + (CLS[b][2] - CLS[a][2]) * t);
    };
    // Frame pipes are thin: a ray straight into the surface hits the far wall
    // within a couple cm. Body panels (cowl, apron, pods) have deep solid or
    // open space behind. Thin surfaces never take paint — every pipe keeps its
    // classified frame-grey. (Probed on the original mesh via the bake BVH.)
    const _thinRay = new THREE.Ray();
    const isThin = (x, y, z, nx, ny, nz) => {
      _thinRay.origin.set(x - nx * 0.001, y - ny * 0.001, z - nz * 0.001);
      _thinRay.direction.set(-nx, -ny, -nz);
      const h = bvh.raycastFirst(_thinRay, THREE.DoubleSide);
      return h && h.distance < LIV.THIN;
    };
    let painted = 0;
    for (let i = 0; i < nRec; i++) {
      const x = recs[i * 7], y = recs[i * 7 + 1], z = recs[i * 7 + 2];
      let nx = recs[i * 7 + 3], ny = recs[i * 7 + 4], nz = recs[i * 7 + 5];
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      let cls = -1, blended = false;
      if (inPod(x, y, z)) {
        cls = RED; // side pods: solid red, no inset panel
      } else if (x > LIV.XFRONT) {
        const tb = arcBinOf(x, z);
        const onTube = arcOuter[tb] > LIV.ARC_RMIN &&
          arcOuter[tb] - Math.hypot(x - LIV.ARC_CX, z) < LIV.D_TUBE;
        // is this column red above the waterline? (cowl or raised nose furniture)
        const redAbove = (Math.abs(z) < LIV.COWL.z && x >= LIV.COWL.x0 && x <= LIV.COWL.x1) ||
          (x <= 0.3 && Math.abs(z) < 0.25);
        if (onTube) {
          // White crown over a dark face. The up-facing cut is anti-aliased so
          // the rounded bumper's coarse facets don't tear it into fingers.
          const t = (ny - LIV.NY_UP) / LIV.W_NY;
          if (t >= 1) cls = WHITE;
          else if (t <= -1) cls = DARK;
          else { writeMix(i, DARK, WHITE, t * 0.5 + 0.5); blended = true; }
        } else if (isThin(x, y, z, nx, ny, nz)) {
          // a frame pipe threading the front region: leave it classified grey
        } else if (y > CUT + W_AA) {
          if (redAbove) cls = RED;
        } else if (y >= LIV.PLATE.y0 && ny > LIV.NY_PLATE) {
          // White nose apron: up-facing plate only (pipe sides/undersides keep
          // grey). One horizontal waterline, anti-aliased where red sits above.
          if (redAbove && y > CUT - W_AA) { writeMix(i, WHITE, RED, (y - CUT) / (2 * W_AA) + 0.5); blended = true; }
          else cls = WHITE;
        }
      }
      if (blended) { painted++; continue; }
      if (cls < 0) continue; // grey/dark structure: keep the clean classified value
      writeClass(i, cls);
      painted++;
    }
    console.log(`${name}: livery stamped ${painted}/${nRec} texels (rest = classified grey/dark)`);
  } else if (name === "tripo_part_2") {
    // Steering wheel: a toy kart's wheel is uniformly black. Tripo painted
    // its spokes/hub a noisy silver that classified into blotchy grey, so
    // force the whole part flat dark — one clean moulded piece; the cel
    // shader still models the rim and spokes from geometry.
    for (let i = 0; i < nRec; i++) writeClass(i, DARK);
    console.log(`${name}: forced flat dark (${nRec} texels)`);
  } else {
    // Road wheels: tyre AND rim entirely black — one clean moulded wheel.
    // (The cel shader still separates tyre / rim / hub from geometry.)
    for (let i = 0; i < nRec; i++) writeClass(i, DARK);
    console.log(`${name}: forced flat dark (${nRec} texels)`);
  }

  // 4) dilate unbaked texels from baked neighbours (gutter fill). 6 passes
  //    covers the 2px gutters plus unpaired cells' empty halves near edges.
  for (let pass = 0; pass < 6; pass++) {
    const prev = out.slice();
    for (let py = 0; py < TEX; py++) {
      for (let px = 0; px < TEX; px++) {
        const o = (py * TEX + px) * 4;
        if (prev[o + 3]) continue;
        // Copy ONE baked neighbor (not an average): blending flat palette
        // colors at region borders would mint new in-between tints.
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= TEX || ny >= TEX) continue;
          const q = (ny * TEX + nx) * 4;
          if (!prev[q + 3]) continue;
          out[o] = prev[q]; out[o + 1] = prev[q + 1]; out[o + 2] = prev[q + 2]; out[o + 3] = 255;
          break;
        }
      }
    }
  }

  // Flood every remaining unbaked texel (unpaired half-cells, grid remainder)
  // with the part's average baked color: those texels are never addressed
  // directly, but mipmap averaging folds them in at distance — leaving them
  // black darkens the whole model in the far field.
  {
    let r = 0, g = 0, b = 0, n = 0;
    for (let o = 0; o < out.length; o += 4)
      if (out[o + 3]) { r += out[o]; g += out[o + 1]; b += out[o + 2]; n++; }
    if (n) {
      r /= n; g /= n; b /= n;
      for (let o = 0; o < out.length; o += 4)
        if (!out[o + 3]) { out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255; }
    }
  }

  // Palette PNG: the texture is a handful of flat colors, so lossless PNG is
  // both smaller than JPEG here AND free of the mosquito noise JPEG sprays
  // around crisp color boundaries (it read as residual streaking up close).
  const jpeg = await sharp(Buffer.from(out.buffer), { raw: { width: TEX, height: TEX, channels: 4 } })
    .removeAlpha().png({ palette: true, colors: 48, dither: 0 }).toBuffer();

  // 5) emit node
  const tex = outDoc.createTexture(`${name}_baked`).setImage(jpeg).setMimeType("image/png");
  const mat = outDoc.createMaterial(`${name}_material`)
    .setBaseColorTexture(tex).setMetallicFactor(0).setRoughnessFactor(0.85);
  const p = outDoc.createPrimitive()
    .setAttribute("POSITION", outDoc.createAccessor().setType("VEC3").setArray(fPos).setBuffer(buffer))
    .setAttribute("NORMAL", outDoc.createAccessor().setType("VEC3").setArray(fNrm).setBuffer(buffer))
    .setAttribute("TEXCOORD_0", outDoc.createAccessor().setType("VEC2").setArray(fUV).setBuffer(buffer))
    .setIndices(outDoc.createAccessor().setType("SCALAR").setArray(fIdx).setBuffer(buffer))
    .setMaterial(mat);
  const outMesh = outDoc.createMesh(name).addPrimitive(p);
  const outNode = outDoc.createNode(name).setMesh(outMesh).setTranslation(node.getTranslation());
  parent.addChild(outNode);
  console.log(`${name}: ${oIdx.length / 3} -> ${triCount} tris, tex ${TEX}px, err=${S.err.toFixed(4)}, pairs=${pairs.length}, cell=${cellPx}px`);
}

// Recenter wheel/steering pivots on bbox centers (true spin axes).
for (const node of outDoc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh || node.getName() === "tripo_part_19") continue;
  const acc = mesh.listPrimitives()[0].getAttribute("POSITION");
  const pos = acc.getArray().slice();
  let lo = [Infinity, Infinity, Infinity], hiB = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], pos[i + k]); hiB[k] = Math.max(hiB[k], pos[i + k]);
    }
  const c = [0, 1, 2].map((k) => (lo[k] + hiB[k]) / 2);
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) pos[i + k] -= c[k];
  acc.setArray(pos);
  const t = node.getTranslation();
  node.setTranslation([t[0] + c[0], t[1] + c[1], t[2] + c[2]]);
}

let tris = 0;
for (const mesh of outDoc.getRoot().listMeshes())
  for (const prim of mesh.listPrimitives()) tris += prim.getIndices().getCount() / 3;
console.log(`final tris=${Math.round(tris)}`);
await io.write(dst, outDoc);
console.log("wrote", dst);
