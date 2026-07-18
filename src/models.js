import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// Rounded box helper — the workhorse of the soft, toy-like art direction. Edges
// are chamfered by `r` (auto-clamped so it never exceeds half the smallest side).
function rbox(w, h, d, r = 0.18, seg = 4) {
  const radius = Math.min(r, w / 2, h / 2, d / 2) * 0.98;
  return new RoundedBoxGeometry(w, h, d, seg, radius);
}

// Bake a list of positioned meshes down to ONE multi-material mesh — the single
// biggest lever on draw calls. The cat + kart used to be ~100 separate meshes
// each (≈100 draw calls × 6 racers); collapsing the rigid clusters into a mesh
// whose draw-call count equals only its number of DISTINCT materials cuts that
// dramatically with no visual change.
//
// Each input mesh's local transform (position/rotation/scale) is baked into a
// clone of its geometry, geometries are normalised to non-indexed (RoundedBox is
// non-indexed while Box/Sphere/Cone/Cylinder are indexed, and mergeGeometries
// refuses to mix the two — same gotcha scenery.js documents), then grouped by
// material so each material becomes one merged sub-geometry / one draw call.
// Returns a single THREE.Mesh (material is a single material or an array), or
// null when given nothing. Materials are reused by reference so toonify() still
// maps them and dynamic refs (brake/flames) are unaffected.
// Merged-geometry cache (see geoKey below): kart shells / wheels / cat clusters
// are byte-identical across every racer with the same style/pattern — only the
// MATERIALS differ (colour-keyed instances). Caching the merged geometry means a
// six-kart field holds ONE copy of each body in memory instead of six, and a
// rebuilt race reuses it outright instead of re-merging. This is the lever that
// makes high-poly kart/cat models affordable: geometry cost is per VARIANT, not
// per racer. Entries are flagged shared so disposeGroup leaves them alone.
const _geoCache = new Map();
export function mergeMeshes(meshes, { castShadow = false, receiveShadow = false, geoKey = null } = {}) {
  if (!meshes.length) return null;
  // geoKey contract: for a given key, callers always pass parts with identical
  // geometry/transforms and an identical material-identity pattern (same roles
  // collapsing to the same slots), so the cached geometry + fresh material list
  // line up group-for-group.
  if (geoKey) {
    const cached = _geoCache.get(geoKey);
    if (cached) {
      const mats = [];
      const seen = new Set();
      for (const m of meshes) {
        if (!seen.has(m.material)) { seen.add(m.material); mats.push(m.material); }
      }
      const mesh = new THREE.Mesh(cached, mats.length === 1 ? mats[0] : mats);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      return mesh;
    }
  }
  const order = [];          // material instances, in first-seen order
  const byMat = new Map();   // material -> [baked geometry]
  for (const m of meshes) {
    m.updateMatrix();
    let geo = m.geometry.clone();
    geo.applyMatrix4(m.matrix);
    if (geo.index) geo = geo.toNonIndexed();
    // Drop any attributes beyond the common set so every geometry merges cleanly.
    for (const key of Object.keys(geo.attributes)) {
      if (key !== "position" && key !== "normal" && key !== "uv") geo.deleteAttribute(key);
    }
    if (!byMat.has(m.material)) { byMat.set(m.material, []); order.push(m.material); }
    byMat.get(m.material).push(geo);
  }
  const mats = [];
  const perMat = [];
  for (const mat of order) {
    const geos = byMat.get(mat);
    perMat.push(geos.length === 1 ? geos[0] : mergeGeometries(geos, false));
    mats.push(mat);
  }
  const finalGeo = perMat.length === 1 ? perMat[0] : mergeGeometries(perMat, true);
  if (geoKey) {
    finalGeo.userData.shared = true; // disposeGroup must not free it between races
    // Soft cap (multiplayer can mint arbitrary accessory-colour variants):
    // evict oldest-inserted. Live meshes keep their reference; GC reclaims later.
    if (_geoCache.size >= 96) _geoCache.delete(_geoCache.keys().next().value);
    _geoCache.set(geoKey, finalGeo);
  }
  const mesh = new THREE.Mesh(finalGeo, mats.length === 1 ? mats[0] : mats);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  return mesh;
}

// How lit-up the karts are, from the world's time of day: 0 = midday (off),
// ~0.55 = sunset/dusk (warm, dimmer), 1 = night (full). Drives the glow of the
// headlight bulbs; the underglow stays a night-only effect. Set once before karts
// are built.
let _lightLevel = 0;
export function setLightLevel(v) {
  _lightLevel = Math.max(0, Math.min(1, v || 0));
}

// Racing-number roundel decal: a white disc with a dark ring and the kart's
// number, drawn to a transparent canvas so it sits on a plane on each fairing.
const _numTexCache = new Map();
export function makeNumberTexture(n) {
  if (_numTexCache.has(n)) return _numTexCache.get(n);
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = "#f5f5f5";
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S * 0.46, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = S * 0.06;
  ctx.strokeStyle = "#1c1c20";
  ctx.stroke();
  ctx.fillStyle = "#1c1c20";
  ctx.font = `bold ${S * 0.6}px system-ui, Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(n), S / 2, S / 2 + S * 0.03);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  _numTexCache.set(n, t);
  return t;
}

// Soft radial texture for the kart underglow pool.
let _underTex = null;
function underglowTexture() {
  if (_underTex) return _underTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,0.85)");
  g.addColorStop(0.55, "rgba(255,255,255,0.3)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  _underTex = new THREE.CanvasTexture(c);
  _underTex.colorSpace = THREE.SRGBColorSpace;
  return _underTex;
}

// The catalogue the custom-cat creator offers, and each breed's signature
// accessory (the default when opts.accessory isn't given). Real cat coat
// patterns, plus the accessory each preset breed wears.
export const CAT_PATTERNS = ["spotted", "solid", "tuxedo", "snowshoe", "tabby", "mitted", "point", "calico", "tortie", "bengal", "cow", "smoke"];
export const CAT_ACCESSORIES = ["none", "cap", "headphones", "beanie", "flower", "fedora", "sunglasses", "bandana", "collar", "bow"];
// Human-facing labels (ids stay stable for saved garages / breed defaults).
export const ACCESSORY_LABELS = {
  none: "None", cap: "Cap", headphones: "Headphones", beanie: "Beanie", flower: "Flower",
  fedora: "Fedora", sunglasses: "Sunglasses", bandana: "Bandana", collar: "Collar", bow: "Bow tie",
};
// A sensible colour palette per accessory type — the FIRST entry is the natural
// default (used when a cat doesn't pick a colour), the rest are the swatches the
// creator offers. Single source of truth: createCat reads [0], the garage UI
// renders the whole list.
export const ACCESSORY_COLORS = {
  none: [],
  cap:        [0xe23b3b, 0x2f6fd6, 0x37b24d, 0x1a1a1a, 0xf5c518, 0xf0f0f0, 0xff8c1a, 0xa259ff, 0x18b6a6], // team-cap colours
  headphones: [0x222831, 0xf0f0f0, 0xe23b3b, 0x2f6fd6, 0xff5fa2, 0x37b24d, 0xf5c518, 0xa259ff, 0x18b6a6], // gadget colours
  beanie:     [0x3f7fd6, 0xe23b3b, 0x37b24d, 0x8a8f98, 0xff5fa2, 0xf5c518, 0xa259ff, 0xff8c1a, 0xf0f0f0], // knit colours
  flower:     [0xff7ab3, 0xe23b3b, 0xffe14d, 0xa259ff, 0xf0f0f0, 0xff8c1a, 0x2f6fd6, 0x18b6a6, 0x37b24d], // bloom colours
  fedora:     [0x6b4a2f, 0x1a1a1a, 0x8a8f98, 0xcaa472, 0x3a2f2a, 0x2f4a6b, 0x6b2f3a, 0x24614a, 0xf0f0f0], // felt-hat tones
  sunglasses: [0x0a0a0a, 0x5a3b1e, 0x2f6fd6, 0xe23b3b, 0xf5c518, 0xf0f0f0, 0xa259ff, 0x18b6a6, 0xff5fa2], // frame colours (lenses stay black)
  bandana:    [0xd23b3b, 0x2f6fd6, 0x37b24d, 0x1a1a1a, 0xff8c1a, 0xa259ff, 0x18b6a6, 0xf5c518, 0xff5fa2], // kerchief colours
  collar:     [0xd23b3b, 0x2f6fd6, 0xff5fa2, 0x37b24d, 0x1a1a1a, 0xf5c518, 0xa259ff, 0x18b6a6, 0xff8c1a], // collar colours
  bow:        [0xff5fa2, 0xe23b3b, 0x2f6fd6, 0x1a1a1a, 0xa259ff, 0x18b6a6, 0xf5c518, 0x37b24d, 0xff8c1a], // bow-tie colours
};
const PATTERN_ACCESSORY = {
  spotted: "cap", solid: "headphones", snowshoe: "beanie", point: "flower",
  mitted: "fedora", tuxedo: "sunglasses", tabby: "bandana", calico: "collar", tortie: "bow",
  bengal: "none", cow: "collar", smoke: "fedora", // rosettes speak for themselves; moo gets a bell; noir cat
};

// Cat colour/pattern templates. Each cat is more than a recolour: a base fur, a
// pattern (tabby stripes / tuxedo bib / colour-points / mittens), and an eye
// colour, all chosen from the fur tone — so any colour, including recoloured
// AI/multiplayer cats, still reads as an intentional breed. `override` forces a
// named pattern; otherwise it's derived from how light/dark the fur is.
function _lum(c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }
function catPalette(furColor, override) {
  const fur = new THREE.Color(furColor);
  const L = _lum(fur);
  const pattern = override || (
    L < 0.16 ? "tuxedo" :
    L < 0.30 ? "mitted" :
    L > 0.80 ? "point" : "tabby"
  );
  // Masked breeds (Siamese point / snowshoe) wear seal-brown extremities and
  // blue eyes; a snowshoe is white-bodied so its points must be a fixed bold
  // brown rather than a tint of the (white) coat.
  const masked = pattern === "point" || pattern === "snowshoe";
  return {
    pattern,
    fur,
    // bold markings — dark and high-contrast so stripes/spots read as painted-on
    // markings, not a subtle shade. Mixed toward a deep brown-black.
    stripe: fur.clone().multiplyScalar(0.32).lerp(new THREE.Color(0x140d08), 0.4),
    white: new THREE.Color(0xfbfbfb),
    // seal-brown points for masked breeds; a deep tint of the coat otherwise.
    point: pattern === "snowshoe" ? new THREE.Color(0x6a5240) : fur.clone().lerp(new THREE.Color(0x4a382a), 0.76),
    // eye colour: blue on masked breeds, amber on dark coats, the classic
    // gooseberry green in between.
    eye: masked ? new THREE.Color(0x73a9e6) : L < 0.3 ? new THREE.Color(0xffc24d) : new THREE.Color(0x9bdc54),
  };
}

function _finishTex(c) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter; // crisp painted edges, no blur
  t.needsUpdate = true;
  return t;
}
// Painted tabby coat: exactly `count` bold mackerel stripes baked into the
// texture (no tiling). `axis` "u" → stripes run DOWN the flanks (vertical, the
// classic body/head look); "v" → rings around the tail. Each stripe is broken
// into a few jittered dashes so it reads hand-painted, not like a barcode.
// Both caches are insertion-ordered Maps capped by evicting the OLDEST entry —
// without a cap, arbitrary multiplayer colours would grow them forever (each coat
// texture is a 256² canvas). Evicted entries are NOT disposed: a kart still on
// track may reference them; once unreferenced, GC reclaims them.
const _coatTexCache = new Map();
const COAT_TEX_CAP = 64;
function _cacheTex(key, tex) {
  if (_coatTexCache.size >= COAT_TEX_CAP) _coatTexCache.delete(_coatTexCache.keys().next().value);
  _coatTexCache.set(key, tex);
  return tex;
}
// Colour-keyed shared materials: two karts/cats with the same colours get the SAME
// material instance, so the toon conversion (cached per source material) collapses
// them to one render pipeline, and teardown knows not to dispose them (shared flag).
const _matCache = new Map();
const MAT_CACHE_CAP = 256;
export function sharedMat(key, make) {
  let m = _matCache.get(key);
  if (!m) {
    if (_matCache.size >= MAT_CACHE_CAP) _matCache.delete(_matCache.keys().next().value);
    m = make();
    m.userData.shared = true;
    _matCache.set(key, m);
  }
  return m;
}
// Free a discarded kart/cat group's GPU resources: geometries are always
// per-instance (merged fresh per kart) so they always dispose; materials flagged
// shared (colour-keyed cache above, module constants, and their toon conversions)
// are still used by other karts and are skipped.
export function disposeGroup(root) {
  root.traverse((o) => {
    // Cached merged geometries (and other flagged-shared geometry) are reused by
    // other racers / future rebuilds — never dispose those.
    if (o.geometry && !o.geometry.userData?.shared) o.geometry.dispose();
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) if (!m?.userData?.shared) m?.dispose?.();
  });
}
function makeStripeTexture(furColor, stripeColor, count, axis = "u") {
  const key = `s|${furColor.getHexString()}|${stripeColor.getHexString()}|${count}|${axis}`;
  if (_coatTexCache.has(key)) return _coatTexCache.get(key);
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#" + furColor.getHexString();
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = "#" + stripeColor.getHexString();
  const pitch = S / count;
  for (let i = 0; i < count; i++) {
    const c0 = (i + 0.5) * pitch + (i % 2 ? pitch * 0.16 : -pitch * 0.16); // wobble off the grid
    const w = pitch * (0.16 + (i % 3) * 0.02); // thin mackerel bars, not chunky bands
    // Each stripe broken into short, offset dashes (pattern varies per stripe) so
    // it reads like real tabby fur ticking, not an even barcode of rings.
    const segs = i % 3 === 0
      ? [[0.02, 0.24], [0.34, 0.2], [0.62, 0.3]]
      : i % 3 === 1
      ? [[0.06, 0.36], [0.5, 0.42]]
      : [[0.0, 0.3], [0.42, 0.22], [0.72, 0.24]];
    for (const [a, len] of segs) {
      if (axis === "v") ctx.fillRect(a * S, c0 - w / 2, len * S, w);      // ring (along the tail)
      else ctx.fillRect(c0 - w / 2, a * S, w, len * S);                   // vertical flank stripe
    }
  }
  const t = _finishTex(c);
  return _cacheTex(key, t);
}
// Painted spotted/rosetted coat (ginger spotted tabby): a deterministic scatter
// of bold rounded spots — drawn once, no tiling.
function makeSpotTexture(furColor, spotColor) {
  const key = `p|${furColor.getHexString()}|${spotColor.getHexString()}`;
  if (_coatTexCache.has(key)) return _coatTexCache.get(key);
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#" + furColor.getHexString();
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = "#" + spotColor.getHexString();
  // fractions of S: [x, y, radius]
  const spots = [
    [0.14, 0.16, 0.05], [0.4, 0.1, 0.04], [0.66, 0.15, 0.055], [0.88, 0.24, 0.04],
    [0.1, 0.42, 0.045], [0.36, 0.4, 0.06], [0.6, 0.46, 0.045], [0.84, 0.5, 0.05],
    [0.2, 0.68, 0.05], [0.46, 0.72, 0.045], [0.72, 0.7, 0.06], [0.92, 0.78, 0.04],
    [0.32, 0.9, 0.045], [0.6, 0.9, 0.05],
  ];
  for (const [x, y, r] of spots) {
    ctx.beginPath();
    ctx.ellipse(x * S, y * S, r * S, r * S * 1.2, 0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = _finishTex(c);
  return _cacheTex(key, t);
}

// Painted bengal coat, modelled on real rosette types (paw-print / donut /
// clustered): each rosette is a RUST-filled core wrapped in a chunky BROKEN
// outline of dark blobs — two-tone like a real bengal, where the inside of a
// rosette runs warmer than the base coat — with small solid spots scattered
// between. Deterministic jitter (a sin hash) keeps it hand-painted, not grid.
function makeRosetteTexture(furColor, spotColor) {
  const key = `ros|${furColor.getHexString()}|${spotColor.getHexString()}`;
  if (_coatTexCache.has(key)) return _coatTexCache.get(key);
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#" + furColor.getHexString();
  ctx.fillRect(0, 0, S, S);
  const rust = furColor.clone().lerp(new THREE.Color(0x7a3d16), 0.5);
  const rustHex = "#" + rust.getHexString();
  const darkHex = "#" + spotColor.getHexString();
  const jit = (a, b) => { const v = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return v - Math.floor(v); };
  // [x, y, r] fractions of S — rosette centres.
  const rosettes = [
    [0.16, 0.16, 0.062], [0.46, 0.1, 0.05], [0.74, 0.2, 0.066],
    [0.1, 0.44, 0.054], [0.4, 0.4, 0.07], [0.7, 0.52, 0.056],
    [0.94, 0.44, 0.05], [0.22, 0.7, 0.062], [0.52, 0.72, 0.054],
    [0.82, 0.8, 0.066], [0.34, 0.94, 0.05], [0.64, 0.92, 0.056],
  ];
  rosettes.forEach(([x, y, r], i) => {
    // Rust core — the warm heart of the rosette.
    ctx.fillStyle = rustHex;
    ctx.beginPath();
    ctx.ellipse(x * S, y * S, r * S * 0.8, r * S * 0.68, jit(i, 0) * Math.PI, 0, Math.PI * 2);
    ctx.fill();
    // Broken outline: 4-6 chunky dark blobs around the rim, one gap left open
    // (paw-print / donut rosetting). Blobs elongate along the rim tangent.
    const n = 4 + (i % 3);
    const skip = i % n;
    ctx.fillStyle = darkHex;
    for (let k = 0; k < n; k++) {
      if (k === skip) continue; // the break in the ring
      const ang = (k / n) * Math.PI * 2 + jit(i, k) * 0.7;
      const bx = x * S + Math.cos(ang) * r * S * 0.92;
      const by = y * S + Math.sin(ang) * r * S * 0.8;
      ctx.beginPath();
      ctx.ellipse(bx, by, r * S * (0.4 + jit(i, k + 9) * 0.14), r * S * 0.26, ang + Math.PI / 2, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  // Small solid spots peppered between the rosettes (the spotted-belly look).
  ctx.fillStyle = darkHex;
  const spots = [
    [0.3, 0.26, 0.016], [0.6, 0.32, 0.02], [0.86, 0.62, 0.017], [0.06, 0.62, 0.02],
    [0.36, 0.58, 0.016], [0.62, 0.6, 0.014], [0.12, 0.86, 0.02], [0.5, 0.86, 0.016],
    [0.92, 0.12, 0.018], [0.04, 0.28, 0.015], [0.7, 0.06, 0.016], [0.96, 0.94, 0.02],
  ];
  for (const [x, y, r] of spots) {
    ctx.beginPath();
    ctx.ellipse(x * S, y * S, r * S, r * S * 1.25, 0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = _finishTex(c);
  return _cacheTex(key, t);
}

// Painted cow coat: a handful of BIG soft black patches on a white base — the
// classic moo-cat. Like a calico with one colour and more countryside.
function makeCowTexture(baseColor) {
  const key = `cow|${baseColor.getHexString()}`;
  if (_coatTexCache.has(key)) return _coatTexCache.get(key);
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#" + baseColor.getHexString(); // milk-white base
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = "#2b2b2e";
  // Fewer, bigger patches than a calico — [x, y, rx, ry, rot] fractions of S.
  const patches = [
    [0.24, 0.18, 0.2, 0.16, 0.3], [0.78, 0.3, 0.17, 0.22, -0.4],
    [0.42, 0.56, 0.22, 0.17, 0.15], [0.1, 0.78, 0.16, 0.18, 0.5],
    [0.78, 0.84, 0.2, 0.15, -0.2],
  ];
  for (const [x, y, rx, ry, rot] of patches) {
    ctx.beginPath();
    ctx.ellipse(x * S, y * S, rx * S, ry * S, rot, 0, Math.PI * 2);
    ctx.fill();
  }
  // A couple of little island spots for the hand-painted feel.
  for (const [x, y, r] of [[0.6, 0.28, 0.04], [0.3, 0.4, 0.034], [0.6, 0.86, 0.036]]) {
    ctx.beginPath();
    ctx.ellipse(x * S, y * S, r * S, r * S * 1.15, 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = _finishTex(c);
  return _cacheTex(key, t);
}

// Classic bandana print: the chosen base colour tiled with a white paisley-ish
// motif (a dot ringed by a little diamond), staggered row to row so it reads as
// cloth, not a grid. Cached per colour AND repeat, so the band and the drape can
// each get a texture instance with its own tiling (distinct instances, not clones
// — cloned textures don't reliably carry their own repeat on the WebGPU backend).
function makeBandanaTexture(baseHex, rx = 3, ry = 2) {
  const base = new THREE.Color(baseHex);
  const key = `band|${base.getHexString()}|${rx}x${ry}`;
  if (_coatTexCache.has(key)) return _coatTexCache.get(key);
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#" + base.getHexString();
  ctx.fillRect(0, 0, S, S);
  const cell = S / 4;
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      const x = (gx * cell + cell / 2 + (gy % 2 ? cell / 2 : 0)) % S;
      const y = gy * cell + cell / 2;
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.beginPath(); ctx.arc(x, y, S * 0.036, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = S * 0.017;
      ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4);
      const d = S * 0.082;
      ctx.strokeRect(-d, -d, 2 * d, 2 * d);
      ctx.restore();
    }
  }
  const t = _finishTex(c);
  t.repeat.set(rx, ry);
  return _cacheTex(key, t);
}

// Painted calico coat: a cream base broken up by big irregular ginger and black
// patches (plus a few freckles) — the classic tortie-and-white tricolour, baked
// once, no tiling.
function makeCalicoTexture(baseColor) {
  const key = `cal|${baseColor.getHexString()}`;
  if (_coatTexCache.has(key)) return _coatTexCache.get(key);
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#" + baseColor.getHexString(); // cream base shows as the "white"
  ctx.fillRect(0, 0, S, S);
  const ginger = "#df8a2f", black = "#2c2723";
  // [x, y, rx, ry, rotation, colour] as fractions of S — big soft patches.
  const patches = [
    [0.22, 0.2, 0.18, 0.15, 0.3, ginger], [0.7, 0.16, 0.16, 0.19, -0.4, black],
    [0.5, 0.44, 0.21, 0.16, 0.2, ginger], [0.15, 0.6, 0.15, 0.19, 0.5, black],
    [0.83, 0.56, 0.16, 0.2, -0.3, ginger], [0.4, 0.82, 0.19, 0.15, 0.1, black],
    [0.76, 0.86, 0.14, 0.14, 0.4, ginger],
  ];
  for (const [x, y, rx, ry, rot, col] of patches) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.ellipse(x * S, y * S, rx * S, ry * S, rot, 0, Math.PI * 2);
    ctx.fill();
  }
  // A few small freckles straddling the patches for a hand-painted feel.
  for (const [x, y, r, col] of [[0.34, 0.36, 0.03, black], [0.6, 0.66, 0.028, ginger], [0.5, 0.62, 0.026, black]]) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.ellipse(x * S, y * S, r * S, r * S * 1.1, 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = _finishTex(c);
  return _cacheTex(key, t);
}

// Painted tortoiseshell coat: like a calico but with NO white — a dense mottled
// brindle of ginger and black over a warm base, the way a true tortie's two coat
// colours marble together. Baked once, no tiling.
function makeTortieTexture(baseColor) {
  const key = `tort|${baseColor.getHexString()}`;
  if (_coatTexCache.has(key)) return _coatTexCache.get(key);
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#" + baseColor.getHexString(); // warm base shows between patches
  ctx.fillRect(0, 0, S, S);
  const ginger = "#c9742a", black = "#241c17";
  // Denser, more interlocked patches than a calico (no cream gaps) — [x,y,rx,ry,rot,col].
  const patches = [
    [0.18, 0.16, 0.2, 0.18, 0.3, black], [0.5, 0.12, 0.18, 0.16, -0.3, ginger],
    [0.82, 0.2, 0.19, 0.2, 0.2, black], [0.12, 0.46, 0.18, 0.2, 0.5, ginger],
    [0.46, 0.42, 0.2, 0.18, -0.2, black], [0.8, 0.5, 0.18, 0.19, 0.3, ginger],
    [0.22, 0.76, 0.19, 0.18, 0.1, black], [0.56, 0.78, 0.2, 0.17, -0.4, ginger],
    [0.86, 0.82, 0.16, 0.18, 0.4, black],
  ];
  for (const [x, y, rx, ry, rot, col] of patches) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.ellipse(x * S, y * S, rx * S, ry * S, rot, 0, Math.PI * 2);
    ctx.fill();
  }
  // Brindle freckles straddling the seams so the two colours marble together.
  for (const [x, y, r, col] of [[0.34, 0.3, 0.035, ginger], [0.66, 0.34, 0.03, black], [0.4, 0.6, 0.032, ginger], [0.7, 0.66, 0.03, ginger], [0.5, 0.9, 0.028, black]]) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.ellipse(x * S, y * S, r * S, r * S * 1.1, 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = _finishTex(c);
  return _cacheTex(key, t);
}

// Eyeball texture: sclera + iris + slit pupil + catch-lights all PAINTED onto one
// sphere (cached per eye colour), so the eye is a single clean ball an eyelid can
// sweep over — no separate pupil/shine objects poking through a closing lid. The
// iris is drawn at u≈0.25, which is the +z (forward-facing) point of a three.js
// sphere, so it looks straight ahead with no mesh rotation.
const _eyeTexCache = new Map();
function makeEyeTexture(eyeColor) {
  const col = new THREE.Color(eyeColor);
  const hex = col.getHexString();
  if (_eyeTexCache.has(hex)) return _eyeTexCache.get(hex);
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fbfbfb"; // sclera
  ctx.fillRect(0, 0, S, S);
  const cx = S * 0.25, cy = S * 0.5; // forward-facing point of the sphere
  ctx.fillStyle = "#" + hex; // iris (tall oval — cat eye)
  ctx.beginPath(); ctx.ellipse(cx, cy, S * 0.2, S * 0.27, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#141414"; // vertical slit pupil
  ctx.beginPath(); ctx.ellipse(cx, cy, S * 0.07, S * 0.23, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.95)"; // double catch-light
  ctx.beginPath(); ctx.arc(cx - S * 0.07, cy - S * 0.12, S * 0.055, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + S * 0.04, cy + S * 0.09, S * 0.028, 0, Math.PI * 2); ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  if (_eyeTexCache.size >= COAT_TEX_CAP) _eyeTexCache.delete(_eyeTexCache.keys().next().value);
  _eyeTexCache.set(hex, t);
  return t;
}

// Constant cat materials — never vary per cat, so a single shared instance is
// reused by every driver (the toToon cache then collapses each to one pipeline).
// Flagged shared so kart teardown (disposeGroup) never disposes them.
const _shared = (m) => { m.userData.shared = true; return m; };
const _cDark = _shared(new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.5 }));
const _cPink = _shared(new THREE.MeshStandardMaterial({ color: 0xff90ad, roughness: 0.6 }));
const _cWhite = _shared(new THREE.MeshStandardMaterial({ color: 0xfbfbfb, roughness: 0.6 }));
const _cWhisker = _shared(new THREE.LineBasicMaterial({ color: 0xf0f0f0 }));
const _cMouth = _shared(new THREE.LineBasicMaterial({ color: 0x6b4a4a }));
const _cShade = _shared(new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.3, metalness: 0.4 }));

// Constant cat geometries — identical for every cat, so build each ONCE and let
// all drivers reference it (flagged shared so disposeGroup leaves them alone).
const _sharedGeo = (g) => { g.userData.shared = true; return g; };
let _catConstGeo = null;
function catConstGeo() {
  if (_catConstGeo) return _catConstGeo;
  const tailCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0.05, 0.4, -0.5),
    new THREE.Vector3(0.35, 1.0, -0.45),
    new THREE.Vector3(0.7, 1.45, -0.02),
  ]);
  const whisker = (sx) => {
    const pts = [];
    for (const dy of [-0.08, 0.0, 0.08]) {
      pts.push(new THREE.Vector3(0, dy * 0.4, 0), new THREE.Vector3(sx * 0.75, dy, 0.05));
    }
    return _sharedGeo(new THREE.BufferGeometry().setFromPoints(pts));
  };
  _catConstGeo = {
    tail: _sharedGeo(new THREE.TubeGeometry(tailCurve, 28, 0.2, 10)),
    tailTipPos: tailCurve.getPoint(1),
    tailTip: _sharedGeo(new THREE.SphereGeometry(0.2, 12, 12)),
    eyelid: _sharedGeo(new THREE.SphereGeometry(0.26, 14, 10)),
    mouth: _sharedGeo(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, -0.16, 0.92), new THREE.Vector3(-0.12, -0.26, 0.86),
      new THREE.Vector3(0, -0.16, 0.92), new THREE.Vector3(0.12, -0.26, 0.86),
    ])),
    whiskerL: whisker(-1),
    whiskerR: whisker(1),
  };
  return _catConstGeo;
}

// Builds a low-poly cat sitting upright (the driver). Returns a Group whose
// origin sits at the seat base. `furColor` tints the fur; `opts.pattern` can
// force a markings template (else it's derived from the colour). The returned
// group's userData.rig holds pivots (ears, whiskers, tail, head) that
// updateCatRig() animates with cornering physics.
//
// Per-pose front-leg placement (see the arms block below). All values are in
// shoulder-pivot local space; the pivot sits at (±0.5, 1.05, 0.45), the ground
// under a seated cat is at y ≈ -0.29 in cat space.
const ARM_POSES = {
  // Driving: arms reach FORWARD-DOWN so the paws land on the wheel rim (the old
  // pose held the paws above shoulder height, hovering behind the wheel), with
  // the beans on the paw's far face — against the wheel, not floating mid-arm.
  kart: { armR: 0.17, armRot: -1.35, armPos: [0, -0.02, 0.4], pawPos: [0, -0.04, 0.86], pawScale: [1, 0.85, 1.1], beanY: -0.06, beanZ: 1.05 },
  moto: { armR: 0.17, armRot: -1.42, armPos: [0, 0.12, 0.24], pawPos: [0, 0.3, 0.68], pawScale: [1, 0.95, 0.9], beanY: 0.26, beanZ: 0.86 },
  // Sitting: no beans — a sitting cat shows the TOPS of its front paws (beans
  // on the paw front read as claws).
  sit: { armR: 0.19, armRot: -0.2, armPos: [0, -0.55, 0.26], pawPos: [0, -1.1, 0.36], pawScale: [1.05, 0.8, 1.3], beans: false },
  // Standing on the hind legs like a curious meerkat-cat: front paws dangle at
  // the sides, hind feet planted under the body (built in the stand block below).
  stand: { armR: 0.17, armRot: -0.06, armPos: [0, -0.5, 0.04], pawPos: [0, -1.0, 0.16], pawScale: [1, 0.85, 1.2], beans: false },
};

// The rigid clusters (body, head, each arm, each ear, glasses) are baked into a
// single mesh apiece so a cat is ~a dozen draw calls, not ~40; the animated
// pivots (head / ears / whiskers / arms / tail / glasses) stay separate so the
// rig still drives them.
export function createCat(furColor = 0xf0a830, opts = {}) {
  const cat = new THREE.Group();
  const pal = catPalette(furColor, opts.pattern);
  const pat = pal.pattern;
  const isTabby = pat === "tabby";
  const isSpotted = pat === "spotted";
  const isCalico = pat === "calico";
  const isTortie = pat === "tortie";
  const isBengal = pat === "bengal";
  const isCow = pat === "cow";
  const isTextured = isTabby || isSpotted || isCalico || isTortie || isBengal || isCow; // coat carries a painted pattern
  const isTuxedo = pat === "tuxedo";
  const isMitted = pat === "mitted";
  const isSolid = pat === "solid";
  const isSmoke = pat === "smoke";             // dark coat, pale silver chest — structural only
  const isPoint = pat === "point";
  const isSnow = pat === "snowshoe";
  const hasMask = isPoint || isSnow;           // dark face mask + colour points
  const hasBib = isTuxedo || isMitted;         // big white chest
  const whitePaws = isTuxedo || isMitted || isSnow || isCalico || isCow; // calicos + cow cats have white socks
  const colorExtremity = isPoint || isSnow;    // ears/mask/tail take the point colour

  // Colour-dependent materials come from the shared cache: two cats with the same
  // palette share instances (one toon pipeline for both, safe-skipped on teardown).
  const furHex = pal.fur.getHexString();
  const fur = sharedMat(`cfur|${furHex}`, () => new THREE.MeshStandardMaterial({ color: pal.fur, roughness: 0.92 }));
  const stripeMat = sharedMat(`cstripe|${pal.stripe.getHexString()}`, () => new THREE.MeshStandardMaterial({ color: pal.stripe, roughness: 0.92 }));
  // Extremity fur: masked breeds darken at ears/mask/tail; everyone else reuses
  // the base coat.
  const extremity = colorExtremity
    ? sharedMat(`cpoint|${pal.point.getHexString()}`, () => new THREE.MeshStandardMaterial({ color: pal.point, roughness: 0.92 }))
    : fur;
  const dark = _cDark;
  const pink = _cPink;
  const white = _cWhite;
  const pawMat = whitePaws ? white : isPoint ? extremity : fur;
  // Eyeball: one sphere with the iris/pupil/highlights painted on (see makeEyeTexture).
  const eyeballMat = sharedMat(`ceye|${pal.eye.getHexString()}`, () => new THREE.MeshStandardMaterial({ map: makeEyeTexture(pal.eye), roughness: 0.32 }));
  // Painted coat: vertical mackerel stripes down the flanks (tabby) or scattered
  // spots (spotted), baked into the fur so the markings read as bold and graphic.
  // The tail gets rings (stripes wrapped the other way). Flat for everyone else.
  function coatTex(forTail) {
    if (isTabby) return forTail
      ? makeStripeTexture(pal.fur, pal.stripe, 7, "v")   // rings around the tail
      : makeStripeTexture(pal.fur, pal.stripe, 18, "v"); // many fine mackerel bands
    if (isSpotted) return makeSpotTexture(pal.fur, pal.stripe);
    if (isCalico) return makeCalicoTexture(pal.fur);     // tricolour ginger/black patches
    if (isTortie) return makeTortieTexture(pal.fur);     // mottled ginger/black, no white
    if (isBengal) return forTail
      ? makeStripeTexture(pal.fur, pal.stripe, 6, "v")   // bengals wear a RINGED tail
      : makeRosetteTexture(pal.fur, pal.stripe);         // two-tone rosettes on the body
    if (isCow) return makeCowTexture(pal.fur);           // big black patches on white
    return null;
  }
  const coatKey = `${pat}|${furHex}|${pal.stripe.getHexString()}`;
  const coat = isTextured
    ? sharedMat(`ccoat|${coatKey}`, () => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, map: coatTex(false) }))
    : fur;
  const tailCoat = isTextured
    ? sharedMat(`ctail|${coatKey}`, () => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, map: coatTex(true) }))
    : extremity;

  // Rigid clusters are collected and baked at the end: `catStatic` sits on the
  // cat root, `headStatic` rides with the (animated) head.
  const catStatic = [];
  const headStatic = [];

  // Body (sitting torso) — painted pattern for tabbies/spotted cats.
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.9, 0.78, 6, 16), coat);
  body.position.y = 1.0;
  catStatic.push(body);

  // Chest + belly fluff. Tuxedo/mitten cats get a big white bib; solid coats keep
  // the body colour (no bib); others get a soft pale chest.
  // Smoke cats show the pale silver undercoat at the chest; solid/tortie keep
  // the body colour; everyone else gets the soft white chest.
  const chestMat = isSmoke
    ? sharedMat("csmoke", () => new THREE.MeshStandardMaterial({ color: 0xc9ced6, roughness: 0.92 }))
    : (isSolid || isTortie) ? fur : white;
  // A clean ROUND tummy patch: equal width/height and pushed proud of the
  // belly, so the visible cap silhouettes as a circle. (The old tall ellipsoid
  // grazed the faceted body and its intersection read as a jagged bow tie.)
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.62, 26, 20), chestMat);
  chest.position.set(0, 0.8, hasBib ? 0.6 : 0.64);
  chest.scale.set(hasBib ? 1.0 : 0.84, hasBib ? 1.0 : 0.84, 0.5);
  catStatic.push(chest);

  // Front paws — posed for the scenario (opts.pose):
  //   kart — reaching forward onto the steering wheel (the racing default)
  //   moto — arms up and out to the handlebars
  //   sit  — front legs planted straight down, the classic cat sit (used for
  //          Cat-alog portraits / the asset viewer, plus visible hind feet below)
  // The pose is baked into the MESH inside each shoulder pivot: the rig zeroes
  // pivot rotations every frame (and the victory pump sets them absolutely), so
  // the pivot itself must stay identity at rest in every pose.
  const pose = ARM_POSES[opts.pose] ? opts.pose : "kart";
  const ap = ARM_POSES[pose];
  const arms = {};
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.5, 1.05, 0.45);
    cat.add(pivot);
    const parts = [];
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(ap.armR, 0.6, 4, 10), pawMat);
    arm.position.set(...ap.armPos);
    arm.rotation.x = ap.armRot;
    parts.push(arm);
    const paw = new THREE.Mesh(new THREE.SphereGeometry(0.21, 12, 12), pawMat);
    paw.position.set(...ap.pawPos);
    paw.scale.set(...ap.pawScale);
    parts.push(paw);
    // Toe-bean detail: three little pads on the front of each paw (poses with
    // grounded paws skip them — see ARM_POSES.sit).
    if (ap.beans !== false) {
      for (const tx of [-0.07, 0, 0.07]) {
        const bean = new THREE.Mesh(new THREE.SphereGeometry(0.032, 6, 6), pink);
        bean.position.set(tx, ap.beanY, ap.beanZ);
        parts.push(bean);
      }
    }
    // one mesh per arm; the pivot still pumps it. Geometry is identical for every
    // cat of a pose (colours live in the materials) — shared via the merge cache.
    pivot.add(mergeMeshes(parts, { geoKey: `carm|${pose}` }));
    arms[sx < 0 ? "L" : "R"] = pivot;
  }
  if (pose === "sit") {
    // Haunches: big thigh mounds against the body's lower sides, so the hind
    // feet emerge from under something instead of floating beside the body.
    for (const sx of [-1, 1]) {
      const haunch = new THREE.Mesh(new THREE.SphereGeometry(0.46, 14, 12), coat);
      haunch.position.set(sx * 0.6, 0.12, 0.12);
      haunch.scale.set(0.95, 0.85, 1.05);
      catStatic.push(haunch);
    }
    // Hind feet tucked under the haunches, flat on the ground.
    for (const sx of [-1, 1]) {
      const foot = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 10), pawMat);
      foot.position.set(sx * 0.58, -0.2, 0.6);
      foot.scale.set(1.1, 0.55, 1.5);
      catStatic.push(foot);
    }
  } else if (pose === "stand") {
    // Standing: hind feet planted directly under the body.
    for (const sx of [-1, 1]) {
      const foot = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 10), pawMat);
      foot.position.set(sx * 0.34, -0.24, 0.5);
      foot.scale.set(1.05, 0.5, 1.6);
      catStatic.push(foot);
    }
  }

  // --- Head (animated for lean/pitch) — a touch bigger for a cuter ratio ---
  const head = new THREE.Group();
  head.position.set(0, 2.06, 0.12);
  cat.add(head);

  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.78, 20, 20), coat);
  skull.scale.set(1.04, 0.98, 0.96);
  headStatic.push(skull);
  // Masked breeds (Siamese point / snowshoe): a dark mask across the eyes +
  // muzzle bridge. The white cheeks/muzzle below and the eyes on top leave a
  // band of colour around the eyes — the signature masked face. (Tabby/spotted
  // head markings come from the painted coat.)
  if (hasMask) {
    const mask = new THREE.Mesh(new THREE.SphereGeometry(0.54, 16, 16), extremity);
    mask.position.set(0, 0.02, 0.46);
    mask.scale.set(0.96, 0.84, 0.6);
    headStatic.push(mask);
  }
  // Cheeks — fuller floof for a rounder face. White, except solid coats keep the
  // body colour so the face isn't oddly two-toned.
  const cheekMat = isSolid ? fur : white;
  for (const sx of [-1, 1]) {
    const cheek = new THREE.Mesh(new THREE.SphereGeometry(0.38, 14, 14), cheekMat);
    cheek.position.set(sx * 0.36, -0.18, 0.52);
    cheek.scale.set(0.95, 0.74, 0.72);
    headStatic.push(cheek);
  }

  // Ears on pivots so they can flick/lag. Point cats darken at the ear tips.
  // The cone gets extra shank and sits LOWER than it looks: its flat base is
  // buried well inside the skull, so the tilted base edge can't peek out of the
  // curving scalp as a seam (it did, at the base rear).
  const earGeo = new THREE.ConeGeometry(0.35, 0.8, 6);
  const innerGeo = new THREE.ConeGeometry(0.19, 0.4, 6);
  const ears = {};
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.45, 0.5, -0.02);
    head.add(pivot);
    const ear = new THREE.Mesh(earGeo, extremity);
    ear.position.y = 0.22;
    ear.rotation.z = sx * -0.22;
    const inner = new THREE.Mesh(innerGeo, pink);
    inner.position.set(0, 0.21, 0.07);
    inner.rotation.z = sx * -0.22;
    pivot.add(mergeMeshes([ear, inner], { geoKey: `cear|${sx}` })); // one mesh per ear; the pivot flicks it
    ears[sx < 0 ? "L" : "R"] = pivot;
  }

  // Eyes — one painted eyeball each (iris + slit pupil + catch-lights baked into
  // the texture), so it's a single clean ball. Merged into the head like the rest.
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.23, 16, 16), eyeballMat);
    eye.position.set(sx * 0.31, 0.1, 0.6);
    eye.scale.set(0.96, 1.12, 0.7);
    headStatic.push(eye);
  }

  // Eyelids — a coat-coloured cap that sweeps DOWN over each eyeball for the idle
  // blink (garage / post-race only). Each lid hangs off a pivot at the TOP of the
  // eye; scaling the pivot's Y from 0 (tucked away at the brow, hidden) to 1 draws
  // the lid cleanly down over the ball. visible=false at rest, so zero draw-call
  // cost while racing. updateCatRig drives the pivots when allowBlink is set.
  const eyelids = [];
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.31, 0.36, 0.6); // top edge of the eye
    pivot.scale.y = 0;
    pivot.visible = false;
    const lid = new THREE.Mesh(catConstGeo().eyelid, coat);
    lid.position.set(0, -0.26, 0.02); // centre hangs over the eyeball when scale.y = 1
    lid.scale.set(1.0, 1.15, 0.8);
    pivot.add(lid);
    head.add(pivot);
    eyelids.push(pivot);
  }

  // Muzzle + nose + a tiny "ω" smile. White, except solid coats (a clean grey
  // face shouldn't sprout a white snout).
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.34, 14, 14), isSolid ? fur : white);
  muzzle.position.set(0, -0.2, 0.66);
  muzzle.scale.set(1.12, 0.7, 0.62);
  headStatic.push(muzzle);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.11, 6), pink);
  nose.rotation.x = Math.PI;
  // Nestled INTO the muzzle surface (rear half embedded) — at the old (−0.08,
  // 0.94) it sat past the muzzle's upper edge and visibly floated off the face.
  nose.position.set(0, -0.13, 0.87);
  headStatic.push(nose);
  // The "ω" smile — both strokes baked into one LineSegments (4 points → 2 segs).
  head.add(new THREE.LineSegments(catConstGeo().mouth, _cMouth));

  // Cool-cat sunglasses, hidden until the victory celebration drops them on.
  // The two lenses + bridge bake into one mesh; the group is what the rig
  // shows/slides on.
  const glasses = new THREE.Group();
  const shade = _cShade;
  const glassParts = [];
  for (const sx of [-1, 1]) {
    const lens = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.24, 0.06), shade);
    lens.position.set(sx * 0.3, 0.12, 0.64);
    glassParts.push(lens);
  }
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.07, 0.05), shade);
  bridge.position.set(0, 0.16, 0.64);
  glassParts.push(bridge);
  glasses.add(mergeMeshes(glassParts, { geoKey: "cglasses" }));
  glasses.visible = false;
  head.add(glasses);

  // Whiskers on pivots (sweep with cornering) — three strokes per side baked into
  // one LineSegments so each side is a single draw.
  const whiskerMat = _cWhisker;
  const whiskers = {};
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.18, -0.12, 0.78);
    head.add(pivot);
    pivot.add(new THREE.LineSegments(sx < 0 ? catConstGeo().whiskerL : catConstGeo().whiskerR, whiskerMat));
    whiskers[sx < 0 ? "L" : "R"] = pivot;
  }

  // --- Accessory: each breed has a signature piece, but a custom cat can pick
  // any of them (or none) via opts.accessory. Ids are semantic so the creator UI
  // can list them. Hats/headwear parent to the head (so they lean with it);
  // neckwear parents to the body. ---
  const accId = opts.accessory || PATTERN_ACCESSORY[pat] || "none";
  // Each accessory has a natural default colour (the first swatch in its palette);
  // a custom cat can recolour it via opts.accessoryColor. Accent bits that read as
  // "not the main fabric" — a gold bell, a white pom/button, a yellow flower centre
  // — keep their own fixed colours so recolouring still reads.
  const accCol = (opts.accessoryColor != null && opts.accessoryColor !== "")
    ? new THREE.Color(opts.accessoryColor).getHex()
    : (ACCESSORY_COLORS[accId]?.[0] ?? 0xffffff);
  // Accessory materials come from the shared cache (keyed by colour + surface
  // params): every cat wearing e.g. a red collar shares one material/pipeline.
  const accMat = (hex, r = 0.6, m = 0) =>
    sharedMat(`acc|${hex}|${r}|${m}`, () => new THREE.MeshStandardMaterial({ color: hex, roughness: r, metalness: m }));
  // Shade for knots/accents — only the bow tie uses it, so derive lazily there.
  const accColDark = () => new THREE.Color(accCol).multiplyScalar(0.8).getHex();
  const acc = new THREE.Group();
  if (accId === "cap") {
    // forward-facing baseball cap
    const m = accMat(accCol);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.62, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), m);
    dome.position.set(0, 0.46, 0.04); dome.scale.set(1, 0.72, 1);
    acc.add(dome);
    const brim = new THREE.Mesh(rbox(0.66, 0.08, 0.56, 0.04), m);
    brim.position.set(0, 0.45, 0.66); // rear tucks under the dome, front juts over the brow
    acc.add(brim);
    const btn = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), accMat(0xffffff));
    btn.position.set(0, 0.78, 0.04); acc.add(btn);  } else if (accId === "headphones") {
    // headphones — cups on the sides, band routed around the BACK of the head so
    // it clears the tall cat ears instead of slicing through them.
    const m = accMat(accCol, 0.4);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.84, 0.06, 8, 24, Math.PI), m);
    band.rotation.x = -Math.PI / 3; // angled up-and-back so it arcs behind the ears (not flat)
    band.position.set(0, 0.12, 0); acc.add(band);
    for (const sx of [-1, 1]) {
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.16, 16), m);
      cup.rotation.z = Math.PI / 2; cup.position.set(sx * 0.82, 0.12, 0);
      acc.add(cup);
    }  } else if (accId === "beanie") {
    // bobble beanie
    const m = accMat(accCol);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.66, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), m);
    cap.position.set(0, 0.36, 0); cap.scale.set(1, 0.92, 1); acc.add(cap);
    const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.1, 8, 18), accMat(0xffffff));
    cuff.position.set(0, 0.4, 0); cuff.rotation.x = Math.PI / 2; acc.add(cuff);
    const pom = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 10), accMat(0xffffff));
    pom.position.set(0, 0.96, 0); acc.add(pom);  } else if (accId === "flower") {
    // flower tucked forward of one ear — laid on a tangent plane to the skull so
    // the whole bloom sits flat ON the surface (never dipping into head or ear).
    const fn = new THREE.Vector3(0.6, 0.72, 0.36).normalize();   // outward direction
    const fc = fn.clone().multiplyScalar(0.86);                  // proud of the surface
    const fu = new THREE.Vector3().crossVectors(fn, new THREE.Vector3(0, 1, 0)).normalize();
    const fv = new THREE.Vector3().crossVectors(fn, fu).normalize();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const petal = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), accMat(accCol));
      petal.position.copy(fc).addScaledVector(fu, Math.cos(a) * 0.12).addScaledVector(fv, Math.sin(a) * 0.12);
      petal.scale.set(1, 1, 0.8); acc.add(petal);
    }
    const ctr = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), accMat(0xffe14d));
    ctr.position.copy(fc).addScaledVector(fn, 0.05); acc.add(ctr);  } else if (accId === "fedora") {
    // little fedora — rides up near the crown so the brim rests on the head
    const m = accMat(accCol);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.82, 0.82, 0.05, 20), m);
    brim.position.set(0, 0.64, 0.02); acc.add(brim);
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.48, 0.46, 18), m);
    crown.position.set(0, 0.86, 0.02); acc.add(crown);
    const bandm = new THREE.Mesh(new THREE.CylinderGeometry(0.49, 0.49, 0.1, 18), accMat(0x2a2a2a));
    bandm.position.set(0, 0.7, 0.02); acc.add(bandm);  } else if (accId === "sunglasses") {
    // wayfarer sunglasses on the face. The eyes are big spheres bulging to ~z0.76
    // and out to ~x0.53, so the lenses sit forward (z~0.84) and WIDER (spanning
    // x0.12–0.56), and each temple arm hinges at the lens's outer edge and runs
    // straight back to the ear — staying outboard of the eyeball the whole way
    // rather than sweeping across it.
    // The frame (rims, temple arms, bridge) takes the accessory colour; the LENSES
    // are always black, inset as a smaller panel sitting just proud of each rim.
    const frameMat = accMat(accCol, 0.4, 0.3);
    const lensMat = accMat(0x0a0a0a, 0.15, 0.6);
    for (const sx of [-1, 1]) {
      const rim = new THREE.Mesh(rbox(0.44, 0.34, 0.06, 0.06), frameMat);
      rim.position.set(sx * 0.34, 0.1, 0.84); rim.rotation.z = sx * -0.08; // slight wayfarer cant
      acc.add(rim);
      const lens = new THREE.Mesh(rbox(0.34, 0.24, 0.05, 0.05), lensMat);
      lens.position.set(sx * 0.34, 0.1, 0.88); lens.rotation.z = sx * -0.08; // black lens, proud of the rim
      acc.add(lens);
      const armg = new THREE.Mesh(rbox(0.66, 0.05, 0.05, 0.02), frameMat);
      // hinged at the lens's outer-top corner (x0.56, z0.84), running back to the
      // ear (x0.72, z0.20) — the whole arm stays at x >= 0.56, clear of the eye.
      armg.position.set(sx * 0.64, 0.17, 0.52); armg.rotation.y = sx * 1.33;
      acc.add(armg);
    }
    const bridge = new THREE.Mesh(rbox(0.3, 0.08, 0.05, 0.02), frameMat);
    bridge.position.set(0, 0.14, 0.85); acc.add(bridge);  } else if (accId === "bandana") {
    // bandana: a flat printed cloth band around the neck with a WIDE inverted-
    // triangle kerchief whose top edge tucks right under the band and drapes down
    // the chest — one continuous cloth, not a ring with a triangle floating below.
    // The band is a thin open cylinder wall (a fabric strip, not a rounded tube),
    // radius 0.92 (a touch wider than the ~0.87 torso so it never clips). Printed:
    // a white-mapped material carries the base colour + subtle white paisley motif.
    // One continuous printed cloth: the band, the chest drape, and the tie (knot +
    // tails) at the nape all use the same white-mapped paisley material — the band
    // and the drape get their own texture instances with their own tiling so the
    // print reads at each scale yet feels like the same fabric.
    const clothMatOf = (rx, ry) =>
      sharedMat(`cloth|${accCol}|${rx}x${ry}`, () => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.86, side: THREE.DoubleSide, map: makeBandanaTexture(accCol, rx, ry) }));
    const bandMat = clothMatOf(9, 1.4);    // a row of motifs wrapping the thin band
    const clothMat = clothMatOf(2.4, 2.4); // drape / knot / tails
    // The band is tilted (rotation.x 0.26) so its BACK arc rides UP toward the nape
    // (where it's tied) instead of flaring down onto the upper back; the front dips
    // to the throat, as a real neckerchief sits.
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 0.92, 0.18, 32, 1, true), bandMat);
    band.position.set(0, 1.64, 0.05); band.rotation.x = 0.26; acc.add(band);
    // Kerchief: a wide, short inverted triangle. NOT a flat sheet — it bulges
    // FORWARD in the middle (a gentle fold) so it drapes OVER the rounded chest
    // instead of the chest bulging through a flat plane. Top edge tucks behind the
    // band; the two top corners and the point hang back at the sides.
    //   TL ── TR      (top edge, at the band, z 0)
    //     \ MC /       (centre bulged forward, +z, riding over the chest)
    //       BP         (point, forward a little)
    const fp = [-0.54, 0, 0,  0.54, 0, 0,  0, -0.30, 0.22,  0, -0.60, 0.16];
    const fuv = [0, 1,  1, 1,  0.5, 0.5,  0.5, 0];
    const fgeo = new THREE.BufferGeometry();
    fgeo.setAttribute("position", new THREE.Float32BufferAttribute(fp, 3));
    fgeo.setAttribute("uv", new THREE.Float32BufferAttribute(fuv, 2));
    fgeo.setIndex([0, 2, 1, 0, 3, 2, 2, 3, 1]);
    fgeo.computeVertexNormals();
    const flap = new THREE.Mesh(fgeo, clothMat);
    flap.position.set(0, 1.42, 0.82); acc.add(flap);
    // The tie at the nape: a knot with two pointed tails, as when a bandana is
    // knotted at the back of the neck. Pushed well behind the neck (z ~ -0.95) so
    // it sits PROUD of the torso's back (which reaches ~z-0.85 here) instead of
    // being buried inside it.
    const knot = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 12), clothMat);
    knot.position.set(0, 1.86, -0.95); knot.scale.set(1.5, 1.2, 1.0); acc.add(knot);
    for (const sx of [-1, 1]) {
      const tail = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.52, 4), clothMat);
      tail.position.set(sx * 0.2, 1.6, -0.96);
      tail.rotation.z = sx * -2.5; // apex swings down-and-out to the side
      tail.rotation.y = sx * 0.3;
      tail.scale.set(1, 1, 0.55);  // flatten like cloth
      acc.add(tail);
    }  } else if (accId === "collar") {
    // collar: a flat fabric band (a thin open cylinder wall — a strip, not a
    // rounded tube) around the neck, with a little gold bell at the throat. Radius
    // 0.92 sits just proud of the ~0.87 torso so the whole band clears it. Tilted
    // (rotation.x 0.26) so the BACK of the band rides up near the head rather than
    // drooping down the back; the throat side dips low where the bell hangs.
    const m = new THREE.MeshStandardMaterial({ color: accCol, roughness: 0.55, side: THREE.DoubleSide });
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 0.92, 0.17, 32, 1, true), m);
    collar.position.set(0, 1.64, 0.05); collar.rotation.x = 0.26; acc.add(collar);
    const bell = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 12), accMat(0xffd24d, 0.4, 0.35));
    bell.position.set(0, 1.2, 0.86); acc.add(bell);
    const nub = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.07, 8), accMat(0xe0b53a, 0.4, 0.35));
    nub.position.set(0, 1.3, 0.87); acc.add(nub);  } else if (accId === "bow") {
    // a bow tie at the throat — two pinched loops meeting at a centre knot, sitting
    // on the upper chest in the body frame (a real bow tie, not a hair bow).
    const m = accMat(accCol);
    for (const sx of [-1, 1]) {
      const loop = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 10), m);
      // flatter, less bulbous: shallow depth (z 0.22) so it lies against the chest
      loop.position.set(sx * 0.26, 1.5, 0.9); loop.scale.set(1.0, 0.62, 0.22);
      acc.add(loop);
    }
    const knot = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 10), accMat(accColDark()));
    knot.position.set(0, 1.5, 0.94); knot.scale.set(0.9, 1.0, 0.55); acc.add(knot);  }
  // Headwear / eyewear ride with the head; neckwear (bandana, collar, bow tie) sits
  // on the body. `acc` is at the origin, so its children's transforms already read
  // in the right frame — route them into the matching static bucket to merge.
  const accToBody = accId === "bandana" || accId === "collar" || accId === "bow";
  (accToBody ? catStatic : headStatic).push(...acc.children);

  // Tail on a base pivot (sways + lifts) — fuller, and pattern-matched: tabby
  // rings up its length, a darker point tip on colour-point cats, a white tip on
  // tuxedos. A taper-radius function fattens the base and rounds the tip.
  const tail = new THREE.Mesh(catConstGeo().tail, tailCoat);
  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 0.6, -0.7);
  tailPivot.add(tail);
  // Tail tip cap: white for tuxedo, a dark tip for tabby/spotted coats, the
  // point colour for masked breeds, otherwise the coat colour.
  const tipMat = isTuxedo ? white : isTextured ? stripeMat : extremity;
  const tip = new THREE.Mesh(catConstGeo().tailTip, tipMat);
  tip.position.copy(catConstGeo().tailTipPos);
  tailPivot.add(tip);
  cat.add(tailPivot);

  // Bake the rigid clusters: the head cluster (skull/face/eyes/headwear) rides
  // with the head; the body cluster (torso/chest/neckwear) sits on the cat root.
  // Each becomes one multi-material mesh (one draw call per material).
  // Like the kart, the cat relies on the kart's contact blob rather than casting
  // into the sun shadow map — keeps the bunched-up field cheap.
  // Cluster geometry is a pure function of (pattern, accessory) — colours only
  // pick material instances. The accessory COLOUR is in the key because a colour
  // matching an accent piece (e.g. a white cap button on a white cap) collapses
  // two materials into one and changes the merged group layout.
  const accKey = `${accId}:${accCol}`;
  head.add(mergeMeshes(headStatic, { castShadow: false, geoKey: `chead|${pat}|${accToBody ? "none" : accKey}` }));
  cat.add(mergeMeshes(catStatic, { castShadow: false, geoKey: `cbody|${pat}|${accToBody ? accKey : "none"}|${pose}` }));

  cat.userData.tail = tailPivot;
  cat.userData.rig = {
    head,
    earL: ears.L,
    earR: ears.R,
    whiskerL: whiskers.L,
    whiskerR: whiskers.R,
    armL: arms.L,
    armR: arms.R,
    glasses,
    celebT: 0,
    eyelids, // idle-blink caps (hidden until a blink)
    blinkT: 1.5 + Math.random() * 3, // seconds until the next blink
    blinkP: 0, // progress through the current blink (>0 = blinking)
    tail: tailPivot,
    springs: {
      earSway: { a: 0, v: 0 },
      earBack: { a: 0, v: 0 },
      whisker: { a: 0, v: 0 },
      tailY: { a: 0, v: 0 },
      tailX: { a: 0, v: 0 },
      headLean: { a: 0, v: 0 },
      headPitch: { a: 0, v: 0 },
      gloatYaw: { a: 0, v: 0 }, // head cranks over the shoulder for a gloating look-back
    },
  };
  return cat;
}

// Animates a cat rig with cornering physics. `lat` is the (signed) cornering
// intensity, `lon` the longitudinal acceleration; both roughly -1..1. The
// appendages lag and overshoot via simple spring-dampers so they whip around
// corners and flatten back under acceleration. `toot` lifts the tail.
// `celebrate` triggers the victory pose: sunglasses drop on and one paw pumps.
export function updateCatRig(rig, dt, lat, lon, toot = false, celebrate = false, allowBlink = false, gloat = false) {
  if (!rig) return;
  const sp = rig.springs;
  const step = (s, target, k, d) => {
    s.v += (target - s.a) * k * dt;
    s.v *= Math.max(0, 1 - d * dt);
    s.a += s.v * dt;
  };
  step(sp.earSway, -lat * 0.85, 70, 9);
  step(sp.earBack, Math.max(0, lon) * 0.7 + Math.abs(lat) * 0.5, 75, 12);
  step(sp.whisker, -lat * 0.9, 55, 8);
  step(sp.tailY, -lat * 1.9, 42, 6);
  step(sp.tailX, toot ? -1.5 : -Math.max(0, lon) * 0.5, 55, 9);
  step(sp.headLean, -lat * 0.4, 65, 10);
  step(sp.headPitch, lon * 0.2, 70, 11);

  // --- Gloat: crank the head back over the shoulder and giggle (e.g. your spilled
  // milk just spun a rival out). The spring eases the look-back in AND out; the
  // giggle is a quick nod whose amplitude follows the look-back so it fades cleanly.
  const GLOAT_YAW = -2.15; // radians over the left shoulder
  step(sp.gloatYaw, gloat ? GLOAT_YAW : 0, 60, 12);
  const gloatAmt = sp.gloatYaw.a / GLOAT_YAW; // 0 (forward) .. 1 (fully looking back)
  rig.gloatPhase = gloatAmt > 0.02 ? (rig.gloatPhase || 0) + dt * 17 : 0;
  const giggle = Math.sin(rig.gloatPhase) * 0.3 * gloatAmt;

  rig.earL.rotation.set(sp.earBack.a, 0, sp.earSway.a);
  rig.earR.rotation.set(sp.earBack.a, 0, sp.earSway.a);
  rig.whiskerL.rotation.y = sp.whisker.a;
  rig.whiskerR.rotation.y = sp.whisker.a;
  rig.tail.rotation.set(sp.tailX.a, sp.tailY.a, 0);
  rig.head.rotation.set(sp.headPitch.a + giggle, sp.gloatYaw.a, sp.headLean.a + gloatAmt * 0.25);

  // --- Victory celebration: shades drop on, right paw pumps the air ---
  if (celebrate) {
    rig.celebT += dt;
    if (rig.glasses) {
      rig.glasses.visible = true;
      rig.glasses.position.y = Math.max(0, 1.0 - rig.celebT * 4); // slide on over ~0.25s
    }
    if (rig.armR) {
      const pump = Math.sin(rig.celebT * 9);
      rig.armR.rotation.set(-1.9 + pump * 0.5, 0, -0.2); // paw raised overhead, pumping
    }
  } else {
    rig.celebT = 0;
    if (rig.glasses) rig.glasses.visible = false;
    if (rig.armR) rig.armR.rotation.set(0, 0, 0);
  }
  if (rig.armL) rig.armL.rotation.set(0, 0, 0); // left paw stays on the wheel

  // --- Idle blink: only in showcase contexts (garage / post-race pan), so a
  // racing cat — already animated by the cornering rig — never blinks. The lids
  // are hidden the rest of the time, so they cost nothing during a race. ---
  const lids = rig.eyelids;
  if (allowBlink && lids && lids.length) {
    if (rig.blinkP > 0) {
      rig.blinkP -= dt;
      // Lid sweeps down then back up over the blink; sin gives a smooth 0→1→0
      // travel. The pivot sits at the brow, so scaling its Y draws the lid down
      // over the eyeball (1 = fully closed).
      const t = 1 - Math.max(0, rig.blinkP) / 0.16;
      const v = Math.sin(Math.min(1, t) * Math.PI);
      for (const lid of lids) { lid.visible = true; lid.scale.y = v; }
      if (rig.blinkP <= 0) { for (const lid of lids) { lid.visible = false; lid.scale.y = 0; } rig.blinkT = 1.8 + Math.random() * 3.5; }
    } else {
      rig.blinkT -= dt;
      if (rig.blinkT <= 0) rig.blinkP = 0.16; // start a blink
    }
  } else if (lids && lids.length && lids[0].visible) {
    for (const lid of lids) { lid.visible = false; lid.scale.y = 0; }
  }
}

// Constant kart materials — colour never varies per kart, so a single shared
// instance is reused by every racer. Combined with the toToon cache, each
// collapses to ONE render pipeline for the whole field instead of one per kart.
// Flagged shared so kart teardown (disposeGroup) never disposes them.
const _kDark = _shared(new THREE.MeshStandardMaterial({ color: 0x1c1c20, roughness: 0.6 }));
const _kTire = _shared(new THREE.MeshStandardMaterial({ color: 0x16161a, roughness: 1.0, metalness: 0.0 }));
const _kTread = _shared(new THREE.MeshStandardMaterial({ color: 0x0e0e12, roughness: 1.0, metalness: 0.0 }));
const _kChrome = _shared(new THREE.MeshStandardMaterial({ color: 0xd2dadf, metalness: 0.9, roughness: 0.22 }));
const _kRim = _shared(new THREE.MeshStandardMaterial({ color: 0xc9cfd6, metalness: 0.45, roughness: 0.42 }));
const _kCaliper = _shared(new THREE.MeshStandardMaterial({ color: 0xcf3a2e, metalness: 0.3, roughness: 0.4 }));

// Builds a chunky go-kart as ONE cohesive moulded shell (floor pan → cockpit
// spine → tapering nose → rear deck, with the side fairings flush to the body
// rather than bolted-on pods). A two-tone livery — body colour, a darker accent
// on the lower skirt/nose, a light centre racing stripe, and a number roundel —
// gives each kart its own paint without needing per-kart art. Returns
// { group, wheels, brakeMat, flames }. The rigid shell is baked into one
// multi-material mesh and each wheel into one mesh, so a kart is a handful of
// draw calls instead of ~70.
export function createKartModel(bodyColor = 0xe53935, opts = {}) {
  const group = new THREE.Group();
  const body = new THREE.Color(bodyColor);
  // Body silhouette variants (cockpit height stays constant so the cat always
  // seats correctly; the nose, wing, tyres and roll-cage change the profile):
  //   gp        — long nose, big rear wing, low slick tyres (default)
  //   roadster  — short nose, ducktail lip spoiler, classic rounded tail
  //   buggy     — stubby nose, no wing, fat tyres + a roll hoop
  //   speedster — longest needle nose, low slicks, twin swept rocket tail-fins
  //   moto      — a narrow café-racer with a tank, forks, and training wheels
  //   van       — an open-top minivan (roof cut away so the cat pokes out)
  // Kart styles use `snout` — how far the short lower nose reaches (real karts
  // barely out-reach their front wheels); the van keeps its long-hood fields.
  const STYLES = [
    { snout: 1.55, wing: "big", tire: 1.0, hoop: false },
    { snout: 1.45, wing: "lip", tire: 1.06, hoop: false },
    { snout: 1.3, wing: "none", tire: 1.2, hoop: true },
    { snout: 1.8, wing: "fin", tire: 0.94, hoop: false },
    { body: "moto", wing: "none", tire: 1.12, hoop: false },
    { body: "van", nose: 1.05, noseZ: 1.9, tipZ: 2.55, hlZ: 2.72, wing: "none", tire: 1.05, hoop: false },
    { snout: 1.35, wing: "none", tire: 1.3, hoop: false, cage: true }, // off-road cage buggy
  ];
  const st = STYLES[opts.style ?? 0] || STYLES[0];
  const styleIdx = STYLES.indexOf(st);
  const bodyKind = st.body || "kart";
  const kartNumber = opts.number ?? 1;
  // Soft "toy gloss" — a gentle sheen, not a mirror (the toon spec is keyed off
  // userData.paint). Accent is a darker shade of the same hue; the stripe is a
  // near-white tint so the livery reads on dark and light bodies alike. All the
  // livery materials come from the shared colour-keyed cache: two karts painted
  // the same colour share instances (one toon pipeline for the pair, and teardown
  // knows to leave them alone).
  const bodyHex = body.getHexString();
  const paintMat = (tag, make) => sharedMat(`k${tag}|${bodyHex}`, () => {
    const m = make();
    m.userData.paint = true;
    return m;
  });
  const paint = paintMat("paint", () => new THREE.MeshStandardMaterial({ color: body.clone(), roughness: 0.34, metalness: 0.0 }));
  const accent = paintMat("accent", () => new THREE.MeshStandardMaterial({ color: body.clone().multiplyScalar(0.55), roughness: 0.38, metalness: 0.0 }));
  // Painted racing stripe: crisp white on dark/medium bodies, a deep charcoal on
  // very light bodies, so the stripe always reads as deliberate paint.
  const bodyL = 0.2126 * body.r + 0.7152 * body.g + 0.0722 * body.b;
  const stripeHex = bodyL > 0.62 ? 0x2c2a27 : 0xf3efe6;
  const stripe = sharedMat(`kstripe|${stripeHex}`, () => {
    const m = new THREE.MeshStandardMaterial({ color: stripeHex, roughness: 0.4, metalness: 0.0 });
    m.userData.paint = true;
    return m;
  });
  // Shared constant materials (matte rubber, chrome, dark trim).
  const dark = _kDark;
  const tire = _kTire;
  const chrome = _kChrome;
  // Headlights glow much brighter at night (bloom picks them up). The intensity is
  // baked at creation from the current light level, so the level is in the key.
  const glass = sharedMat(`kglass|${_lightLevel}`, () => new THREE.MeshStandardMaterial({
    color: 0xfff4d0, emissive: 0xfff0c0, emissiveIntensity: 0.4 + _lightLevel * 2.3,
  }));

  // --- Moulded shell ---
  // Every rigid, opaque body part is collected here and baked into ONE
  // multi-material mesh at the end (one draw call per livery material) instead of
  // ~25 separate meshes. Transparent/emissive/animated parts (number roundels,
  // headlight bulbs, tail lights, flames, underglow) stay separate below.
  const shell = [];
  const add = (mesh) => { shell.push(mesh); return mesh; };
  // Numbered roundel decals (a plane pair facing outward). Position varies by
  // body: kart fairings, van sliding doors, moto tank flanks.
  const numMat = sharedMat(`knum|${kartNumber}`, () =>
    new THREE.MeshStandardMaterial({ map: makeNumberTexture(kartNumber), transparent: true, roughness: 0.5 }));
  const roundels = [];
  const addRoundels = (x, y, z, size = 0.62) => {
    for (const sx of [-1, 1]) {
      const roundel = new THREE.Mesh(new THREE.PlaneGeometry(size, size), numMat);
      roundel.position.set(sx * x, y, z);
      roundel.rotation.y = sx * Math.PI / 2; // face outward (±X)
      roundels.push(roundel);
    }
  };

  if (bodyKind === "moto") {
    // --- Café-racer: a narrow spine frame, fuel tank, saddle and chrome forks.
    // Cats famously balance fine, but the training wheels make it read as a toy
    // (and excuse the kart physics). Saddle sits exactly where the kart seat
    // does, so the cat drops straight on. ---
    const frame = add(new THREE.Mesh(rbox(0.52, 0.42, 3.2, 0.18), paint));
    frame.position.set(0, 0.78, -0.1);
    const tank = add(new THREE.Mesh(rbox(0.78, 0.6, 1.25, 0.3), paint));
    tank.position.set(0, 1.08, 0.5);
    const tankTop = add(new THREE.Mesh(rbox(0.5, 0.14, 0.9, 0.06), accent));
    tankTop.position.set(0, 1.38, 0.5);
    const tankStripe = add(new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.95), stripe));
    tankStripe.rotation.x = -Math.PI / 2;
    tankStripe.position.set(0, 1.451, 0.5);
    const saddle = add(new THREE.Mesh(rbox(0.95, 0.32, 1.6, 0.15), dark));
    saddle.position.set(0, 1.06, -0.55);
    const sissy = add(new THREE.Mesh(rbox(0.85, 0.85, 0.22, 0.1), dark));
    sissy.position.set(0, 1.28, -1.3);
    // Fenders hugging each wheel.
    const rearFender = add(new THREE.Mesh(rbox(0.62, 0.2, 1.35, 0.1), accent));
    rearFender.position.set(0, 1.56, -1.6);
    const frontFender = add(new THREE.Mesh(rbox(0.56, 0.18, 1.15, 0.09), accent));
    frontFender.position.set(0, 1.36, 1.55);
    // Chrome forks raking down to the front axle, and handlebars with grips.
    for (const sx of [-1, 1]) {
      const fork = add(new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 1.3, 10), chrome));
      fork.position.set(sx * 0.3, 1.1, 1.32);
      fork.rotation.x = 0.42;
    }
    const bar = add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.15, 10), chrome));
    bar.rotation.z = Math.PI / 2;
    bar.position.set(0, 1.66, 1.02);
    for (const sx of [-1, 1]) {
      const grip = add(new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.26, 10), dark));
      grip.rotation.z = Math.PI / 2;
      grip.position.set(sx * 0.52, 1.66, 1.02);
    }
    // Outrigger arms for the training wheels (the casters themselves spin in
    // the wheels section below; the arms stay rigid in the shell).
    for (const sx of [-1, 1]) {
      const arm = add(new THREE.Mesh(rbox(0.8, 0.12, 0.16, 0.05), accent));
      arm.position.set(sx * 0.5, 0.52, -1.35);
      arm.rotation.z = sx * -0.24; // slope down toward the caster hub
    }
    addRoundels(0.41, 1.08, 0.5, 0.5); // on the tank flanks
  } else {
    // Steering wheel — shared by van and karts (same spot the cat's driving
    // pose reaches for). A chunky centre cap + two spokes IN the wheel's
    // plane, so the assembly reads as one clean part.
    const WHEEL_TILT = Math.PI / 2.6;
    // The hub disc and spokes must have their AXES along the wheel's normal —
    // that's the torus tilt minus 90° (same tilt left them standing sideways).
    const IN_PLANE = WHEEL_TILT - Math.PI / 2;
    const wheel = add(new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.07, 10, 18), dark));
    wheel.position.set(0, 1.4, 0.55);
    wheel.rotation.x = WHEEL_TILT;
    const wheelHub = add(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.09, 12), chrome));
    wheelHub.position.set(0, 1.4, 0.55);
    wheelHub.rotation.x = IN_PLANE;
    for (const sx of [-1, 1]) {
      const spoke = add(new THREE.Mesh(rbox(0.3, 0.05, 0.07, 0.02), dark));
      spoke.position.set(sx * 0.17, 1.4, 0.55);
      spoke.rotation.x = IN_PLANE; // flat against the wheel's face
    }
    // Seat where the cat sits — same height in every body so the cat always fits.
    const seat = add(new THREE.Mesh(rbox(1.5, 0.66, 1.5, 0.28), dark));
    seat.position.set(0, 1.06, -0.5);

    if (bodyKind === "van") {
      // --- Open-top minivan: the chunky moulded body ---
      const pan = add(new THREE.Mesh(rbox(2.55, 0.42, 4.7, 0.3), paint));
      pan.position.y = 0.56;
      const skirt = add(new THREE.Mesh(rbox(2.66, 0.3, 4.3, 0.22), accent));
      skirt.position.y = 0.36;
      // Hood + soft tip.
      const nose = add(new THREE.Mesh(rbox(1.7, 0.46, st.nose, 0.3), paint));
      nose.position.set(0, 0.62, st.noseZ);
      const noseTip = add(new THREE.Mesh(rbox(1.16, 0.42, 1.2, 0.42), paint));
      noseTip.position.set(0, 0.58, st.tipZ);
      const flash = add(new THREE.Mesh(rbox(0.95, 0.2, 1.5, 0.12), accent));
      flash.position.set(0, 0.84, st.noseZ + 0.6);
      // Tall slab sides + a tailgate, roof cut away so the cat rides head-out.
      for (const sx of [-1, 1]) {
        const wall = add(new THREE.Mesh(rbox(0.26, 1.1, 3.4, 0.12), paint));
        wall.position.set(sx * 1.18, 1.25, -0.35);
        const doorLine = add(new THREE.Mesh(rbox(0.06, 0.72, 1.1, 0.03), accent));
        doorLine.position.set(sx * 1.32, 1.12, -0.85);
      }
      const tailgate = add(new THREE.Mesh(rbox(2.4, 1.0, 0.3, 0.12), paint));
      tailgate.position.set(0, 1.28, -2.1);
      // Windshield frame raked over the hood (no pane — it's a toy).
      const shield = add(new THREE.Mesh(rbox(2.2, 0.8, 0.14, 0.06), accent));
      shield.position.set(0, 1.42, 1.28);
      shield.rotation.x = -0.42;
      addRoundels(1.36, 1.3, -0.85);
      const noseStripe = add(new THREE.Mesh(new THREE.PlaneGeometry(0.42, 1.5), stripe));
      noseStripe.rotation.x = -Math.PI / 2;
      noseStripe.position.set(0, 0.951, st.noseZ + 0.6);
      const seatBack = add(new THREE.Mesh(rbox(1.4, 0.9, 0.4, 0.18), dark));
      seatBack.position.set(0, 1.3, -1.2);
    } else {
      // --- Go-kart: a LOW, OPEN chassis like the real thing — flat floor pan,
      // exposed side rails, a bare bucket seat, a narrow nose cone with the
      // stripe, low side pods, and an engine block behind the seat. The old
      // slab-sided body read as a toy car, not a kart. ---
      // Flat floor pan riding just off the tarmac (dark — chassis, not paint).
      // Runs all the way back under the engine so the rear bumper and exhaust
      // tips attach to the frame instead of floating behind it.
      const pan = add(new THREE.Mesh(rbox(2.1, 0.22, 4.6, 0.11), dark));
      pan.position.set(0, 0.4, -0.1);
      // Exposed tube side-rails: the go-kart frame look.
      for (const sx of [-1, 1]) {
        const rail = add(new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 4.2, 10), dark));
        rail.rotation.x = Math.PI / 2;
        rail.position.set(sx * 1.02, 0.34, -0.15);
      }
      // SHORT nose, real-kart shape: a low under-stub barely past the front
      // wheels, and ONE continuous raked panel running from the stub up to the
      // wheel — low at the front, high at the driver — with the number roundel
      // and the racing stripe lying FLUSH on its face like paint.
      const snout = st.snout ?? 1.55;
      const RAKE = 0.39; // the panel's climb toward the wheel
      const stub = add(new THREE.Mesh(rbox(0.95, 0.26, 1.9, 0.13), paint));
      stub.position.set(0, 0.44, snout - 0.45);
      const cowl = add(new THREE.Mesh(rbox(0.88, 0.24, 1.55, 0.12), paint));
      cowl.position.set(0, 0.78, 1.0);
      // +RAKE = front end dips into the stub, rear rises to the wheel, and the
      // panel's face tilts up-FORWARD so the number reads from the front.
      cowl.rotation.x = RAKE;
      // Decals lie a hair proud of the panel, exactly parallel to its face —
      // painted on, not floating (the face normal is (0, cos RAKE, sin RAKE)).
      // The roundel sits mid-panel, BELOW where the steering column lands, so
      // the post never crosses the number; the stripe runs beneath it.
      const cowlNum = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), numMat);
      cowlNum.position.set(0, 0.935, 0.98);
      cowlNum.rotation.x = -(Math.PI / 2 - RAKE);
      roundels.push(cowlNum);
      const noseStripe = add(new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.55), stripe));
      noseStripe.position.set(0, 0.715, 1.51);
      noseStripe.rotation.x = -(Math.PI / 2 - RAKE);
      // Little accent winglets flanking the panel (the reference's red fins).
      for (const sx of [-1, 1]) {
        const winglet = add(new THREE.Mesh(rbox(0.36, 0.12, 0.52, 0.05), accent));
        winglet.position.set(sx * 0.64, 0.6, 1.25);
      }
      if (st.hoop || st.cage) {
        // Off-roaders wear round pod headlights up on chrome stalks (classic
        // dune-buggy bullets). The glowing lenses join the headlight merge below.
        for (const sx of [-1, 1]) {
          const stem = add(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.28, 8), chrome));
          stem.position.set(sx * 0.3, 0.74, snout - 0.2);
          const pod = add(new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.2, 14), chrome));
          pod.rotation.x = Math.PI / 2;
          pod.position.set(sx * 0.3, 0.92, snout - 0.18);
        }
      }
      // Steering post drops STRAIGHT DOWN from the hub into the panel — well
      // clear of the number roundel further down the slope.
      const column = add(new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.55, 10), dark));
      column.position.set(0, 1.18, 0.55);
      // Wrap-around bumpers, front and rear (dark, low, at rail height). The
      // front one is wide and close, guarding the front wheels like the real thing.
      const bumperF = add(new THREE.Mesh(rbox(2.3, 0.2, 0.3, 0.14), dark));
      bumperF.position.set(0, 0.4, snout + 0.5);
      const bumperR = add(new THREE.Mesh(rbox(1.85, 0.2, 0.26, 0.12), dark));
      bumperR.position.set(0, 0.42, -2.35);
      // Low side pods between the wheels — ONE clean shape each, shortened so
      // they stay out of the tyres' space, with a nearly FLAT outer face
      // (small corner radius) so the flush roundel conforms like paint.
      const podLen = st.tire >= 1.2 ? 1.25 : 1.62; // fat-tyre styles need shorter pods
      for (const sx of [-1, 1]) {
        const pod = add(new THREE.Mesh(rbox(0.46, 0.5, podLen, 0.07), paint));
        pod.position.set(sx * 1.12, 0.5, -0.12);
      }
      addRoundels(1.36, 0.5, -0.12, 0.4);
      // Bare bucket seat: tall back + side bolsters (nothing to sink into now).
      const seatBack = add(new THREE.Mesh(rbox(1.35, 1.05, 0.34, 0.16), dark));
      seatBack.position.set(0, 1.38, -1.26);
      for (const sx of [-1, 1]) {
        const bolster = add(new THREE.Mesh(rbox(0.2, 0.5, 1.2, 0.09), dark));
        bolster.position.set(sx * 0.74, 1.12, -0.55);
      }
      // Engine block + air intake behind the seat, off to one side.
      const engine = add(new THREE.Mesh(rbox(0.85, 0.55, 0.7, 0.12), dark));
      engine.position.set(-0.45, 0.72, -1.85);
      const intake = add(new THREE.Mesh(rbox(0.42, 0.32, 0.46, 0.1), accent));
      intake.position.set(-0.45, 1.05, -1.85);
      if (st.cage) {
        // Off-road roll cage in body paint, TRIANGULAR in profile like the
        // real thing: long tubes rake all the way down to the nose, and the
        // short roof only covers the driver — not a box.
        // Smooth round tubes (high segment count, like the whip aerial).
        const tube = (len) => new THREE.CylinderGeometry(0.08, 0.08, len, 14);
        for (const sx of [-1, 1]) {
          // Long front diagonals: nose (y 0.55, z 1.5) → roof front (y 2.72, z -0.62).
          const diag = add(new THREE.Mesh(tube(3.05), paint));
          diag.position.set(sx * 0.82, 1.63, 0.44);
          diag.rotation.x = -0.775;
          // Near-vertical hoops behind the seat.
          const rear = add(new THREE.Mesh(tube(2.25), paint));
          rear.position.set(sx * 0.82, 1.61, -1.74);
          rear.rotation.x = -0.055; // a whisper of backward lean
          // Short roof rails over the seat only.
          const rail = add(new THREE.Mesh(tube(1.2), paint));
          rail.rotation.x = Math.PI / 2;
          rail.position.set(sx * 0.82, 2.73, -1.21);
        }
        // Roof crossbars + a mid-brace tying the diagonals together.
        for (const [cy, cz] of [[2.73, -0.66], [2.73, -1.76], [1.63, 0.44]]) {
          const cross = add(new THREE.Mesh(tube(1.68), paint));
          cross.rotation.z = Math.PI / 2;
          cross.position.set(0, cy, cz);
        }
      }
    }
  }
  // Both roundels share one material — merge them into one mesh (one draw).
  // Positions are style-dependent, so the merge cache keys on the style.
  group.add(mergeMeshes(roundels, { geoKey: `kroundel|${styleIdx}` }));

  // Rear aero varies by style: a big winged GP, a low ducktail lip, or none.
  let flagPivot = null; // the roadster's pennant pivot (returned for live flapping)
  if (st.wing === "big") {
    // Pylon runs all the way down to the floor pan (no rear deck any more).
    const pylon = add(new THREE.Mesh(rbox(0.34, 1.1, 0.34, 0.1), dark));
    pylon.position.set(0, 1.06, -2.3);
    const wing = add(new THREE.Mesh(rbox(2.7, 0.14, 0.74, 0.06), paint));
    wing.position.set(0, 1.62, -2.32);
    for (const sx of [-1, 1]) {
      const plate = add(new THREE.Mesh(rbox(0.08, 0.36, 0.78, 0.03), accent));
      plate.position.set(sx * 1.32, 1.55, -2.32);
    }
  } else if (st.wing === "lip") {
    // Ducktail lip spoiler perched on the rear bumper…
    const lip = add(new THREE.Mesh(rbox(2.0, 0.12, 0.5, 0.06), paint));
    lip.position.set(0, 0.72, -2.32);
    lip.rotation.x = -0.18;
    // …plus a tall CURVED whip aerial off the rear corner flying a triangular
    // body-coloured pennant. The pennant hangs on its own pivot (returned as
    // `flag`) so the kart can flap it live each frame.
    // Rooted just behind the seat — ahead of the lip spoiler, so the arc never
    // passes through it.
    const whip = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(0.82, 0.55, -1.88),
      new THREE.Vector3(0.82, 1.72, -1.95),
      new THREE.Vector3(0.82, 2.2, -2.38)
    );
    const pole = add(new THREE.Mesh(new THREE.TubeGeometry(whip, 10, 0.035, 6), chrome));
    // Triangle pennant, thin-extruded so both faces render with the shared
    // paint material. Shape-x runs along the trailing direction; the mesh is
    // yawed so it streams backward off the pole tip.
    const penShape = new THREE.Shape();
    penShape.moveTo(0, 0);
    penShape.lineTo(0.85, -0.17);
    penShape.lineTo(0, -0.36);
    penShape.closePath();
    const penGeo = new THREE.ExtrudeGeometry(penShape, { depth: 0.035, bevelEnabled: false, curveSegments: 2 });
    const pennant = new THREE.Mesh(penGeo, paint);
    pennant.rotation.y = Math.PI / 2; // shape +x → world -z (trailing)
    flagPivot = new THREE.Group();
    flagPivot.position.copy(whip.getPoint(1)); // hinged at the pole tip
    flagPivot.add(pennant);
    group.add(flagPivot);
  } else if (st.wing === "fin") {
    // Twin swept rocket tail-fins flanking the rear deck (body paint, accent edge),
    // plus a small central spine fin — a jet-age speedster look.
    // Two clean raked fins, nothing else (the accent edge caps and the centre
    // spine fin cluttered the tail into a jumble of plates).
    for (const sx of [-1, 1]) {
      const fin = add(new THREE.Mesh(rbox(0.14, 0.95, 1.1, 0.07), paint));
      fin.position.set(sx * 0.72, 1.02, -2.15);
      fin.rotation.x = -0.34; // rake the fin back
      fin.rotation.z = sx * 0.12; // splay outward a touch
    }
  }

  // --- Greebles: chrome roll hoop (buggy) + twin exhaust tips (all) ---
  if (st.hoop) {
    // Roll hoop BEHIND the seat, with straight legs running all the way down
    // to the chassis pan — a grounded hoop, not a floating arch.
    const hoop = add(new THREE.Mesh(new THREE.TorusGeometry(0.82, 0.09, 10, 20, Math.PI), chrome));
    hoop.position.set(0, 1.3, -1.62);
    for (const sx of [-1, 1]) {
      const leg = add(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.95, 10), chrome));
      leg.position.set(sx * 0.82, 0.87, -1.62);
    }
  }
  // Twin exhaust tips — tucked in tight and shorter on the moto's tail.
  const exX = bodyKind === "moto" ? 0.26 : 0.42;
  const exZ = bodyKind === "moto" ? -2.05 : -2.62;
  for (const sx of [-exX, exX]) {
    const pipe = add(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.6, 12), chrome));
    pipe.rotation.x = Math.PI / 2; // axis along Z, poking out the back
    pipe.position.set(sx, 0.58, exZ);
    const pipeTip = add(new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.1, 0.12, 12), dark));
    pipeTip.rotation.x = Math.PI / 2;
    pipeTip.position.set(sx, 0.58, exZ - 0.3);
  }

  // Bake the whole rigid shell into one mesh (≈5 draw calls — one per material).
  // Karts don't cast a real sun shadow: each already has a soft contact-shadow
  // blob (kart.js), so casting into the 2048 shadow map too just doubled the
  // field's vertex/fill cost when cars bunched up. The blob grounds them.
  // Shell geometry is a pure function of the STYLE (colours only pick which
  // material instances fill the slots — role-keyed, so they never collapse into
  // each other) — share it across every kart of that style via the merge cache.
  const shellMesh = mergeMeshes(shell, { castShadow: false, geoKey: `kshell|${styleIdx}` });
  group.add(shellMesh);

  // Headlights — a pair set into the nose (kart/van) or one big moto lamp on
  // the handlebar stem. Positions are style-dependent → style-keyed merge.
  const hlParts = [];
  if (bodyKind === "moto") {
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 12), glass);
    light.position.set(0, 1.42, 1.42);
    hlParts.push(light);
  } else if (bodyKind === "van") {
    for (const sx of [-1, 1]) {
      const light = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 12), glass);
      light.position.set(sx * 0.46, 0.66, st.hlZ ?? 2.92);
      hlParts.push(light);
    }
  } else if (st.hoop || st.cage) {
    // Lenses for the pod headlights on stalks (housings built in the shell).
    for (const sx of [-1, 1]) {
      const lens = new THREE.Mesh(new THREE.SphereGeometry(0.105, 12, 12), glass);
      lens.position.set(sx * 0.3, 0.92, (st.snout ?? 1.55) - 0.05);
      lens.scale.set(1, 1, 0.7); // shallow dome poking out of the housing
      hlParts.push(lens);
    }
  } else {
    // Kart lights sit on the short nose stub's tip.
    for (const sx of [-1, 1]) {
      const light = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 12), glass);
      light.position.set(sx * 0.26, 0.5, (st.snout ?? 1.55) + 0.3);
      hlParts.push(light);
    }
  }
  group.add(mergeMeshes(hlParts, { geoKey: `khl|${styleIdx}` }));
  // The forward beam that lights the road is NOT parented here (it would tilt with
  // the kart and clip the tarmac during drifts) — it's a ground-projected pool
  // managed per-frame in the main loop (see headlights in main.js).

  // Tail lights: a dim red glow normally, flaring bright when braking/reversing
  // (the kart updates brakeMat.emissiveIntensity). Shared material returned below.
  const brakeMat = new THREE.MeshStandardMaterial({
    color: 0x6e0d0d, emissive: 0xff2a1e, emissiveIntensity: 0.25, roughness: 0.5,
  });
  const tlParts = [];
  if (bodyKind === "moto") {
    const tl = new THREE.Mesh(rbox(0.34, 0.22, 0.14, 0.05), brakeMat);
    tl.position.set(0, 1.54, -2.3); // on the rear fender's tail
    tlParts.push(tl);
  } else if (bodyKind === "van") {
    for (const sx of [-1, 1]) {
      const tl = new THREE.Mesh(rbox(0.4, 0.26, 0.16, 0.06), brakeMat);
      tl.position.set(sx * 0.62, 0.86, -2.46);
      tlParts.push(tl);
    }
  } else {
    // Kart tail lights sit on the rear bumper bar.
    for (const sx of [-1, 1]) {
      const tl = new THREE.Mesh(rbox(0.34, 0.22, 0.14, 0.05), brakeMat);
      tl.position.set(sx * 0.62, 0.48, -2.5);
      tlParts.push(tl);
    }
  }
  group.add(mergeMeshes(tlParts, { geoKey: `ktl|${styleIdx}` }));

  // --- Wheels: matte tyres with a contact tread band, a spoked body-coloured
  // rim + chrome hub cap, and a brake caliper at the rim. Fronts a touch smaller
  // than the rears; tyre size scales with the body style. Each wheel's parts are
  // baked into ONE mesh (≈5 draw calls) inside a Group the kart still spins/steers. ---
  const wheels = [];
  // `side` is the sign of the wheel's x position so the spokes / hub cap sit on
  // the OUTER face (the visible one) on both sides of the kart.
  function buildWheel(radius, side) {
    // Real go-kart wheel: a smooth slick tyre, a wide flat SILVER RING rim,
    // and a deep dark centre bore — no toy spokes. Four lug dots on the ring
    // keep the spin readable while the kart rolls.
    const w = new THREE.Group();
    const parts = [];
    const t = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.5, 24), tire);
    t.rotation.z = Math.PI / 2;
    parts.push(t);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.56, radius * 0.56, 0.53, 20), _kRim);
    ring.rotation.z = Math.PI / 2;
    parts.push(ring);
    const bore = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.3, radius * 0.3, 0.55, 16), dark);
    bore.rotation.z = Math.PI / 2;
    parts.push(bore);
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const lug = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.57, 8), dark);
      lug.rotation.z = Math.PI / 2;
      lug.position.set(0, Math.cos(ang) * radius * 0.44, Math.sin(ang) * radius * 0.44);
      parts.push(lug);
    }
    // Wheel geometry depends only on (radius, side): every kart of a style
    // shares the same four wheel geometries instead of merging 24 of them.
    w.add(mergeMeshes(parts, { castShadow: false, geoKey: `kwheel|${radius.toFixed(3)}|${side}` }));
    return w;
  }
  if (bodyKind === "moto") {
    // Two centre-line wheels + training-wheel casters. The wheels array keeps
    // the 4-slot contract every consumer assumes (indices 0-1 steer, all roll):
    // [front, front-dummy(empty), rear, caster-pair] — so the front steers, the
    // empty dummy absorbs the second "front axle" slot, and the caster group
    // rolls with everything else (both casters share one axle line).
    const frontR = 0.55 * st.tire, rearR = 0.62 * st.tire, casterR = 0.3;
    const front = buildWheel(frontR, 1);
    front.position.set(0, frontR, 1.55);
    const dummy = new THREE.Group();
    dummy.position.copy(front.position);
    const rear = buildWheel(rearR, 1);
    rear.position.set(0, rearR, -1.6);
    const casters = new THREE.Group();
    casters.position.set(0, casterR, -1.35);
    const casterParts = [];
    for (const sx of [-0.85, 0.85]) {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(casterR, casterR, 0.22, 14), tire);
      c.rotation.z = Math.PI / 2;
      c.position.x = sx;
      casterParts.push(c);
    }
    casters.add(mergeMeshes(casterParts, { castShadow: false, geoKey: "kcasters" }));
    for (const w of [front, dummy, rear, casters]) { group.add(w); wheels.push(w); }
  } else {
    // A touch smaller than before so the tyres and side pods keep out of each
    // other's space (the pods are shorter now too).
    const wheelDefs = [
      [1.32, 1.55, 0.52],
      [-1.32, 1.55, 0.52],
      [1.42, -1.6, 0.62],
      [-1.42, -1.6, 0.62],
    ];
    for (const [x, z, baseR] of wheelDefs) {
      const radius = baseR * st.tire;
      const w = buildWheel(radius, Math.sign(x));
      w.position.set(x, radius, z); // centre at radius so the tyre sits on the ground
      group.add(w);
      wheels.push(w);
    }
  }

  // Boost flames out the back — hidden until boosting (the kart shows/flickers
  // them). Bright, un-tonemapped additive cones so bloom makes them roar.
  const flames = new THREE.Group();
  flames.visible = false;
  const flameOuter = new THREE.MeshBasicMaterial({
    color: 0xff7a1e, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false,
  });
  const flameCore = new THREE.MeshBasicMaterial({
    color: 0xfff2c0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false,
  });
  const flameParts = [];
  const flameX = bodyKind === "moto" ? 0.26 : 0.7; // moto flames hug the tail pipes
  for (const sx of [-flameX, flameX]) {
    const outer = new THREE.Mesh(new THREE.ConeGeometry(0.3, 1.5, 8), flameOuter);
    outer.rotation.x = -Math.PI / 2; // taper trailing backward (-Z)
    outer.position.set(sx, 0.55, -2.7);
    flameParts.push(outer);
    const core = new THREE.Mesh(new THREE.ConeGeometry(0.16, 1.0, 8), flameCore);
    core.rotation.x = -Math.PI / 2;
    core.position.set(sx, 0.55, -2.5);
    flameParts.push(core);
  }
  // One merged mesh (2 draws — outer + core groups) instead of 4 cones; the
  // group still flickers via its scale. The kart recolours via userData mats.
  flames.add(mergeMeshes(flameParts, { geoKey: `kflames|${flameX}` }));
  flames.userData.outerMat = flameOuter;
  flames.userData.coreMat = flameCore;
  group.add(flames);

  // Neon underglow — a night-only effect (a soft additive pool under the chassis
  // tinted to the kart's body colour, so each kart sits in its own coloured halo).
  if (_lightLevel >= 0.9) {
    const under = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: underglowTexture(),
        color: new THREE.Color(bodyColor).multiplyScalar(1.7),
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false,
      })
    );
    under.position.set(0, 0.07, -0.1);
    under.scale.set(4.6, 1, 5.6);
    under.renderOrder = 1;
    group.add(under);
  }

  return { group, wheels, brakeMat, flames, flag: flagPivot };
}
