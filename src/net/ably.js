// Ably Realtime transport adapter — maps Ably pub/sub + presence to the same
// { send(obj), onmessage, onopen, onclose } interface that Net expects.
// No server-side relay needed: Ably handles fan-out, presence (with late-join
// catchup), and authoritative server timestamps via client.time().
//
// Set ABLY_KEY in src/net/config.js (publishable key, safe to expose) then
// add &mp=1 to the URL. Room name = world seed, so the same ?seed= is a lobby.

function makeId() {
  return (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 16);
}

// A STABLE per-tab id. On a reload, Ably keeps the previous connection's
// presence entry alive for a while before it times out — with a fresh random id
// each load, the other players briefly see that stale entry as a phantom extra
// player. Reusing the same id (persisted for the tab) means the old and new
// presence entries share a clientId and collapse into one in the set-based diff.
function getClientId() {
  try {
    let id = sessionStorage.getItem("zoomies_cid");
    if (!id) {
      id = makeId();
      sessionStorage.setItem("zoomies_cid", id);
    }
    return id;
  } catch {
    return makeId(); // private mode / no storage — fall back to a fresh id
  }
}

class AblyTransport {
  constructor(client, channel, selfId) {
    this._client = client;
    this._channel = channel;
    this._id = selfId;
    this._onmessage = null;
    this._queue = [];
    this.onopen = null;
    this.onclose = null;
  }

  get onmessage() { return this._onmessage; }
  set onmessage(fn) {
    this._onmessage = fn;
    if (fn) while (this._queue.length) fn(this._queue.shift());
  }

  _emit(msg) {
    if (this._onmessage) this._onmessage(msg);
    else this._queue.push(msg);
  }

  open() {} // Ably auto-connects on construction

  send(obj) {
    switch (obj.type) {
      case 'ping': {
        const c = obj.c;
        // client.time() returns Ably's server clock — perfect for NTP-style sync.
        this._client.time().then((S) => this._emit({ type: 'pong', c, S })).catch(() => {});
        break;
      }
      case 'hello':
        // clientId was set to selfId at construction, so member.clientId == our id.
        this._channel.presence.enter({ name: obj.name, color: obj.color, catColor: obj.catColor })
          .catch(() => {});
        break;
      default:
        // state / start / hit / finish … all relayed as channel messages.
        this._channel.publish(obj.type, obj).catch(() => {});
        break;
    }
  }

  close() {
    this._channel.presence.leave().catch(() => {});
    this._client.close();
  }
}

// Returns a transport that is already connected and has 'welcome' queued.
// Net.connect() drains the queue, triggering the normal hello/ping sequence.
export async function createAblyTransport({ key, room }) {
  const mod = await import('ably');
  const Realtime = mod.Realtime ?? mod.default?.Realtime ?? mod.default;
  const selfId = getClientId();

  const client = new Realtime({ key, clientId: selfId });
  const channel = client.channels.get(`zoomies:${room}`);
  const transport = new AblyTransport(client, channel, selfId);

  // Presence as a SET, not a stream of deltas. Relying on individual
  // enter/leave events is fragile — a missed event or a brief reconnect leaves
  // the two sides disagreeing about who's in the room (one shows peers 0, the
  // other peers 1). Instead, on every presence change we re-fetch the full
  // membership and diff it, emitting hello for newcomers and bye for departures.
  // This is idempotent (Net dedupes), self-heals after reconnects, and is cheap
  // because presence changes are rare.
  let present = new Set();
  async function resyncPresence() {
    let members;
    try {
      members = await channel.presence.get();
    } catch {
      return;
    }
    const now = new Set();
    for (const m of members) {
      if (m.clientId === selfId) continue;
      now.add(m.clientId);
      if (!present.has(m.clientId)) {
        transport._emit({ type: 'hello', id: m.clientId, ...m.data });
      }
    }
    for (const id of present) {
      if (!now.has(id)) transport._emit({ type: 'bye', id });
    }
    present = now;
  }

  await new Promise((resolve, reject) => {
    client.connection.once('connected', async () => {
      try {
        // Synthetic welcome — lets Net assign our id and kick off hello + pings.
        transport._emit({ type: 'welcome', id: selfId });

        // Any published channel message (state/start/hit/finish) relays back,
        // stamped with the authoritative sender id.
        channel.subscribe((msg) => {
          if (msg.clientId === selfId) return;
          transport._emit({ ...msg.data, id: msg.clientId });
        });

        // Any presence action (enter/leave/update/present) triggers a full
        // re-sync, so both sides always converge on the same membership.
        channel.presence.subscribe(() => resyncPresence());

        await resyncPresence(); // initial membership
        resolve();
      } catch (e) {
        reject(e);
      }
    });
    client.connection.once('failed', () => reject(new Error('Ably connection failed')));
  });

  // A dropped-and-resumed connection can miss presence deltas; re-sync on every
  // reconnect so we never get stuck believing a peer is absent (or still here).
  client.connection.on('connected', () => resyncPresence());

  client.connection.on('closed', () => { if (transport.onclose) transport.onclose(); });
  client.connection.on('failed', () => { if (transport.onclose) transport.onclose(); });

  // Leave promptly on navigate-away/reload so peers don't have to wait for the
  // server-side presence timeout to notice we're gone.
  window.addEventListener('pagehide', () => {
    try {
      channel.presence.leave();
      client.close();
    } catch {}
  });

  return transport;
}
