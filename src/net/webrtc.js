// WebRTC peer-to-peer transport (opt-in via ?rtc=1).
//
// Same { send, onmessage, close, open } interface every transport exposes, so the
// game/Net code is unchanged. The difference is WHERE the packets travel:
//
//   • Presence, the shared clock (ping/pong), connection status, the signalling
//     handshake, and the low-frequency events (start/shoot/hit/finish) ride the
//     Ably transport underneath — reliable, and their latency doesn't matter.
//   • The high-frequency STATE stream (each kart's ~16 Hz pose) is sent DIRECTLY
//     peer-to-peer over WebRTC data channels. On a LAN that's a ~1-5 ms hop
//     instead of a ~50-150 ms round trip to Ably's cloud — the felt-lag win.
//
// A full mesh (each peer connects to each other peer) is fine at 2-6 players.
// Until a peer's data channel is open, that peer's state falls back to Ably, and
// the receiver drops the Ably copy once the P2P link is live (so no duplicates).
// A non-WebRTC peer simply never opens a channel, so everything with them stays on
// Ably — the mode is backward-compatible.
import { createAblyTransport } from "./ably.js";
import { resolveIceServers } from "./config.js";
import { encodePosePacket, decodePosePacket } from "./posecodec.js";

// ICE servers (STUN, and optional TURN relay for symmetric-NAT peers) come from
// config.js so a deploy can add TURN without touching this file. Computed once at
// module load (config guards `location` so this is node-safe for net-check).
const RTC_CONFIG = { iceServers: resolveIceServers() };

// Deterministic initiator so the two sides don't both send an offer (glare):
// the lexicographically-lower id makes the offer, the other one answers.
export function isInitiator(selfId, peerId) {
  return String(selfId) < String(peerId);
}

// Should a STATE message that arrived via the Ably fallback be used, or dropped as
// a duplicate because we already have a live P2P link to the sender? (Pure so it's
// unit-testable.)
export function acceptAblyState(peer) {
  return !(peer && peer.ready);
}

export class WebRTCTransport {
  constructor(ably) {
    this._ably = ably;
    this._selfId = null;
    this._peers = new Map(); // id -> { pc, dc, ready, pendingIce: [] }
    this._onmessage = null;
    this.onopen = null;
    this.onclose = null;
    // Our own recent outgoing poses (newest-first, cap 3) — each P2P packet
    // piggybacks the last few for loss recovery (see posecodec.js).
    this._poseHistory = [];
    this._lastAblyState = 0; // throttle the Ably state fallback to ~16 Hz
  }

  get onmessage() { return this._onmessage; }
  set onmessage(fn) { this._onmessage = fn; }

  open() {
    // Route the Ably transport's stream through us (draining its queued 'welcome').
    this._ably.onmessage = (m) => this._fromAbly(m);
    this._ably.onclose = () => { if (this.onclose) this.onclose(); };
    if (this._ably.open) this._ably.open();
  }

  send(obj) {
    switch (obj.type) {
      case "ping":   // clock sync — Ably answers with server time
      case "hello":  // presence/identity — Ably presence
        this._ably.send(obj);
        break;
      case "state":  // the latency-critical stream — peer-to-peer where we can
        this._broadcastState(obj);
        break;
      default:       // start / shoot / hit / finish — reliable, latency-tolerant
        this._ably.send(obj);
        break;
    }
  }

  // How many peers are on a live direct data channel right now (for the debug HUD).
  p2pCount() {
    let n = 0;
    for (const p of this._peers.values()) if (p.ready) n++;
    return n;
  }

  close() {
    for (const p of this._peers.values()) this._closePeer(p);
    this._peers.clear();
    this._ably.close?.();
  }

  // --- Ably side: signalling, presence, clock, and the state fallback ---
  _fromAbly(m) {
    if (m.type === "welcome") { this._selfId = m.id; this._emit(m); return; }
    if (m.type === "rtc") { this._onSignal(m); return; } // internal — never a game message
    if (m.type === "hello") { this._ensurePeer(m.id); this._emit(m); return; }
    if (m.type === "bye") { this._dropPeer(m.id); this._emit(m); return; }
    if (m.type === "state") {
      // Ably fallback copy — drop it if this sender already has a live P2P link.
      if (!acceptAblyState(this._peers.get(m.id))) return;
      this._emit(m);
      return;
    }
    this._emit(m); // pong / start / shoot / hit / finish
  }

  _emit(m) { if (this._onmessage) this._onmessage(m); }

  _broadcastState(obj) {
    // Piggyback the last few poses so a dropped datagram is recovered from the
    // next packet (FEC). History is always our own outgoing pose.
    this._poseHistory.unshift(obj);
    if (this._poseHistory.length > 3) this._poseHistory.length = 3;
    const packet = encodePosePacket(this._poseHistory); // binary; no id/type (peer-known)

    let anyOnAbly = this._peers.size === 0; // no peers yet → nothing to do but keep Ably warm
    for (const p of this._peers.values()) {
      if (p.ready && p.dc && p.dc.readyState === "open") {
        try { p.dc.send(packet); }
        catch { anyOnAbly = true; }
      } else {
        anyOnAbly = true; // still connecting — this peer needs the Ably copy
      }
    }
    if (anyOnAbly) this._ablyState(obj); // reaches connecting peers; live P2P peers drop the dupe
  }

  // Ably state fallback, throttled to ~16 Hz. The P2P channel may run at 30 Hz,
  // but during the brief connecting window we don't want to push 30 messages/s
  // onto the shared Ably connection (per-message rate limits). The fallback peer
  // is the degraded path anyway; 16 Hz there is plenty. Uses Date.now (wall) — a
  // rate gate, unrelated to the shared clock.
  _ablyState(obj) {
    const now = Date.now();
    if (now - this._lastAblyState < 1000 / 16) return;
    this._lastAblyState = now;
    this._ably.send(obj); // unchanged JSON-object shape (Ably path stays object-based)
  }

  // --- Peer connections (mesh) ---
  _ensurePeer(peerId) {
    if (!peerId || peerId === this._selfId || this._peers.has(peerId)) return;
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const rec = { pc, dc: null, ready: false, pendingIce: [] };
    this._peers.set(peerId, rec);

    pc.onicecandidate = (e) => { if (e.candidate) this._signal(peerId, { kind: "ice", cand: e.candidate }); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        // A dead connection can't recover (no ICE restart here) — tear it down and
        // forget the record, so state falls back to Ably and a fresh handshake can
        // rebuild the link if the peer reappears. Without this, failed peers and
        // their buffered ICE candidates lingered in the map for the whole session.
        this._dropPeer(peerId);
      }
    };

    const wire = (dc) => {
      rec.dc = dc;
      dc.binaryType = "arraybuffer"; // receive pose packets as ArrayBuffer, not Blob
      dc.onopen = () => { rec.ready = true; };
      dc.onclose = () => { rec.ready = false; };
      dc.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          // Safety / back-compat path (a peer still sending JSON).
          try { this._emit(JSON.parse(ev.data)); } catch { /* ignore */ }
          return;
        }
        // Binary pose packet: the sender is THIS channel's peer, so stamp its id
        // (the payload carries none). Emit each pose ascending-t so pushSnapshot
        // accepts the piggybacked redundancy.
        try {
          const poses = decodePosePacket(ev.data);
          for (const pose of poses) this._emit({ type: "state", id: peerId, ...pose });
        } catch { /* ignore a malformed frame */ }
      };
    };

    if (isInitiator(this._selfId, peerId)) {
      // Unreliable + unordered: a lossy pose stream must not head-of-line-block
      // (one dropped datagram would stall every later pose behind a retransmit).
      // FEC (piggybacked poses) recovers drops; pushSnapshot tolerates reordering.
      wire(pc.createDataChannel("game", { ordered: false, maxRetransmits: 0 }));
      pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .then(() => this._signal(peerId, { kind: "offer", sdp: pc.localDescription }))
        .catch(() => {});
    } else {
      pc.ondatachannel = (e) => wire(e.channel);
    }
  }

  _onSignal(m) {
    if (m.to !== this._selfId) return; // addressed to a different peer
    const from = m.from || m.id;
    this._ensurePeer(from);
    const rec = this._peers.get(from);
    if (!rec) return;
    const pc = rec.pc;
    if (m.kind === "offer") {
      pc.setRemoteDescription(m.sdp)
        .then(() => this._flushIce(rec))
        .then(() => pc.createAnswer())
        .then((a) => pc.setLocalDescription(a))
        .then(() => this._signal(from, { kind: "answer", sdp: pc.localDescription }))
        .catch(() => {});
    } else if (m.kind === "answer") {
      pc.setRemoteDescription(m.sdp).then(() => this._flushIce(rec)).catch(() => {});
    } else if (m.kind === "ice") {
      // Candidates can arrive before the remote description is set — buffer them.
      // Capped: if the offer/answer never lands (lost signalling), the buffer
      // must not grow forever off a peer that keeps trickling candidates.
      if (pc.remoteDescription) pc.addIceCandidate(m.cand).catch(() => {});
      else if (rec.pendingIce.length < 64) rec.pendingIce.push(m.cand);
    }
  }

  _flushIce(rec) {
    const pc = rec.pc;
    for (const c of rec.pendingIce) pc.addIceCandidate(c).catch(() => {});
    rec.pendingIce.length = 0;
  }

  _signal(peerId, payload) {
    this._ably.send({ type: "rtc", to: peerId, from: this._selfId, ...payload });
  }

  _dropPeer(id) {
    const p = this._peers.get(id);
    if (p) { this._closePeer(p); this._peers.delete(id); }
  }
  _closePeer(p) {
    try { p.dc && p.dc.close(); } catch { /* ignore */ }
    try { p.pc && p.pc.close(); } catch { /* ignore */ }
    p.ready = false;
  }
}

// Built on top of the Ably transport (its signalling / presence / clock backbone).
export async function createWebRTCTransport(opts) {
  const ably = await createAblyTransport(opts);
  return new WebRTCTransport(ably);
}
