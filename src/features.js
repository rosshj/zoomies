import * as THREE from "three";

// ---- Track set pieces -------------------------------------------------------
// Signature moments planned onto the loop: a river the road BRIDGES over, a
// CANYON the road threads through, a GIANT-tree forest stretch, and an urban
// OVERPASS riding above a sunken city level. The core idea: every feature is a
// deliberate disagreement between the road and the terrain, and the structure
// that resolves it (deck + piers, rock walls, towering trunks) IS the feature.
//
// It stays procedural + cohesive by "authoring the coincidence": the loop is
// generated first, exactly as before, then each feature picks the arc of the
// loop best suited to it — owned by its biome (river in the green biomes,
// canyon in desert/alpine, giants in the forest, overpass in the city) — and
// the terrain is shaped around that arc. Everything derives from the seeded
// RNG stream, so a seed reproduces its features, and every field blends in and
// out over wide bands so runs stay seamless with the surrounding world.
//
// Wiring:
//   - track.js:  planFeatures(track, biomeNames, rng) -> track.features
//   - scenery.js heightAt chain: featureHeightMod (canyon walls, overpass sink)
//   - scenery.js makeLakes:      riverLakeEntry (the river reuses the ribbon-
//                                lake carve + water wholesale)
//   - scenery.js buildForests:   giantTreeBoost (0..1 tree-scale field)
//   - scenery.js buildWorld:     buildFeatureStructures (decks, piers, rocks)
// Gameplay is untouched: karts project onto the centreline and ride the road's
// own height, so a kart on a bridge is just a kart on road that happens to be
// high. A feature only spawns when its biome actually appears under the loop.

const TAU = Math.PI * 2;
const smooth01 = (t) => {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
};

// One entry per feature kind, in planning priority order: the single-biome
// kinds pick first (they have the fewest options); the bridge goes last since
// seven biomes can host it, so it can always find room elsewhere.
//   biomes:   the run must sit (almost) entirely in these
//   halfFrac: half the run length, as a fraction of the lap
//   flatW / curvW: scoring weights — bridges/overpasses want flat straight
//   arcs (a deck on a hairpin or a steep grade reads broken), canyons and
//   giant woods tolerate bends and slope.
const KIND_SPECS = [
  { kind: "overpass", biomes: ["city"], halfFrac: 0.038, flatW: 2.6, curvW: 120 },
  { kind: "canyon", biomes: ["desert", "alpine", "tundra"], halfFrac: 0.052, flatW: 0.6, curvW: 40 },
  { kind: "giant", biomes: ["forest"], halfFrac: 0.045, flatW: 0.3, curvW: 20 },
  { kind: "bridge", biomes: ["meadow", "autumn", "blossom", "savanna", "tundra", "beach", "forest"], halfFrac: 0.032, flatW: 3.0, curvW: 150 },
];

// Circular index distance on the sample loop.
const loopDist = (a, b, N) => {
  const d = Math.abs(a - b) % N;
  return Math.min(d, N - d);
};

// Nearest-point query against a run/river spine polyline: XZ distance, the
// 0..1 position along the spine, and the spine point's own y. Reused scratch.
const _sd = { d: Infinity, u: -1, y: 0 };
function spineDist(spine, x, z) {
  _sd.d = Infinity;
  _sd.u = -1;
  const n = spine.length;
  for (let i = 0; i < n - 1; i++) {
    const a = spine[i], b = spine[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz || 1;
    let t = ((x - a.x) * dx + (z - a.z) * dz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = x - (a.x + dx * t), pz = z - (a.z + dz * t);
    const d = px * px + pz * pz;
    if (d < _sd.d) {
      _sd.d = d;
      _sd.u = (i + t) / (n - 1);
      _sd.y = a.y + (b.y - a.y) * t;
    }
  }
  _sd.d = Math.sqrt(_sd.d);
  return _sd;
}

// Build a run record for samples c-half .. c+half: a subsampled spine (with
// road y for the overpass's sunken-level reference) plus everything the height
// fields and structure builder need. `others` is a coarse point list of every
// OTHER pass of the road, so the run's terrain field can yield around folds of
// the loop that come near — instead of burying (or sinking) that road.
function makeRun(track, kind, c, half) {
  const N = track.samples;
  const spine = [];
  for (let i = c - half; i <= c + half; i += 3) {
    const p = track._pts[((i % N) + N) % N];
    spine.push({ x: p.x, z: p.z, y: p.y });
  }
  const others = [];
  for (let j = 0; j < N; j += 5) {
    if (loopDist(j, ((c % N) + N) % N, N) <= half + 12) continue;
    const q = track._pts[j];
    others.push(q.x, q.z);
  }
  return { kind, c, half, i0: c - half, i1: c + half, spine, others, halfWidth: track.halfWidth };
}

// XZ distance from (x,z) to the nearest point of a run's "other road" list.
function otherRoadDist(others, x, z) {
  let d = Infinity;
  for (let i = 0; i < others.length; i += 2) {
    const dx = others[i] - x;
    const dz = others[i + 1] - z;
    const dd = dx * dx + dz * dz;
    if (dd < d) d = dd;
  }
  return Math.sqrt(d);
}

// Plan the map's set pieces. `biomeNames` is the biome name per track sample
// (computed by the track, which owns the layout); `rng` is the seeded stream.
export function planFeatures(track, biomeNames, rng) {
  const N = track.samples;
  const pts = track._pts;
  const tans = track._tans;
  const feats = { runs: [], river: null };
  const startGuard = Math.round(0.07 * N); // keep the start grid + banner clean
  const taken = [];

  const overlapsTaken = (c, half) => {
    if (loopDist(c, 0, N) < startGuard + half) return true;
    return taken.some((t) => loopDist(c, t.c, N) < t.half + half + Math.round(0.03 * N));
  };

  for (const spec of KIND_SPECS) {
    const half = Math.round(spec.halfFrac * N);
    let best = null;
    let bestScore = Infinity;
    for (let c = 0; c < N; c += 5) {
      if (overlapsTaken(c, half)) continue;
      // The run must sit (almost) entirely inside its host biome.
      let hits = 0, total = 0;
      for (let i = c - half; i <= c + half; i += 4) {
        total++;
        if (spec.biomes.includes(biomeNames[((i % N) + N) % N])) hits++;
      }
      if (hits < total * 0.86) continue;
      // Score: flat + straight (weighted per kind) with a seeded jitter so
      // equally-good arcs vary per map instead of always picking the first.
      let mn = Infinity, mx = -Infinity, curv = 0;
      for (let i = c - half; i <= c + half; i += 2) {
        const idx = ((i % N) + N) % N;
        const y = pts[idx].y;
        if (y < mn) mn = y;
        if (y > mx) mx = y;
        const t0 = tans[idx];
        const t1 = tans[(idx + 2) % N];
        let d = Math.atan2(t1.x, t1.z) - Math.atan2(t0.x, t0.z);
        while (d > Math.PI) d -= TAU;
        while (d < -Math.PI) d += TAU;
        curv += Math.abs(d);
      }
      const score = (mx - mn) * spec.flatW + curv * spec.curvW + rng() * 6;
      if (score >= bestScore) continue;
      bestScore = score;
      best = c;
    }
    if (best == null) continue;
    const run = makeRun(track, spec.kind, best, half);
    if (spec.kind === "canyon") {
      run.mag = 23 + rng() * 9; // wall height varies per seed
      // Desert canyons get warm red rock; alpine/tundra stay cool grey.
      run.warmRock = biomeNames[((best % N) + N) % N] === "desert";
    }
    if (spec.kind === "overpass") run.depth = 7.5;
    if (spec.kind === "bridge") {
      const river = makeRiver(track, run, rng);
      if (!river) continue; // no room for the river -> no bridge this map
      feats.river = river;
    }
    taken.push({ c: best, half });
    feats.runs.push(run);
  }
  return feats;
}

// The river under a bridge run: a meandering spine perpendicular to the road at
// the run's centre, extended BOTH ways until it runs out of length or would
// touch another part of the loop. Shaped exactly like a ribbon lake so the
// existing carve/water/prop-exclusion systems take it wholesale.
function makeRiver(track, run, rng) {
  const N = track.samples;
  const c = ((run.c % N) + N) % N;
  const p = track._pts[c];
  const tan = track._tans[c];
  const side = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0)).normalize();
  const waterR = 10 + rng() * 4;
  const blend = waterR + 3.5 + 11;
  const ph0 = rng() * TAU;
  const ph1 = rng() * TAU;
  const amp = 26 + rng() * 22;

  // March outward from the crossing in each direction; the meander is a couple
  // of harmonics along the road's tangent axis, eased in from zero so the river
  // leaves the crossing perpendicular (it can't curl back over its own deck).
  // Each arm stops before the carve could reach any OTHER pass of the loop —
  // checked against the run's `others` list, so the intended crossing itself
  // never truncates the river.
  const STEP = 13;
  const armPts = (sign) => {
    const arm = [];
    for (let k = 1; k <= 30; k++) {
      const t = sign * k * STEP;
      const sway = amp * smooth01(Math.abs(t) / 80) * (Math.sin(t * 0.011 + ph0) * 0.7 + Math.sin(t * 0.023 + ph1) * 0.3);
      const x = p.x + side.x * t + tan.x * sway;
      const z = p.z + side.z * t + tan.z * sway;
      if (otherRoadDist(run.others, x, z) < track.halfWidth + blend + 6) break;
      if (Math.hypot(x, z) > 880) break; // stay on the terrain sheet
      arm.push({ x, z });
    }
    return arm;
  };
  const a = armPts(-1);
  const b = armPts(1);
  if (a.length + b.length < 9) return null; // too boxed in to read as a river
  const raw = [...a.reverse(), { x: p.x, z: p.z }, ...b];

  // Per-point widths (sx/sz) for the water ribbon, from the local flow direction.
  const spine = raw.map((q, i) => {
    const q0 = raw[Math.max(0, i - 1)];
    const q1 = raw[Math.min(raw.length - 1, i + 1)];
    let dx = q1.x - q0.x, dz = q1.z - q0.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    return { x: q.x, z: q.z, sx: dz, sz: -dx };
  });

  let runMinY = Infinity;
  for (const s of run.spine) if (s.y < runMinY) runMinY = s.y;
  const level = runMinY - 5.5; // water sits well under the LOWEST point of the deck
  return {
    ribbon: true,
    river: true,
    spine,
    level,
    floor: level - 3.4,
    waterR,
    shoreR: waterR + 3.5,
    blendR: blend,
  };
}

// The river as a lake-system entry (or null). makeLakes() unshifts this ahead
// of the lakes it places itself, so every later placement keeps clear of it.
export function riverLakeEntry(feats) {
  return feats && feats.river ? feats.river : null;
}

// Canyon walls + overpass sink, applied on top of the lake-carved height. Both
// fade in/out along the run and across their distance bands, so the terrain
// meets the surrounding world without a seam.
export function featureHeightMod(feats, x, z, h) {
  if (!feats) return h;
  for (const run of feats.runs) {
    if (run.kind === "canyon") {
      const s = spineDist(run.spine, x, z);
      if (s.u < 0 || s.d > 132) continue;
      const endW = smooth01(s.u / 0.16) * smooth01((1 - s.u) / 0.16);
      if (endW <= 0) continue;
      const inner = run.halfWidth + 7; // road corridor + verge stays untouched
      const peak0 = inner + 9; // steep climb straight off the verge
      const peak1 = inner + 50;
      let w = 0;
      if (s.d <= inner) w = 0;
      else if (s.d < peak0) w = smooth01((s.d - inner) / (peak0 - inner));
      else if (s.d < peak1) w = 1;
      else w = 1 - smooth01((s.d - peak1) / (132 - peak1));
      if (w <= 0) continue;
      // Yield around any OTHER pass of the loop that folds near this run, so
      // the wall never buries road (the field fades out approaching it).
      const gate = smooth01((otherRoadDist(run.others, x, z) - (run.halfWidth + 10)) / 26);
      if (gate <= 0) continue;
      // Gentle rim variation — the wall reads as a steep hillside, not a berm.
      const wob = 0.9 + 0.1 * Math.sin(x * 0.045 + z * 0.06) * Math.sin(x * 0.021 - z * 0.033);
      h += run.mag * w * endW * wob * gate;
    } else if (run.kind === "overpass") {
      const s = spineDist(run.spine, x, z);
      if (s.u < 0 || s.d > 74) continue;
      const endW = smooth01(s.u / 0.2) * smooth01((1 - s.u) / 0.2);
      const across = 1 - smooth01((s.d - 34) / (74 - 34)); // flat sunken level near the road
      // As with the canyon: never sink ground under another pass of the loop.
      const gate = smooth01((otherRoadDist(run.others, x, z) - (run.halfWidth + 10)) / 26);
      const t = across * endW * gate;
      if (t <= 0) continue;
      const sunk = s.y - run.depth; // the lower city level, relative to the deck above it
      h += (Math.min(h, sunk) - h) * t;
    }
  }
  return h;
}

// Should roadside buildings/props stay out of (x,z)? Each set piece keeps a
// clear corridor so it reads as itself: no cottages inside the canyon, deep
// woods (not a town) around the giants, and the city towers stand back from
// the overpass so the deck visibly flies over the sunken level. The river is
// already covered by the lake exclusion.
export function featureKeepClear(feats, x, z) {
  if (!feats) return false;
  for (const run of feats.runs) {
    const R =
      run.kind === "overpass" ? 42
      : run.kind === "canyon" ? 88
      : run.kind === "giant" ? 66
      : 34; // bridge: keep props out from under the deck
    const s = spineDist(run.spine, x, z);
    if (s.u >= 0 && s.d < R) return true;
  }
  return false;
}

// Should trees stay off (x,z)? The canyon's wall band is bare rock/scrub —
// trees planted mid-face clipped straight into the outcrops.
export function featureTreeBlock(feats, x, z) {
  if (!feats) return false;
  for (const run of feats.runs) {
    if (run.kind !== "canyon") continue;
    const s = spineDist(run.spine, x, z);
    if (s.u >= 0 && s.d < run.halfWidth + 58) return true;
  }
  return false;
}

// 0..1 "make the trees giant here" field for the forest run.
export function giantTreeBoost(feats, x, z) {
  if (!feats) return 0;
  for (const run of feats.runs) {
    if (run.kind !== "giant") continue;
    const s = spineDist(run.spine, x, z);
    if (s.u < 0) return 0;
    const endW = smooth01(s.u / 0.15) * smooth01((1 - s.u) / 0.15);
    return (1 - smooth01((s.d - 70) / 55)) * endW;
  }
  return 0;
}

// ---- Structures -------------------------------------------------------------
// One kit for both elevated runs: concrete deck skirts + underside so the road
// reads as a slab with thickness, and paired piers with a crossbeam carrying it
// down to whatever the (carved) ground is — riverbed, bank or sunken plaza.
// The canyon gets rows of craggy rock chunks riding its walls. The road's own
// barriers keep running along the deck edges as parapets, so the driving
// envelope is unchanged.
export function buildFeatureStructures(scene, track, heightAt, rng = Math.random) {
  const feats = track.features;
  if (!feats || !feats.runs.length) return;
  const N = track.samples;
  const up = new THREE.Vector3(0, 1, 0);
  const spacing = track.length / N; // world units per sample

  const concrete = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide });
  const cTop = new THREE.Color(0xb5b0a6); // skirt face
  const cUnder = new THREE.Color(0x7e7a72); // shadowed underside
  const deckGeoms = [];
  const pierBoxes = []; // { x, y, z, sx, sy, sz, yaw }

  for (const run of feats.runs) {
    if (run.kind !== "bridge" && run.kind !== "overpass") continue;
    const span = run.i1 - run.i0;
    const skirtTopOff = track.halfWidth + 0.62;
    const positions = [];
    const colors = [];
    const indices = [];
    let row = 0;
    // Two side skirts + the underside as one triangulated strip set.
    for (let i = run.i0; i <= run.i1; i++) {
      const idx = ((i % N) + N) % N;
      const p = track._pts[idx];
      const side = new THREE.Vector3().crossVectors(track._tans[idx], up).normalize();
      const u = (i - run.i0) / span;
      const endW = smooth01(u / 0.12) * smooth01((1 - u) / 0.12);
      const depth = 0.35 + 2.0 * endW; // slab thins away to nothing at the ends
      const lx = p.x + side.x * skirtTopOff, lz = p.z + side.z * skirtTopOff;
      const rx = p.x - side.x * skirtTopOff, rz = p.z - side.z * skirtTopOff;
      positions.push(
        lx, p.y + 0.12, lz, // 0 left top
        lx, p.y - depth, lz, // 1 left bottom
        rx, p.y - depth, rz, // 2 right bottom
        rx, p.y + 0.12, rz // 3 right top
      );
      colors.push(cTop.r, cTop.g, cTop.b, cUnder.r, cUnder.g, cUnder.b, cUnder.r, cUnder.g, cUnder.b, cTop.r, cTop.g, cTop.b);
      if (i < run.i1) {
        const a = row * 4;
        const b = a + 4;
        indices.push(a, b, a + 1, a + 1, b, b + 1); // left skirt
        indices.push(a + 1, b + 1, a + 2, a + 2, b + 1, b + 2); // underside
        indices.push(a + 2, b + 2, a + 3, a + 3, b + 2, b + 3); // right skirt
      }
      row++;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    deckGeoms.push(geo);

    // Piers wherever the deck actually has air under it.
    const step = Math.max(5, Math.round(24 / spacing));
    for (let i = run.i0 + step; i <= run.i1 - step; i += step) {
      const idx = ((i % N) + N) % N;
      const p = track._pts[idx];
      const side = new THREE.Vector3().crossVectors(track._tans[idx], up).normalize();
      const yaw = Math.atan2(side.x, side.z);
      const deckBottom = p.y - 2.0;
      let lowest = Infinity;
      const legOff = track.halfWidth * 0.42;
      const legs = [];
      for (const sgn of [1, -1]) {
        const x = p.x + side.x * sgn * legOff;
        const z = p.z + side.z * sgn * legOff;
        const gy = heightAt(x, z);
        legs.push({ x, z, gy });
        if (gy < lowest) lowest = gy;
      }
      if (deckBottom - lowest < 1.6) continue; // deck is basically on the ground here
      for (const leg of legs) {
        const hgt = deckBottom - leg.gy + 1.6; // sink the foot into the ground
        pierBoxes.push({ x: leg.x, y: leg.gy - 1.6 + hgt / 2, z: leg.z, sx: 2.5, sy: hgt, sz: 2.1, yaw });
      }
      // Crossbeam cap tying the pair under the deck.
      pierBoxes.push({ x: p.x, y: deckBottom - 0.55, z: p.z, sx: track.halfWidth * 1.5, sy: 1.1, sz: 2.4, yaw });
    }
  }

  if (deckGeoms.length) {
    for (const g of deckGeoms) {
      const mesh = new THREE.Mesh(g, concrete);
      mesh.castShadow = true;
      scene.add(mesh);
    }
  }
  if (pierBoxes.length) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xa8a49b, roughness: 1 });
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, pierBoxes.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pv = new THREE.Vector3();
    const sv = new THREE.Vector3();
    pierBoxes.forEach((b, i) => {
      q.setFromAxisAngle(up, b.yaw);
      pv.set(b.x, b.y, b.z);
      sv.set(b.sx, b.sy, b.sz);
      m.compose(pv, q, sv);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    scene.add(mesh);
  }

  // Canyon rim rocks: two craggy rows riding the raised walls on both sides,
  // tinted warm in the desert and grey elsewhere (same trick as the mountains).
  const canyon = feats.runs.find((r) => r.kind === "canyon");
  if (canyon) {
    // Sparse outcrops sunk into the wall face — accents on a steep hillside,
    // not a rampart of boulders hiding it.
    const chunks = [];
    for (let i = canyon.i0; i <= canyon.i1; i += 5) {
      const idx = ((i % N) + N) % N;
      const p = track._pts[idx];
      const side = new THREE.Vector3().crossVectors(track._tans[idx], up).normalize();
      for (const sgn of [1, -1]) {
        if (rng() < 0.62) continue;
        const off = track.halfWidth + 14 + rng() * 34; // scattered up the wall
        const x = p.x + side.x * sgn * off + (rng() - 0.5) * 5;
        const z = p.z + side.z * sgn * off + (rng() - 0.5) * 5;
        if (track.distanceToCenter(x, z) < track.halfWidth + 10) continue;
        chunks.push({ x, z, base: heightAt(x, z), h: 4.5 + rng() * 6 });
      }
    }
    if (chunks.length) {
      const geo = new THREE.IcosahedronGeometry(1, 1);
      const mat = new THREE.MeshStandardMaterial({ roughness: 1 });
      const mesh = new THREE.InstancedMesh(geo, mat, chunks.length);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const pv = new THREE.Vector3();
      const sv = new THREE.Vector3();
      const col = new THREE.Color();
      chunks.forEach((c, i) => {
        const sy = c.h / 2;
        q.setFromEuler(new THREE.Euler(rng() * 0.5, rng() * Math.PI, rng() * 0.5));
        pv.set(c.x, c.base + sy * 0.15, c.z); // sunk into the hillside
        sv.set(2.2 + rng() * 2.4, sy, 2.2 + rng() * 2.4);
        m.compose(pv, q, sv);
        mesh.setMatrixAt(i, m);
        // Desert canyons read as red rock; alpine/tundra rims stay cool grey.
        const warm = canyon.warmRock;
        if (warm) col.setHSL(0.055, 0.52, 0.33 + rng() * 0.1);
        else col.setHSL(0.09, 0.1, 0.4 + rng() * 0.14);
        mesh.setColorAt(i, col);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = true;
      mesh.layers.set(1); // out of the rear-view mirror, like the cliffs
      scene.add(mesh);
    }
  }
}
