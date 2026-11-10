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
  setTeamMode,
  autoSplitTeams,
  assignTeam,
  buildFinalResult,
} from './state.js';
import {
  openGroup,
  normalizeCode,
  markAttendance,
  unmarkAttendance,
  adjustTalent,
  recordGame,
  groupSummary,
  claimNickname,
  releaseNickname,
  setWeeklyCap,
  nickKey,
  shopState,
  buyItem,
  equipItem,
} from './records.js';

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
  for (const p of room.players.values()) send(p.socket, 'roomState', { room: snapshot });
  // 호스트에게만 방 PIN 이 담긴 스냅샷을 보낸다.
  send(room.hostSocket, 'roomState', { room: serializeRoom(room, { forHost: true }) });
}

// ---- 방 PIN / 호스트 확인 ----
const JOIN_MAX_FAILS = 5;
const JOIN_LOCK_MS = 30000;
// 없는 방이든 PIN 이 틀렸든 같은 안내를 준다 (방이 있는지 굳이 알려 주지 않는다).
const JOIN_FAIL_MESSAGE = '방에 들어갈 수 없어요. 선생님이 알려 준 방 PIN 숫자 4자리를 다시 확인해 주세요.';

function failJoin(socket) {
  const f = socket.joinFails;
  f.count += 1;
  if (f.count >= JOIN_MAX_FAILS) {
    f.count = 0;
    f.lockedUntil = Date.now() + JOIN_LOCK_MS;
  }
  throw new Error(JOIN_FAIL_MESSAGE);
}

function pinMatches(room, pin) {
  return typeof pin === 'string' && pin === room.pin;
}

// 반 기록에 연결된 방이면 닉네임 주인 확인 + 착용 아이템 불러오기.
// 다른 친구가 먼저 쓴 닉네임이면 여기서 오류가 난다.
function claimForRoom(room, { deviceId, nickname, avatar }) {
  if (!room.groupCode) return null;
  return claimNickname(room.groupCode, { nickname, deviceId, avatar });
}

// ---------------------------------------------------------------------------
// 반(그룹) 기록: 교사 PIN 으로 인증된 소켓만 조회/수정할 수 있다.
// ---------------------------------------------------------------------------
const groupWatchers = new Map(); // code -> Set<socket>
const pinFailures = new Map(); // code -> { fails, lockedUntil }
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MS = 60000;

function authGroup(socket, code, pin, create) {
  const c = normalizeCode(code);
  const f = pinFailures.get(c);
  if (f && f.lockedUntil > Date.now()) throw new Error('PIN을 여러 번 틀렸어요. 1분 뒤에 다시 시도해 주세요.');
  let result;
  try {
    result = openGroup(c, pin, { create: !!create });
  } catch (err) {
    if (/PIN이 맞지/.test(err.message)) {
      const next = { fails: (f?.fails || 0) + 1, lockedUntil: 0 };
      if (next.fails >= PIN_MAX_FAILS) {
        next.fails = 0;
        next.lockedUntil = Date.now() + PIN_LOCK_MS;
      }
      pinFailures.set(c, next);
    }
    throw err;
  }
  pinFailures.delete(c);
  socket.groupAuth.add(c);
  if (!groupWatchers.has(c)) groupWatchers.set(c, new Set());
  groupWatchers.get(c).add(socket);
  return { code: c, created: result.created };
}

function requireGroupAuth(socket, code) {
  const c = normalizeCode(code);
  if (!socket.groupAuth.has(c)) throw new Error('교사 PIN 확인이 필요해요.');
  return c;
}

function pushGroup(code) {
  const watchers = groupWatchers.get(code);
  if (!watchers || watchers.size === 0) return;
  const group = groupSummary(code);
  for (const s of watchers) send(s, 'groupData', { group });
}

function markRoomAttendance(room, player) {
  if (!room.groupCode || !player.recordKey) return null;
  try {
    return markAttendance(room.groupCode, { nickname: player.nickname, avatar: player.avatar });
  } catch (err) {
    console.error('[records] 출석 기록 실패:', err.message);
    return null;
  }
}

// 게임이 끝나는 순간 한 번만 호출: 결과 요약(MVP·팀 승패)을 만들고,
// 반이 연결돼 있으면 달란트를 원장에 기록한다.
function finalizeGame(room) {
  if (room.status !== 'finished' || room.finalResult || room.questions.length === 0) return;
  const result = buildFinalResult(room);
  room.finalResult = result;
  // 닉네임 주인 확인을 통과한 친구만 반 장부에 기록한다.
  const players = [...room.players.values()].filter((p) => p.recordKey);
  if (!room.groupCode || players.length === 0) return;
  try {
    const { awards } = recordGame(room.groupCode, {
      roomTitle: room.title,
      level: room.level,
      totalQuestions: result.totalQuestions,
      players: players.map((p) => ({ id: p.id, nickname: p.nickname, avatar: p.avatar, score: p.score, teamId: room.team.enabled ? p.teamId : null })),
      mvpNicknames: players.filter((p) => result.mvpIds.includes(p.id)).map((p) => p.nickname),
      team: result.team
        ? {
            bonus: result.team.bonus,
            tie: result.team.tie,
            teams: result.team.teams,
            winnerTeamIds: result.team.winnerTeamIds,
            names: Object.fromEntries(result.team.teams.map((t) => [t.id, t.name])),
          }
        : null,
    });
    result.awards = awards;
    result.recorded = true;
    pushGroup(room.groupCode);
  } catch (err) {
    console.error('[records] 게임 기록 실패:', err.message);
  }
}

function linkRoomToGroup(socket, room, code, pin) {
  const c = pin ? authGroup(socket, code, pin, false).code : requireGroupAuth(socket, code);
  room.groupCode = c;
  // 이미 들어와 있는 친구들: 닉네임이 다른 기기 것이면 기록에서만 빼고 게임은 그대로 한다.
  for (const p of room.players.values()) {
    try {
      const claim = claimForRoom(room, { deviceId: p.id, nickname: p.nickname, avatar: p.avatar });
      p.recordKey = claim.key;
      p.cosmetics = claim.equipped;
    } catch {
      p.recordKey = null;
      p.cosmetics = {};
    }
    markRoomAttendance(room, p);
  }
  pushGroup(c);
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
  socket.groupAuth = new Set(); // 이 소켓이 교사 PIN 으로 연 반 코드들
  socket.joinFails = { count: 0, lockedUntil: 0 }; // 방 PIN 틀린 횟수

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
    for (const c of socket.groupAuth) groupWatchers.get(c)?.delete(socket);
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
        level: msg.level,
        questionCount: msg.questionCount,
        pin: msg.pin,
      });
      room.hostSocket = socket;
      socket.meta = { roomId: room.id, deviceId: null, role: 'host' };
      if (msg.groupCode) {
        // 반 연결에 실패해도(PIN 오류 등) 방은 그대로 만들고 이유만 알려 준다.
        try {
          linkRoomToGroup(socket, room, msg.groupCode, msg.groupPin);
        } catch (err) {
          send(socket, 'error', { message: `반 연결 실패: ${err.message}` });
        }
      }
      if (msg.teamMode) setTeamMode(room, { enabled: true, count: msg.teamCount, bonus: msg.teamBonus });
      send(socket, 'roomCreated', { room: serializeRoom(room, { forHost: true }), hostKey: room.hostKey });
      break;
    }

    case 'hostOpenRoom': {
      const room = getRoom(msg.roomId);
      // 호스트 화면은 방을 만든 브라우저(hostKey) 또는 방 PIN 을 아는 사람만 열 수 있다.
      if (socket.joinFails.lockedUntil > Date.now()) throw new Error('여러 번 틀렸어요. 30초 뒤에 다시 시도해 주세요.');
      if (!room || !(msg.hostKey === room.hostKey || pinMatches(room, msg.pin))) {
        socket.joinFails.count += 1;
        if (socket.joinFails.count >= JOIN_MAX_FAILS) socket.joinFails = { count: 0, lockedUntil: Date.now() + JOIN_LOCK_MS };
        send(socket, 'hostAuthRequired', { roomId: msg.roomId, message: '호스트 화면을 열려면 방 PIN 숫자 4자리를 입력해 주세요.' });
        break;
      }
      socket.joinFails.count = 0;
      room.hostSocket = socket;
      socket.meta = { roomId: room.id, deviceId: null, role: 'host' };
      send(socket, 'roomState', { room: serializeRoom(room, { forHost: true }) });
      break;
    }

    case 'joinRoom': {
      if (socket.joinFails.lockedUntil > Date.now()) throw new Error('PIN을 여러 번 틀렸어요. 30초 뒤에 다시 시도해 주세요.');
      const room = getRoom(msg.roomId);
      if (!msg.deviceId || typeof msg.deviceId !== 'string') throw new Error('기기 정보를 확인할 수 없어요. 새로고침 후 다시 들어와 주세요.');
      // 이미 이 방에 들어와 있던 기기(새로고침·재접속)는 PIN 을 다시 묻지 않는다.
      const already = room?.players.get(msg.deviceId);
      if (!room || (!already && !pinMatches(room, msg.pin))) failJoin(socket);
      socket.joinFails.count = 0;
      const nickname = String(msg.nickname ?? '').trim().replace(/\s+/g, ' ').slice(0, 12) || already?.nickname || '친구';
      // 같은 방 안에서도 닉네임은 한 명만 (먼저 들어온 친구 우선).
      const wantedKey = nickKey(nickname);
      for (const other of room.players.values()) {
        if (other.id !== msg.deviceId && nickKey(other.nickname) === wantedKey) {
          throw new Error(`"${other.nickname}"은(는) 이 방에서 이미 다른 친구가 쓰고 있는 이름이에요. 다른 이름을 골라 주세요!`);
        }
      }
      // 반 기록이 연결된 방이면 반 전체에서 닉네임 주인 확인 (먼저 등록한 친구 우선).
      const claim = claimForRoom(room, { deviceId: msg.deviceId, nickname, avatar: msg.avatar });
      const player = joinRoom(room, {
        deviceId: msg.deviceId,
        nickname,
        avatar: msg.avatar,
      });
      player.recordKey = claim ? claim.key : null;
      player.cosmetics = claim ? claim.equipped : {};
      player.socket = socket;
      socket.meta = { roomId: room.id, deviceId: msg.deviceId, role: 'player' };
      const attendance = markRoomAttendance(room, player);
      send(socket, 'joined', { playerId: player.id, room: serializeRoom(room), attendance });
      broadcastRoom(room);
      if (attendance) pushGroup(room.groupCode);
      break;
    }

    case 'startQuiz': {
      const room = requireHostRoom(socket, msg.roomId);
      startQuiz(room, msg.questionCount);
      advanceQuestion(room, onQuestionTimeout);
      finalizeGame(room);
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
      if (room.status === 'finished') break; // 이미 끝난 게임 (중복 클릭 방지)
      advanceQuestion(room, onQuestionTimeout);
      finalizeGame(room);
      broadcastRoom(room);
      break;
    }

    // ---- 팀 대결 (호스트 전용) ----
    case 'setTeamMode': {
      const room = requireHostRoom(socket, msg.roomId);
      setTeamMode(room, { enabled: msg.enabled, count: msg.count, bonus: msg.bonus });
      broadcastRoom(room);
      break;
    }

    case 'autoSplitTeams': {
      const room = requireHostRoom(socket, msg.roomId);
      if (!room.team.enabled) throw new Error('팀 대결이 꺼져 있어요.');
      if (room.status !== 'lobby' && room.status !== 'finished') throw new Error('팀은 게임 시작 전에만 바꿀 수 있어요.');
      autoSplitTeams(room);
      broadcastRoom(room);
      break;
    }

    case 'assignTeam': {
      const room = requireHostRoom(socket, msg.roomId);
      assignTeam(room, msg.playerId, msg.teamId);
      broadcastRoom(room);
      break;
    }

    // ---- 반(그룹) 출석 · 달란트 (교사 PIN) ----
    case 'groupOpen': {
      const { code, created } = authGroup(socket, msg.code, msg.pin, msg.create);
      send(socket, 'groupData', { group: groupSummary(code), created });
      break;
    }

    case 'linkGroup': {
      const room = requireHostRoom(socket, msg.roomId);
      if (room.status !== 'lobby' && room.status !== 'finished') throw new Error('반 연결은 게임 시작 전에만 바꿀 수 있어요.');
      if (msg.code) linkRoomToGroup(socket, room, msg.code, msg.pin);
      else {
        room.groupCode = null;
        for (const p of room.players.values()) {
          p.recordKey = null;
          p.cosmetics = {};
        }
      }
      broadcastRoom(room);
      break;
    }

    case 'groupAdjust': {
      const code = requireGroupAuth(socket, msg.code);
      adjustTalent(code, { nickname: msg.nickname, delta: msg.delta, reason: msg.reason });
      pushGroup(code);
      break;
    }

    case 'groupSettings': {
      const code = requireGroupAuth(socket, msg.code);
      if (msg.weeklyCap !== undefined) setWeeklyCap(code, msg.weeklyCap);
      pushGroup(code);
      break;
    }

    case 'groupReleaseNickname': {
      const code = requireGroupAuth(socket, msg.code);
      releaseNickname(code, msg.nickname);
      pushGroup(code);
      break;
    }

    // ---- 달란트 상점 (학생: 자기 닉네임의 주인으로 방에 들어와 있어야 함) ----
    case 'shopOpen': {
      const { room, player } = requireShopPlayer(socket, msg.roomId);
      send(socket, 'shopData', { shop: shopState(room.groupCode, player.recordKey) });
      break;
    }

    case 'shopBuy': {
      const { room, player } = requireShopPlayer(socket, msg.roomId);
      const { charged, state } = buyItem(room.groupCode, player.recordKey, msg.itemId);
      player.cosmetics = state.equipped;
      send(socket, 'shopData', { shop: state, charged, itemId: msg.itemId });
      broadcastRoom(room);
      pushGroup(room.groupCode);
      break;
    }

    case 'shopEquip': {
      const { room, player } = requireShopPlayer(socket, msg.roomId);
      const state = equipItem(room.groupCode, player.recordKey, msg.itemId, msg.equip !== false);
      player.cosmetics = state.equipped;
      send(socket, 'shopData', { shop: state });
      broadcastRoom(room);
      pushGroup(room.groupCode);
      break;
    }

    case 'groupMarkAttendance': {
      const code = requireGroupAuth(socket, msg.code);
      if (msg.present === false) unmarkAttendance(code, { nickname: msg.nickname });
      else markAttendance(code, { nickname: msg.nickname, via: 'teacher' });
      pushGroup(code);
      break;
    }

    default:
      send(socket, 'error', { message: `알 수 없는 메시지 타입: ${msg.type}` });
  }
}

function requireShopPlayer(socket, roomId) {
  const room = getRoom(roomId);
  const player = room && socket.meta.role === 'player' && socket.meta.roomId === room.id ? room.players.get(socket.meta.deviceId) : null;
  if (!player) throw new Error('방에 먼저 들어와 주세요.');
  if (!room.groupCode || !player.recordKey) throw new Error('상점은 선생님이 반 기록을 연결한 방에서만 열려요.');
  return { room, player };
}

function requireHostRoom(socket, roomId) {
  const room = getRoom(roomId);
  if (!room) throw new Error('방을 찾을 수 없어요.');
  if (room.hostSocket !== socket) throw new Error('호스트만 사용할 수 있어요.');
  return room;
}

console.log(`church-game server listening on ws://localhost:${PORT}`);
