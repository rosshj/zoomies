// Battle arena (phase 1): an open, fenced bowl that stands in for the Track.
//
// The kart physics never cared about the circuit — it asks its ground provider
// three questions per frame (project() for containment + ground height under
// the front/rear wheels) and the Track answered them from a spline. The Arena
// answers the same questions from a radial profile, so `Kart`, the chase
// camera, the minimap and the sun-shadow fitter all run unchanged:
//
//   - `side` is the outward radial direction and `lateral` the distance from
//     the arena centre, so the barrier clamp in kart._integrate (limit =
//     halfWidth - kart.radius) IS the fence — scrape sparks and all.
//   - `t` is constant 0: no arc coordinate means no lap counting, so a battle
//     never "finishes" by driving in circles (_updateLap sees d = 0 forever).
//   - `features` is an empty run-list, so the tunnel camera clamps, minimap
//     glyphs and feature planners all no-op.
//
// The bowl is one molded lathe surface (floor, dish and banked rim in a single
// unbroken profile — per the molded-surfaces rule), with the SAME
// groundHeightAt() sampling for the mesh and the physics so the wheels always
// sit exactly on what you see. The fence, rail and outer apron ring it.
import * as THREE from "three";

const RIM_BANK = 4.5; // extra rise across the outer 30% — a rideable skate-bowl bank
const DISH = 1.6; // saucer depth: the centre sits this far below the fence line

export class Arena {
  constructor({ radius = 90 } = {}) {
    this.isArena = true;
    this.radius = radius;
    this.halfWidth = radius; // kart containment: |lateral| clamps at halfWidth - kart.radius
    this.length = Math.PI * 2 * radius; // nominal arc length for t-space consumers
    this.samples = 128;
    this.totalLaps = 3; // overwritten by main.js like the Track's; unused (t never advances)
    this.raceTime = 0;
    this.features = { runs: [] }; // no tunnels/bridges: camera clamps + glyphs no-op

    // Fence outline in Track._pts form: the minimap draws it as the map bounds
    // and fitSunShadow fits the light frustum around it.
    this._pts = [];
    this._tans = [];
    const rimY = this.groundHeightAt(radius);
    for (let i = 0; i < this.samples; i++) {
      const a = (i / this.samples) * Math.PI * 2;
      this._pts.push(new THREE.Vector3(Math.sin(a) * radius, rimY, Math.cos(a) * radius));
      this._tans.push(new THREE.Vector3(Math.cos(a), 0, -Math.sin(a)));
    }

    this.group = new THREE.Group();
    this._build();
  }

  // Radial ground profile — the single source of truth for both the physics
  // (project/groundYNear) and the bowl mesh, so they can never disagree.
  // A shallow saucer (lowest at the centre) with a banked rim sweeping up to
  // the fence; beyond the fence the world is flat at the fence height.
  groundHeightAt(r) {
    const R = this.radius;
    const rc = Math.min(Math.abs(r), R);
    const dish = DISH * (rc * rc) / (R * R);
    const s = Math.max(0, (rc - R * 0.7) / (R * 0.3));
    return dish + RIM_BANK * s * s;
  }

  // Same contract as Track.project, in radial terms: `side` points outward from
  // the arena centre and `lateral` is the centre distance, so the kart's wall
  // clamp holds it inside the fence and shoves radially on a scrape.
  project(pos) {
    const x = pos.x, z = pos.z;
    const r = Math.hypot(x, z);
    const side = r > 1e-4 ? new THREE.Vector3(x / r, 0, z / r) : new THREE.Vector3(1, 0, 0);
    const tangent = new THREE.Vector3(-side.z, 0, side.x);
    const groundY = this.groundHeightAt(r);
    return {
      t: 0, // constant: no arc coordinate, no laps (see file comment)
      point: new THREE.Vector3(x, groundY, z),
      tangent,
      side,
      lateral: r,
      distance: r,
      groundY,
    };
  }

  groundYNear(x, z) {
    return this.groundHeightAt(Math.hypot(x, z));
  }

  // Scenery-style sampler: y = ground height, dist = how far OUTSIDE the play
  // area (0 anywhere in the bowl), mirroring "distance from the road corridor".
  groundInfo(x, z) {
    const r = Math.hypot(x, z);
    return { y: this.groundHeightAt(r), dist: Math.max(0, r - this.radius) };
  }

  // A circle at mid-floor stands in for the centreline: the menu orbit anchors
  // sweep it, and any t-space consumer gets sensible world points.
  getPointAt(t, target = new THREE.Vector3()) {
    const a = (((t % 1) + 1) % 1) * Math.PI * 2;
    const r = this.radius * 0.55;
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    return target.set(x, this.groundHeightAt(r), z);
  }

  getTangentAt(t, target = new THREE.Vector3()) {
    const a = (((t % 1) + 1) % 1) * Math.PI * 2;
    return target.set(Math.cos(a), 0, -Math.sin(a));
  }

  // Start cluster south of centre, all facing the middle of the bowl — the same
  // rows-of-2 shape the Track grid uses, so the menu tableau frames it fine.
  gridSlot(index) {
    const back = 42 + Math.floor(index / 2) * 8;
    const lateral = (index % 2 === 0 ? -1 : 1) * 5;
    const pos = new THREE.Vector3(lateral, 0, back);
    pos.y = this.groundHeightAt(Math.hypot(lateral, back));
    return { position: pos, heading: Math.PI }; // forward = (0,-1): toward the centre
  }

  // ---- Visual build --------------------------------------------------------

  _build() {
    const R = this.radius;
    const rimY = this.groundHeightAt(R);

    // Bowl: ONE lathe from the centre to the fence, sampling groundHeightAt so
    // the surface is exactly the physics profile. Concentric floor rings — a
    // centre spot, a mid ring, and a dusty edge zone over the banked rim — are
    // baked as per-vertex colours keyed off each vertex's own radius (no
    // texture: bands land exactly where the physics features are).
    // Profile runs rim → centre: a lathe profile that walks OUTWARD generates
    // downward-facing normals (the whole floor backface-culls into sky).
    const profile = [];
    const N = 40;
    for (let i = N; i >= 0; i--) {
      const r = (i / N) * R;
      profile.push(new THREE.Vector2(Math.max(r, 0.01), this.groundHeightAt(r)));
    }
    const bowlGeo = new THREE.LatheGeometry(profile, 96);
    {
      const sand = new THREE.Color(0xd9c08f); // packed sand
      const cream = new THREE.Color(0xefe3c0); // painted rings
      const edge = new THREE.Color(0xc4795a); // dusty rim edge zone
      const line = new THREE.Color(0xb98f5c);
      const pos = bowlGeo.getAttribute("position");
      const col = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3);
      const pick = (r) => {
        const u = r / R;
        if (u < 0.1) return cream; // centre spot
        if (u < 0.115) return line;
        if (u > 0.94) return edge; // over the bank, right before the fence
        if (u > 0.7 && u < 0.715) return line; // where the bank begins
        if (u > 0.49 && u < 0.51) return cream; // mid-floor ring
        return sand;
      };
      for (let i = 0; i < pos.count; i++) {
        const c = pick(Math.hypot(pos.getX(i), pos.getZ(i)));
        col.setXYZ(i, c.r, c.g, c.b);
      }
      bowlGeo.setAttribute("color", col);
    }
    const bowl = new THREE.Mesh(
      bowlGeo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 })
    );
    this.group.add(bowl);

    // Fence: a single open cylinder wall sunk slightly under the rim so no gap
    // can show, with a pale rail on top and a rhythm of posts around it.
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(R + 0.35, R + 0.35, 3.9, 96, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x9a6a45, roughness: 0.9, side: THREE.DoubleSide })
    );
    wall.position.y = rimY + 1.45; // 0.5u buried
    this.group.add(wall);

    const rail = new THREE.Mesh(
      new THREE.TorusGeometry(R + 0.35, 0.3, 10, 96),
      new THREE.MeshStandardMaterial({ color: 0xefe3c0, roughness: 0.8 })
    );
    rail.rotation.x = Math.PI / 2;
    rail.position.y = rimY + 3.4;
    this.group.add(rail);

    const POSTS = 24;
    const postGeo = new THREE.CylinderGeometry(0.42, 0.5, 4.4, 8);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x7c5236, roughness: 0.95 });
    const posts = new THREE.InstancedMesh(postGeo, postMat, POSTS);
    const m = new THREE.Matrix4();
    for (let i = 0; i < POSTS; i++) {
      const a = (i / POSTS) * Math.PI * 2;
      m.makeTranslation(Math.sin(a) * (R + 0.35), rimY + 1.7, Math.cos(a) * (R + 0.35));
      posts.setMatrixAt(i, m);
    }
    this.group.add(posts);

    // Apron: flat meadow from just outside the fence to past the fog, so the
    // view over the rail is grass fading out rather than void.
    const apron = new THREE.Mesh(
      new THREE.RingGeometry(R + 0.7, 1400, 96, 1),
      new THREE.MeshStandardMaterial({ color: 0x6fae5a, roughness: 1 })
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = rimY - 0.35;
    this.group.add(apron);
  }
}
