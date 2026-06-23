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
      case 'state':
        this._channel.publish('state', obj).catch(() => {});
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
  const selfId = makeId();

  const client = new Realtime({ key, clientId: selfId });
  const channel = client.channels.get(`zoomies:${room}`);
  const transport = new AblyTransport(client, channel, selfId);

  await new Promise((resolve, reject) => {
    client.connection.once('connected', async () => {
      try {
        // Synthetic welcome — lets Net assign our id and kick off hello + pings.
        transport._emit({ type: 'welcome', id: selfId });

        // State snapshots from remote karts.
        channel.subscribe('state', (msg) => {
          if (msg.clientId === selfId) return;
          transport._emit({ type: 'state', id: msg.clientId, ...msg.data });
        });

        // Peer presence.
        channel.presence.subscribe('enter', (member) => {
          if (member.clientId === selfId) return;
          transport._emit({ type: 'hello', id: member.clientId, ...member.data });
        });
        channel.presence.subscribe('update', (member) => {
          if (member.clientId === selfId) return;
          transport._emit({ type: 'hello', id: member.clientId, ...member.data });
        });
        channel.presence.subscribe('leave', (member) => {
          transport._emit({ type: 'bye', id: member.clientId });
        });

        // Catch up on peers already in the room before we joined.
        const members = await channel.presence.get();
        for (const m of members) {
          if (m.clientId !== selfId) {
            transport._emit({ type: 'hello', id: m.clientId, ...m.data });
          }
        }

        resolve();
      } catch (e) {
        reject(e);
      }
    });
    client.connection.once('failed', () => reject(new Error('Ably connection failed')));
  });

  client.connection.on('closed', () => { if (transport.onclose) transport.onclose(); });
  client.connection.on('failed', () => { if (transport.onclose) transport.onclose(); });

  return transport;
}
