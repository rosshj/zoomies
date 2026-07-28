// Battle-mode rules + arena AI (phase 4). Owns everything that makes the
// arena a GAME instead of a sandbox: hearts, KOs, respawns, the match clock,
// KO attribution and standings — plus the AI driver that replaces the
// spline-following racing brain in an open arena.
//
// Deliberately headless (no THREE, no DOM): presentation stays in main.js via
// the hooks, so the rules can run under plain node checks like the rest of
// the sim code.
//
// Rules of the match:
//   - Every cat carries HEARTS (3). A spin-out costs one — detected by
//     LATCHING kart.spinTimer, so every damage source (furballs, milk,
//     whatever phase 5 adds) counts without touching its call site. A
//     Nine-Lives save never trips the latch (no spin happened), so the item
//     keeps its meaning.
//   - At zero hearts: KO. The kart poofs, the freshest attacker (tracked via
//     noteHit from the hit callbacks) scores a KO, and the victim respawns
//     after a beat at the ring point farthest from the living field, with
//     full hearts and a short mercy shield.
//   - Most KOs when the clock runs out wins.
export const BATTLE_HEARTS = 3;
export const MATCH_LEN = 120; // seconds
export const RESPAWN_DELAY = 2.4;
export const MERCY_SHIELD = 2.0; // spawn protection, seconds
const HIT_CREDIT_WINDOW = 2.5; // attacker credit stays fresh this long
const RETARGET_EVERY = 1.2; // AI re-picks its target on this cadence

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function angleDelta(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class Battle {
  // hooks: { onHeart(victim, attacker), onKO(victim, attacker), onRespawn(kart),
  //          onEnd(standings) } — all optional, presentation only.
  constructor(arena, hooks = {}) {
    this.arena = arena;
    this.hooks = hooks;
    this.left = MATCH_LEN;
    this.over = false;
    this.elapsed = 0;
  }

  reset(karts) {
    this.left = MATCH_LEN;
    this.over = false;
    this.elapsed = 0;
    for (const k of karts) {
      k.battleHearts = BATTLE_HEARTS;
      k.battleKOs = 0;
      k.battleDowns = 0; // times KO'd — the standings tie-break
      k._spinLatch = false;
      k._koTimer = 0;
      k._lastHitBy = null;
      k._lastHitAt = -99;
      k._btRetarget = Math.random() * RETARGET_EVERY; // stagger the AI's decisions
      k._btTarget = null;
      if (k.group) k.group.visible = true;
    }
  }

  // Called from the hit callbacks (furball onLocalHit, milk onMilkHit) so a KO
  // can be credited. Victim keeps the freshest attacker for a short window.
  noteHit(victim, attacker) {
    if (!attacker || attacker === victim) return;
    victim._lastHitBy = attacker;
    victim._lastHitAt = this.elapsed;
  }

  standings(karts) {
    // Most KOs wins; equal KOs ranks whoever went down less.
    return [...karts].sort(
      (a, b) => (b.battleKOs || 0) - (a.battleKOs || 0) || (a.battleDowns || 0) - (b.battleDowns || 0)
    );
  }

  // 0 for the KO leader … 1 for last: feeds the battle item roll the same way
  // race position feeds the racing roll.
  rankFrac(kart, karts) {
    const order = this.standings(karts);
    const i = order.indexOf(kart);
    return order.length > 1 ? i / (order.length - 1) : 0.5;
  }

  update(dt, karts) {
    if (this.over) return;
    this.elapsed += dt;
    this.left -= dt;
    if (this.left <= 0) {
      this.left = 0;
      this.over = true;
      if (this.hooks.onEnd) this.hooks.onEnd(this.standings(karts));
      return;
    }

    for (const k of karts) {
      // KO'd: held off-field (invisible, parked) until the respawn beat.
      if (k._koTimer > 0) {
        k._koTimer -= dt;
        k.speed = 0;
        k.throttleInput = 0;
        k.spinTimer = 0;
        if (k._koTimer <= 0) this._respawn(k, karts);
        continue;
      }
      // Heart latch: one heart per spin-out, whatever caused it.
      if (k.spinTimer > 0 && !k._spinLatch) {
        k._spinLatch = true;
        this._loseHeart(k, karts);
      } else if (k.spinTimer <= 0) {
        k._spinLatch = false;
      }
    }
  }

  _loseHeart(k, karts) {
    k.battleHearts = Math.max(0, (k.battleHearts ?? BATTLE_HEARTS) - 1);
    const attacker =
      k._lastHitBy && this.elapsed - k._lastHitAt < HIT_CREDIT_WINDOW ? k._lastHitBy : null;
    if (k.battleHearts > 0) {
      if (this.hooks.onHeart) this.hooks.onHeart(k, attacker);
      return;
    }
    // KO.
    if (attacker) attacker.battleKOs = (attacker.battleKOs || 0) + 1;
    k.battleDowns = (k.battleDowns || 0) + 1;
    k._koTimer = RESPAWN_DELAY;
    k._lastHitBy = null;
    // Strip run-state so nothing dangles across the respawn.
    k.spinTimer = 0;
    k.spinAngVel = 0;
    k.shieldTimer = 0;
    k.catnipTimer = 0;
    k.milkBottles = 0;
    k.triShots = 0;
    k.lives = 0;
    if (k.group) k.group.visible = false;
    if (this.hooks.onKO) this.hooks.onKO(k, attacker);
  }

  // Respawn at the ring point farthest from every living rival — never in
  // someone's lap, never twice in a row in a camping corner.
  _respawn(k, karts) {
    const R = this.arena.radius * 0.62;
    let best = null, bestScore = -1;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const x = Math.sin(a) * R, z = Math.cos(a) * R;
      let nearest = Infinity;
      for (const other of karts) {
        if (other === k || other._koTimer > 0) continue;
        nearest = Math.min(nearest, Math.hypot(other.position.x - x, other.position.z - z));
      }
      if (nearest > bestScore) {
        bestScore = nearest;
        best = { x, z, heading: a + Math.PI }; // face the arena centre
      }
    }
    k.placeAt({ x: best.x, y: 0, z: best.z }, best.heading, this.arena);
    k.battleHearts = BATTLE_HEARTS;
    k.shieldTimer = MERCY_SHIELD;
    k._spinLatch = false;
    if (k.group) k.group.visible = true;
    if (this.hooks.onRespawn) this.hooks.onRespawn(k);
  }

  // ---- Arena AI ------------------------------------------------------------
  // A hunter, not a racer: pick a victim (or a power-up box when empty-handed),
  // steer at it with terrain/obstacle avoidance, fire when lined up. Returns
  // the trigger pulls — main.js owns the actual firing (it also does audio/fx).
  driveAI(k, karts, boxes, dt) {
    const out = { shoot: false, milk: false };
    if (k._koTimer > 0 || k.spinTimer > 0 || this.over) {
      k.driftHeld = false;
      return out;
    }

    // Re-pick the target on a cadence (staggered per kart).
    k._btRetarget -= dt;
    if (k._btRetarget <= 0 || !k._btTarget) {
      k._btRetarget = RETARGET_EVERY;
      k._btTarget = this._pickTarget(k, karts, boxes);
    }
    const t = k._btTarget;

    // Aim point: lead a moving kart a beat; boxes sit still.
    let tx, tz;
    if (t && t.kart) {
      const v = t.kart.speed || 0;
      tx = t.kart.position.x + Math.sin(t.kart.heading) * v * 0.35;
      tz = t.kart.position.z + Math.cos(t.kart.heading) * v * 0.35;
    } else if (t) {
      tx = t.x; tz = t.z;
    } else {
      tx = 0; tz = 0; // nothing alive: drift toward the middle
    }

    const desired = Math.atan2(tx - k.position.x, tz - k.position.z);
    let steer = clamp(angleDelta(desired, k.heading) * 2.6, -1, 1);
    let throttle = 1;

    // Terrain avoidance: if a wall-grade face looms ahead, steer toward the
    // shallower side (the collide() wall rule is the hard stop; this keeps the
    // AI from grinding on cliffs and fences).
    const fx = Math.sin(k.heading), fz = Math.cos(k.heading);
    const hC = this.arena.heightAt(k.position.x, k.position.z);
    const probe = 7;
    if (this.arena.heightAt(k.position.x + fx * probe, k.position.z + fz * probe) - hC > 2.4 ||
        Math.hypot(k.position.x + fx * probe, k.position.z + fz * probe) > this.arena.radius - 4) {
      const aL = k.heading - 0.7, aR = k.heading + 0.7;
      const hL = this.arena.heightAt(k.position.x + Math.sin(aL) * probe, k.position.z + Math.cos(aL) * probe);
      const hR = this.arena.heightAt(k.position.x + Math.sin(aR) * probe, k.position.z + Math.cos(aR) * probe);
      steer = hL < hR ? -1 : 1;
      throttle = 0.55;
    } else {
      // Obstacle avoidance: bend around toys on the line to the target.
      for (const o of this.arena.obstacles) {
        const dx = o.x - k.position.x, dz = o.z - k.position.z;
        const d = Math.hypot(dx, dz);
        if (d > 14 || d < 0.01) continue;
        const ahead = (dx * fx + dz * fz) / d;
        if (ahead < 0.75) continue;
        let rel = angleDelta(Math.atan2(dx, dz), k.heading);
        const away = Math.abs(rel) < 0.04 ? 1 : -Math.sign(rel);
        steer = clamp(steer + away * (1 - d / 14) * 1.6, -1, 1);
      }
    }

    k.steerInput = steer;
    k.throttleInput = throttle;
    k.driftHeld = false;

    // Trigger discipline: fire on a lined-up living rival in range; drop milk
    // on a tail-gater. (Cadence-gated so a whole lobby doesn't fire as one.)
    if (t && t.kart && k.shootCooldown <= 0) {
      const dx = t.kart.position.x - k.position.x, dz = t.kart.position.z - k.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 38 && Math.abs(angleDelta(Math.atan2(dx, dz), k.heading)) < 0.13 && Math.random() < 6 * dt) {
        out.shoot = true;
      }
    }
    if (k.milkBottles > 0) {
      for (const other of karts) {
        if (other === k || other._koTimer > 0) continue;
        const dx = other.position.x - k.position.x, dz = other.position.z - k.position.z;
        const d = Math.hypot(dx, dz);
        if (d < 15 && (dx * fx + dz * fz) / (d || 1) < -0.45) {
          out.milk = true;
          break;
        }
      }
    }
    return out;
  }

  _pickTarget(k, karts, boxes) {
    // Empty-handed and uncharged? Grab a box first (60/40 vs pressing the hunt).
    const wantsBox = boxes && boxes.length && k.boxCooldown <= 0 && Math.random() < 0.45;
    if (wantsBox) {
      let best = null, bestD = 70;
      for (const b of boxes) {
        const d = Math.hypot(b.x - k.position.x, b.z - k.position.z);
        // Boxes on high decks read as "nearby" in 2D while being a climb away —
        // only chase one near our own level.
        if (d < bestD && Math.abs(b.y - k.position.y) < 4) {
          bestD = d;
          best = b;
        }
      }
      if (best) return { x: best.x, z: best.z };
    }
    let best = null, bestD = Infinity;
    for (const other of karts) {
      if (other === k || other._koTimer > 0) continue;
      const d = Math.hypot(other.position.x - k.position.x, other.position.z - k.position.z);
      if (d < bestD) {
        bestD = d;
        best = other;
      }
    }
    return best ? { kart: best } : null;
  }
}
