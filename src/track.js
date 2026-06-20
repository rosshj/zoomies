import * as THREE from "three";

// A closed race track built from a smooth Catmull-Rom loop.
// Provides the road mesh, walls, start/finish line and helpers for
// projecting a world position onto the track (used for lap timing & AI).
export class Track {
  constructor() {
    this.width = 16; // road half-handled below (full width)
    this.halfWidth = this.width / 2;

    // Control points (x, z) shaping an interesting closed circuit.
    const pts = [
      [0, -70],
      [70, -60],
      [110, -10],
      [95, 55],
      [45, 80],
      [-15, 70],
      [-30, 30],
      [-65, 25],
      [-110, 0],
      [-95, -55],
      [-40, -80],
    ].map(([x, z]) => new THREE.Vector3(x, 0, z));

    this.curve = new THREE.CatmullRomCurve3(pts, true, "catmullrom", 0.5);

    // Precompute samples for fast nearest-point lookups.
    this.samples = 600;
    this._pts = [];
    this._tans = [];
    for (let i = 0; i < this.samples; i++) {
      const t = i / this.samples;
      this._pts.push(this.curve.getPointAt(t));
      this._tans.push(this.curve.getTangentAt(t));
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
      const t = (i % div) / div;
      const p = this.curve.getPointAt(t);
      const tan = this.curve.getTangentAt(t);
      const side = new THREE.Vector3().crossVectors(tan, up).normalize();

      const left = new THREE.Vector3().copy(p).addScaledVector(side, this.halfWidth);
      const right = new THREE.Vector3().copy(p).addScaledVector(side, -this.halfWidth);

      positions.push(left.x, 0.02, left.z);
      positions.push(right.x, 0.02, right.z);
      uvs.push(0, i);
      uvs.push(1, i);

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

    // Curbs / walls along both edges plus a dashed center line.
    this._buildEdges();
    this._buildCenterLine();
    this._buildStartLine();
  }

  _buildEdges() {
    const up = new THREE.Vector3(0, 1, 0);
    const wallGeo = new THREE.BoxGeometry(1, 1.4, 1);
    const matA = new THREE.MeshStandardMaterial({ color: 0xe53935 });
    const matB = new THREE.MeshStandardMaterial({ color: 0xfafafa });

    const step = 6; // post spacing in samples
    for (let i = 0; i < this.samples; i += step) {
      const t = i / this.samples;
      const p = this.curve.getPointAt(t);
      const tan = this.curve.getTangentAt(t);
      const side = new THREE.Vector3().crossVectors(tan, up).normalize();
      const mat = (i / step) % 2 === 0 ? matA : matB;

      for (const dir of [1, -1]) {
        const post = new THREE.Mesh(wallGeo, mat);
        const pos = new THREE.Vector3().copy(p).addScaledVector(side, dir * (this.halfWidth + 0.6));
        post.position.set(pos.x, 0.7, pos.z);
        post.lookAt(pos.x + tan.x, 0.7, pos.z + tan.z);
        post.scale.set(0.6, 1, 3);
        post.castShadow = true;
        this.group.add(post);
      }
    }
  }

  _buildCenterLine() {
    const up = new THREE.Vector3(0, 1, 0);
    const dashGeo = new THREE.PlaneGeometry(0.4, 3);
    const dashMat = new THREE.MeshStandardMaterial({ color: 0xffd54f, roughness: 0.8 });
    const dashes = 120;
    for (let i = 0; i < dashes; i++) {
      const t = i / dashes;
      const p = this.curve.getPointAt(t);
      const tan = this.curve.getTangentAt(t);
      const dash = new THREE.Mesh(dashGeo, dashMat);
      dash.position.set(p.x, 0.04, p.z);
      dash.rotation.x = -Math.PI / 2;
      dash.rotation.z = -Math.atan2(tan.z, tan.x) + Math.PI / 2;
      this.group.add(dash);
    }
  }

  _buildStartLine() {
    const up = new THREE.Vector3(0, 1, 0);
    const p = this.curve.getPointAt(0);
    const tan = this.curve.getTangentAt(0);
    const side = new THREE.Vector3().crossVectors(tan, up).normalize();

    // Checkered strip across the road.
    const cols = 8;
    const cellW = this.width / cols;
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < 2; r++) {
        const cell = new THREE.Mesh(
          new THREE.PlaneGeometry(cellW, 1.4),
          new THREE.MeshStandardMaterial({
            color: (c + r) % 2 === 0 ? 0x111111 : 0xffffff,
          })
        );
        const offSide = (c + 0.5) * cellW - this.halfWidth;
        const offFwd = (r - 0.5) * 1.5;
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
    this.startPoint = p;
    this.startTangent = tan;
    this.startSide = side;
  }

  getPointAt(t) {
    return this.curve.getPointAt(((t % 1) + 1) % 1);
  }

  getTangentAt(t) {
    return this.curve.getTangentAt(((t % 1) + 1) % 1);
  }

  // Returns the nearest sampled position on the centerline:
  // { t, point, tangent, lateral } where lateral is signed distance
  // from the centerline (positive on the left side).
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
    const up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3().crossVectors(tangent, up).normalize();
    const lateral = new THREE.Vector3().subVectors(pos, point).dot(side);
    return { t, point, tangent, lateral, distance: Math.sqrt(bestDist) };
  }

  // World position + heading for a starting grid slot.
  gridSlot(index) {
    // Stagger karts in two columns slightly behind the start line.
    const back = 6 + Math.floor(index / 2) * 7; // distance behind line
    const lateral = (index % 2 === 0 ? -1 : 1) * 4;

    const tApprox = -back / this.curve.getLength();
    const p = this.getPointAt(tApprox);
    const tan = this.getTangentAt(tApprox);
    const side = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0)).normalize();
    const pos = new THREE.Vector3().copy(p).addScaledVector(side, lateral);
    const heading = Math.atan2(tan.x, tan.z);
    return { position: pos, heading };
  }
}
