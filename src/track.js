import * as THREE from "three";

// A closed race track built from a smooth 3D Catmull-Rom loop. The curve now
// carries elevation (y), so the road climbs and dips. Provides the road mesh,
// barrier walls, start/finish line and helpers for projecting a world position
// onto the track (lap timing, AI, containment, ground height).
export class Track {
  constructor() {
    this.width = 22;
    this.halfWidth = this.width / 2;

    // Control points (x, z, y) — a long, flowing circuit that turns both ways
    // and rolls up and down hills.
    const pts = [
      [0, -210, 0],
      [130, -205, 6],
      [235, -140, 26],
      [275, -25, 36],
      [225, 95, 20],
      [140, 180, 4],
      [35, 220, 2],
      [-85, 215, 16],
      [-195, 165, 32],
      [-280, 45, 38],
      [-250, -85, 16],
      [-160, -195, 4],
      [-65, -228, 0],
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
    const positions = [];
    const uvs = [];
    const indices = [];

    for (let i = 0; i <= div; i++) {
      const idx = i % div;
      const p = this._pts[idx];
      const side = this._sideAt(idx);
      const left = new THREE.Vector3().copy(p).addScaledVector(side, this.halfWidth);
      const right = new THREE.Vector3().copy(p).addScaledVector(side, -this.halfWidth);

      positions.push(left.x, left.y + 0.02, left.z);
      positions.push(right.x, right.y + 0.02, right.z);
      uvs.push(0, i * 0.1);
      uvs.push(1, i * 0.1);

      if (i < div) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2);
        indices.push(a + 1, a + 3, a + 2);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const road = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 0.95 })
    );
    road.receiveShadow = true;
    this.group.add(road);

    this._buildSandTrim();
    this._buildWalls();
    this._buildCenterLine();
    this._buildStartLine();
  }

  _buildSandTrim() {
    const div = this.samples;
    const positions = [];
    const indices = [];
    const trim = 3.2;
    for (let i = 0; i <= div; i++) {
      const idx = i % div;
      const p = this._pts[idx];
      const side = this._sideAt(idx);
      const lOut = new THREE.Vector3().copy(p).addScaledVector(side, this.halfWidth + trim);
      const lIn = new THREE.Vector3().copy(p).addScaledVector(side, this.halfWidth);
      const rIn = new THREE.Vector3().copy(p).addScaledVector(side, -this.halfWidth);
      const rOut = new THREE.Vector3().copy(p).addScaledVector(side, -this.halfWidth - trim);
      positions.push(lOut.x, lOut.y, lOut.z, lIn.x, lIn.y, lIn.z, rIn.x, rIn.y, rIn.z, rOut.x, rOut.y, rOut.z);
      if (i < div) {
        const a = i * 4;
        indices.push(a, a + 1, a + 4, a + 1, a + 5, a + 4);
        indices.push(a + 2, a + 3, a + 6, a + 3, a + 7, a + 6);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xc2a86a, roughness: 1 }));
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  _buildWalls() {
    const wallH = 1.6;
    const off = this.halfWidth + 0.8;
    const red = new THREE.Color(0xe53935);
    const white = new THREE.Color(0xfafafa);

    // Continuous ribbon barriers (no gaps) down each side of the road.
    for (const dirSign of [1, -1]) {
      const positions = [];
      const colors = [];
      const indices = [];
      for (let i = 0; i <= this.samples; i++) {
        const idx = i % this.samples;
        const p = this._pts[idx];
        const side = this._sideAt(idx);
        const base = new THREE.Vector3().copy(p).addScaledVector(side, dirSign * off);
        positions.push(base.x, base.y, base.z);
        positions.push(base.x, base.y + wallH, base.z);
        const c = Math.floor(i / 6) % 2 === 0 ? red : white;
        colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
        if (i < this.samples) {
          const a = i * 2;
          indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
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
    const dashGeo = new THREE.PlaneGeometry(0.5, 4);
    const dashMat = new THREE.MeshStandardMaterial({ color: 0xffd54f, roughness: 0.8 });
    const dashes = 240;
    const inst = new THREE.InstancedMesh(dashGeo, dashMat, dashes);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < dashes; i++) {
      const t = i / dashes;
      const p = this.curve.getPointAt(t);
      const tan = this.curve.getTangentAt(t);
      dummy.position.set(p.x, p.y + 0.05, p.z);
      dummy.rotation.set(-Math.PI / 2, 0, -Math.atan2(tan.z, tan.x) + Math.PI / 2);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    this.group.add(inst);
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

    const archMat = new THREE.MeshStandardMaterial({ color: 0x263238 });
    for (const dir of [1, -1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 9, 10), archMat);
      const lp = new THREE.Vector3().copy(p).addScaledVector(side, dir * (this.halfWidth + 1.2));
      leg.position.set(lp.x, lp.y + 4.5, lp.z);
      leg.castShadow = true;
      this.group.add(leg);
    }
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(this.width + 4, 1.6, 1.6),
      new THREE.MeshStandardMaterial({ color: 0xffb300 })
    );
    beam.position.set(p.x, p.y + 9, p.z);
    beam.rotation.y = -Math.atan2(tan.z, tan.x);
    beam.castShadow = true;
    this.group.add(beam);
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
