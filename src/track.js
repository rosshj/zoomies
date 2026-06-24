import * as THREE from "three";
import { biomeBarrierStyle, biomeRoadStyle } from "./scenery.js";

// Bluish-white tone for the alpine road's icy patches.
const SNOW_PATCH = new THREE.Color(0xdfeaf5);

// Fine grayscale noise used as the road's bump map (asphalt grain).
function noiseTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(64, 64);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 140 + Math.random() * 115;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

// A closed race track built from a smooth 3D Catmull-Rom loop. The curve now
// carries elevation (y), so the road climbs and dips. Provides the road mesh,
// barrier walls, start/finish line and helpers for projecting a world position
// onto the track (lap timing, AI, containment, ground height).
export class Track {
  constructor() {
    this.width = 30;
    this.halfWidth = this.width / 2;

    // Control points (x, z, y) — a long, tall, serpentine circuit with two
    // upper lobes and a winding lower half (see the design sketch). It runs
    // counter-clockwise, so it favours left-hand turns, and rolls up and down
    // big hills (two high shoulders on the left and right).
    const pts = [
      [0, -430, 0],
      [120, -400, 4],
      [210, -330, 14],
      [180, -250, 22],
      [250, -160, 30],
      [310, -40, 38],
      [270, 80, 32],
      [320, 200, 22],
      [280, 330, 12],
      [180, 420, 5],
      [80, 400, 6],
      [55, 300, 12],
      [-45, 300, 14],
      [-70, 400, 8],
      [-170, 430, 4],
      [-280, 350, 28],
      [-310, 200, 58],
      [-250, 90, 78],
      [-300, -40, 84],
      [-250, -160, 58],
      [-280, -290, 28],
      [-180, -370, 8],
      [-70, -400, 3],
    ].map(([x, z, y]) => new THREE.Vector3(x, y, z));

    this.curve = new THREE.CatmullRomCurve3(pts, true, "catmullrom", 0.5);
    this.length = this.curve.getLength();

    // Precompute samples for fast nearest-point lookups.
    this.samples = 1000;
    this._pts = [];
    this._tans = [];
    for (let i = 0; i < this.samples; i++) {
      const t = i / this.samples;
      this._pts.push(this.curve.getPointAt(t));
      this._tans.push(this.curve.getTangentAt(t));
    }

    // Point list for cheap distance/height queries used by scenery.
    this._coarse = [];
    for (let i = 0; i < this.samples; i += 2) this._coarse.push(this._pts[i]);

    this.group = new THREE.Group();
    this._buildRoad();
  }

  _sideAt(i) {
    return new THREE.Vector3().crossVectors(this._tans[i], new THREE.Vector3(0, 1, 0)).normalize();
  }

  _buildRoad() {
    const div = this.samples;
    const cross = 5; // subdivisions across the road, for color variation
    const vpr = cross + 1; // vertices per row
    const positions = [];
    const uvs = [];
    const colors = [];
    const indices = [];
    const base = new THREE.Color(0x53535b); // asphalt
    const c = new THREE.Color();

    const hash = (a, b) => {
      const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
      return s - Math.floor(s);
    };

    for (let i = 0; i <= div; i++) {
      const idx = i % div;
      const p = this._pts[idx];
      const side = this._sideAt(idx);
      for (let j = 0; j < vpr; j++) {
        const f = j / cross; // 0..1 across the road
        const lat = -this.halfWidth + f * this.width;
        const x = p.x + side.x * lat;
        const z = p.z + side.z * lat;
        positions.push(x, p.y + 0.02, z);
        uvs.push(f, i * 0.1);

        // Asphalt tone: smooth patchy variation + fine grain, with two faint
        // darker "tyre line" bands where karts tend to drive.
        let shade =
          1 +
          0.07 * Math.sin(x * 0.05) * Math.cos(z * 0.045) +
          0.05 * Math.sin(x * 0.013 + z * 0.017) +
          (hash(idx, j) - 0.5) * 0.07;
        const lane = Math.min(Math.abs(f - 0.32), Math.abs(f - 0.68));
        if (lane < 0.08) shade -= 0.06;
        // Biome surface: tint the asphalt and add per-biome speckle so the road
        // changes character as you lap (sandy/cracked desert, snowy/icy alpine,
        // damp forest tarmac, warm autumn).
        const style = biomeRoadStyle(x, z);
        const h2 = hash(idx * 1.7 + 3.1, j * 2.3 + 5.7);
        c.setRGB(base.r * style.tint[0], base.g * style.tint[1], base.b * style.tint[2]).multiplyScalar(shade);
        if (style.kind === "sand" && h2 < 0.05) c.multiplyScalar(0.55); // dark cracks
        else if (style.kind === "snow" && h2 > 0.9) c.lerp(SNOW_PATCH, 0.7); // icy patches
        else if (style.kind === "damp" && h2 > 0.93) c.multiplyScalar(0.7); // wet patches
        colors.push(c.r, c.g, c.b);
      }

      if (i < div) {
        const row = i * vpr;
        const next = (i + 1) * vpr;
        for (let j = 0; j < cross; j++) {
          indices.push(row + j, next + j, row + j + 1);
          indices.push(row + j + 1, next + j, next + j + 1);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const bump = noiseTexture();
    bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
    bump.repeat.set(6, 6);
    bump.anisotropy = 8;
    const road = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.95,
        bumpMap: bump,
        bumpScale: 0.25,
      })
    );
    road.receiveShadow = true;
    this.group.add(road);

    this._buildSandTrim();
    this._buildWalls();
    this._buildCenterLine();
    this._buildEdgeLines();
    this._buildStartLine();
  }

  // Solid painted lines down both edges of the tarmac (just inside the verge).
  _buildEdgeLines() {
    const inset = this.halfWidth - 0.55;
    const hw = 0.22; // half-width of the painted line
    const mat = new THREE.MeshStandardMaterial({
      color: 0xece7da,
      roughness: 0.85,
      side: THREE.DoubleSide,
    });
    for (const sgn of [1, -1]) {
      const positions = [];
      const indices = [];
      for (let i = 0; i <= this.samples; i++) {
        const idx = i % this.samples;
        const p = this._pts[idx];
        const side = this._sideAt(idx);
        const a = new THREE.Vector3().copy(p).addScaledVector(side, sgn * (inset - hw));
        const b = new THREE.Vector3().copy(p).addScaledVector(side, sgn * (inset + hw));
        positions.push(a.x, p.y + 0.05, a.z, b.x, p.y + 0.05, b.z);
        if (i < this.samples) {
          const k = i * 2;
          indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  _buildSandTrim() {
    const div = this.samples;
    const positions = [];
    const colors = [];
    const indices = [];
    const trim = 3.2;
    const sand = new THREE.Color(0xc2a86a);
    const red = new THREE.Color(0xd83a2f);
    const white = new THREE.Color(0xf2f2f2);
    const c = new THREE.Color();
    const tanAng = (k) => {
      const t = this._tans[((k % div) + div) % div];
      return Math.atan2(t.x, t.z);
    };
    for (let i = 0; i <= div; i++) {
      const idx = i % div;
      const p = this._pts[idx];
      const side = this._sideAt(idx);
      // Local curvature: how much the heading turns over a short look-ahead. On
      // bends the verge becomes a red/white rumble kerb; straights stay sandy.
      let d = tanAng(idx + 10) - tanAng(idx);
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      if (Math.abs(d) > 0.055) c.copy(Math.floor(i / 2) % 2 === 0 ? red : white);
      else c.copy(sand);
      const lOut = new THREE.Vector3().copy(p).addScaledVector(side, this.halfWidth + trim);
      const lIn = new THREE.Vector3().copy(p).addScaledVector(side, this.halfWidth);
      const rIn = new THREE.Vector3().copy(p).addScaledVector(side, -this.halfWidth);
      const rOut = new THREE.Vector3().copy(p).addScaledVector(side, -this.halfWidth - trim);
      positions.push(lOut.x, lOut.y, lOut.z, lIn.x, lIn.y, lIn.z, rIn.x, rIn.y, rIn.z, rOut.x, rOut.y, rOut.z);
      for (let v = 0; v < 4; v++) colors.push(c.r, c.g, c.b);
      if (i < div) {
        const a = i * 4;
        indices.push(a, a + 1, a + 4, a + 1, a + 5, a + 4);
        indices.push(a + 2, a + 3, a + 6, a + 3, a + 7, a + 6);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  _buildWalls() {
    const wallH = 1.6;
    const off = this.halfWidth + 0.8; // inner face — kept where the old thin wall sat
    const ca = new THREE.Color();
    const cb = new THREE.Color();

    // Cross-section of the barrier, offset OUTWARD from the road (sOff) and UP
    // (yOff): a solid wall with a rounded top, so it reads as a chunky kerb
    // rather than a paper-thin ribbon. Swept along the spine below.
    const W = 0.85; // thickness
    const r = W / 2; // top round radius
    const shoulderY = wallH - r;
    const profile = [[0, 0]];
    const ARC = 5;
    for (let k = 0; k <= ARC; k++) {
      const a = Math.PI * (1 - k / ARC); // inner shoulder -> over the top -> outer shoulder
      profile.push([r + Math.cos(a) * r, shoulderY + Math.sin(a) * r]);
    }
    profile.push([W, 0]);
    const P = profile.length;

    // Continuous barriers (no gaps) down each side of the road. The two
    // alternating colours come from the biome the segment sits in, so the
    // fencing changes as you pass from meadow to forest to desert, etc.
    for (const dirSign of [1, -1]) {
      const positions = [];
      const colors = [];
      const indices = [];
      for (let i = 0; i <= this.samples; i++) {
        const idx = i % this.samples;
        const p = this._pts[idx];
        const side = this._sideAt(idx); // horizontal lateral; outward when scaled by dirSign
        const style = biomeBarrierStyle(p.x + side.x * dirSign * off, p.z + side.z * dirSign * off);
        const c = Math.floor(i / 6) % 2 === 0 ? ca.set(style.a) : cb.set(style.b);
        for (const [sOff, yOff] of profile) {
          const d = off + sOff;
          positions.push(p.x + side.x * dirSign * d, p.y + yOff, p.z + side.z * dirSign * d);
          colors.push(c.r, c.g, c.b);
        }
        if (i < this.samples) {
          const a0 = i * P;
          const b0 = (i + 1) * P;
          for (let j = 0; j < P - 1; j++) {
            indices.push(a0 + j, a0 + j + 1, b0 + j, a0 + j + 1, b0 + j + 1, b0 + j);
          }
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.9 })
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  _buildCenterLine() {
    // Dashes built as quads lying in the road surface (offset a hair along the
    // surface normal) so they read as painted-on, not raised — important now
    // that the road pitches over hills.
    const positions = [];
    const indices = [];
    const N = 220;
    const up = new THREE.Vector3(0, 1, 0);
    const hl = 1.6; // half-length of a dash
    const hw = 0.22; // half-width
    let v = 0;
    for (let k = 0; k < N; k += 2) {
      const t = k / N;
      const p = this.curve.getPointAt(t);
      const tan = this.curve.getTangentAt(t).normalize();
      const side = new THREE.Vector3().crossVectors(tan, up).normalize();
      const normal = new THREE.Vector3().crossVectors(side, tan).normalize();
      const o = normal.clone().multiplyScalar(0.03);
      const corner = (al, aw) =>
        new THREE.Vector3()
          .copy(p)
          .addScaledVector(tan, al)
          .addScaledVector(side, aw)
          .add(o);
      const c0 = corner(-hl, -hw);
      const c1 = corner(-hl, hw);
      const c2 = corner(hl, -hw);
      const c3 = corner(hl, hw);
      positions.push(c0.x, c0.y, c0.z, c1.x, c1.y, c1.z, c2.x, c2.y, c2.z, c3.x, c3.y, c3.z);
      indices.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
      v += 4;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: 0xf4cf3a, roughness: 0.9 })
    );
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  _buildStartLine() {
    const p = this.curve.getPointAt(0);
    const tan = this.curve.getTangentAt(0);
    const side = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0)).normalize();

    const cols = 11;
    const cellW = this.width / cols;
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < 2; r++) {
        const cell = new THREE.Mesh(
          new THREE.PlaneGeometry(cellW, 1.6),
          new THREE.MeshStandardMaterial({ color: (c + r) % 2 === 0 ? 0x111111 : 0xffffff })
        );
        const offSide = (c + 0.5) * cellW - this.halfWidth;
        const offFwd = (r - 0.5) * 1.7;
        const pos = new THREE.Vector3().copy(p).addScaledVector(side, offSide).addScaledVector(tan, offFwd);
        cell.position.set(pos.x, pos.y + 0.06, pos.z);
        cell.rotation.x = -Math.PI / 2;
        cell.rotation.z = -Math.atan2(tan.z, tan.x) + Math.PI / 2;
        this.group.add(cell);
      }
    }

    // Archway over the track: a single tube that rises as a post on each side
    // and curves over the road into a rounded arch. The apex is recorded so the
    // finish fireworks can burst from it.
    const up = new THREE.Vector3(0, 1, 0);
    const W = this.halfWidth + 1.6; // post offset from centre
    const postH = 5.5; // straight post height before the arch curves
    const archRise = 5.0; // how high the arch bulges above the posts
    const pt = (s, y) => new THREE.Vector3().copy(p).addScaledVector(side, s).addScaledVector(up, y);
    const archPts = [pt(-W, 0)]; // left base
    const ARCSEG = 16;
    for (let k = 0; k <= ARCSEG; k++) {
      const a = Math.PI * (1 - k / ARCSEG); // left shoulder -> apex -> right shoulder
      archPts.push(pt(W * Math.cos(a), postH + archRise * Math.sin(a)));
    }
    archPts.push(pt(W, 0)); // right base
    const archGeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(archPts), 90, 0.55, 12, false);
    const arch = new THREE.Mesh(
      archGeo,
      new THREE.MeshStandardMaterial({ color: 0xe53935, roughness: 0.55, metalness: 0.1 })
    );
    arch.castShadow = true;
    this.group.add(arch);

    // Golden finials at the apex and shoulders for a fairground gate look.
    const finialMat = new THREE.MeshStandardMaterial({ color: 0xffd54f, roughness: 0.5, metalness: 0.3 });
    this.archApex = pt(0, postH + archRise);
    for (const s of [-W, 0, W]) {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.85, 16, 12), finialMat);
      ball.position.copy(pt(s, s === 0 ? postH + archRise : postH));
      ball.castShadow = true;
      this.group.add(ball);
    }
  }

  getPointAt(t) {
    return this.curve.getPointAt(((t % 1) + 1) % 1);
  }

  getTangentAt(t) {
    return this.curve.getTangentAt(((t % 1) + 1) % 1);
  }

  // Closest point on the polyline `pts` to (x,z), interpolated *along* the
  // nearest segment so the result (especially height) is continuous — no
  // stair-stepping as you cross sample boundaries.
  _projectArr(pts, x, z) {
    const N = pts.length;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < N; i++) {
      const dx = pts[i].x - x;
      const dz = pts[i].z - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    let rDist = Infinity;
    let ry = pts[best].y;
    let ri = best;
    let ru = 0;
    let cx = pts[best].x;
    let cz = pts[best].z;
    for (const di of [-1, 0]) {
      const a = (best + di + N) % N;
      const b = (a + 1) % N;
      const ax = pts[a].x;
      const az = pts[a].z;
      const ex = pts[b].x - ax;
      const ez = pts[b].z - az;
      const len2 = ex * ex + ez * ez || 1;
      let u = ((x - ax) * ex + (z - az) * ez) / len2;
      u = Math.max(0, Math.min(1, u));
      const px = ax + ex * u;
      const pz = az + ez * u;
      const dx = x - px;
      const dz = z - pz;
      const d = dx * dx + dz * dz;
      if (d < rDist) {
        rDist = d;
        ry = pts[a].y + (pts[b].y - pts[a].y) * u;
        ri = a;
        ru = u;
        cx = px;
        cz = pz;
      }
    }
    return { dist: Math.sqrt(rDist), y: ry, i: ri, u: ru, cx, cz };
  }

  // Projection onto the centerline with an interpolated ground height:
  // { t, point, tangent, side, lateral, distance, groundY }.
  project(pos) {
    const r = this._projectArr(this._pts, pos.x, pos.z);
    const t = (r.i + r.u) / this.samples;
    const point = new THREE.Vector3(r.cx, r.y, r.cz);
    const tangent = this._tans[r.i];
    const side = this._sideAt(r.i);
    const lateral = (pos.x - r.cx) * side.x + (pos.z - r.cz) * side.z;
    return { t, point, tangent, side, lateral, distance: r.dist, groundY: r.y };
  }

  // Nearest XZ distance + interpolated height (coarse, for scenery).
  groundInfo(x, z) {
    const r = this._projectArr(this._coarse, x, z);
    return { dist: r.dist, y: r.y };
  }

  distanceToCenter(x, z) {
    return this.groundInfo(x, z).dist;
  }

  // World position + heading for a starting grid slot (on the road surface).
  gridSlot(index) {
    const back = 8 + Math.floor(index / 2) * 8;
    const lateral = (index % 2 === 0 ? -1 : 1) * 5;
    const tApprox = -back / this.length;
    const p = this.getPointAt(tApprox);
    const tan = this.getTangentAt(tApprox);
    const side = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0)).normalize();
    const pos = new THREE.Vector3().copy(p).addScaledVector(side, lateral);
    const heading = Math.atan2(tan.x, tan.z);
    return { position: pos, heading };
  }
}
