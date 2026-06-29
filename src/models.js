import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

// Rounded box helper — the workhorse of the soft, toy-like art direction. Edges
// are chamfered by `r` (auto-clamped so it never exceeds half the smallest side).
function rbox(w, h, d, r = 0.18, seg = 4) {
  const radius = Math.min(r, w / 2, h / 2, d / 2) * 0.98;
  return new RoundedBoxGeometry(w, h, d, seg, radius);
}

// How lit-up the karts are, from the world's time of day: 0 = midday (off),
// ~0.55 = sunset/dusk (warm, dimmer), 1 = night (full). Drives the glow of the
// headlight bulbs; the underglow stays a night-only effect. Set once before karts
// are built.
let _lightLevel = 0;
export function setLightLevel(v) {
  _lightLevel = Math.max(0, Math.min(1, v || 0));
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

function _finishTex(c, rx, ry) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.magFilter = THREE.NearestFilter; // crisp painted edges, no blur
  t.needsUpdate = true;
  return t;
}
// Painted tabby coat: bold mackerel stripes baked into a texture. `axis` "u"
// draws stripes that run DOWN the flanks (vertical, the classic tabby look on
// the body/head); "v" draws rings around the tail. The stripes are slightly
// broken/irregular so they read organic rather than like a barcode.
function makeStripeTexture(furColor, stripeColor, count, axis = "u") {
  const c = document.createElement("canvas");
  c.width = 96; c.height = 96;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#" + furColor.getHexString();
  ctx.fillRect(0, 0, 96, 96);
  ctx.fillStyle = "#" + stripeColor.getHexString();
  // 4 bars across the tile, each broken into 2-3 dashes with a little jitter so
  // the stripes look hand-painted; tiled `count` times around/along the surface.
  for (let i = 0; i < 4; i++) {
    const x = 6 + i * 24 + (i % 2 ? 3 : -3);
    const w = 9 + (i % 2 ? 2 : 0);
    const segs = i % 2 ? [[2, 40], [48, 44]] : [[0, 30], [36, 30], [70, 26]];
    for (const [y, h] of segs) ctx.fillRect(x, y, w, h);
  }
  return axis === "v" ? _finishTex(c, 1, count) : _finishTex(c, count, 1);
}
// Painted spotted/rosetted coat (ocicat / spotted tabby): scattered dark blobs.
function makeSpotTexture(furColor, spotColor, count = 4) {
  const c = document.createElement("canvas");
  c.width = 96; c.height = 96;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#" + furColor.getHexString();
  ctx.fillRect(0, 0, 96, 96);
  ctx.fillStyle = "#" + spotColor.getHexString();
  // a fixed scatter (deterministic) of rounded spots, varied in size
  const spots = [
    [16, 14, 8], [40, 22, 6], [66, 12, 9], [86, 30, 6],
    [10, 42, 7], [34, 52, 9], [58, 44, 7], [80, 58, 8],
    [20, 72, 8], [46, 82, 7], [70, 80, 9], [90, 70, 6],
  ];
  for (const [x, y, r] of spots) {
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 1.25, 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  return _finishTex(c, count, count);
}

// Builds a low-poly cat sitting upright (the driver). Returns a Group whose
// origin sits at the seat base. `furColor` tints the fur; `opts.pattern` can
// force a markings template (else it's derived from the colour). The returned
// group's userData.rig holds pivots (ears, whiskers, tail, head) that
// updateCatRig() animates with cornering physics.
export function createCat(furColor = 0xf0a830, opts = {}) {
  const cat = new THREE.Group();
  const pal = catPalette(furColor, opts.pattern);
  const pat = pal.pattern;
  const isTabby = pat === "tabby";
  const isSpotted = pat === "spotted";
  const isTextured = isTabby || isSpotted;     // coat carries a painted pattern
  const isTuxedo = pat === "tuxedo";
  const isMitted = pat === "mitted";
  const isSolid = pat === "solid";
  const isPoint = pat === "point";
  const isSnow = pat === "snowshoe";
  const hasMask = isPoint || isSnow;           // dark face mask + colour points
  const hasBib = isTuxedo || isMitted;         // big white chest
  const whitePaws = isTuxedo || isMitted || isSnow;
  const colorExtremity = isPoint || isSnow;    // ears/mask/tail take the point colour

  const fur = new THREE.MeshStandardMaterial({ color: pal.fur, roughness: 0.92 });
  const stripeMat = new THREE.MeshStandardMaterial({ color: pal.stripe, roughness: 0.92 });
  // Extremity fur: masked breeds darken at ears/mask/tail; everyone else reuses
  // the base coat.
  const extremity = colorExtremity
    ? new THREE.MeshStandardMaterial({ color: pal.point, roughness: 0.92 })
    : fur;
  const dark = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.5 });
  const pink = new THREE.MeshStandardMaterial({ color: 0xff90ad, roughness: 0.6 });
  const white = new THREE.MeshStandardMaterial({ color: pal.white, roughness: 0.6 });
  const pawMat = whitePaws ? white : isPoint ? extremity : fur;
  const iris = new THREE.MeshStandardMaterial({
    color: pal.eye, emissive: pal.eye.clone().multiplyScalar(0.25), emissiveIntensity: 0.4, roughness: 0.25,
  });
  // Painted coat: vertical mackerel stripes down the flanks (tabby) or scattered
  // spots (spotted), baked into the fur so the markings read as bold and graphic.
  // The tail gets rings (stripes wrapped the other way). Flat for everyone else.
  function coatTex(forTail) {
    if (isTabby) return makeStripeTexture(pal.fur, pal.stripe, forTail ? 7 : 7, forTail ? "v" : "u");
    if (isSpotted) return makeSpotTexture(pal.fur, pal.stripe, forTail ? 4 : 3);
    return null;
  }
  const coat = isTextured
    ? new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, map: coatTex(false) })
    : fur;
  const tailCoat = isTextured
    ? new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, map: coatTex(true) })
    : extremity;

  // Body (sitting torso) — painted pattern for tabbies/spotted cats.
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.9, 0.78, 6, 16), coat);
  body.position.y = 1.0;
  body.castShadow = true;
  cat.add(body);

  // Chest + belly fluff. Tuxedo/mitten cats get a big white bib; solid coats keep
  // the body colour (no bib); others get a soft pale chest.
  const chestMat = isSolid ? fur : white;
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.62, 16, 16), chestMat);
  chest.position.set(0, 0.78, 0.57);
  chest.scale.set(hasBib ? 0.98 : 0.86, hasBib ? 1.14 : 1.04, hasBib ? 0.62 : 0.54);
  cat.add(chest);

  // Front paws on the wheel. Each arm hangs off a shoulder pivot so it can be
  // raised for a victory fist-pump; at rest (pivot identity) the pose is
  // unchanged from before. Mitten/tuxedo cats get white "socks".
  const arms = {};
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.5, 1.05, 0.45);
    cat.add(pivot);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.6, 4, 10), pawMat);
    arm.position.set(0, 0, 0.15);
    arm.rotation.x = -1.0;
    pivot.add(arm);
    const paw = new THREE.Mesh(new THREE.SphereGeometry(0.21, 12, 12), pawMat);
    paw.position.set(0, 0.15, 0.52);
    paw.scale.set(1, 0.82, 1.05);
    pivot.add(paw);
    // Toe-bean detail: three little dark pads on the front of each paw.
    for (const tx of [-0.07, 0, 0.07]) {
      const bean = new THREE.Mesh(new THREE.SphereGeometry(0.032, 6, 6), pink);
      bean.position.set(tx, 0.1, 0.7);
      pivot.add(bean);
    }
    arms[sx < 0 ? "L" : "R"] = pivot;
  }

  // --- Head (animated for lean/pitch) — a touch bigger for a cuter ratio ---
  const head = new THREE.Group();
  head.position.set(0, 2.06, 0.12);
  cat.add(head);

  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.78, 20, 20), coat);
  skull.scale.set(1.04, 0.98, 0.96);
  skull.castShadow = true;
  head.add(skull);
  // Masked breeds (Siamese point / snowshoe): a dark mask across the eyes +
  // muzzle bridge. The white cheeks/muzzle below and the eyes on top leave a
  // band of colour around the eyes — the signature masked face. (Tabby/spotted
  // head markings come from the painted coat.)
  if (hasMask) {
    const mask = new THREE.Mesh(new THREE.SphereGeometry(0.54, 16, 16), extremity);
    mask.position.set(0, 0.02, 0.46);
    mask.scale.set(0.96, 0.84, 0.6);
    head.add(mask);
  }
  // Cheeks — fuller floof for a rounder face. White, except solid coats keep the
  // body colour so the face isn't oddly two-toned.
  const cheekMat = isSolid ? fur : white;
  for (const sx of [-1, 1]) {
    const cheek = new THREE.Mesh(new THREE.SphereGeometry(0.38, 14, 14), cheekMat);
    cheek.position.set(sx * 0.36, -0.18, 0.52);
    cheek.scale.set(0.95, 0.74, 0.72);
    head.add(cheek);
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
    ear.castShadow = true;
    pivot.add(ear);
    const inner = new THREE.Mesh(innerGeo, pink);
    inner.position.set(0, 0.27, 0.07);
    inner.rotation.z = sx * -0.22;
    pivot.add(inner);
    ears[sx < 0 ? "L" : "R"] = pivot;
  }

  // Eyes — bigger and glossier, with a double catch-light for life. A vertical
  // slit pupil and a warm/green iris read as "cat" instantly.
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.23, 16, 16), iris);
    eye.position.set(sx * 0.31, 0.1, 0.6);
    eye.scale.set(0.96, 1.12, 0.7);
    head.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 12), dark);
    pupil.position.set(sx * 0.31, 0.1, 0.74);
    pupil.scale.set(0.42, 1.05, 1);
    head.add(pupil);
    const shine = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), white);
    shine.position.set(sx * 0.37, 0.2, 0.78);
    head.add(shine);
    const shine2 = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 6), white);
    shine2.position.set(sx * 0.26, 0.02, 0.78);
    head.add(shine2);
  }

  // Muzzle + nose + a tiny "ω" smile. White, except solid coats (a clean grey
  // face shouldn't sprout a white snout).
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.34, 14, 14), isSolid ? fur : white);
  muzzle.position.set(0, -0.2, 0.66);
  muzzle.scale.set(1.12, 0.7, 0.62);
  head.add(muzzle);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.11, 6), pink);
  nose.rotation.x = Math.PI;
  nose.position.set(0, -0.08, 0.94);
  head.add(nose);
  const mouthMat = new THREE.LineBasicMaterial({ color: 0x6b4a4a });
  for (const sx of [-1, 1]) {
    const g = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, -0.16, 0.92),
      new THREE.Vector3(sx * 0.12, -0.26, 0.86),
    ]);
    head.add(new THREE.Line(g, mouthMat));
  }

  // Cool-cat sunglasses, hidden until the victory celebration drops them on.
  const glasses = new THREE.Group();
  const shade = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.3, metalness: 0.4 });
  for (const sx of [-1, 1]) {
    const lens = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.24, 0.06), shade);
    lens.position.set(sx * 0.3, 0.12, 0.64);
    glasses.add(lens);
  }
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.07, 0.05), shade);
  bridge.position.set(0, 0.16, 0.64);
  glasses.add(bridge);
  glasses.visible = false;
  head.add(glasses);

  // Whiskers on pivots (sweep with cornering)
  const whiskerMat = new THREE.LineBasicMaterial({ color: 0xf0f0f0 });
  const whiskers = {};
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.18, -0.12, 0.78);
    head.add(pivot);
    for (const dy of [-0.08, 0.0, 0.08]) {
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, dy * 0.4, 0),
        new THREE.Vector3(sx * 0.75, dy, 0.05),
      ]);
      pivot.add(new THREE.Line(g, whiskerMat));
    }
    whiskers[sx < 0 ? "L" : "R"] = pivot;
  }

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
  tail.castShadow = true;
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
export function updateCatRig(rig, dt, lat, lon, toot = false, celebrate = false) {
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
}

// Builds a chunky go-kart as ONE cohesive moulded shell (floor pan → cockpit
// spine → tapering nose → rear deck, with the side fairings flush to the body
// rather than bolted-on pods). A two-tone livery — body colour, a darker accent
// on the lower skirt/nose, a light centre racing stripe, and a number roundel —
// gives each kart its own paint without needing per-kart art. Returns
// { group, wheels, brakeMat, flames }.
export function createKartModel(bodyColor = 0xe53935) {
  const group = new THREE.Group();
  const body = new THREE.Color(bodyColor);
  // Soft "toy gloss" — a gentle sheen, not a mirror (the toon spec is keyed off
  // userData.paint). Accent is a darker shade of the same hue; the stripe is a
  // near-white tint so the livery reads on dark and light bodies alike.
  const paint = new THREE.MeshStandardMaterial({ color: body.clone(), roughness: 0.34, metalness: 0.0 });
  paint.userData.paint = true;
  const accent = new THREE.MeshStandardMaterial({ color: body.clone().multiplyScalar(0.55), roughness: 0.38, metalness: 0.0 });
  accent.userData.paint = true;
  const stripeCol = body.clone().lerp(new THREE.Color(0xffffff), 0.78);
  const stripe = new THREE.MeshStandardMaterial({ color: stripeCol, roughness: 0.32, metalness: 0.0 });
  stripe.userData.paint = true;
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c1c20, roughness: 0.6 });
  // Matte rubber: fully rough, no metalness, a hair warm-black for depth.
  const tire = new THREE.MeshStandardMaterial({ color: 0x16161a, roughness: 1.0, metalness: 0.0 });
  const tread = new THREE.MeshStandardMaterial({ color: 0x0e0e12, roughness: 1.0, metalness: 0.0 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xd2dadf, metalness: 0.9, roughness: 0.22 });
  const rimMat = new THREE.MeshStandardMaterial({ color: body.clone().multiplyScalar(0.85), roughness: 0.35, metalness: 0.3 });
  rimMat.userData.paint = true;
  const decal = new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.5 });
  // Headlights glow much brighter at night (bloom picks them up).
  const glass = new THREE.MeshStandardMaterial({
    color: 0xfff4d0, emissive: 0xfff0c0, emissiveIntensity: 0.4 + _lightLevel * 2.3,
  });

  // --- Moulded shell ---
  // Floor pan: the wide, low monocoque the whole car is built on.
  const pan = new THREE.Mesh(rbox(2.55, 0.42, 4.7, 0.3), paint);
  pan.position.y = 0.56;
  pan.castShadow = true;
  group.add(pan);
  // Lower accent skirt (two-tone) — slightly wider + darker, hugging the ground.
  const skirt = new THREE.Mesh(rbox(2.66, 0.3, 4.3, 0.22), accent);
  skirt.position.y = 0.36;
  group.add(skirt);
  // Cockpit spine: the raised centre body that the seat sinks into.
  const spine = new THREE.Mesh(rbox(1.6, 0.78, 3.1, 0.34), paint);
  spine.position.set(0, 0.92, -0.25);
  spine.castShadow = true;
  group.add(spine);
  // Nose: a single tapering wedge flowing off the front of the pan + soft tip.
  const nose = new THREE.Mesh(rbox(1.7, 0.46, 1.7, 0.3), paint);
  nose.position.set(0, 0.62, 2.0);
  nose.castShadow = true;
  group.add(nose);
  const noseTip = new THREE.Mesh(rbox(1.16, 0.42, 1.2, 0.42), paint);
  noseTip.position.set(0, 0.58, 2.95);
  noseTip.castShadow = true;
  group.add(noseTip);
  // Nose flash (accent) over the snout.
  const flash = new THREE.Mesh(rbox(0.95, 0.2, 1.5, 0.12), accent);
  flash.position.set(0, 0.84, 2.6);
  group.add(flash);
  // Side fairings — flush to the floor sides, same paint: bodywork, not pods.
  for (const sx of [-1, 1]) {
    const fairing = new THREE.Mesh(rbox(0.62, 0.5, 2.7, 0.26), paint);
    fairing.position.set(sx * 1.2, 0.64, 0.0);
    fairing.castShadow = true;
    group.add(fairing);
    // Number roundel on each fairing: a white disc with a darker ring.
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.04, 20), decal);
    disc.rotation.z = Math.PI / 2;
    disc.position.set(sx * 1.53, 0.78, 0.1);
    group.add(disc);
    const ringD = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.04, 8, 22), accent);
    ringD.position.set(sx * 1.55, 0.78, 0.1);
    ringD.rotation.y = Math.PI / 2;
    group.add(ringD);
  }
  // Centre racing stripe running nose → tail over the spine.
  const stripeTop = new THREE.Mesh(rbox(0.42, 0.08, 4.5, 0.04), stripe);
  stripeTop.position.set(0, 1.33, -0.1);
  group.add(stripeTop);
  const stripeNose = new THREE.Mesh(rbox(0.42, 0.08, 1.6, 0.04), stripe);
  stripeNose.position.set(0, 0.86, 2.6);
  group.add(stripeNose);

  // Seat well (where the cat sits) — sunk into the spine.
  const seat = new THREE.Mesh(rbox(1.5, 0.66, 1.5, 0.28), dark);
  seat.position.set(0, 1.06, -0.5);
  group.add(seat);
  const seatBack = new THREE.Mesh(rbox(1.4, 0.9, 0.4, 0.18), dark);
  seatBack.position.set(0, 1.3, -1.2);
  group.add(seatBack);

  // Steering wheel
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.07, 10, 18), chrome);
  wheel.position.set(0, 1.4, 0.55);
  wheel.rotation.x = Math.PI / 2.6;
  group.add(wheel);

  // Rear deck behind the cockpit, housing the tail lights + a single wing pylon.
  const deck = new THREE.Mesh(rbox(1.7, 0.5, 1.0, 0.26), paint);
  deck.position.set(0, 0.86, -1.95);
  deck.castShadow = true;
  group.add(deck);

  // Rear wing on one clean central pylon + accent end-plates.
  const pylon = new THREE.Mesh(rbox(0.34, 0.7, 0.34, 0.1), dark);
  pylon.position.set(0, 1.25, -2.3);
  group.add(pylon);
  const wing = new THREE.Mesh(rbox(2.7, 0.14, 0.74, 0.06), paint);
  wing.position.set(0, 1.62, -2.32);
  wing.castShadow = true;
  group.add(wing);
  for (const sx of [-1, 1]) {
    const plate = new THREE.Mesh(rbox(0.08, 0.36, 0.78, 0.03), accent);
    plate.position.set(sx * 1.32, 1.55, -2.32);
    group.add(plate);
  }

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

  // --- Wheels: matte tyres with a contact tread band + a body-coloured rim and
  // chrome centre cap. Fronts a touch smaller than the rears (kart stance). ---
  const wheels = [];
  function buildWheel(radius) {
    const w = new THREE.Group();
    const t = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.5, 22), tire);
    t.rotation.z = Math.PI / 2;
    t.castShadow = true;
    w.add(t);
    // A slightly proud, slightly wider tread band around the centre.
    const band = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.02, radius * 1.02, 0.34, 22), tread);
    band.rotation.z = Math.PI / 2;
    w.add(band);
    // Body-coloured rim disc + chrome hub cap on the outer face.
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.62, radius * 0.62, 0.52, 16), rimMat);
    rim.rotation.z = Math.PI / 2;
    w.add(rim);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.26, 12, 12), chrome);
    cap.scale.set(0.5, 1, 1);
    w.add(cap);
    return w;
  }
  const wheelDefs = [
    [1.32, 0.55, 1.55, 0.55],
    [-1.32, 0.55, 1.55, 0.55],
    [1.42, 0.62, -1.6, 0.66],
    [-1.42, 0.62, -1.6, 0.66],
  ];
  for (const [x, y, z, radius] of wheelDefs) {
    const w = buildWheel(radius);
    w.position.set(x, y, z);
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
