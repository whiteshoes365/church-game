import { WebSocketServer } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  searchChurches,
  findOrCreateChurch,
  getChurch,
  listRooms,
  createRoom,
  getRoom,
  joinRoom,
  startQuiz,
  advanceQuestion,
  recordAnswer,
  revealAnswer,
  serializeRoom,
  serializeRoomSummary,
  setPlayerInput,
  requestPlayerJump,
  setAutoWalkTarget,
  tickRoomPhysics,
  serializePositions,
  allRooms,
  PHYSICS_TICK_MS,
} from './state.js';

const PORT = Number(process.env.PORT) || 8787;
const POSITIONS_BROADCAST_MS = 80; // ~12.5 Hz, within the 10-15 Hz target

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const httpServer = http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent((req.url || '/').split('?')[0]); } catch { rel = '/'; }
  let p = path.join(DIST, rel);
  if (!p.startsWith(DIST) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(DIST, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('church-game server ok'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
const wss = new WebSocketServer({ server: httpServer });
httpServer.listen(PORT);

function send(socket, type, payload) {
  if (socket && socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify({ type, ...payload }));
  }
}

function broadcastRoom(room) {
  const snapshot = serializeRoom(room);
  const sockets = [room.hostSocket, ...[...room.players.values()].map((p) => p.socket)];
  for (const s of sockets) send(s, 'roomState', { room: snapshot });
}

function onQuestionTimeout(room) {
  revealAnswer(room);
  broadcastRoom(room);
}

// Authoritative movement simulation ticks for every room all the time (cheap
// even with many rooms), but the compact position broadcast is only sent to
// rooms that are actually "in play" (question/reveal) and have a host
// watching, to keep bandwidth down.
setInterval(() => {
  for (const room of allRooms()) tickRoomPhysics(room, PHYSICS_TICK_MS);
}, PHYSICS_TICK_MS);

setInterval(() => {
  for (const room of allRooms()) {
    if (room.status !== 'question' && room.status !== 'reveal') continue;
    if (!room.hostSocket) continue;
    send(room.hostSocket, 'positions', { roomId: room.id, players: serializePositions(room) });
  }
}, POSITIONS_BROADCAST_MS);

wss.on('connection', (socket) => {
  socket.meta = { roomId: null, deviceId: null, role: null };

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(socket, 'error', { message: '잘못된 메시지예요.' });
      return;
    }
    try {
      handleMessage(socket, msg);
    } catch (err) {
      send(socket, 'error', { message: err.message || '오류가 발생했어요.' });
    }
  });

  socket.on('close', () => {
    const { roomId, deviceId, role } = socket.meta;
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!room) return;
    if (role === 'host' && room.hostSocket === socket) {
      room.hostSocket = null;
    } else if (role === 'player' && deviceId) {
      const player = room.players.get(deviceId);
      if (player) player.connected = false;
    }
    broadcastRoom(room);
  });
});

function handleMessage(socket, msg) {
  switch (msg.type) {
    case 'searchChurches': {
      const results = searchChurches(msg.query);
      send(socket, 'churchList', { churches: results.map((c) => ({ id: c.id, name: c.name })) });
      break;
    }

    case 'findOrCreateChurch': {
      const church = findOrCreateChurch(msg.name);
      send(socket, 'churchJoined', { church: { id: church.id, name: church.name } });
      break;
    }

    case 'listRooms': {
      const church = getChurch(msg.churchId);
      if (!church) throw new Error('교회를 찾을 수 없어요.');
      const rooms = listRooms(msg.churchId).map(serializeRoomSummary);
      send(socket, 'roomList', { churchId: msg.churchId, rooms });
      break;
    }

    case 'createRoom': {
      const room = createRoom({
        churchId: msg.churchId,
        title: msg.title,
        map: msg.map,
        capacity: msg.capacity,
        questionSeconds: msg.questionSeconds,
      });
      room.hostSocket = socket;
      socket.meta = { roomId: room.id, deviceId: null, role: 'host' };
      send(socket, 'roomCreated', { room: serializeRoom(room) });
      break;
    }

    case 'hostOpenRoom': {
      const room = getRoom(msg.roomId);
      if (!room) throw new Error('방을 찾을 수 없어요.');
      room.hostSocket = socket;
      socket.meta = { roomId: room.id, deviceId: null, role: 'host' };
      send(socket, 'roomState', { room: serializeRoom(room) });
      break;
    }

    case 'joinRoom': {
      const room = getRoom(msg.roomId);
      if (!room) throw new Error('방을 찾을 수 없어요.');
      const player = joinRoom(room, {
        deviceId: msg.deviceId,
        nickname: msg.nickname,
        avatar: msg.avatar,
      });
      player.socket = socket;
      socket.meta = { roomId: room.id, deviceId: msg.deviceId, role: 'player' };
      send(socket, 'joined', { playerId: player.id, room: serializeRoom(room) });
      broadcastRoom(room);
      break;
    }

    case 'startQuiz': {
      const room = requireHostRoom(socket, msg.roomId);
      startQuiz(room, msg.questionCount);
      advanceQuestion(room, onQuestionTimeout);
      broadcastRoom(room);
      break;
    }

    case 'answer': {
      // Kept for backward compatibility: still marks `side` immediately for
      // UI feedback, but the O/X quick-button fallback now also auto-walks
      // the avatar into that zone. Final scoring always uses live zone
      // position at reveal time, not this recorded choice.
      const room = getRoom(msg.roomId);
      if (!room) throw new Error('방을 찾을 수 없어요.');
      const ok = recordAnswer(room, socket.meta.deviceId, msg.choice);
      if (ok) {
        setAutoWalkTarget(room, socket.meta.deviceId, msg.choice);
        broadcastRoom(room);
      }
      break;
    }

    case 'move': {
      const room = getRoom(msg.roomId);
      if (!room) throw new Error('방을 찾을 수 없어요.');
      if (socket.meta.deviceId) setPlayerInput(room, socket.meta.deviceId, { dir: msg.dir, run: msg.run, crawl: msg.crawl });
      break;
    }

    case 'jump': {
      const room = getRoom(msg.roomId);
      if (!room) throw new Error('방을 찾을 수 없어요.');
      if (socket.meta.deviceId) requestPlayerJump(room, socket.meta.deviceId);
      break;
    }

    case 'reveal': {
      const room = requireHostRoom(socket, msg.roomId);
      revealAnswer(room);
      broadcastRoom(room);
      break;
    }

    case 'nextQuestion': {
      const room = requireHostRoom(socket, msg.roomId);
      advanceQuestion(room, onQuestionTimeout);
      broadcastRoom(room);
      break;
    }

    default:
      send(socket, 'error', { message: `알 수 없는 메시지 타입: ${msg.type}` });
  }
}

function requireHostRoom(socket, roomId) {
  const room = getRoom(roomId);
  if (!room) throw new Error('방을 찾을 수 없어요.');
  if (room.hostSocket !== socket) throw new Error('호스트만 사용할 수 있어요.');
  return room;
}

console.log(`church-game server listening on ws://localhost:${PORT}`);
