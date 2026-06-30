// MAW Signaling Server
// ─────────────────────────────────────────────────────────────────────────────
// This is the ONLY piece of MAW that must live on the public internet. It does
// not touch your project, audio, or chat — it only brokers the initial WebRTC
// handshake (SDP offers/answers + ICE candidates) between a host and the guests
// joining their session. Once two peers are connected, all real traffic flows
// directly peer-to-peer and never passes through here.
//
// Deploy it once to any free Node host (Render / Railway / Fly). See README.md.
//
// Protocol (all messages are JSON):
//   client -> server  { type:'host',   room }            register as a session host
//   client -> server  { type:'join',   room }            ask to join a session
//   client -> server  { type:'signal', to, data }        relay SDP/ICE to a peer
//   server -> host    { type:'hosting', room, id }        room created, you own it
//   server -> host    { type:'peer-joined', id }          a guest wants to connect
//   server -> host    { type:'peer-left',  id }           a guest's socket dropped
//   server -> guest   { type:'joined', room, id, hostId } paired with the host
//   server -> guest   { type:'host-gone' }                host closed the session
//   server -> any     { type:'signal', from, data }       relayed SDP/ICE
//   server -> any     { type:'error',  reason }           bad-room|room-taken|no-room

const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 9000;
// Cap a single frame at 64KB — SDP/ICE messages are small, so anything larger is abuse.
// The ws library closes the connection (1009) if a peer exceeds this.
const wss = new WebSocketServer({ port: PORT, maxPayload: 64 * 1024 });

// ── Abuse limits ────────────────────────────────────────────────────────────
// This server is public and unauthenticated, so bound the resources a single
// source can consume: it can't open unlimited sockets (DoS / room-code brute force
// across connections) and the process can't be made to hold unlimited rooms.
const MAX_CONNS_PER_IP = 25;
const MAX_ROOMS = 10000;
const MAX_JOINS_PER_CONN = 60;        // a legit guest joins one room; this caps code-guessing
const connsByIp = new Map();          // ip -> open socket count

// Validate that an extracted IP is actually an IP (not a crafted header).
const IP_RE = /^([\d]{1,3}\.){3}[\d]{1,3}$|^[0-9a-fA-F:]{2,39}$/;
function clientIp(req) {
  // Behind Render/Railway/Fly the real client is in x-forwarded-for; fall back to the
  // socket address for direct/local connections.
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const candidate = String(xff).split(',')[0].trim();
    // Only trust if it looks like a real IP address, not a crafted value used to bypass rate limits.
    if (IP_RE.test(candidate)) return candidate;
  }
  return req.socket?.remoteAddress || 'unknown';
}

wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Another instance is already running on this port — that's fine, exit cleanly.
    process.exit(0);
  }
  console.error('Signaling server error:', err.message);
});

// rooms: roomCode -> { host: ws|null, peers: Map<signalId, ws> }
const rooms = new Map();
let nextId = 1;

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function normRoom(room) {
  return String(room || '').trim().toUpperCase();
}

wss.on('connection', (ws, req) => {
  // Per-IP connection cap — refuse (don't just drop) once a source is over budget.
  const ip = clientIp(req);
  const open = connsByIp.get(ip) || 0;
  if (open >= MAX_CONNS_PER_IP) { try { ws.close(1013, 'too-many'); } catch {} return; }
  connsByIp.set(ip, open + 1);

  ws.id = String(nextId++);
  ws.ip = ip;
  ws.room = null;
  ws.role = null;
  ws._rlStart = 0;
  ws._rlCount = 0;
  ws._rlDrops = 0;
  ws._joins = 0;

  ws.on('message', (raw) => {
    // Per-connection rate limit: legitimate signaling is a handful of messages per peer.
    // Drop anything past ~120/sec (cheap) so a misbehaving client can't flood the server.
    const now = Date.now();
    if (now - ws._rlStart > 1000) { ws._rlStart = now; ws._rlCount = 0; }
    if (++ws._rlCount > 120) {
      // After 600 excess messages (5 s of sustained abuse), terminate the connection.
      if (++ws._rlDrops > 600) { try { ws.close(1008, 'rate-exceeded'); } catch {} }
      return;
    }

    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'host': {
        const code = normRoom(msg.room);
        if (!code) return send(ws, { type: 'error', reason: 'bad-room' });
        const existing = rooms.get(code);
        if (existing && existing.host && existing.host.readyState === 1) {
          return send(ws, { type: 'error', reason: 'room-taken' });
        }
        // Bound total rooms so the process can't be made to hold unlimited state.
        if (!existing && rooms.size >= MAX_ROOMS) {
          return send(ws, { type: 'error', reason: 'server-full' });
        }
        const room = existing || { host: null, peers: new Map() };
        room.host = ws;
        rooms.set(code, room);
        ws.room = code;
        ws.role = 'host';
        send(ws, { type: 'hosting', room: code, id: ws.id });
        break;
      }

      case 'join': {
        // Cap join attempts per connection so a single socket can't sweep the room-code
        // keyspace (paired with the per-IP connection cap, this bounds brute force).
        if (++ws._joins > MAX_JOINS_PER_CONN) { try { ws.close(1013, 'too-many-joins'); } catch {} return; }
        const code = normRoom(msg.room);
        const room = rooms.get(code);
        if (!room || !room.host || room.host.readyState !== 1) {
          return send(ws, { type: 'error', reason: 'no-room' });
        }
        room.peers.set(ws.id, ws);
        ws.room = code;
        ws.role = 'guest';
        send(ws, { type: 'joined', room: code, id: ws.id, hostId: room.host.id });
        send(room.host, { type: 'peer-joined', id: ws.id });
        break;
      }

      case 'signal': {
        const room = rooms.get(ws.room);
        if (!room) return;
        // Enforce the star topology: a guest may only signal its host, and the host may
        // only signal its own guests. Stops a guest from relaying crafted SDP/ICE to
        // other guests (forcing unsolicited peer connections that bypass host approval).
        let target = null;
        if (ws.role === 'guest') {
          if (room.host && room.host.id === msg.to) target = room.host;
        } else if (ws.role === 'host' && room.host === ws) {
          target = room.peers.get(msg.to) || null;
        }
        send(target, { type: 'signal', from: ws.id, data: msg.data });
        break;
      }
    }
  });

  ws.on('close', () => {
    // Release this socket's slot in the per-IP budget.
    const n = (connsByIp.get(ws.ip) || 1) - 1;
    if (n <= 0) connsByIp.delete(ws.ip); else connsByIp.set(ws.ip, n);

    const room = rooms.get(ws.room);
    if (!room) return;
    if (ws.role === 'host' && room.host === ws) {
      // Host left — tell every guest the session is over and drop the room.
      for (const peer of room.peers.values()) send(peer, { type: 'host-gone' });
      rooms.delete(ws.room);
    } else if (ws.role === 'guest') {
      room.peers.delete(ws.id);
      send(room.host, { type: 'peer-left', id: ws.id });
    }
  });

  ws.on('error', () => {});
});

// Lightweight liveness ping so idle hosts (e.g. on free tiers) aren't culled.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState === 1) { try { ws.ping(); } catch {} }
  }
}, 30000);

console.log(`MAW signaling server listening on :${PORT}`);
