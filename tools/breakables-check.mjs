// Node-only checks for the feature-playground building blocks:
//  - every breakable structure builds, with sane hulls and rest poses, and
//    scales its hit points with its art;
//  - surface features (track-surface.js) lift the road where they say and
//    nowhere else, and a HEADLESS kart launches off a ramp lip, hops only a
//    little over a speed bump, and never leaves the ground on a long smooth
//    hill (the ramp-launch rule must not fire on the generator's crests).
// Run: `npm run check:breakables`.
import * as THREE from "three";
import { BREAKABLES, BREAKABLE_KINDS, BIOME_SCENES, makeBreakable } from "../src/breakables.js";
import { ROAD_PROP_BIOMES } from "../src/road-prop-assets.js";
import { SurfaceFeatures, SURFACE_TYPES } from "../src/track-surface.js";
import { Kart } from "../src/kart.js";

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log((cond ? "  ok  " : "FAIL  ") + name + (extra ? `  (${extra})` : ""));
  if (!cond) failures++;
};

// ---- Breakables -------------------------------------------------------------
for (const kind of BREAKABLE_KINDS) {
  const sizes = [0, 1, 2].map((sz) => makeBreakable(kind, () => 0.5, sz));
  check(
    `${BREAKABLES[kind].name}: sizes grow (${sizes.map((b) => b.pieces.length).join("/")} pieces)`,
    sizes[0].pieces.length <= sizes[1].pieces.length &&
      sizes[1].pieces.length <= sizes[2].pieces.length &&
      sizes[0].pieces.length >= 2,
  );
  const b = sizes[1];
  const spec = BREAKABLES[kind];
  let ok = b.pieces.length >= 3 && b.hitPoints.length >= 1 && b.height > 1 && b.radius > 1;
  let worst = "";
  for (const p of b.pieces) {
    const finite = p.hull.every((v) => Number.isFinite(v.x + v.y + v.z));
    const hullR = Math.sqrt(Math.max(...p.hull.map((v) => v.lengthSq())));
    // Every piece rests inside the structure's footprint, and its hull is a
    // real convex set around its origin (not a point, not the whole street).
    const inside = Math.hypot(p.local.pos.x, p.local.pos.z) <= b.radius + 0.5;
    if (!(finite && hullR > 0.05 && hullR < 6 && p.rest > -1.0 && inside && p.profile && p.mesh.children.length)) {
      ok = false;
      worst = `${p.name}: hullR ${hullR.toFixed(2)} rest ${p.rest.toFixed(2)} inside ${inside}`;
    }
  }
  check(
    `${spec.name}: ${b.pieces.length} pieces, ${b.hitPoints.length} hit points, scale ${spec.scale || 1}`,
    ok,
    worst,
  );
  check(
    `${spec.name}: hit points sit inside its radius`,
    b.hitPoints.every(([x, z]) => Math.hypot(x, z) <= b.radius),
  );
  check(`${spec.name}: debris list and slow factor set`, Array.isArray(spec.debris) && typeof spec.slow === "number");
}
check(
  "every biome has at least three scene recipes, all of which exist",
  Object.keys(ROAD_PROP_BIOMES).every(
    (b) => (BIOME_SCENES[b] || []).length >= 3 && BIOME_SCENES[b].every((k) => BREAKABLES[k]),
  ),
);
{
  const a = makeBreakable("marketStall", () => 0.5),
    s = BREAKABLES.marketStall.scale;
  check(
    "structure scale applies to hit points and height alike",
    Math.abs(a.height - 2.7 * s) < 1e-6 && Math.abs(a.hitPoints[0][0] + 2 * s) < 1e-6,
  );
}

// ---- Surface features on a stub track ----------------------------------------
// A straight road along +x (z lateral), with everything SurfaceFeatures and a
// headless Kart read. `hill(x)` is the base elevation profile.
function stubTrack(hill = () => 0, length = 600, halfWidth = 15) {
  const N = 1000;
  const _pts = [];
  for (let i = 0; i < N; i++) {
    const x = (i / N) * length;
    _pts.push(new THREE.Vector3(x, hill(x), 0));
  }
  const t = {
    length,
    halfWidth,
    samples: N,
    totalLaps: 99,
    raceTime: 0,
    surface: null,
    _pts,
    _projectArr(pts, x) {
      const f = ((((x / length) % 1) + 1) % 1) * N;
      const i0 = Math.floor(f) % N,
        i1 = (i0 + 1) % N;
      return { y: pts[i0].y + (pts[i1].y - pts[i0].y) * (f - Math.floor(f)), i: i0, u: f - Math.floor(f), dist: 0 };
    },
    project(pos) {
      const r = t._projectArr(_pts, pos.x);
      let groundY = r.y;
      if (t.surface) groundY += t.surface.liftAt(pos.x, pos.z);
      return {
        t: (((pos.x / length) % 1) + 1) % 1,
        point: new THREE.Vector3(pos.x, r.y, 0),
        tangent: new THREE.Vector3(1, 0, 0),
        side: new THREE.Vector3(0, 0, 1),
        lateral: pos.z,
        groundY,
        i: r.i,
      };
    },
    getPointAt(tt, out = new THREE.Vector3()) {
      const x = (((tt % 1) + 1) % 1) * length;
      return out.set(x, hill(x), 0);
    },
    getTangentAt(tt, out = new THREE.Vector3()) {
      return out.set(1, 0, 0);
    },
  };
  return t;
}
const kartCfg = {
  name: "P",
  color: 0x888888,
  catColor: 0x888888,
  catPattern: 0,
  catAccessory: 0,
  catAccessoryColor: 0,
  kartStyle: 0,
  kartNumber: 1,
  headless: true,
  isPlayer: true,
};
// Drive a headless kart flat out from x=20 over the track and report its flight.
function fly(track, frames = 420) {
  const k = new Kart(kartCfg);
  k.placeAt(new THREE.Vector3(20, 0, 0), Math.PI / 2, track); // heading +x
  k.throttleInput = 1;
  let airFrames = 0,
    peak = 0,
    launched = false,
    landedAt = null,
    launchX = 0;
  for (let i = 0; i < frames; i++) {
    k.update(1 / 60, track);
    if (k.airLaunch) {
      launched = true;
      launchX = k.position.x;
      k.airLaunch = false;
    }
    if (k.airborne) airFrames++;
    else if (launched && landedAt === null) landedAt = k.position.x;
    peak = Math.max(peak, k.y);
  }
  return {
    airFrames,
    peak,
    launched,
    dist: landedAt === null ? null : landedAt - launchX,
    finite: Number.isFinite(k.position.x + k.y),
  };
}
{
  const track = stubTrack();
  const sf = new SurfaceFeatures(track);
  check(
    "every surface type builds a mesh",
    SURFACE_TYPES.every(
      (type) =>
        sf.add({ type, t: 0.2 + SURFACE_TYPES.indexOf(type) * 0.08 }).mesh.geometry.attributes.position.count > 50,
    ),
  );
  sf.clear();
  const ramp = sf.add({ type: "ramp", t: 100 / 600, length: 11, width: 10, height: 2.8 });
  check(
    "ramp lifts to its height at the lip and nothing past it",
    Math.abs(sf.liftAt(100 + 5.4, 0) - 2.8) < 0.2 && sf.liftAt(100 + 5.6, 0) === 0 && sf.liftAt(100, 6) === 0,
  );
  const f = fly(track);
  check(
    "a headless kart launches off the ramp lip and lands",
    f.launched && f.airFrames > 25 && f.peak > 1.2 && f.dist > 10 && f.finite,
    JSON.stringify(f),
  );
  sf.clear();
  sf.add({ type: "bumps", t: 100 / 600, length: 12, width: 16, height: 0.12, count: 3 });
  const b = fly(track, 300);
  check("speed bumps only rattle the kart", b.peak < 0.6 && b.finite, `peak ${b.peak.toFixed(2)}m`);
  sf.clear();
  sf.add({ type: "hump", t: 100 / 600, length: 9, width: 12, height: 1.5 });
  const h = fly(track, 300);
  check("a whoop throws the kart", h.launched && h.peak > 0.5 && h.finite, `peak ${h.peak.toFixed(2)}m`);
}
{
  // The generator's hills: ~300u wavelength, 15u amplitude — the kart must
  // stay glued (the launch rule only fires when the road drops faster than g).
  const track = stubTrack((x) => 15 * Math.sin((x / 300) * Math.PI * 2));
  const f = fly(track, 900);
  check("long smooth hills never launch the kart", !f.launched && f.airFrames === 0 && f.finite, JSON.stringify(f));
}
{
  // A hilly lap's SHARPER crests (the featured Meadow/Desert laps have
  // ~40u-radius crests at 3u sample spacing): bare terrain never launches
  // the kart, however it kinks — jumps are surface features only. This is
  // the "my kart spontaneously hops from time to time" regression.
  const track = stubTrack((x) => 6 * Math.sin((x / 60) * Math.PI * 2));
  const f = fly(track, 900);
  check(
    "sharp crests on bare terrain never launch the kart",
    !f.launched && f.airFrames === 0 && f.finite,
    JSON.stringify(f),
  );
}

console.log(failures ? `\n${failures} breakables/surface check(s) failed` : "\nall breakables/surface checks passed");
process.exit(failures ? 1 : 0);
