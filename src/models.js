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
export function mergeMeshes(meshes, { castShadow = false, receiveShadow = false } = {}) {
  if (!meshes.length) return null;
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
function makeNumberTexture(n) {
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
export const CAT_PATTERNS = ["spotted", "solid", "tuxedo", "snowshoe", "tabby", "mitted", "point", "calico", "tortie"];
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
    if (o.geometry) o.geometry.dispose();
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
  // A few LARGE soft-edged patches (the reference toy's spots), not confetti.
  // Soft edge via a radial gradient per spot: solid to ~70%, fading out.
  const spotHex = "#" + spotColor.getHexString();
  const spots = [
    [0.16, 0.2, 0.1], [0.62, 0.12, 0.085], [0.9, 0.4, 0.095],
    [0.34, 0.48, 0.115], [0.72, 0.62, 0.1], [0.14, 0.74, 0.09], [0.52, 0.88, 0.095],
  ];
  for (const [x, y, r] of spots) {
    const g = ctx.createRadialGradient(x * S, y * S, 0, x * S, y * S, r * S);
    g.addColorStop(0, spotHex);
    g.addColorStop(0.72, spotHex);
    g.addColorStop(1, spotHex + "00");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x * S, y * S, r * S, r * S * 1.25, 0.4, 0, Math.PI * 2);
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
  // Toy-figure eye: the iris fills most of the visible ball (only a thin
  // sclera ring survives at the edges), with a big soft-slit pupil and two
  // bold catch-lights — the "vinyl collectible" look.
  // Darker rim ring first, then the iris inside it — the toy eye's depth.
  ctx.fillStyle = "#" + col.clone().multiplyScalar(0.5).getHexString();
  ctx.beginPath(); ctx.ellipse(cx, cy, S * 0.39, S * 0.44, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#" + hex; // iris (big round — fills the eye)
  ctx.beginPath(); ctx.ellipse(cx, cy, S * 0.35, S * 0.4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#141414"; // soft-slit pupil (the iris colour stays the star)
  ctx.beginPath(); ctx.ellipse(cx, cy, S * 0.14, S * 0.26, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.95)"; // double catch-light
  ctx.beginPath(); ctx.arc(cx - S * 0.09, cy - S * 0.14, S * 0.075, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + S * 0.06, cy + S * 0.11, S * 0.04, 0, Math.PI * 2); ctx.fill();
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

// Builds a low-poly cat sitting upright (the driver). Returns a Group whose
// origin sits at the seat base. `furColor` tints the fur; `opts.pattern` can
// force a markings template (else it's derived from the colour). The returned
// group's userData.rig holds pivots (ears, whiskers, tail, head) that
// updateCatRig() animates with cornering physics.
//
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
  const isTextured = isTabby || isSpotted || isCalico || isTortie; // coat carries a painted pattern
  const isTuxedo = pat === "tuxedo";
  const isMitted = pat === "mitted";
  const isSolid = pat === "solid";
  const isPoint = pat === "point";
  const isSnow = pat === "snowshoe";
  const hasMask = isPoint || isSnow;           // dark face mask + colour points
  const hasBib = isTuxedo || isMitted;         // big white chest
  const whitePaws = isTuxedo || isMitted || isSnow || isCalico; // calicos have white socks
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

  // Body (sitting torso) — a plump pear (wide hips, narrower shoulders) like a
  // vinyl toy, painted pattern for tabbies/spotted cats.
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.88, 0.52, 6, 16), coat);
  body.position.y = 0.94;
  body.scale.set(0.98, 1.0, 0.94);
  catStatic.push(body);
  // Haunches: big folded thighs at the hips, with oval feet poking out in
  // front — the classic sitting-toy base. Hidden inside the seat well in a
  // kart; they complete the silhouette in the garage/viewer.
  for (const sx of [-1, 1]) {
    const haunch = new THREE.Mesh(new THREE.SphereGeometry(0.46, 14, 14), coat);
    haunch.position.set(sx * 0.5, 0.44, 0.22);
    haunch.scale.set(0.92, 0.86, 1.05);
    catStatic.push(haunch);
    const foot = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), pawMat);
    foot.position.set(sx * 0.42, 0.16, 0.72);
    foot.scale.set(0.95, 0.7, 1.35);
    catStatic.push(foot);
  }

  // Chest + belly fluff. Tuxedo/mitten cats get a big white bib; solid coats keep
  // the body colour (no bib); others get a soft pale chest.
  const chestMat = (isSolid || isTortie) ? fur : white;
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.62, 16, 16), chestMat);
  chest.position.set(0, 0.76, 0.55);
  chest.scale.set(hasBib ? 0.98 : 0.86, hasBib ? 1.1 : 1.0, hasBib ? 0.6 : 0.52);
  catStatic.push(chest);

  // Front paws on the wheel. Each arm hangs off a shoulder pivot so it can be
  // raised for a victory fist-pump; at rest (pivot identity) the pose is
  // unchanged from before. Mitten/tuxedo cats get white "socks".
  const arms = {};
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.5, 1.05, 0.45);
    cat.add(pivot);
    const parts = [];
    // Stubby toy arms: chunky and short, ending in a fat round mitt.
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.21, 0.46, 4, 10), pawMat);
    arm.position.set(0, 0, 0.15);
    arm.rotation.x = -1.0;
    parts.push(arm);
    const paw = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 12), pawMat);
    paw.position.set(0, 0.15, 0.5);
    paw.scale.set(1, 0.86, 1.02);
    parts.push(paw);
    // Toe-bean detail: three little pink pads on the front of each mitt.
    for (const tx of [-0.08, 0, 0.08]) {
      const bean = new THREE.Mesh(new THREE.SphereGeometry(0.036, 6, 6), pink);
      bean.position.set(tx, 0.1, 0.72);
      parts.push(bean);
    }
    pivot.add(mergeMeshes(parts)); // one mesh per arm; the pivot still pumps it
    arms[sx < 0 ? "L" : "R"] = pivot;
  }

  // --- Head (animated for lean/pitch) — HUGE, the vinyl-toy ratio: nearly as
  // wide as the whole body, sitting low on the shoulders. ---
  const head = new THREE.Group();
  head.position.set(0, 2.02, 0.12);
  cat.add(head);

  // Wide, softly squashed skull — the toy's rounded-square face, not a balloon.
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.98, 22, 22), coat);
  skull.scale.set(1.12, 0.88, 0.92);
  headStatic.push(skull);
  // Masked breeds (Siamese point / snowshoe): a dark mask across the eyes +
  // muzzle bridge. The white muzzle below and the eyes on top leave a band of
  // colour around the eyes — the signature masked face. (Tabby/spotted head
  // markings come from the painted coat.)
  if (hasMask) {
    const mask = new THREE.Mesh(new THREE.SphereGeometry(0.68, 16, 16), extremity);
    mask.position.set(0, 0.06, 0.56);
    mask.scale.set(0.98, 0.82, 0.58);
    headStatic.push(mask);
  }

  // Ears on pivots so they can flick/lag — big WIDE-BASED triangles whose
  // bases sink into the skull so they grow out of the silhouette instead of
  // sitting on it. The inner ear is a darker fur tone (the loud pink pockets
  // read wrong on the toy). Point cats darken at the ear tips.
  const earGeo = new THREE.ConeGeometry(0.56, 0.9, 6);
  const innerGeo = new THREE.ConeGeometry(0.28, 0.55, 6);
  const innerEarMat = hasMask ? extremity : (isTextured ? stripeMat : sharedMat(`cinner|${furHex}`, () => new THREE.MeshStandardMaterial({ color: pal.fur.clone().multiplyScalar(0.72), roughness: 0.92 })));
  const ears = {};
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.58, 0.5, -0.04); // base buried in the crown
    head.add(pivot);
    const ear = new THREE.Mesh(earGeo, extremity);
    ear.position.y = 0.4;
    ear.rotation.z = sx * -0.3; // tilted outward
    const inner = new THREE.Mesh(innerGeo, innerEarMat);
    inner.position.set(sx * 0.02, 0.38, 0.12);
    inner.rotation.z = sx * -0.3;
    pivot.add(mergeMeshes([ear, inner])); // one mesh per ear; the pivot flicks it
    ears[sx < 0 ? "L" : "R"] = pivot;
  }

  // Eyes — enormous painted eyeballs (iris + pupil + catch-lights baked into
  // the texture): together they span most of the face, resting right on top of
  // the muzzle. Merged into the head like the rest.
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.36, 18, 18), eyeballMat);
    eye.position.set(sx * 0.35, 0.14, 0.7);
    eye.scale.set(0.92, 1.16, 0.56); // tall ovals, gently bulging off the face
    eye.rotation.y = sx * 0.05;
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
    pivot.position.set(sx * 0.37, 0.5, 0.68); // top edge of the eye
    pivot.scale.y = 0;
    pivot.visible = false;
    const lid = new THREE.Mesh(new THREE.SphereGeometry(0.39, 14, 10), coat);
    lid.position.set(0, -0.38, 0.02); // centre hangs over the eyeball when scale.y = 1
    lid.scale.set(1.0, 1.12, 0.72);
    pivot.add(lid);
    head.add(pivot);
    eyelids.push(pivot);
  }

  // Muzzle: two big side-by-side white lobes spanning most of the lower face
  // (the "ω" cheeks of the reference toy), tucked right under the eyes, with a
  // small pink triangle nose where they meet. White, except solid coats (a
  // clean grey face shouldn't sprout a white snout).
  const muzMat = isSolid ? fur : white;
  for (const sx of [-1, 1]) {
    // Big puffy lobes — the muzzle dominates the lower half of the face and
    // pushes up between the eyes, like the toy.
    const lobe = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 14), muzMat);
    lobe.position.set(sx * 0.22, -0.3, 0.66);
    lobe.scale.set(1.0, 0.85, 0.62);
    headStatic.push(lobe);
  }
  // Nose: a small flat pink triangle FACING FORWARD (a squat 3-sided prism —
  // a down-pointing cone read as dark plum because its visible surface tilted
  // away from the light).
  const noseGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.06, 3);
  noseGeo.rotateX(Math.PI / 2); // axis along +z; the cross-section vertex swings to point DOWN
  const nose = new THREE.Mesh(noseGeo, pink);
  nose.position.set(0, -0.1, 0.97);
  headStatic.push(nose);
  // Chin puff nestled under the lobe seam — completes the toy's lower face.
  const chin = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 10), muzMat);
  chin.position.set(0, -0.52, 0.62);
  chin.scale.set(1.15, 0.75, 0.7);
  headStatic.push(chin);
  // The "ω" smile — both strokes baked into one LineSegments (4 points → 2 segs).
  const mouthGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, -0.22, 0.99), new THREE.Vector3(-0.15, -0.36, 0.92),
    new THREE.Vector3(0, -0.22, 0.99), new THREE.Vector3(0.15, -0.36, 0.92),
  ]);
  head.add(new THREE.LineSegments(mouthGeo, _cMouth));

  // Cool-cat sunglasses, hidden until the victory celebration drops them on.
  // The two lenses + bridge bake into one mesh; the group is what the rig
  // shows/slides on.
  const glasses = new THREE.Group();
  const shade = _cShade;
  const glassParts = [];
  for (const sx of [-1, 1]) {
    const lens = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.32, 0.06), shade);
    lens.position.set(sx * 0.37, 0.14, 0.92);
    glassParts.push(lens);
  }
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.08, 0.05), shade);
  bridge.position.set(0, 0.19, 0.92);
  glassParts.push(bridge);
  glasses.add(mergeMeshes(glassParts));
  glasses.visible = false;
  head.add(glasses);

  // Whiskers on pivots (sweep with cornering) — three real drooping strands
  // per side (thin curved tubes, not hairline screen-space lines), baked into
  // one mesh per side so each side stays a single draw.
  const whiskers = {};
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.3, -0.24, 0.88);
    head.add(pivot);
    const strands = [];
    for (const dy of [-0.08, 0.0, 0.08]) {
      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(0, dy * 0.4, 0),
        new THREE.Vector3(sx * 0.4, dy * 0.7 + 0.03, 0.05),
        new THREE.Vector3(sx * 0.7, dy - 0.07, 0.0)
      );
      strands.push(new THREE.Mesh(new THREE.TubeGeometry(curve, 6, 0.013, 5), white));
    }
    pivot.add(mergeMeshes(strands, { castShadow: false }));
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
    // forward-facing baseball cap — a deep dome hugging the crown (between the
    // ears) with a substantial curved brim over the brow, like the reference.
    const m = accMat(accCol);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.68, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), m);
    dome.position.set(0, 0.42, 0.04); dome.scale.set(1, 0.75, 1);
    acc.add(dome);
    const brim = new THREE.Mesh(rbox(0.76, 0.1, 0.58, 0.05), m);
    brim.position.set(0, 0.46, 0.66); // rear tucks under the dome, front juts over the brow
    brim.rotation.x = 0.1; // tips down a touch
    acc.add(brim);  } else if (accId === "headphones") {
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
  // Headwear coordinates were tuned for the old 0.78-radius skull; bake the
  // enlarged head's scale into each piece (a group scale would be lost when the
  // children are pushed into the merge bucket).
  const accToBody = accId === "bandana" || accId === "collar" || accId === "bow";
  if (!accToBody) {
    const HEAD_S = 1.26; // new skull radius 0.98 / old 0.78
    for (const ch of acc.children) {
      ch.position.multiplyScalar(HEAD_S);
      ch.scale.multiplyScalar(HEAD_S);
    }
  }
  (accToBody ? catStatic : headStatic).push(...acc.children);

  // Tail on a base pivot (sways + lifts) — fuller, and pattern-matched: tabby
  // rings up its length, a darker point tip on colour-point cats, a white tip on
  // tuxedos. A taper-radius function fattens the base and rounds the tip.
  const tailCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0.05, 0.4, -0.5),
    new THREE.Vector3(0.35, 1.0, -0.45),
    new THREE.Vector3(0.7, 1.45, -0.02),
  ]);
  const tail = new THREE.Mesh(new THREE.TubeGeometry(tailCurve, 28, 0.2, 10), tailCoat);
  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 0.6, -0.7);
  tailPivot.add(tail);
  // Tail tip cap: white for tuxedo, a dark tip for tabby/spotted coats, the
  // point colour for masked breeds, otherwise the coat colour.
  const tipMat = isTuxedo ? white : isTextured ? stripeMat : extremity;
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 12), tipMat);
  tip.position.copy(tailCurve.getPoint(1));
  tailPivot.add(tip);
  cat.add(tailPivot);

  // Bake the rigid clusters: the head cluster (skull/face/eyes/headwear) rides
  // with the head; the body cluster (torso/chest/neckwear) sits on the cat root.
  // Each becomes one multi-material mesh (one draw call per material).
  // Like the kart, the cat relies on the kart's contact blob rather than casting
  // into the sun shadow map — keeps the bunched-up field cheap.
  head.add(mergeMeshes(headStatic, { castShadow: false }));
  cat.add(mergeMeshes(catStatic, { castShadow: false }));

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
    },
  };
  return cat;
}

// Animates a cat rig with cornering physics. `lat` is the (signed) cornering
// intensity, `lon` the longitudinal acceleration; both roughly -1..1. The
// appendages lag and overshoot via simple spring-dampers so they whip around
// corners and flatten back under acceleration. `toot` lifts the tail.
// `celebrate` triggers the victory pose: sunglasses drop on and one paw pumps.
export function updateCatRig(rig, dt, lat, lon, toot = false, celebrate = false, allowBlink = false) {
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

  rig.earL.rotation.set(sp.earBack.a, 0, sp.earSway.a);
  rig.earR.rotation.set(sp.earBack.a, 0, sp.earSway.a);
  rig.whiskerL.rotation.y = sp.whisker.a;
  rig.whiskerR.rotation.y = sp.whisker.a;
  rig.tail.rotation.set(sp.tailX.a, sp.tailY.a, 0);
  rig.head.rotation.set(sp.headPitch.a, 0, sp.headLean.a);

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
  // seats correctly; the nose fairing, rear aero, tyres and roll-cage change
  // the profile). All four ride the same open-frame classic-kart base:
  //   gp        — the reference kart: long nose fairing, no wing, low slicks
  //   roadster  — shorter fairing, ducktail lip on the rear bumper
  //   buggy     — stubby fairing, fat tyres + a roll hoop
  //   speedster — longest fairing, low slicks, twin swept rocket tail-fins
  const STYLES = [
    { fair: 2.45, wing: "none", tire: 1.0, hoop: false },
    { fair: 2.1, wing: "lip", tire: 1.06, hoop: false },
    { fair: 1.8, wing: "none", tire: 1.2, hoop: true },
    { fair: 2.75, wing: "fin", tire: 0.94, hoop: false },
  ];
  const st = STYLES[opts.style ?? 0] || STYLES[0];
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
  // Shared constant materials (matte rubber + tread, chrome, dark trim, caliper).
  const dark = _kDark;
  const tire = _kTire;
  const tread = _kTread;
  const chrome = _kChrome;
  const rimMat = paintMat("rim", () => new THREE.MeshStandardMaterial({ color: body.clone().multiplyScalar(0.85), roughness: 0.35, metalness: 0.3 }));
  // Headlights glow much brighter at night (bloom picks them up). The intensity is
  // baked at creation from the current light level, so the level is in the key.
  const glass = sharedMat(`kglass|${_lightLevel}`, () => new THREE.MeshStandardMaterial({
    color: 0xfff4d0, emissive: 0xfff0c0, emissiveIntensity: 0.4 + _lightLevel * 2.3,
  }));

  // --- Open-frame classic kart ---
  // Every rigid, opaque body part is collected here and baked into ONE
  // multi-material mesh at the end (one draw call per material) instead of
  // ~25 separate meshes. Transparent/emissive/animated parts (number roundels,
  // headlight bulbs, tail lights, flames, underglow) stay separate below.
  // Layout (z+ forward): a low dark floor pan on exposed frame tubes, a wide
  // black wrap-around front bumper, a paint nose fairing rising to the wheel
  // with the number roundel on its face, side pods with a white lower band, a
  // black bucket seat, and an engine block + muffler behind the seat.
  const frame = sharedMat("kframe", () => new THREE.MeshStandardMaterial({ color: 0x878c94, roughness: 0.55, metalness: 0.35 }));
  const shell = [];
  const add = (mesh) => { shell.push(mesh); return mesh; };
  // Floor pan: low, flat, dark — the kart is built on it, not enclosed by it.
  const pan = add(new THREE.Mesh(rbox(1.9, 0.16, 3.7, 0.08), dark));
  pan.position.set(0, 0.42, 0.2);
  // Frame tubes: two side rails + front/rear cross members, visible under and
  // around the pan.
  for (const sx of [-1, 1]) {
    const rail = add(new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 4.3, 10), frame));
    rail.rotation.x = Math.PI / 2;
    rail.position.set(sx * 0.98, 0.38, 0.2);
  }
  for (const [cz, cw] of [[2.2, 2.0], [-1.62, 2.1]]) {
    const cross = add(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, cw, 10), frame));
    cross.rotation.z = Math.PI / 2;
    cross.position.set(0, 0.38, cz);
  }
  // Front steering gear: a kingpin + tie rod per side connecting the frame to
  // the front hubs — the exposed linkage that makes it read as a real kart.
  for (const sx of [-1, 1]) {
    const kingpin = add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.34, 8), frame));
    kingpin.position.set(sx * 1.02, 0.5, 1.62);
    const rod = add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.95, 8), frame));
    rod.rotation.z = Math.PI / 2;
    rod.rotation.y = sx * -0.25;
    rod.position.set(sx * 0.55, 0.42, 1.44);
  }
  // Front bumper: the wide black wrap bar with swept-back corner arms hugging
  // the nose, sitting low like the reference.
  const bumper = add(new THREE.Mesh(rbox(2.35, 0.32, 0.5, 0.24), dark));
  bumper.position.set(0, 0.46, 2.82);
  for (const sx of [-1, 1]) {
    // Straight side returns hugging the nose panel (angled arms read clunky).
    const arm = add(new THREE.Mesh(rbox(0.3, 0.3, 0.9, 0.15), dark));
    arm.position.set(sx * 1.03, 0.46, 2.42);
  }
  // Nose panel just behind the bar: white with a paint band over the top —
  // the reference's white/red front.
  const bPanel = add(new THREE.Mesh(rbox(1.7, 0.3, 0.72, 0.12), stripe));
  bPanel.position.set(0, 0.5, 2.32);
  const bBand = add(new THREE.Mesh(rbox(1.72, 0.16, 0.74, 0.07), paint));
  bBand.position.set(0, 0.64, 2.32);
  // Nose fairing: ONE moulded cowl sweeping from the bumper panel up to the
  // steering column — a rounded box tapered per-vertex (wide low front,
  // narrow raised rear) so it reads as a single smooth wedge, not stacked
  // slabs. Length varies by style.
  const fairGeo = rbox(1.0, 0.42, st.fair, 0.2);
  {
    const p = fairGeo.attributes.position;
    for (let v = 0; v < p.count; v++) {
      const t = p.getZ(v) / st.fair + 0.5; // 0 rear .. 1 front
      p.setX(v, p.getX(v) * (0.68 + t * 0.5)); // widen toward the front
      p.setY(v, p.getY(v) * (1 - t * 0.35)); // thin toward the front
    }
    fairGeo.computeVertexNormals();
  }
  const fairing = add(new THREE.Mesh(fairGeo, paint));
  fairing.position.set(0, 0.72, 1.98 - st.fair / 2);
  fairing.rotation.x = -0.2; // rises toward the column
  // White swoosh band across the cowl's low front (the reference livery).
  const swoosh = add(new THREE.Mesh(rbox(1.06, 0.18, 0.34, 0.06), stripe));
  swoosh.position.set(0, 0.6, 1.78);
  swoosh.rotation.x = -0.2;
  const numMat = sharedMat(`knum|${kartNumber}`, () =>
    new THREE.MeshStandardMaterial({ map: makeNumberTexture(kartNumber), transparent: true, roughness: 0.5 }));
  // Roundel lying on the fairing's tilted upper face, reading up-and-forward.
  const roundel = new THREE.Mesh(new THREE.PlaneGeometry(0.78, 0.78), numMat);
  roundel.position.set(0, 0.94, 1.95 - st.fair / 2 + 0.1);
  roundel.rotation.x = -Math.PI / 2 + 0.22;
  group.add(roundel);
  // Side pods: paint boxes between the wheels with a white lower band, plus a
  // numbered roundel facing outward (identifies rivals at a glance mid-race).
  for (const sx of [-1, 1]) {
    const pod = add(new THREE.Mesh(rbox(0.54, 0.36, 2.35, 0.17), paint));
    pod.position.set(sx * 1.08, 0.57, 0.1);
    const band = add(new THREE.Mesh(rbox(0.56, 0.16, 2.37, 0.08), stripe));
    band.position.set(sx * 1.08, 0.36, 0.1);
    const sideNum = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.56), numMat);
    sideNum.position.set(sx * 1.36, 0.6, 0.2);
    sideNum.rotation.y = sx * Math.PI / 2; // face outward (±X)
    group.add(sideNum);
  }
  // Bucket seat: base + tall leaned-back shell whose side wings wrap FORWARD
  // (attached flush to the back, not floating alongside). Glossier than the
  // matte trim — the reference seat reads as smooth moulded plastic.
  const seatMat = sharedMat("kseat", () => new THREE.MeshStandardMaterial({ color: 0x17181c, roughness: 0.32 }));
  const seatBase = add(new THREE.Mesh(rbox(1.1, 0.22, 1.05, 0.1), seatMat));
  seatBase.position.set(0, 0.64, -0.45);
  const seatBack = add(new THREE.Mesh(rbox(1.16, 1.08, 0.28, 0.14), seatMat));
  seatBack.position.set(0, 1.12, -1.02);
  seatBack.rotation.x = -0.14;
  for (const sx of [-1, 1]) {
    const wing = add(new THREE.Mesh(rbox(0.24, 0.72, 0.5, 0.12), seatMat));
    wing.position.set(sx * 0.55, 1.0, -0.86);
    wing.rotation.x = -0.14;
    wing.rotation.y = sx * -0.2; // curls forward around the driver
  }
  // Steering column rising from the fairing to the wheel; black wheel with a
  // chrome hub (position unchanged — the cat's paws grip exactly here).
  const column = add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.95, 10), frame));
  column.position.set(0, 1.05, 0.72);
  column.rotation.x = 0.5;
  const wheel = add(new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.09, 10, 18), dark));
  wheel.position.set(0, 1.4, 0.55);
  wheel.rotation.x = Math.PI / 2.6;
  const wheelHub = add(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.06, 12), dark));
  wheelHub.position.set(0, 1.4, 0.55);
  wheelHub.rotation.x = Math.PI / 2.6;
  // Three spokes in the (tilted) wheel plane.
  {
    const n = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2.6);
    const u = new THREE.Vector3(1, 0, 0);
    const v = new THREE.Vector3().crossVectors(n, u).normalize();
    const X = new THREE.Vector3(1, 0, 0);
    for (let k = 0; k < 3; k++) {
      const a = -Math.PI / 2 + (k * Math.PI * 2) / 3;
      const dir = u.clone().multiplyScalar(Math.cos(a)).addScaledVector(v, Math.sin(a));
      const spoke = add(new THREE.Mesh(rbox(0.3, 0.05, 0.06, 0.02), dark));
      spoke.position.set(0, 1.4, 0.55).addScaledVector(dir, 0.17);
      spoke.quaternion.setFromUnitVectors(X, dir);
    }
  }
  // Engine block on the right of the seat back with a FINNED cylinder head
  // (stacked cooling fins — the little detail that sells "engine"), an air
  // box, a visible rear axle, and a fat round-ended muffler on the left fed
  // by a curved header pipe — the classic kart's asymmetric rear.
  const block = add(new THREE.Mesh(rbox(0.62, 0.44, 0.62, 0.08), dark));
  block.position.set(0.52, 0.66, -1.62);
  for (let f = 0; f < 4; f++) {
    const fin = add(new THREE.Mesh(rbox(0.5 - f * 0.03, 0.05, 0.52 - f * 0.03, 0.02), frame));
    fin.position.set(0.52, 0.92 + f * 0.085, -1.62);
  }
  const airbox = add(new THREE.Mesh(rbox(0.3, 0.3, 0.3, 0.1), frame));
  airbox.position.set(0.16, 0.88, -1.92);
  // Rear axle tube spanning the frame behind the seat.
  const axle = add(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.5, 10), frame));
  axle.rotation.z = Math.PI / 2;
  axle.position.set(0, 0.64, -1.58);
  // Header pipe: a quarter-torus curving down-and-left out of the block into
  // the muffler's snout.
  const header = add(new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.055, 8, 10, Math.PI * 0.55), chrome));
  header.position.set(0.1, 0.68, -1.66);
  header.rotation.y = Math.PI / 2;
  header.rotation.x = Math.PI;
  // Muffler: a capsule (soft rounded ends like the toy) with a dark tip.
  const muffler = add(new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.66, 4, 12), chrome));
  muffler.rotation.x = Math.PI / 2;
  muffler.position.set(-0.62, 0.56, -1.95);
  const muffTip = add(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.07, 0.12, 10), dark));
  muffTip.rotation.x = Math.PI / 2;
  muffTip.position.set(-0.62, 0.56, -2.48);
  // Rear bumper bar.
  const rearBar = add(new THREE.Mesh(rbox(2.15, 0.22, 0.32, 0.11), dark));
  rearBar.position.set(0, 0.46, -2.35);

  // Rear aero varies by style (the reference GP kart runs clean — no wing).
  if (st.wing === "lip") {
    // Ducktail lip riding the rear bumper.
    const lip = add(new THREE.Mesh(rbox(1.9, 0.1, 0.46, 0.05), paint));
    lip.position.set(0, 0.72, -2.3);
    lip.rotation.x = -0.2;
  } else if (st.wing === "fin") {
    // Twin swept rocket tail-fins flanking the engine — jet-age speedster.
    for (const sx of [-1, 1]) {
      const fin = add(new THREE.Mesh(rbox(0.14, 0.85, 0.95, 0.06), paint));
      fin.position.set(sx * 0.78, 1.05, -1.95);
      fin.rotation.x = -0.34;
      fin.rotation.z = sx * 0.12;
      const edge = add(new THREE.Mesh(rbox(0.09, 0.15, 0.95, 0.04), accent));
      edge.position.set(sx * 0.78, 1.47, -1.95);
      edge.rotation.x = -0.34;
      edge.rotation.z = sx * 0.12;
    }
  }
  // Roll hoop (buggy): arcs over the seat back.
  if (st.hoop) {
    const hoop = add(new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.07, 10, 20, Math.PI), frame));
    hoop.position.set(0, 1.5, -1.05);
    const brace = add(new THREE.Mesh(rbox(0.1, 0.1, 0.85, 0.04), frame));
    brace.position.set(0, 1.25, -1.5);
    brace.rotation.x = 0.6;
  }

  // Bake the whole rigid shell into one mesh (≈6 draw calls — one per material).
  // Karts don't cast a real sun shadow: each already has a soft contact-shadow
  // blob (kart.js), so casting into the 2048 shadow map too just doubled the
  // field's vertex/fill cost when cars bunched up. The blob grounds them.
  const shellMesh = mergeMeshes(shell, { castShadow: false });
  group.add(shellMesh);

  // Headlights, tucked into the front bumper (tiny by day; night beams are a
  // ground-projected pool managed in main.js).
  for (const sx of [-1, 1]) {
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 12), glass);
    light.position.set(sx * 0.72, 0.54, 2.96);
    group.add(light);
  }
  // The forward beam that lights the road is NOT parented here (it would tilt with
  // the kart and clip the tarmac during drifts) — it's a ground-projected pool
  // managed per-frame in the main loop (see headlights in main.js).

  // Tail lights: a dim red glow normally, flaring bright when braking/reversing
  // (the kart updates brakeMat.emissiveIntensity). Shared material returned below.
  const brakeMat = new THREE.MeshStandardMaterial({
    color: 0x6e0d0d, emissive: 0xff2a1e, emissiveIntensity: 0.25, roughness: 0.5,
  });
  for (const sx of [-1, 1]) {
    const tl = new THREE.Mesh(rbox(0.36, 0.2, 0.14, 0.06), brakeMat);
    tl.position.set(sx * 0.78, 0.5, -2.46); // on the rear bumper bar
    group.add(tl);
  }

  // --- Wheels: fat matte slicks with a contact tread band and a plain flat
  // grey hub + small chrome cap (the reference kart's simple wheels). Rears
  // are bigger AND wider than the fronts; tyre size scales with the body
  // style. Each wheel's parts bake into ONE mesh inside a Group the kart
  // still spins/steers. ---
  const wheels = [];
  // `side` is the sign of the wheel's x position so the hub face sits on the
  // OUTER side (the visible one) on both sides of the kart.
  function buildWheel(radius, width, side) {
    const w = new THREE.Group();
    const parts = [];
    // The slick is a fat TORUS — soft rounded shoulders like the reference's
    // toy tyres (a cylinder's sharp edges read as cheese wheels). Ring+tube
    // sum to the rolling radius; the tube fills the width, leaving almost no
    // centre hole for the hub to cover.
    const tube = width * 0.5;
    const t = new THREE.Mesh(new THREE.TorusGeometry(radius - tube, tube, 12, 20), tire);
    t.rotation.y = Math.PI / 2; // torus axis along the axle (±X)
    parts.push(t);
    // Big flat grey hub disc on the outer face + a small chrome cap.
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.52, radius * 0.52, width * 0.36, 16), frame);
    hub.rotation.z = Math.PI / 2;
    hub.position.x = side * width * 0.36;
    parts.push(hub);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.18, radius * 0.18, 0.06, 12), chrome);
    cap.rotation.z = Math.PI / 2;
    cap.position.x = side * (width * 0.36 + width * 0.16);
    parts.push(cap);
    w.add(mergeMeshes(parts, { castShadow: false }));
    return w;
  }
  const wheelDefs = [
    [1.28, 1.62, 0.48, 0.42],
    [-1.28, 1.62, 0.48, 0.42],
    [1.38, -1.58, 0.66, 0.66],
    [-1.38, -1.58, 0.66, 0.66],
  ];
  for (const [x, z, baseR, width] of wheelDefs) {
    const radius = baseR * st.tire;
    const w = buildWheel(radius, width, Math.sign(x));
    w.position.set(x, radius, z); // centre at radius so the tyre sits on the ground
    group.add(w);
    wheels.push(w);
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
  for (const sx of [-0.6, 0.6]) {
    const outer = new THREE.Mesh(new THREE.ConeGeometry(0.3, 1.5, 8), flameOuter);
    outer.rotation.x = -Math.PI / 2; // taper trailing backward (-Z)
    outer.position.set(sx, 0.56, -2.85); // off the muffler / engine side
    flames.add(outer);
    const core = new THREE.Mesh(new THREE.ConeGeometry(0.16, 1.0, 8), flameCore);
    core.rotation.x = -Math.PI / 2;
    core.position.set(sx, 0.56, -2.65);
    flames.add(core);
  }
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

  return { group, wheels, brakeMat, flames };
}
