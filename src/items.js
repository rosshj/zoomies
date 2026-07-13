// Yarn balls and spilled-milk puddles: the two aimed/placed power-ups.
//
// A YARN BALL is the pressure item: it drops onto the road and ROLLS ALONG THE
// TRACK toward the kart ahead, homing only weakly in the lateral — so the
// target has three honest outs, each with a cost. Shield blocks it (but bleeds
// speed and occupies the action slot), a hard late juke out-steers the homing,
// and a well-timed hop clears it entirely. The target hears about it early
// (minimap trace from launch) but the hard "!" ping only lands ~a second out,
// so defending is a read, not a reflex armed at launch.
//
// A MILK PUDDLE is the placed trap: dropped behind the kart, ~a third of the
// road wide, spins out the first kart that drives through it and evaporates.
// It's a floor hazard: the shield bubble does NOT help — jump it, drive around
// it, or eat it. Catnip invincibility plows straight through both items.
import * as THREE from "three";

const UP = new THREE.Vector3(0, 1, 0);
const _pt = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _side = new THREE.Vector3();

const YARN_LIFE = 12; // seconds before an unspent ball unravels
const YARN_HOME_RATE = 6; // u/s of lateral pull — beatable by a hard late juke
const MILK_LIFE = 30; // unhit puddles dry up eventually
const MILK_GRACE = 1.5; // the dropper can't hit their own bottle immediately

export class ItemManager {
  constructor(scene, track) {
    this.scene = scene;
    this.track = track;
    this.yarns = [];
    this.puddles = [];

    // Yarn: a rosy wound ball with a darker band so the roll reads.
    this._yarnGeo = new THREE.SphereGeometry(0.62, 10, 8);
    this._yarnMat = new THREE.MeshStandardMaterial({ color: 0xe4607a, roughness: 0.85 });
    this._yarnBandGeo = new THREE.TorusGeometry(0.62, 0.09, 6, 14);
    this._yarnBandMat = new THREE.MeshStandardMaterial({ color: 0xb23a52, roughness: 0.85 });

    // Milk: a soft blobby circle with a faint sheen (fresh spill, not paint).
    this._milkGeo = ItemManager._blobGeometry();
    this._milkMat = new THREE.MeshStandardMaterial({
      color: 0xf4f6f2,
      roughness: 0.25,
      metalness: 0.0,
      transparent: true,
      opacity: 0.95,
    });
  }

  // A wobbly-edged disc (radius 1, scaled per puddle) so spills read as liquid.
  static _blobGeometry() {
    const N = 26;
    const shape = new THREE.Shape();
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const r = 1 + 0.14 * Math.sin(a * 3 + 1.2) + 0.09 * Math.sin(a * 5 + 4.0);
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    const geo = new THREE.ShapeGeometry(shape, 2);
    geo.rotateX(-Math.PI / 2); // lie flat (XZ plane)
    return geo;
  }

  // ---- Yarn ball -----------------------------------------------------------

  // Launch a yarn ball from `owner` toward `target` (may be null: it just
  // rolls up the road and expires). Speed is set from the owner's pace so it
  // CLOSES slowly — the chase, minimap trace and late ping are the drama.
  spawnYarn(owner, target) {
    const proj = owner._proj || this.track.project(owner.position);
    const ball = new THREE.Group();
    const core = new THREE.Mesh(this._yarnGeo, this._yarnMat);
    const band = new THREE.Mesh(this._yarnBandGeo, this._yarnBandMat);
    band.rotation.x = Math.PI / 2;
    ball.add(core, band);
    core.castShadow = true;
    ball.frustumCulled = false;
    this.scene.add(ball);
    this.yarns.push({
      mesh: ball,
      t: proj.t,
      lat: Math.max(-8, Math.min(8, proj.lateral)),
      speed: Math.max(36, Math.min(48, Math.abs(owner.speed) + 14)),
      owner,
      target: target || null,
      life: YARN_LIFE,
      passed: false, // rolled past its target (juked/hopped) — no re-lock
      roll: 0,
    });
  }

  // Smallest time-to-impact of any live yarn bearing down on `kart` (Infinity
  // when none) — drives the target's "!" ping and the AI's defend decision.
  yarnEta(kart) {
    let eta = Infinity;
    const L = this.track.length;
    for (const y of this.yarns) {
      if (y.target !== kart || y.passed) continue;
      let gap = (kart.trackT - y.t) % 1;
      if (gap < 0) gap += 1;
      if (gap > 0.5) continue; // it's behind the wrap — not approaching
      const closing = y.speed - Math.max(0, kart.speed);
      if (closing <= 0.5) continue;
      eta = Math.min(eta, (gap * L) / closing);
    }
    return eta;
  }

  // ---- Milk puddle ---------------------------------------------------------

  dropMilk(owner) {
    const track = this.track;
    const proj = owner._proj || track.project(owner.position);
    // Drop a few metres behind the rear bumper, at the kart's own lane.
    let t = proj.t - 6 / track.length;
    if (t < 0) t += 1;
    track.getPointAt(t, _pt);
    track.getTangentAt(t, _tan);
    _side.crossVectors(_tan, UP).normalize();
    const lat = Math.max(-track.halfWidth + 5.5, Math.min(track.halfWidth - 5.5, proj.lateral));
    const r = track.halfWidth / 1.5 / 2; // diameter = a third of the full road width
    const mesh = new THREE.Mesh(this._milkGeo, this._milkMat.clone());
    mesh.scale.set(r, 1, r);
    mesh.position.set(_pt.x + _side.x * lat, _pt.y + 0.09, _pt.z + _side.z * lat);
    // Conform to the road's slope along the tangent so the spill lies on ramps
    // instead of knifing into them (the road is flat across).
    const pitch = Math.atan2(_tan.y, Math.hypot(_tan.x, _tan.z));
    mesh.rotation.set(0, Math.atan2(_tan.x, _tan.z), 0);
    mesh.rotateX(-pitch);
    mesh.renderOrder = 2; // over road decals
    this.scene.add(mesh);
    this.puddles.push({
      mesh,
      x: mesh.position.x,
      z: mesh.position.z,
      r,
      owner,
      grace: MILK_GRACE,
      life: MILK_LIFE,
      fading: 0, // >0: evaporating (post-hit or dried up)
      spread: 0, // pour-in animation
    });
  }

  // Nearest live puddle roughly ahead of `kart` within `range` (AI avoidance).
  puddleAhead(kart, range = 34) {
    const fx = Math.sin(kart.heading);
    const fz = Math.cos(kart.heading);
    let best = null;
    let bestD = range;
    for (const p of this.puddles) {
      if (p.fading > 0) continue;
      const dx = p.x - kart.position.x;
      const dz = p.z - kart.position.z;
      const d = Math.hypot(dx, dz);
      if (d >= bestD || d < 0.001) continue;
      if ((dx * fx + dz * fz) / d < 0.75) continue; // not on our heading
      best = p;
      bestD = d;
    }
    return best ? { puddle: best, dist: bestD } : null;
  }

  // ---- Frame update --------------------------------------------------------

  update(dt, karts, callbacks = {}) {
    const track = this.track;
    const L = track.length;

    // Yarn balls roll along the spline, easing laterally toward their target.
    for (let i = this.yarns.length - 1; i >= 0; i--) {
      const y = this.yarns[i];
      y.life -= dt;
      y.t = (y.t + (y.speed * dt) / L) % 1;
      if (y.target && !y.passed) {
        const tl = y.target._proj ? y.target._proj.lateral : 0;
        const want = Math.max(-track.halfWidth + 2, Math.min(track.halfWidth - 2, tl));
        const d = want - y.lat;
        y.lat += Math.max(-YARN_HOME_RATE * dt, Math.min(YARN_HOME_RATE * dt, d));
      }
      track.getPointAt(y.t, _pt);
      track.getTangentAt(y.t, _tan);
      _side.crossVectors(_tan, UP).normalize();
      y.mesh.position.set(_pt.x + _side.x * y.lat, _pt.y + 0.62, _pt.z + _side.z * y.lat);
      y.roll += (y.speed * dt) / 0.62;
      y.mesh.rotation.set(0, Math.atan2(_tan.x, _tan.z), 0);
      y.mesh.rotateX(y.roll);

      // Contact test against every live kart near its arc position.
      let dead = false;
      for (const k of karts) {
        if (k === y.owner || k.finished || k.spinTimer > 0) continue;
        let gap = (k.trackT - y.t) % 1;
        if (gap < 0) gap += 1;
        if (gap > 0.5) gap -= 1;
        const arc = gap * L;
        if (arc < -2.5 || arc > 2.5) continue;
        const kl = k._proj ? k._proj.lateral : 0;
        if (Math.abs(kl - y.lat) > 3.1) continue;
        if (k.y > 1.05) continue; // hopped it — clean dodge
        if (k.shielding || k.catnipBoosting) {
          dead = true; // blocked: the ball unravels on the bubble
          if (callbacks.onYarnBlocked) callbacks.onYarnBlocked(k, y);
          break;
        }
        _tan.y = 0;
        if (_tan.lengthSq() > 0.001) _tan.normalize();
        k.spinOut(_tan.clone());
        if (callbacks.onYarnHit) callbacks.onYarnHit(k, y);
        dead = true;
        break;
      }

      // Rolled past its target without connecting (juke/hop): no second lock.
      if (!dead && y.target && !y.passed) {
        let gap = (y.target.trackT - y.t) % 1;
        if (gap < 0) gap += 1;
        if (gap > 0.5) y.passed = true;
      }

      if (dead || y.life <= 0) {
        this.scene.remove(y.mesh);
        this.yarns.splice(i, 1);
      }
    }

    // Milk puddles: pour in, spin the first kart through, evaporate.
    for (let i = this.puddles.length - 1; i >= 0; i--) {
      const p = this.puddles[i];
      if (p.grace > 0) p.grace -= dt;
      p.life -= dt;
      if (p.spread < 1) {
        p.spread = Math.min(1, p.spread + dt * 2.2);
        const s = p.r * (0.35 + 0.65 * p.spread);
        p.mesh.scale.set(s, 1, s);
      }
      if (p.fading > 0) {
        p.fading -= dt;
        p.mesh.material.opacity = Math.max(0, p.fading / 0.45) * 0.95;
        if (p.fading <= 0) {
          this.scene.remove(p.mesh);
          p.mesh.material.dispose();
          this.puddles.splice(i, 1);
        }
        continue;
      }
      if (p.life <= 0) {
        p.fading = 0.45;
        continue;
      }
      for (const k of karts) {
        if (k.finished || k.spinTimer > 0) continue;
        if (k === p.owner && p.grace > 0) continue;
        if (k.y > 0.9) continue; // airborne clears it
        if (k.catnipBoosting) continue; // invincible: plows straight through
        const dx = k.position.x - p.x;
        const dz = k.position.z - p.z;
        if (dx * dx + dz * dz > (p.r + 1.2) * (p.r + 1.2)) continue;
        // A floor hazard: the shield bubble doesn't reach the tarmac.
        _tan.set(Math.sin(k.heading), 0, Math.cos(k.heading));
        k.spinOut(_tan.clone());
        p.fading = 0.45; // one splash and it's gone
        if (callbacks.onMilkHit) callbacks.onMilkHit(k, p);
        break;
      }
    }
  }

  clear() {
    for (const y of this.yarns) this.scene.remove(y.mesh);
    for (const p of this.puddles) {
      this.scene.remove(p.mesh);
      p.mesh.material.dispose();
    }
    this.yarns.length = 0;
    this.puddles.length = 0;
  }
}
