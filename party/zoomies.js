// PartyKit server — the realtime room for Zoomies multiplayer.
//
// One server instance per room. The room name is the world seed, so everyone on
// the same ?seed= shares both the world and the lobby. This is a thin RELAY: it
// assigns each connection an id, answers clock pings with its own time, caches
// each player's identity ("hello") so newcomers can be caught up, and forwards
// pose snapshots to everyone else. No game logic lives here yet — that's where a
// future referee (item hits, lap validation) would go in Phase 4.
//
// Deploy:  npx partykit deploy        (gives you  zoomies.<you>.partykit.dev)
// Dev:     npx partykit dev           (serves on  127.0.0.1:1999)

export default class ZoomiesServer {
  constructor(room) {
    this.room = room;
    this.hellos = new Map(); // connectionId -> last hello (identity), for catch-up
  }

  onConnect(conn) {
    // Tell the new client its server-assigned id; it replies with a hello.
    conn.send(JSON.stringify({ type: "welcome", id: conn.id }));
  }

  onMessage(raw, sender) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    // Stamp the authoritative sender id so a client can't impersonate another.
    if (m.id !== undefined) m.id = sender.id;

    switch (m.type) {
      case "ping":
        sender.send(JSON.stringify({ type: "pong", c: m.c, S: Date.now() }));
        break;

      case "hello": {
        this.hellos.set(sender.id, m);
        const msg = JSON.stringify(m);
        this.room.broadcast(msg, [sender.id]); // announce to everyone else
        // Catch the newcomer up on everyone already in the room.
        for (const [id, h] of this.hellos) {
          if (id !== sender.id) sender.send(JSON.stringify(h));
        }
        break;
      }

      case "state":
        this.room.broadcast(JSON.stringify(m), [sender.id]); // fan out to others
        break;
    }
  }

  onClose(conn) {
    this.hellos.delete(conn.id);
    this.room.broadcast(JSON.stringify({ type: "bye", id: conn.id }));
  }

  onError(conn) {
    this.onClose(conn);
  }
}
