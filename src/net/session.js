// Multiplayer session orchestration — the netcode half of what used to live
// inline in main.js. Owns the MP state (connection, remote roster, parked
// ghosts, send accumulator, adaptive interp delay), the Net event wiring, the
// per-frame update (pose broadcast + ghost interpolation + reaping), and the
// player-vs-ghost collision pass.
//
// Everything game- or DOM-shaped is injected: how to build/dispose a remote
// kart, how to read the local player's pose, and hooks for the UI reactions
// (status readouts, lobby refresh, race start, hairball spawns, spin-outs,
// results). That keeps this file headless — the netsim harness runs the real
// session with stub remotes and a virtual clock, so the exact send loop and
// delay adaptation the game ships is what gets measured.

import { Net } from "./net.js";
import { INTERP_DELAY } from "./remotepose.js";

// Up to 6 players share a race (you + 5 others). The grid, headlight pool and
// placement all scale to this; a late 7th joiner is kept out of the rendered field.
export const MAX_PLAYERS = 6;

// Soft-despawn grace: a peer whose presence flaps (a mobile reconnect) is "parked"
// hidden for this long and REVIVED on rejoin, instead of being destroyed and
// rebuilt. The old destroy/recreate churned a fresh Kart every blip — and
// dispose() only removes from the scene (it can't free the cat's shared materials
// safely), so that churn leaked GPU memory until the tab crashed. Parked ghosts
// live OUTSIDE remotes, so peer counts / placement / rendering see only the
// active field, unchanged.
export const REMOTE_GRACE_MS = 12000;

// Shared kart-vs-kart collision constants, used by BOTH single-player
// (main.js resolveCollisions) and the multiplayer remote-kart path here, so
// the two can never drift out of parity.
export const KART_COLLIDE_MIN = 4.4; // contact diameter
export function kartBumpPower(aSpeed, bSpeed) {
  // Bumper impulse, scaled by how fast the pair is moving.
  return 10 + (Math.abs(aSpeed) + Math.abs(bSpeed)) * 0.4;
}

export class MpSession {
  constructor({
    createRemote, // (identity) => remote kart (RemoteKart in game; headless stub in sim)
    disposeRemote, // (remote) => void — free it for good
    hasLocalPlayer = () => false,
    getPose = () => null, // () => { x, y, z, h, p, s, f, pr }, read only on send ticks
    amHost = () => false,
    wallNow = () => performance.now(),
    netOptions = {}, // extra Net constructor options (the sim injects timers/localNow)
    hooks = {},
  } = {}) {
    this._createRemote = createRemote;
    this._disposeRemote = disposeRemote;
    this._hasLocalPlayer = hasLocalPlayer;
    this._getPose = getPose;
    this._amHost = amHost;
    this._wallNow = wallNow;
    this._netOptions = netOptions;
    this._hooks = hooks;

    // Public state — field-compatible with the old main.js `MP` god-object, so
    // the many scattered reads (lobby, minimap, placement, countdown, results)
    // keep working unchanged.
    this.enabled = false;
    this.net = null;
    this.remotes = new Map();
    this.parked = new Map(); // id -> { r, since } — soft-despawned ghosts held for revival
    this.sendAcc = 0;
    this.hudAcc = 0;
    this.hud = null; // owned by main.js (DOM); lives here so setMpStatus can reach it
    this.inLobby = false;
    this.startAt = 0;
    this.connState = null;
    this.interpDelay = INTERP_DELAY; // adaptive: eased toward a target from the live ping
  }

  _emit(name, ...args) {
    const fn = this._hooks[name];
    if (fn) fn(...args);
  }

  // Wire the Net event handlers onto a resolving transport and connect.
  // `identityFn` is called once the transport is up (matching the old inline
  // timing, so a garage change while connecting still lands in the hello).
  // Returns the promise so the caller owns error handling/reporting.
  begin(transportPromise, identityFn) {
    return transportPromise.then((transport) => {
      const net = new Net(transport, identityFn(), this._netOptions);
      this.net = net;
      net.on("peer", (identity) => {
        this.spawn(identity);
        this._emit("onRoster"); // refresh the "N friends here" count immediately
      });
      net.on("peerleave", (id) => {
        this.despawn(id);
        this._emit("onRoster");
      });
      // Once our own connection is acknowledged, fill in the lobby (it may have
      // been opened before the socket finished connecting).
      net.on("open", () => this._emit("onRoster"));
      net.on("close", () => this._emit("onConnClosed"));
      net.on("state", (id, pose) => {
        const r = this.remotes.get(id);
        if (r) r.pushState(pose);
      });
      net.on("start", (at) => this._emit("onStart", at));
      net.on("shoot", (s) => this._emit("onShoot", s));
      net.on("hit", (h) => {
        // Only the targeted client reacts; the victim's own shield gets last say
        // (that check lives in the hook, with the rest of the game state).
        if (h.target !== net.id) return;
        this._emit("onHit", h);
      });
      net.on("finish", (id, ft, fc) => {
        const r = this.remotes.get(id);
        if (r) {
          r.finished = true;
          r.finishTime = ft;
          r.finishClock = fc || 0;
        }
        // The hook slots a late finisher into an already-open results screen.
        this._emit("onRemoteFinish", id);
      });
      net.connect();
    });
  }

  // Drop the connection + remote karts. Pure netcode teardown — the caller owns
  // UI state (hud element, graphics quality, URL params).
  teardown() {
    if (this.net) {
      try { this.net.close(); } catch { /* ignore */ }
      this.net = null;
    }
    for (const id of [...this.remotes.keys()]) this.despawn(id, true);
    for (const [, p] of this.parked) this._disposeRemote(p.r); // drop any parked ghosts too
    this.parked.clear();
    this.enabled = false;
    this.inLobby = false;
    this.startAt = 0;
  }

  // Total humans currently in the room (me + rendered remotes).
  playerCount() {
    return 1 + this.remotes.size;
  }

  // The same sorted id order assigns starting-grid slots so players don't stack up.
  orderedIds() {
    const ids = [this.net && this.net.id, ...this.remotes.keys()].filter(Boolean);
    ids.sort();
    return ids;
  }

  // The host is simply the player who CREATED the room (clicked Host Game) — not
  // whoever drew the lowest id. `amHost` is authoritative for me; the same flag
  // rides in every identity so I can tag the host (👑) in the player list. No
  // lowest-id election (that was the bug), so a guest never transiently sees Start.
  // (If the host leaves, the room just can't launch — host migration is a separate
  // feature.)
  hostId() {
    if (this._amHost() && this.net && this.net.id) return this.net.id;
    for (const r of this.remotes.values()) if (r.host) return r.id;
    return null;
  }

  gridSlot() {
    const i = this.net ? this.orderedIds().indexOf(this.net.id) : 0;
    return Math.max(0, i);
  }

  spawn(identity) {
    if (this.remotes.has(identity.id)) return;
    // Revive a parked ghost (peer flapped and returned) — reuse the kart and its
    // interpolation buffer instead of churning a new one.
    const parked = this.parked.get(identity.id);
    if (parked) {
      this.parked.delete(identity.id);
      parked.r.host = !!identity.host;
      if (parked.r.group) parked.r.group.visible = true;
      this.remotes.set(identity.id, parked.r);
      return;
    }
    // Cap the rendered field at MAX_PLAYERS (you + MAX_PLAYERS-1 remotes). Beyond
    // that the grid/headlight pool run out, so extra joiners aren't drawn into the
    // race. (Realistically a friends' room is ≤6; a true server-side cap would need
    // room logic Ably's client-side presence doesn't provide.)
    if (this.remotes.size >= MAX_PLAYERS - 1) return;
    const r = this._createRemote(identity);
    r.host = !!identity.host; // remember who the room's host is (for the 👑 + Start)
    this.remotes.set(identity.id, r);
  }

  // `force` tears the ghost down immediately (leaving multiplayer); otherwise it's
  // a soft despawn — parked for possible revival within the grace window, then
  // reaped by the sweeper in update().
  despawn(id, force = false) {
    const r = this.remotes.get(id) || (this.parked.get(id) && this.parked.get(id).r);
    if (!r) return;
    this.remotes.delete(id);
    if (force) {
      this.parked.delete(id);
      this._disposeRemote(r);
      return;
    }
    if (r.group) r.group.visible = false;
    this.parked.set(id, { r, since: this._wallNow() });
  }

  // Broadcast my pose (~16 Hz) and interpolate every ghost kart. Runs every frame
  // while connected, in any game state, so remote karts glide continuously.
  update(dt) {
    if (!this.enabled || !this.net) return;
    const net = this.net;
    if (net.connected && this._hasLocalPlayer()) {
      this.sendAcc += dt;
      // ~16 Hz. Interpolation (with the 200ms delay) reconstructs smooth motion from
      // this, and the lower rate roughly halves the per-channel message load vs the
      // old 25 Hz — easing the relay so a busy room is less likely to drop/throttle
      // a player's updates (which froze their kart on everyone else's screen).
      if (this.sendAcc >= 1 / 16) {
        this.sendAcc = 0;
        const pose = this._getPose();
        if (pose) net.sendState(pose);
      }
    }
    // Adapt the interpolation delay to the live connection: cover roughly one-way
    // latency (half the round-trip) plus a jitter margin, so a laggy link buffers
    // more (smoother, fewer dead-reckon snaps) and a snappy link buffers less (more
    // responsive). Eased slowly so the render time never lurches.
    const rttMs = net.clock && Number.isFinite(net.clock.rtt) ? net.clock.rtt : 0;
    const targetDelay = Math.max(180, Math.min(280, rttMs * 0.5 + 150));
    this.interpDelay += (targetDelay - this.interpDelay) * Math.min(1, dt * 0.5); // ~2s time-constant
    const rt = net.now() - this.interpDelay; // render remote karts slightly in the past
    for (const r of this.remotes.values()) r.update(rt, dt);
    // Reap parked ghosts whose grace has elapsed (peer really left, not a flap).
    if (this.parked.size) {
      const nowMs = this._wallNow();
      for (const [id, p] of this.parked) {
        if (nowMs - p.since > REMOTE_GRACE_MS) { this._disposeRemote(p.r); this.parked.delete(id); }
      }
    }

    this.hudAcc += dt;
    if (this.hudAcc >= 0.5) {
      this.hudAcc = 0;
      // The hook refreshes the debug readout / lobby line through the shared
      // status formatter, so peers/ping update while connected.
      this._emit("onStatusTick");
    }
  }

  // Multiplayer: bump against remote ghost karts. We only ever move OUR OWN player
  // out of the overlap — the ghost's pose is network-driven, so nudging it would
  // just fight interpolation and jitter. The other client resolves the mirror
  // collision against our ghost, so both sides agree without any referee.
  resolveRemoteCollisions(player) {
    if (!this.enabled || !player) return;
    const min = KART_COLLIDE_MIN;
    for (const [rid, r] of this.remotes) {
      if (!r._ready) continue; // no real pose yet — don't collide at the origin
      const g = r.kart;
      const dx = g.position.x - player.position.x;
      const dz = g.position.z - player.position.z;
      const distSq = dx * dx + dz * dz;
      if (distSq <= 0.0001 || distSq >= min * min) continue;

      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const nz = dz / dist;
      const overlap = min - dist;

      // The masses match single-player (you're 1.35, the ghost is 1.0 — same as
      // you-vs-AI), so the shares below are EXACTLY what resolveCollisions() uses.
      const ima = 1 / player.mass;
      const img = 1 / g.mass;
      const inv = ima + img;
      const sp = ima / inv; // player's share
      const sg = img / inv; // ghost's share

      // Position: the player still takes the WHOLE separation (the ghost can't move
      // authoritatively, and clearing the overlap in one frame keeps repeated
      // contact from flinging the ghost). This is a position detail, not the carom.
      player.position.x -= nx * overlap;
      player.position.z -= nz * overlap;

      // Carom: the player's knock is now the SAME mass-share bumper impulse as
      // single-player (no amplification), so ramming a rival online feels exactly
      // like ramming an AI. This knock moves the player's real position, which
      // propagates over the network — the other client independently resolves the
      // mirror contact against its ghost of us, so both sides feel a bump with no
      // referee (they needn't match exactly).
      const power = kartBumpPower(player.speed, g.speed);
      player.knock.x -= nx * power * sp;
      player.knock.z -= nz * power * sp;
      player.speed *= 0.99; // same tiny scrub as single-player

      // Cosmetic-only nudge on the ghost (instant local feedback) at the ghost's
      // mass share — the authoritative slide arrives over the network shortly after.
      r.bump(nx, nz, power * sg);

      // Catnip ram across the network: tell the rival to spin out (their client
      // honours their own shield). Debounced so contact doesn't spam hits.
      if (player.catnipBoosting && this.net) {
        const now = this._wallNow();
        if (!r._lastRam || now - r._lastRam > 1200) {
          r._lastRam = now;
          this.net.sendHit(rid, { x: nx, z: nz });
        }
      }
    }
  }
}
