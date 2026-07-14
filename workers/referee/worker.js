// Cloudflare Worker + Durable Object: the OPTIONAL race referee server (Stage 4).
//
// This is a thin WebSocket shell around the pure RefereeRoom brain in
// src/net/referee.js — all the adjudication logic lives there and is unit-tested
// headless. One Durable Object instance == one race room; clients open a second
// (referee) WebSocket to it alongside their peer-to-peer pose channel. The DO
// never touches positions for rendering — it only ingests lightweight state for
// LAG COMPENSATION and returns verdicts on hits / laps / finish order.
//
// Runs on the Cloudflare Workers FREE plan (SQLite-backed DO; we keep all state
// in memory since a race lives only minutes, so nothing is written to storage).
// Uses the WebSocket Hibernation API so an idle room costs nothing.
//
// Deploy: see workers/referee/DEPLOY.md. The referee is off unless the client is
// pointed at this Worker's URL (?ref=<url> or the built-in default) — the game is
// 100% unchanged without it.
//
// Wire protocol (JSON):
//   client -> DO : {type:"join", id, name?}
//                  {type:"state", id, t, x, z, f, pr}     (lag-comp feed, ~10Hz)
//                  {type:"hitclaim", id, target, t, dir}  (shooter reports a hit)
//                  {type:"finishclaim", id}
//   DO -> client : {type:"welcome", id, standings}
//                  {type:"hitv", target, by, dir, at}     (apply the spin)
//                  {type:"lapv", id, lap, at}
//                  {type:"finishv", id, place, at}
//                  {type:"reject", of, reason}            (diagnostic; ignorable)

import { RefereeRoom } from "../../src/net/referee.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "access-control-allow-origin": "*" } });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket (see workers/referee/DEPLOY.md)", { status: 426 });
    }
    // Route to the room named by ?room=… (default "main"). All clients that pass
    // the same room name land on the same Durable Object instance.
    const room = url.searchParams.get("room") || "main";
    const id = env.RACE_REFEREE.idFromName(room);
    return env.RACE_REFEREE.get(id).fetch(request);
  },
};

export class RaceReferee {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // Rebuild the in-memory room. On DO wake after hibernation the room is empty;
    // clients re-`join` and re-stream state, which is fine — a fresh race, or a
    // reconnect that quickly re-warms the lag-comp buffers.
    this.room = new RefereeRoom({ now: () => Date.now(), totalLaps: Number(env.TOTAL_LAPS) || 3 });
    // Re-adopt any sockets still open across a hibernation wake.
    for (const ws of state.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att && att.id) this.room.join(att.id);
    }
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Hibernation: the runtime can evict us from memory while keeping the socket
    // open, delivering messages via webSocketMessage without a live JS instance
    // pinned in RAM — so an idle room is free.
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.type !== "string") return;

    switch (m.type) {
      case "join": {
        if (!m.id) return;
        ws.serializeAttachment({ id: m.id }); // survives hibernation
        this.room.join(m.id);
        this._send(ws, { type: "welcome", id: m.id, standings: this.room.standings() });
        break;
      }
      case "state": {
        if (!m.id) return;
        const lap = this.room.ingestState(m.id, { t: m.t, x: m.x, z: m.z, f: m.f | 0, pr: m.pr });
        if (lap) this._broadcast({ type: "lapv", id: lap.id, lap: lap.lap, at: lap.at });
        break;
      }
      case "hitclaim": {
        const v = this.room.adjudicateHit({ shooter: m.id, target: m.target, t: m.t, dir: m.dir });
        if (v.ok) this._broadcast({ type: "hitv", target: v.event.target, by: v.event.by, dir: v.event.dir, at: v.event.at });
        else this._send(ws, { type: "reject", of: "hit", reason: v.reason });
        break;
      }
      case "finishclaim": {
        const v = this.room.adjudicateFinish(m.id);
        if (v.ok) this._broadcast({ type: "finishv", id: v.event.id, place: v.event.place, at: v.event.at });
        else this._send(ws, { type: "reject", of: "finish", reason: v.reason });
        break;
      }
    }
  }

  webSocketClose(ws) {
    const att = ws.deserializeAttachment();
    // Keep the player's referee record around: they may reconnect mid-race, and
    // dropping their finish/place on a blip would be worse than a stale entry.
    // Rooms are short-lived and evicted whole, so this never accumulates.
    if (att && att.id) { /* intentionally retained */ }
    try { ws.close(); } catch { /* already closed */ }
  }

  webSocketError(ws) {
    try { ws.close(); } catch { /* already closed */ }
  }

  _send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch { /* socket gone */ }
  }
  _broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(s); } catch { /* skip dead sockets */ }
    }
  }
}
