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
function mergeMeshes(meshes, { castShadow = false, receiveShadow = false } = {}) {
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
  cap: [0xe23b3b, 0x2f6fd6, 0x37b24d, 0x1a1a1a, 0xf5c518, 0xf0f0f0],       // team-cap colours
  headphones: [0x222831, 0xf0f0f0, 0xe23b3b, 0x2f6fd6, 0xff5fa2],         // gadget colours
  beanie: [0x3f7fd6, 0xe23b3b, 0x37b24d, 0x8a8f98, 0xff5fa2],             // knit colours
  flower: [0xff7ab3, 0xe23b3b, 0xffe14d, 0xa259ff, 0xf5f5f5],             // bloom colours
  fedora: [0x6b4a2f, 0x1a1a1a, 0x8a8f98, 0xcaa472],                       // felt-hat tones
  sunglasses: [0x0a0a0a, 0x5a3b1e, 0x2f6fd6, 0xe23b3b],                   // frame colours (black/tortoise/…)
  bandana: [0xd23b3b, 0x2f6fd6, 0x37b24d, 0x1a1a1a, 0xff8c1a],            // kerchief colours
  collar: [0xd23b3b, 0x2f6fd6, 0xff5fa2, 0x37b24d, 0x1a1a1a],            // collar colours
  bow: [0xff5fa2, 0xe23b3b, 0x2f6fd6, 0x1a1a1a, 0xa259ff, 0x18b6a6],      // bow-tie colours
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
const _coatTexCache = new Map();
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
  _coatTexCache.set(key, t);
  return t;
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
  _coatTexCache.set(key, t);
  return t;
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
  _coatTexCache.set(key, t);
  return t;
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
  _coatTexCache.set(key, t);
  return t;
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
  _coatTexCache.set(key, t);
  return t;
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
  _eyeTexCache.set(hex, t);
  return t;
}

// Constant cat materials — never vary per cat, so a single shared instance is
// reused by every driver (the toToon cache then collapses each to one pipeline).
const _cDark = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.5 });
const _cPink = new THREE.MeshStandardMaterial({ color: 0xff90ad, roughness: 0.6 });
const _cWhite = new THREE.MeshStandardMaterial({ color: 0xfbfbfb, roughness: 0.6 });
const _cWhisker = new THREE.LineBasicMaterial({ color: 0xf0f0f0 });
const _cMouth = new THREE.LineBasicMaterial({ color: 0x6b4a4a });
const _cShade = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.3, metalness: 0.4 });

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

  const fur = new THREE.MeshStandardMaterial({ color: pal.fur, roughness: 0.92 });
  const stripeMat = new THREE.MeshStandardMaterial({ color: pal.stripe, roughness: 0.92 });
  // Extremity fur: masked breeds darken at ears/mask/tail; everyone else reuses
  // the base coat.
  const extremity = colorExtremity
    ? new THREE.MeshStandardMaterial({ color: pal.point, roughness: 0.92 })
    : fur;
  const dark = _cDark;
  const pink = _cPink;
  const white = _cWhite;
  const pawMat = whitePaws ? white : isPoint ? extremity : fur;
  // Eyeball: one sphere with the iris/pupil/highlights painted on (see makeEyeTexture).
  const eyeballMat = new THREE.MeshStandardMaterial({ map: makeEyeTexture(pal.eye), roughness: 0.32 });
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
  const coat = isTextured
    ? new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, map: coatTex(false) })
    : fur;
  const tailCoat = isTextured
    ? new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, map: coatTex(true) })
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
  const chestMat = (isSolid || isTortie) ? fur : white;
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.62, 16, 16), chestMat);
  chest.position.set(0, 0.78, 0.57);
  chest.scale.set(hasBib ? 0.98 : 0.86, hasBib ? 1.14 : 1.04, hasBib ? 0.62 : 0.54);
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
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.6, 4, 10), pawMat);
    arm.position.set(0, 0, 0.15);
    arm.rotation.x = -1.0;
    parts.push(arm);
    const paw = new THREE.Mesh(new THREE.SphereGeometry(0.21, 12, 12), pawMat);
    paw.position.set(0, 0.15, 0.52);
    paw.scale.set(1, 0.82, 1.05);
    parts.push(paw);
    // Toe-bean detail: three little dark pads on the front of each paw.
    for (const tx of [-0.07, 0, 0.07]) {
      const bean = new THREE.Mesh(new THREE.SphereGeometry(0.032, 6, 6), pink);
      bean.position.set(tx, 0.1, 0.7);
      parts.push(bean);
    }
    pivot.add(mergeMeshes(parts)); // one mesh per arm; the pivot still pumps it
    arms[sx < 0 ? "L" : "R"] = pivot;
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
  const earGeo = new THREE.ConeGeometry(0.35, 0.66, 6);
  const innerGeo = new THREE.ConeGeometry(0.19, 0.4, 6);
  const ears = {};
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.46, 0.52, -0.02);
    head.add(pivot);
    const ear = new THREE.Mesh(earGeo, extremity);
    ear.position.y = 0.3;
    ear.rotation.z = sx * -0.22;
    const inner = new THREE.Mesh(innerGeo, pink);
    inner.position.set(0, 0.27, 0.07);
    inner.rotation.z = sx * -0.22;
    pivot.add(mergeMeshes([ear, inner])); // one mesh per ear; the pivot flicks it
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
    const lid = new THREE.Mesh(new THREE.SphereGeometry(0.26, 14, 10), coat);
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
  nose.position.set(0, -0.08, 0.94);
  headStatic.push(nose);
  // The "ω" smile — both strokes baked into one LineSegments (4 points → 2 segs).
  const mouthGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, -0.16, 0.92), new THREE.Vector3(-0.12, -0.26, 0.86),
    new THREE.Vector3(0, -0.16, 0.92), new THREE.Vector3(0.12, -0.26, 0.86),
  ]);
  head.add(new THREE.LineSegments(mouthGeo, _cMouth));

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
  glasses.add(mergeMeshes(glassParts));
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
    const pts = [];
    for (const dy of [-0.08, 0.0, 0.08]) {
      pts.push(new THREE.Vector3(0, dy * 0.4, 0), new THREE.Vector3(sx * 0.75, dy, 0.05));
    }
    pivot.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), whiskerMat));
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
  const accColDark = new THREE.Color(accCol).multiplyScalar(0.8).getHex(); // shade for knots/accents
  const accMat = (hex, r = 0.6, m = 0) => new THREE.MeshStandardMaterial({ color: hex, roughness: r, metalness: m });
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
    const m = accMat(accCol, 0.22, 0.5);
    for (const sx of [-1, 1]) {
      const lens = new THREE.Mesh(rbox(0.44, 0.34, 0.06, 0.06), m);
      lens.position.set(sx * 0.34, 0.1, 0.84); lens.rotation.z = sx * -0.08; // slight wayfarer cant
      acc.add(lens);
      const armg = new THREE.Mesh(rbox(0.66, 0.05, 0.05, 0.02), m);
      // hinged at the lens's outer-top corner (x0.56, z0.84), running back to the
      // ear (x0.72, z0.20) — the whole arm stays at x >= 0.56, clear of the eye.
      armg.position.set(sx * 0.64, 0.17, 0.52); armg.rotation.y = sx * 1.33;
      acc.add(armg);
    }
    const bridge = new THREE.Mesh(rbox(0.3, 0.08, 0.05, 0.02), m);
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
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.86, side: THREE.DoubleSide, map: makeBandanaTexture(accCol, rx, ry) });
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
      loop.position.set(sx * 0.26, 1.5, 0.92); loop.scale.set(1.0, 0.66, 0.42);
      acc.add(loop);
    }
    const knot = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 10), accMat(accColDark));
    knot.position.set(0, 1.5, 0.98); acc.add(knot);  }
  // Headwear / eyewear ride with the head; neckwear (bandana, collar, bow tie) sits
  // on the body. `acc` is at the origin, so its children's transforms already read
  // in the right frame — route them into the matching static bucket to merge.
  const accToBody = accId === "bandana" || accId === "collar" || accId === "bow";
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
const _kDark = new THREE.MeshStandardMaterial({ color: 0x1c1c20, roughness: 0.6 });
const _kTire = new THREE.MeshStandardMaterial({ color: 0x16161a, roughness: 1.0, metalness: 0.0 });
const _kTread = new THREE.MeshStandardMaterial({ color: 0x0e0e12, roughness: 1.0, metalness: 0.0 });
const _kChrome = new THREE.MeshStandardMaterial({ color: 0xd2dadf, metalness: 0.9, roughness: 0.22 });
const _kCaliper = new THREE.MeshStandardMaterial({ color: 0xcf3a2e, metalness: 0.3, roughness: 0.4 });

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
  const STYLES = [
    { nose: 1.7, noseZ: 2.0, tipZ: 2.95, wing: "big", tire: 1.0, hoop: false },
    { nose: 1.25, noseZ: 1.85, tipZ: 2.6, wing: "lip", tire: 1.06, hoop: false },
    { nose: 1.0, noseZ: 1.75, tipZ: 2.45, wing: "none", tire: 1.2, hoop: true },
    { nose: 1.95, noseZ: 2.15, tipZ: 3.2, wing: "fin", tire: 0.94, hoop: false },
  ];
  const st = STYLES[opts.style ?? 0] || STYLES[0];
  const kartNumber = opts.number ?? 1;
  // Soft "toy gloss" — a gentle sheen, not a mirror (the toon spec is keyed off
  // userData.paint). Accent is a darker shade of the same hue; the stripe is a
  // near-white tint so the livery reads on dark and light bodies alike.
  const paint = new THREE.MeshStandardMaterial({ color: body.clone(), roughness: 0.34, metalness: 0.0 });
  paint.userData.paint = true;
  const accent = new THREE.MeshStandardMaterial({ color: body.clone().multiplyScalar(0.55), roughness: 0.38, metalness: 0.0 });
  accent.userData.paint = true;
  // Painted racing stripe: crisp white on dark/medium bodies, a deep charcoal on
  // very light bodies, so the stripe always reads as deliberate paint.
  const bodyL = 0.2126 * body.r + 0.7152 * body.g + 0.0722 * body.b;
  const stripeCol = bodyL > 0.62 ? new THREE.Color(0x2c2a27) : new THREE.Color(0xf3efe6);
  const stripe = new THREE.MeshStandardMaterial({ color: stripeCol, roughness: 0.4, metalness: 0.0 });
  stripe.userData.paint = true;
  // Shared constant materials (matte rubber + tread, chrome, dark trim, caliper).
  const dark = _kDark;
  const tire = _kTire;
  const tread = _kTread;
  const chrome = _kChrome;
  const rimMat = new THREE.MeshStandardMaterial({ color: body.clone().multiplyScalar(0.85), roughness: 0.35, metalness: 0.3 });
  rimMat.userData.paint = true;
  // Headlights glow much brighter at night (bloom picks them up).
  const glass = new THREE.MeshStandardMaterial({
    color: 0xfff4d0, emissive: 0xfff0c0, emissiveIntensity: 0.4 + _lightLevel * 2.3,
  });

  // --- Moulded shell ---
  // Every rigid, opaque body part is collected here and baked into ONE
  // multi-material mesh at the end (one draw call per livery material) instead of
  // ~25 separate meshes. Transparent/emissive/animated parts (number roundels,
  // headlight bulbs, tail lights, flames, underglow) stay separate below.
  const shell = [];
  const add = (mesh) => { shell.push(mesh); return mesh; };
  // Floor pan: the wide, low monocoque the whole car is built on.
  const pan = add(new THREE.Mesh(rbox(2.55, 0.42, 4.7, 0.3), paint));
  pan.position.y = 0.56;
  // Lower accent skirt (two-tone) — slightly wider + darker, hugging the ground.
  const skirt = add(new THREE.Mesh(rbox(2.66, 0.3, 4.3, 0.22), accent));
  skirt.position.y = 0.36;
  // Cockpit spine: the raised centre body that the seat sinks into.
  const spine = add(new THREE.Mesh(rbox(1.6, 0.78, 3.1, 0.34), paint));
  spine.position.set(0, 0.92, -0.25);
  // Nose: a single tapering wedge flowing off the front of the pan + soft tip.
  // Length/reach vary by style (long GP snout vs stubby buggy).
  const nose = add(new THREE.Mesh(rbox(1.7, 0.46, st.nose, 0.3), paint));
  nose.position.set(0, 0.62, st.noseZ);
  const noseTip = add(new THREE.Mesh(rbox(1.16, 0.42, 1.2, 0.42), paint));
  noseTip.position.set(0, 0.58, st.tipZ);
  // Nose flash (accent) over the snout.
  const flash = add(new THREE.Mesh(rbox(0.95, 0.2, 1.5, 0.12), accent));
  flash.position.set(0, 0.84, st.noseZ + 0.6);
  // Side fairings — flush to the floor sides, same paint: bodywork, not pods. A
  // numbered roundel sits on each side (a plane decal facing outward).
  const numTex = makeNumberTexture(kartNumber);
  const numMat = new THREE.MeshStandardMaterial({ map: numTex, transparent: true, roughness: 0.5 });
  for (const sx of [-1, 1]) {
    const fairing = add(new THREE.Mesh(rbox(0.62, 0.5, 2.7, 0.26), paint));
    fairing.position.set(sx * 1.2, 0.64, 0.0);
    const roundel = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.62), numMat);
    roundel.position.set(sx * 1.53, 0.8, 0.1);
    roundel.rotation.y = sx * Math.PI / 2; // face outward (±X)
    group.add(roundel);
  }
  // Painted racing stripe — flat decals lying flush on the nose flash panel and
  // the rear deck (zero thickness, a hair proud), so it reads as paint on the
  // bodywork rather than a raised block bolted on top.
  const noseStripe = add(new THREE.Mesh(new THREE.PlaneGeometry(0.42, 1.5), stripe));
  noseStripe.rotation.x = -Math.PI / 2;
  noseStripe.position.set(0, 0.951, st.noseZ + 0.6); // flush on the nose flash
  const deckStripe = add(new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.95), stripe));
  deckStripe.rotation.x = -Math.PI / 2;
  deckStripe.position.set(0, 1.122, -1.95); // flush on the rear deck

  // Seat well (where the cat sits) — sunk into the spine.
  const seat = add(new THREE.Mesh(rbox(1.5, 0.66, 1.5, 0.28), dark));
  seat.position.set(0, 1.06, -0.5);
  const seatBack = add(new THREE.Mesh(rbox(1.4, 0.9, 0.4, 0.18), dark));
  seatBack.position.set(0, 1.3, -1.2);

  // Steering wheel (black) with a small chrome hub.
  const wheel = add(new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.07, 10, 18), dark));
  wheel.position.set(0, 1.4, 0.55);
  wheel.rotation.x = Math.PI / 2.6;
  const wheelHub = add(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.05, 12), chrome));
  wheelHub.position.set(0, 1.4, 0.55);
  wheelHub.rotation.x = Math.PI / 2.6;

  // Rear deck behind the cockpit, housing the tail lights + a single wing pylon.
  const deck = add(new THREE.Mesh(rbox(1.7, 0.5, 1.0, 0.26), paint));
  deck.position.set(0, 0.86, -1.95);

  // Rear aero varies by style: a big winged GP, a low ducktail lip, or none.
  if (st.wing === "big") {
    const pylon = add(new THREE.Mesh(rbox(0.34, 0.7, 0.34, 0.1), dark));
    pylon.position.set(0, 1.25, -2.3);
    const wing = add(new THREE.Mesh(rbox(2.7, 0.14, 0.74, 0.06), paint));
    wing.position.set(0, 1.62, -2.32);
    for (const sx of [-1, 1]) {
      const plate = add(new THREE.Mesh(rbox(0.08, 0.36, 0.78, 0.03), accent));
      plate.position.set(sx * 1.32, 1.55, -2.32);
    }
  } else if (st.wing === "lip") {
    // Ducktail lip spoiler hugging the rear deck.
    const lip = add(new THREE.Mesh(rbox(2.0, 0.12, 0.5, 0.06), paint));
    lip.position.set(0, 1.18, -2.3);
    lip.rotation.x = -0.18;
  } else if (st.wing === "fin") {
    // Twin swept rocket tail-fins flanking the rear deck (body paint, accent edge),
    // plus a small central spine fin — a jet-age speedster look.
    for (const sx of [-1, 1]) {
      const fin = add(new THREE.Mesh(rbox(0.16, 0.98, 1.05, 0.06), paint));
      fin.position.set(sx * 0.72, 1.34, -2.18);
      fin.rotation.x = -0.34; // rake the fin back
      fin.rotation.z = sx * 0.12; // splay outward a touch
      const edge = add(new THREE.Mesh(rbox(0.1, 0.16, 1.05, 0.04), accent));
      edge.position.set(sx * 0.72, 1.82, -2.18);
      edge.rotation.x = -0.34;
      edge.rotation.z = sx * 0.12;
    }
    const spineFin = add(new THREE.Mesh(rbox(0.12, 0.62, 0.86, 0.05), accent));
    spineFin.position.set(0, 1.2, -2.24);
    spineFin.rotation.x = -0.32;
  }

  // --- Greebles: chrome roll hoop (buggy) + twin exhaust tips (all) ---
  if (st.hoop) {
    const hoop = add(new THREE.Mesh(new THREE.TorusGeometry(0.66, 0.08, 10, 20, Math.PI), chrome));
    hoop.position.set(0, 1.32, -1.15);
    // little diagonal brace behind it
    const brace = add(new THREE.Mesh(rbox(0.12, 0.12, 0.9, 0.05), chrome));
    brace.position.set(0, 1.0, -1.55);
    brace.rotation.x = 0.6;
  }
  for (const sx of [-0.42, 0.42]) {
    const pipe = add(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.6, 12), chrome));
    pipe.rotation.x = Math.PI / 2; // axis along Z, poking out the back
    pipe.position.set(sx, 0.58, -2.62);
    const pipeTip = add(new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.1, 0.12, 12), dark));
    pipeTip.rotation.x = Math.PI / 2;
    pipeTip.position.set(sx, 0.58, -2.92);
  }

  // Bake the whole rigid shell into one mesh (≈5 draw calls — one per material).
  // Karts don't cast a real sun shadow: each already has a soft contact-shadow
  // blob (kart.js), so casting into the 2048 shadow map too just doubled the
  // field's vertex/fill cost when cars bunched up. The blob grounds them.
  const shellMesh = mergeMeshes(shell, { castShadow: false });
  group.add(shellMesh);

  // Headlights, set into the nose.
  for (const sx of [-1, 1]) {
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 12), glass);
    light.position.set(sx * 0.46, 0.66, 2.92);
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
    const tl = new THREE.Mesh(rbox(0.4, 0.26, 0.16, 0.06), brakeMat);
    tl.position.set(sx * 0.62, 0.86, -2.46);
    group.add(tl);
  }

  // --- Wheels: matte tyres with a contact tread band, a spoked body-coloured
  // rim + chrome hub cap, and a brake caliper at the rim. Fronts a touch smaller
  // than the rears; tyre size scales with the body style. Each wheel's parts are
  // baked into ONE mesh (≈5 draw calls) inside a Group the kart still spins/steers. ---
  const caliperMat = _kCaliper;
  const wheels = [];
  // `side` is the sign of the wheel's x position so the spokes / hub cap sit on
  // the OUTER face (the visible one) on both sides of the kart.
  function buildWheel(radius, side) {
    const w = new THREE.Group();
    const parts = [];
    const t = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.5, 22), tire);
    t.rotation.z = Math.PI / 2;
    parts.push(t);
    // A slightly proud, slightly wider tread band around the centre.
    const band = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.02, radius * 1.02, 0.34, 22), tread);
    band.rotation.z = Math.PI / 2;
    parts.push(band);
    // Hub + 5 spokes on the outer face.
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.26, radius * 0.26, 0.54, 12), rimMat);
    hub.rotation.z = Math.PI / 2;
    parts.push(hub);
    // 5 spokes spaced around the axle. The old per-spoke pivot Group orbited the
    // spoke's y-offset about the X axle; bake that orbit straight into each spoke's
    // own transform so they all merge into the single wheel mesh.
    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2;
      const spoke = new THREE.Mesh(rbox(0.1, radius * 0.66, 0.1, 0.03), rimMat);
      spoke.rotation.x = ang;
      spoke.position.set(side * 0.24, Math.cos(ang) * radius * 0.36, Math.sin(ang) * radius * 0.36);
      parts.push(spoke);
    }
    const cap = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.24, 12, 12), chrome);
    cap.position.x = side * 0.26;
    cap.scale.set(0.5, 1, 1);
    parts.push(cap);
    // Brake caliper clamped on the inner-upper rim.
    const caliper = new THREE.Mesh(rbox(0.16, 0.24, 0.18, 0.04), caliperMat);
    caliper.position.set(-side * 0.12, radius * 0.62, 0.02);
    parts.push(caliper);
    w.add(mergeMeshes(parts, { castShadow: false }));
    return w;
  }
  const wheelDefs = [
    [1.32, 1.55, 0.55],
    [-1.32, 1.55, 0.55],
    [1.42, -1.6, 0.66],
    [-1.42, -1.6, 0.66],
  ];
  for (const [x, z, baseR] of wheelDefs) {
    const radius = baseR * st.tire;
    const w = buildWheel(radius, Math.sign(x));
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
  for (const sx of [-0.7, 0.7]) {
    const outer = new THREE.Mesh(new THREE.ConeGeometry(0.3, 1.5, 8), flameOuter);
    outer.rotation.x = -Math.PI / 2; // taper trailing backward (-Z)
    outer.position.set(sx, 0.55, -2.7);
    flames.add(outer);
    const core = new THREE.Mesh(new THREE.ConeGeometry(0.16, 1.0, 8), flameCore);
    core.rotation.x = -Math.PI / 2;
    core.position.set(sx, 0.55, -2.5);
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
