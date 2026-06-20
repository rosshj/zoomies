import * as THREE from "three";

// A closed race track built from a smooth Catmull-Rom loop (flat, y≈0).
// Provides the road mesh, barrier walls, start/finish line and helpers for
// projecting a world position onto the track (lap timing, AI, containment).
export class Track {
  constructor() {
    this.width = 22;
    this.halfWidth = this.width / 2;

    // Control points (x, z) shaping a long, flowing closed circuit.
    const pts = [
      [0, -190],
      [110, -175],
      [200, -110],
      [225, -10],
      [195, 95],
      [120, 160],
      [20, 195],
      [-90, 180],
      [-185, 120],
      [-235, 25],
      [-210, -90],
      [-110, -175],
    ].map(([x, z]) => new THREE.Vector3(x, 0, z));

    this.curve = new THREE.CatmullRomCurve3(pts, true, "catmullrom", 0.5);
    this.length = this.curve.getLength();

    // Precompute samples for fast nearest-point lookups.
    this.samples = 900;
    this._pts = [];
    this._tans = [];
    for (let i = 0; i < this.samples; i++) {
      const t = i / this.samples;
      this._pts.push(this.curve.getPointAt(t));
      this._tans.push(this.curve.getTangentAt(t));
    }

    // Coarse point list (xz) for cheap distance queries used by scenery.
    this._coarse = [];
    for (let i = 0; i < this.samples; i += 4) {
      this._coarse.push(this._pts[i]);
    }

    this.group = new THREE.Group();
    this._buildRoad();
  }

  _buildRoad() {
    const div = this.samples;
    const positions = [];
    const uvs = [];
    const indices = [];
    const up = new THREE.Vector3(0, 1, 0);

    for (let i = 0; i <= div; i++) {
      const idx = i % div;
      const p = this._pts[idx];
      const tan = this._tans[idx];
      const side = new THREE.Vector3().crossVectors(tan, up).normalize();

      const left = new THREE.Vector3().copy(p).addScaledVector(side, this.halfWidth);
      const right = new THREE.Vector3().copy(p).addScaledVector(side, -this.halfWidth);

      positions.push(left.x, 0.02, left.z);
      positions.push(right.x, 0.02, right.z);
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

  // Light run-off strip just outside the road, under the barriers.
  _buildSandTrim() {
    const div = this.samples;
    const positions = [];
    const indices = [];
    const up = new THREE.Vector3(0, 1, 0);
    const trim = 3.2;

    for (let i = 0; i <= div; i++) {
      const idx = i % div;
      const p = this._pts[idx];
      const tan = this._tans[idx];
      const side = new THREE.Vector3().crossVectors(tan, up).normalize();
      const lOut = new THREE.Vector3().copy(p).addScaledVector(side, this.halfWidth + trim);
      const lIn = new THREE.Vector3().copy(p).addScaledVector(side, this.halfWidth);
      const rIn = new THREE.Vector3().copy(p).addScaledVector(side, -this.halfWidth);
      const rOut = new THREE.Vector3().copy(p).addScaledVector(side, -this.halfWidth - trim);
      positions.push(lOut.x, 0.0, lOut.z, lIn.x, 0.0, lIn.z, rIn.x, 0.0, rIn.z, rOut.x, 0.0, rOut.z);
      if (i < div) {
        const a = i * 4;
        // left trim quad
        indices.push(a, a + 1, a + 4, a + 1, a + 5, a + 4);
        // right trim quad
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
    const up = new THREE.Vector3(0, 1, 0);
    const wallGeo = new THREE.BoxGeometry(1.2, 1.6, 4.2);
    const matA = new THREE.MeshStandardMaterial({ color: 0xe53935 });
    const matB = new THREE.MeshStandardMaterial({ color: 0xfafafa });

    const step = 5; // post spacing in samples
    const posts = [];
    for (let i = 0; i < this.samples; i += step) {
      const p = this._pts[i];
      const tan = this._tans[i];
      const side = new THREE.Vector3().crossVectors(tan, up).normalize();
      const red = (i / step) % 2 === 0;
      for (const dir of [1, -1]) {
        const pos = new THREE.Vector3().copy(p).addScaledVector(side, dir * (this.halfWidth + 1.6));
        posts.push({ pos, tan, red });
      }
    }

    const dummy = new THREE.Object3D();
    for (const mat of [matA, matB]) {
      const isRed = mat === matA;
      const subset = posts.filter((q) => q.red === isRed);
      const inst = new THREE.InstancedMesh(wallGeo, mat, subset.length);
      inst.castShadow = true;
      inst.receiveShadow = true;
      subset.forEach((q, i) => {
        dummy.position.set(q.pos.x, 0.8, q.pos.z);
        dummy.lookAt(q.pos.x + q.tan.x, 0.8, q.pos.z + q.tan.z);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
      });
      inst.instanceMatrix.needsUpdate = true;
      this.group.add(inst);
    }
  }

  _buildCenterLine() {
    const dashGeo = new THREE.PlaneGeometry(0.5, 4);
    const dashMat = new THREE.MeshStandardMaterial({ color: 0xffd54f, roughness: 0.8 });
    const dashes = 200;
    const inst = new THREE.InstancedMesh(dashGeo, dashMat, dashes);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < dashes; i++) {
      const t = i / dashes;
      const p = this.curve.getPointAt(t);
      const tan = this.curve.getTangentAt(t);
      dummy.position.set(p.x, 0.04, p.z);
      dummy.rotation.set(-Math.PI / 2, 0, -Math.atan2(tan.z, tan.x) + Math.PI / 2);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    this.group.add(inst);
  }

  _buildStartLine() {
    const up = new THREE.Vector3(0, 1, 0);
    const p = this.curve.getPointAt(0);
    const tan = this.curve.getTangentAt(0);
    const side = new THREE.Vector3().crossVectors(tan, up).normalize();

    // Checkered strip across the road.
    const cols = 11;
    const cellW = this.width / cols;
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < 2; r++) {
        const cell = new THREE.Mesh(
          new THREE.PlaneGeometry(cellW, 1.6),
          new THREE.MeshStandardMaterial({
            color: (c + r) % 2 === 0 ? 0x111111 : 0xffffff,
          })
        );
        const offSide = (c + 0.5) * cellW - this.halfWidth;
        const offFwd = (r - 0.5) * 1.7;
        const pos = new THREE.Vector3()
          .copy(p)
          .addScaledVector(side, offSide)
          .addScaledVector(tan, offFwd);
        cell.position.set(pos.x, 0.05, pos.z);
        cell.rotation.x = -Math.PI / 2;
        cell.rotation.z = -Math.atan2(tan.z, tan.x) + Math.PI / 2;
        this.group.add(cell);
      }
    }

    // Start/finish gantry arch over the line.
    const archMat = new THREE.MeshStandardMaterial({ color: 0x263238 });
    for (const dir of [1, -1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 9, 10), archMat);
      const lp = new THREE.Vector3().copy(p).addScaledVector(side, dir * (this.halfWidth + 1.2));
      leg.position.set(lp.x, 4.5, lp.z);
      leg.castShadow = true;
      this.group.add(leg);
    }
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(this.width + 4, 1.6, 1.6),
      new THREE.MeshStandardMaterial({ color: 0xffb300 })
    );
    beam.position.set(p.x, 9, p.z);
    beam.rotation.y = -Math.atan2(tan.z, tan.x);
    beam.castShadow = true;
    this.group.add(beam);

    this.startPoint = p;
    this.startTangent = tan;
  }

  getPointAt(t) {
    return this.curve.getPointAt(((t % 1) + 1) % 1);
  }

  getTangentAt(t) {
    return this.curve.getTangentAt(((t % 1) + 1) % 1);
  }

  // Nearest sampled point on the centerline:
  // { t, point, tangent, side, lateral, distance }.
  project(pos) {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < this.samples; i++) {
      const dx = this._pts[i].x - pos.x;
      const dz = this._pts[i].z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    const t = best / this.samples;
    const point = this._pts[best];
    const tangent = this._tans[best];
    const side = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 1, 0)).normalize();
    const lateral = new THREE.Vector3().subVectors(pos, point).dot(side);
    return { t, point, tangent, side, lateral, distance: Math.sqrt(bestDist) };
  }

  // Smallest XZ distance from a point to the centerline (coarse, for scenery).
  distanceToCenter(x, z) {
    let best = Infinity;
    for (const p of this._coarse) {
      const dx = p.x - x;
      const dz = p.z - z;
      const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  // World position + heading for a starting grid slot.
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
