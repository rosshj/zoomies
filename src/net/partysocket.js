// PartyKit transport adapter: wraps a PartySocket as the generic transport the
// Net facade expects ({ send, close, open, onmessage/onopen/onclose }). The
// `partysocket` client is imported lazily so it's only fetched when multiplayer
// is actually used — single-player never touches the network or this code.

// Buffers any messages that arrive before Net assigns its onmessage handler, so
// the server's immediate 'welcome' can never be dropped on a fast connection.
class PartyTransport {
  constructor(socket) {
    this.socket = socket;
    this._onmessage = null;
    this._queue = [];
    this.onopen = null;
    this.onclose = null;

    socket.addEventListener("message", (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (this._onmessage) this._onmessage(m);
      else this._queue.push(m);
    });
    socket.addEventListener("open", () => this.onopen && this.onopen());
    socket.addEventListener("close", () => this.onclose && this.onclose());
  }

  get onmessage() {
    return this._onmessage;
  }
  set onmessage(fn) {
    this._onmessage = fn;
    if (fn) while (this._queue.length) fn(this._queue.shift());
  }

  open() {} // PartySocket auto-connects on construction
  send(obj) {
    if (this.socket.readyState === 1 /* OPEN */) this.socket.send(JSON.stringify(obj));
  }
  close() {
    this.socket.close();
  }
}

// Create a transport connected to `room` on `host`. `host` is bare, e.g.
// "zoomies.you.partykit.dev" or "127.0.0.1:1999".
export async function createPartyTransport({ host, room }) {
  const mod = await import("partysocket");
  const PartySocket = mod.PartySocket || mod.default;
  const socket = new PartySocket({ host, room });
  return new PartyTransport(socket);
}
