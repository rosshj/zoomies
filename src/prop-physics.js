// Small rigid-prop solver. Only awake props run contact queries; road triangles
// are prepared once, and queries stay on the prop's own strand at crossovers.
import * as THREE from 'three';
const UP = new THREE.Vector3(0, 1, 0);
const SKIN = .035;

export function crateHull(s) {
  const points = [];
  for (const [w, lo, hi] of [[s / 2, -s / 2, s / 2], [s * .51, s * .42, s * .58]])
    for (const x of [-w, w]) for (const y of [lo, hi]) for (const z of [-w, w]) points.push(new THREE.Vector3(x, y, z));
  return points;
}
export function barrelHull(r, h) {
  const points = [];
  // Convex envelope includes the bands, not just the narrower lathed body.
  for (const [y, radius] of [[-h / 2, r * .82], [-h * .36, r * .995], [0, r], [h * .36, r * .995], [h / 2, r * .82]])
    for (let k = 0; k < 12; k++) points.push(new THREE.Vector3(Math.sin(k * Math.PI / 6) * radius, y, Math.cos(k * Math.PI / 6) * radius));
  return points;
}

export class PropPhysics {
  constructor(track) {
    this.track = track;
    this.sections = [];
    const road = track.roadSurface;
    if (road) {
      const p = road.geometry.attributes.position, ix = road.geometry.index, cross = road.rowWidth - 1;
      for (let row = 0; row < track.samples; row++) {
        const triangles = [];
        for (let j = 0; j < cross * 6; j += 3) {
          const offset = row * cross * 6 + j;
          const a = new THREE.Vector3().fromBufferAttribute(p, ix.getX(offset));
          const b = new THREE.Vector3().fromBufferAttribute(p, ix.getX(offset + 1));
          const c = new THREE.Vector3().fromBufferAttribute(p, ix.getX(offset + 2));
          const bx = b.x - a.x, bz = b.z - a.z, cx = c.x - a.x, cz = c.z - a.z;
          const determinant = bx * cz - bz * cx;
          if (Math.abs(determinant) < 1e-8) continue;
          const normal = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
          if (normal.y < 0) normal.negate();
          triangles.push({ x: a.x, z: a.z, y: a.y, bx, bz, cx, cz, inv: 1 / determinant,
            by: b.y - a.y, cy: c.y - a.y, normal,
            minX: Math.min(a.x, b.x, c.x), maxX: Math.max(a.x, b.x, c.x), minZ: Math.min(a.z, b.z, c.z), maxZ: Math.max(a.z, b.z, c.z) });
        }
        this.sections.push(triangles);
      }
    }
    this.normal = new THREE.Vector3(); this.point = new THREE.Vector3();
    this.contact = new THREE.Vector3(); this.delta = new THREE.Vector3();
    this.velocity = new THREE.Vector3(); this.cross = new THREE.Vector3();
    this.q = new THREE.Quaternion(); this.axis = new THREE.Vector3();
    this.nearest = { i: 0, x: 0, y: 0, z: 0, sideX: 0, sideZ: 1, lateral: 0 };
  }
  locate(pr, x = pr.pos.x, z = pr.pos.z) {
    const track = this.track, N = track.samples;
    let best = Infinity;
    const out = this.nearest;
    // At 120 Hz a launched prop travels <1.5u; the window also covers its hull.
    const window = Math.max(4, Math.ceil(8 * N / track.length));
    for (let k = -window; k <= window; k++) {
      const i = ((pr.roadIndex + k) % N + N) % N, a = track._pts[i], b = track._pts[(i + 1) % N];
      const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
      if (l2 < 1e-10) continue;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2));
      const px = a.x + t * dx, pz = a.z + t * dz, d = (x - px) ** 2 + (z - pz) ** 2;
      if (d >= best) continue;
      best = d;
      const len = Math.sqrt(l2);
      out.i = i; out.x = px; out.y = a.y + (b.y - a.y) * t; out.z = pz;
      out.sideX = -dz / len; out.sideZ = dx / len;
      out.lateral = ((x - px) * -dz + (z - pz) * dx) / len;
    }
    return out;
  }
  height(x, z, row, normal = null) {
    if (!this.sections.length) {
      if (normal) normal.copy(UP);
      return this.track.groundInfo(x, z).y + .02;
    }
    const N = this.sections.length;
    // Exact rendered triangles, not the coarse scenery/centreline height.
    const window = Math.max(2, Math.ceil(4 * N / this.track.length));
    for (let k = -window; k <= window; k++) for (const t of this.sections[(row + k + N) % N]) {
      if (x < t.minX - 1e-5 || x > t.maxX + 1e-5 || z < t.minZ - 1e-5 || z > t.maxZ + 1e-5) continue;
      const dx = x - t.x, dz = z - t.z;
      const u = (dx * t.cz - dz * t.cx) * t.inv, v = (t.bx * dz - t.bz * dx) * t.inv;
      if (u < -1e-5 || v < -1e-5 || u + v > 1.00001) continue;
      if (normal) normal.copy(t.normal);
      return t.y + u * t.by + v * t.cy;
    }
    // Just beyond the asphalt, continue the local road plane across the shoulder.
    const a = this.track._pts[row], b = this.track._pts[(row + 1) % N];
    const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1;
    const slope = (b.y - a.y) / l2;
    if (normal) normal.set(-dx * slope, 1, -dz * slope).normalize();
    return a.y + ((x - a.x) * dx + (z - a.z) * dz) * slope + .02;
  }
  prepare(pr, points, roadIndex) {
    pr.hull = points;
    const sphere = pr.profile?.sphereRadius;
    pr.worldHull = sphere ? Array.from({length:8},()=>new THREE.Vector3()) : points.map(() => new THREE.Vector3());
    pr.radius = sphere || Math.sqrt(Math.max(...points.map(p => p.lengthSq())));
    pr.roadIndex = roadIndex; pr.quiet = 0; pr.settleTarget = new THREE.Quaternion();
    pr.invInertia = 1 / Math.max(.2, Math.max(...points.map(p => p.lengthSq())) * .4);
    const road = this.locate(pr); pr.roadIndex = road.i;
    this.height(pr.pos.x, pr.pos.z, road.i, this.normal);
    pr.quat.setFromUnitVectors(UP, this.normal);
    if (pr.profile?.stand) pr.quat.multiply(this.q.setFromAxisAngle(new THREE.Vector3(1,0,0),Math.PI/2));
    this.resolve(pr, true);
    pr.mesh.position.copy(pr.pos); pr.mesh.quaternion.copy(pr.quat);
  }
  transform(pr) {
    if (pr.profile?.sphereRadius) {
      // An orientation-independent circle bounds the footprint; the ground
      // contact below is analytic, using the actual local road normal.
      for(let k=0;k<8;k++){const a=k*Math.PI/4;pr.worldHull[k].set(Math.sin(a)*pr.radius,0,Math.cos(a)*pr.radius);}
    } else for (let k = 0; k < pr.hull.length; k++) pr.worldHull[k].copy(pr.hull[k]).applyQuaternion(pr.quat);
  }
  resolve(pr, seat = false) {
    this.transform(pr);
    // Use the full rotating footprint, and recheck after correction on bends.
    // Keep hulls on the asphalt, leaving room for kerbs and leaning fence slats.
    const center = this.locate(pr);
    const nearFence = Math.abs(center.lateral) + pr.radius > this.track.halfWidth - .12;
    for (let pass = 0; nearFence && pass < 3; pass++) {
      let shift = 0, nx = 0, nz = 0;
      for (const p of pr.worldHull) {
        const road = this.locate(pr, pr.pos.x + p.x, pr.pos.z + p.z);
        const penetration = Math.abs(road.lateral) - (this.track.halfWidth - .12);
        if (penetration > shift) { shift = penetration; nx = road.sideX * Math.sign(road.lateral); nz = road.sideZ * Math.sign(road.lateral); }
      }
      if (shift < 1e-5) break;
      pr.pos.x -= nx * (shift + .005); pr.pos.z -= nz * (shift + .005);
      const vn = pr.vel.x * nx + pr.vel.z * nz;
      if (vn > 0) { pr.vel.x -= 1.22 * vn * nx; pr.vel.z -= 1.22 * vn * nz; pr.angVel.multiplyScalar(.8); }
    }
    const road = this.locate(pr); pr.roadIndex = road.i;
    pr.groundY = this.height(pr.pos.x, pr.pos.z, road.i, this.normal);
    let bottom = -Infinity;
    this.contact.set(0, 0, 0); let contacts = 0;
    if (pr.profile?.sphereRadius) {
      this.contact.copy(this.normal).multiplyScalar(-pr.radius);
      bottom = this.height(pr.pos.x+this.contact.x,pr.pos.z+this.contact.z,road.i)+SKIN-this.contact.y;
      contacts=1;
    }
    if (!pr.profile?.sphereRadius) for (const p of pr.worldHull) {
      const support = this.height(pr.pos.x + p.x, pr.pos.z + p.z, road.i) + SKIN - p.y;
      if (support > bottom + .025) { bottom = support; this.contact.copy(p); contacts = 1; }
      else if (support >= bottom - .025) { bottom = Math.max(bottom, support); this.contact.add(p); contacts++; }
    }
    this.contact.multiplyScalar(1 / Math.max(1, contacts));
    if (!seat && pr.pos.y > bottom) return false;
    pr.pos.y = bottom;
    return true;
  }
  stablePose(pr) {
    if (pr.profile?.shape === 'sphere') { pr.settleTarget.copy(pr.quat); return; }
    const candidates = [];
    if (pr.kind === 'barrel' || pr.profile?.shape === 'cylinder') {
      this.axis.copy(UP).applyQuaternion(pr.quat);
      if (Math.abs(this.axis.dot(this.normal)) > .72) candidates.push(UP, new THREE.Vector3(0, -1, 0));
      else for (let k = 0; k < 12; k++) candidates.push(new THREE.Vector3(Math.sin((k + .5) * Math.PI / 6), 0, Math.cos((k + .5) * Math.PI / 6)));
    } else for (let k = 0; k < 3; k++) for (const sign of [-1, 1]) { const a = new THREE.Vector3(); a.setComponent(k, sign); candidates.push(a); }
    let score = -Infinity;
    for (const axis of candidates) {
      this.point.copy(axis).applyQuaternion(pr.quat);
      const d = this.point.dot(this.normal);
      if (d > score) { score = d; this.axis.copy(this.point); }
    }
    this.q.setFromUnitVectors(this.axis, this.normal);
    pr.settleTarget.copy(this.q).multiply(pr.quat);
  }
  step(pr, dt) {
    if (pr.asleep && !pr.settle) return;
    const count = Math.max(1, Math.ceil(Math.min(dt, .05) * 120)), h = Math.min(dt, .05) / count;
    for (let s = 0; s < count; s++) {
      if (pr.settle) {
        pr.quat.slerp(pr.settleTarget, 1 - Math.exp(-10 * h));
        this.resolve(pr, true);
        if (pr.quat.angleTo(pr.settleTarget) < .005) {
          pr.quat.copy(pr.settleTarget); this.resolve(pr, true);
          pr.settle = false; pr.asleep = true; pr.vel.set(0, 0, 0); pr.angVel.set(0, 0, 0);
          break;
        }
        continue;
      }
      pr.vel.y -= (pr.profile?.gravity ?? 30) * h;
      pr.vel.multiplyScalar(Math.exp(-(pr.profile?.airDrag ?? .22) * h));
      pr.pos.addScaledVector(pr.vel, h);
      const speed = pr.angVel.length();
      if (speed > 1e-8) {
        this.axis.copy(pr.angVel).multiplyScalar(1 / speed);
        this.q.setFromAxisAngle(this.axis, speed * h); pr.quat.premultiply(this.q).normalize();
      }
      if (this.resolve(pr)) {
        this.velocity.crossVectors(pr.angVel, this.contact).add(pr.vel);
        const vn = this.velocity.dot(this.normal);
        pr.contactImpact = Math.max(pr.contactImpact || 0, -vn);
        if (vn < 0) {
          this.cross.crossVectors(this.contact, this.normal);
          const impulse = -(1 + (vn < -2 ? (pr.profile?.restitution ?? .26) : 0)) * vn / (1 + pr.invInertia * this.cross.lengthSq());
          pr.vel.addScaledVector(this.normal, impulse);
          pr.angVel.addScaledVector(this.cross, impulse * pr.invInertia);
        }
        // Time-based contact friction avoids frame-rate-dependent stop distances.
        const normalSpeed = pr.vel.dot(this.normal);
        this.delta.copy(pr.vel).addScaledVector(this.normal, -normalSpeed);
        pr.vel.addScaledVector(this.delta, -(1 - Math.exp(-(pr.profile?.friction ?? 7) * h)));
        if (pr.profile) {
          this.delta.copy(pr.vel).addScaledVector(this.normal, -normalSpeed);
          // Dry contact has static/rolling resistance, not just air-like drag;
          // otherwise a wheel can slide forever down even a modest grade.
          const speed = this.delta.length();
          const resistance = pr.profile.sound === 'ice' ? .09 : .42;
          if(speed>1e-6)pr.vel.addScaledVector(this.delta,-Math.min(1,resistance*(pr.profile.gravity??30)*this.normal.y*h/speed));
          if(pr.profile.shape==='sphere'||pr.profile.shape==='cylinder'){
            this.cross.crossVectors(this.normal,this.delta).multiplyScalar(1/Math.max(.1,pr.radius));
            const blend=1-Math.exp(-5*h);
            if(pr.profile.shape==='sphere')pr.angVel.lerp(this.cross,blend);
            else {
              this.axis.copy(UP).applyQuaternion(pr.quat);
              if(Math.abs(this.axis.dot(this.normal))<.4)pr.angVel.addScaledVector(this.axis,(this.cross.dot(this.axis)-pr.angVel.dot(this.axis))*blend);
            }
          }
        }
        pr.angVel.multiplyScalar(Math.exp(-(pr.profile?.angularDrag ?? 9) * h));
        if (pr.vel.lengthSq() < 2.5 && pr.angVel.lengthSq() < 4) pr.quiet += h;
        else pr.quiet = 0;
        if (pr.quiet > .12) { this.stablePose(pr); pr.settle = true; pr.vel.set(0, 0, 0); pr.angVel.set(0, 0, 0); }
      } else pr.quiet = 0;
    }
    pr.mesh.position.copy(pr.pos); pr.mesh.quaternion.copy(pr.quat);
  }
}
