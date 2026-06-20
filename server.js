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
const wss = new WebSocketServer({ port: PORT });

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

wss.on('connection', (ws) => {
  ws.id = String(nextId++);
  ws.room = null;
  ws.role = null;

  ws.on('message', (raw) => {
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
        const room = existing || { host: null, peers: new Map() };
        room.host = ws;
        rooms.set(code, room);
        ws.room = code;
        ws.role = 'host';
        send(ws, { type: 'hosting', room: code, id: ws.id });
        break;
      }

      case 'join': {
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
        let target = null;
        if (room.host && room.host.id === msg.to) target = room.host;
        else target = room.peers.get(msg.to);
        send(target, { type: 'signal', from: ws.id, data: msg.data });
        break;
      }
    }
  });

  ws.on('close', () => {
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
