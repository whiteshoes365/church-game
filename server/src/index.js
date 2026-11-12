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
  setHostPassword,
  requestGait,
  gaitStatus,
  pauseQuestion,
  resumeQuestion,
  endQuiz,
  kickPlayer,
  zoneCounts,
  normalizeMusic,
  findRoomByJoinCode,
  normalizeJoinCode,
} from './state.js';
import { randomInt } from 'node:crypto';
import { LEVELS, QUESTIONS_BY_LEVEL, questionBankStats } from './questions.js';
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
  verifyNicknameOwner,
} from './records.js';

const PORT = Number(process.env.PORT) || 8787;
const QUESTION_BANK = Object.fromEntries(LEVELS.map((level) => [level, QUESTIONS_BY_LEVEL[level].length]));
// 난이도별 { total, bible, season, … } — 방 만들기 화면(호스트·송출 PC)이 실제 은행 개수를 보여 준다.
const QUESTION_BANK_DETAIL = questionBankStats();
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

// ---- 접속 역할 ----
// 한 방에 붙는 "학생이 아닌" 접속은 세 가지다.
//  - host    : 진행자 화면 (PC). 진행 권한 있음.
//  - remote  : 선생님 휴대폰 리모컨. 진행 권한 있음 + 정답을 미리 본다.
//  - display : 송출 화면(프로젝터·TV). 보기만 한다. 진행자 비밀번호·정답을 받지 않고, 진행 명령은 모두 거절된다.
// host·remote 는 room.hostSockets, display 는 room.displaySockets 에 들어간다.
// socket.attachments: roomId -> 'host' | 'remote' | 'display'
function attachSocket(socket, room, kind) {
  room.hostSockets.delete(socket);
  room.displaySockets.delete(socket);
  if (kind === 'display') room.displaySockets.add(socket);
  else room.hostSockets.add(socket);
  socket.attachments.set(room.id, kind);
}

function viewOf(socket, room) {
  return socket.attachments.get(room.id) || 'player';
}

// 진행자 화면·리모컨·송출 화면에만 보낸다 (학생 화면이 받는 값은 그대로일 때).
function broadcastStaff(room, except = null) {
  const cache = {};
  const snap = (view) => (cache[view] ||= serializeRoom(room, { view }));
  for (const s of room.hostSockets) if (s !== except) send(s, 'roomState', { room: snap(viewOf(s, room)) });
  for (const s of room.displaySockets) if (s !== except) send(s, 'roomState', { room: snap('display') });
}

function broadcastRoom(room) {
  const snapshot = serializeRoom(room);
  for (const p of room.players.values()) {
    // 진행자 접속이 학생으로도 들어와 있으면 아래에서 진행자용 스냅샷을 받는다.
    if (p.socket && (room.hostSockets.has(p.socket) || room.displaySockets.has(p.socket))) continue;
    send(p.socket, 'roomState', { room: snapshot });
  }
  // 방 PIN·진행자 비밀번호는 진행 권한이 있는 접속에만, 방 PIN 은 송출 화면에도 보낸다.
  broadcastStaff(room);
}

// ---- 송출 화면 연결 코드 ----
// PC 가 「송출 화면」을 열면 숫자 6자리 연결 코드를 받는다. 선생님 리모컨(진행 권한 있음)이
// 그 숫자를 넣으면 그 PC 가 방의 송출 화면이 된다. 진행자 비밀번호는 PC 에 입력하지 않는다.
const PAIR_TTL_MS = 10 * 60 * 1000;
const pairWaiting = new Map(); // code -> { socket, expiresAt }

function dropPairCode(socket) {
  if (socket.pairCode && pairWaiting.get(socket.pairCode)?.socket === socket) pairWaiting.delete(socket.pairCode);
  socket.pairCode = null;
}

function newPairCode(socket) {
  dropPairCode(socket);
  const now = Date.now();
  for (const [code, entry] of pairWaiting) if (entry.expiresAt <= now) pairWaiting.delete(code);
  let code;
  do code = String(randomInt(0, 1000000)).padStart(6, '0');
  while (pairWaiting.has(code));
  pairWaiting.set(code, { socket, expiresAt: now + PAIR_TTL_MS });
  socket.pairCode = code;
  return code;
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

// ---- 진행자(호스트) 비밀번호 ----
// 방을 만든 브라우저(hostKey)는 항상 통과. 그 밖에는 진행자 비밀번호가 맞아야 한다.
// 방 PIN 으로는 열 수 없다. 5번 틀리면 30초 잠금 — 틀린 그 접속(소켓)만 잠긴다.
// 방 전체를 잠그지 않으므로, 한 기기가 일부러 틀려도 다른 기기는 계속 시도할 수 있다.
// 없는 방이어도 같은 문구로 답해서 방이 있는지 알려 주지 않는다.
const HOST_MAX_FAILS = 5;
const HOST_LOCK_MS = 30000;
const HOST_LOCK_MESSAGE = '진행자 비밀번호를 여러 번 틀렸어요. 30초 뒤에 다시 시도해 주세요.';
const HOST_FAIL_MESSAGE = '진행자 비밀번호가 맞지 않아요. 방 PIN이 아니라 선생님용 진행자 비밀번호를 입력해 주세요.';

function bumpFail(f) {
  f.count += 1;
  if (f.count >= HOST_MAX_FAILS) {
    f.count = 0;
    f.lockedUntil = Date.now() + HOST_LOCK_MS;
  }
}

// 반환: 'ok' | 'need' (아무것도 안 보냄 → 입력 화면) — 틀리면 오류를 던진다.
function checkHostAccess(socket, room, msg) {
  if (room && typeof msg.hostKey === 'string' && msg.hostKey === room.hostKey) return 'ok';
  // 진행자 비밀번호로 이미 확인받은 기기가 다시 접속할 때 (비밀번호를 바꾸면 이 값도 바뀐다)
  if (room && typeof msg.controlKey === 'string' && msg.controlKey === room.controlKey) return 'ok';
  const supplied = typeof msg.hostPassword === 'string' && msg.hostPassword.length > 0;
  if (!supplied) return 'need';
  const now = Date.now();
  if (socket.hostFails.lockedUntil > now) throw new Error(HOST_LOCK_MESSAGE);
  if (room && msg.hostPassword === room.hostPassword) {
    socket.hostFails.count = 0;
    return 'ok';
  }
  bumpFail(socket.hostFails);
  throw new Error(socket.hostFails.lockedUntil > now ? HOST_LOCK_MESSAGE : HOST_FAIL_MESSAGE);
}

// 홈 화면 상점에서 산/착용한 아이템을, 그 친구가 지금 들어가 있는 방 캐릭터에도 바로 반영한다.
function syncCosmeticsToRooms(code, key, equipped) {
  for (const room of allRooms()) {
    if (room.groupCode !== code) continue;
    let changed = false;
    for (const p of room.players.values()) {
      if (p.recordKey === key) {
        p.cosmetics = { ...equipped };
        changed = true;
      }
    }
    if (changed) broadcastRoom(room);
  }
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
  // 이 접속이 이미 교사 PIN 으로 연 반이면 PIN 을 다시 묻지 않는다
  // (같은 진행자 화면에서 장부로 넘어가는 경우). 인증 안 된 접속은 아래 검사를 그대로 거친다.
  if ((pin === undefined || pin === null || pin === '') && !create && socket.groupAuth.has(c)) {
    return { code: c, created: false };
  }
  const f = pinFailures.get(c);
  if (f && f.lockedUntil > Date.now()) throw new Error('교사 PIN을 여러 번 틀렸어요. 1분 뒤에 다시 시도해 주세요.');
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
// 공개한 문제가 0개여도(첫 정답 공개 전 끝내기) 0점 결과 요약을 만든다.
function finalizeGame(room) {
  if (room.status !== 'finished') return;
  if (!room.finalResult) room.finalResult = buildFinalResult(room);
  const result = room.finalResult;
  if (result.recorded) return;
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
            // 장부에는 기기 id(memberIds)를 남기지 않는다.
            teams: result.team.teams.map(({ memberIds, ...t }) => t),
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
// rooms that are actually "in play" (question/reveal). It goes to the host
// screen and to every connected player (their phone draws a top-down map of
// the same coordinates), so a host does not need to be present.
setInterval(() => {
  for (const room of allRooms()) tickRoomPhysics(room, PHYSICS_TICK_MS);
}, PHYSICS_TICK_MS);

setInterval(() => {
  for (const room of allRooms()) {
    if (room.status !== 'question' && room.status !== 'reveal') continue;
    // 진행자 화면·송출 화면·학생에게 보낸다 (리모컨은 지도를 그리지 않으므로 보내지 않는다).
    const targets = new Set();
    for (const s of room.hostSockets) if (viewOf(s, room) !== 'remote') targets.add(s);
    for (const s of room.displaySockets) targets.add(s);
    for (const player of room.players.values()) if (player.socket) targets.add(player.socket);
    const open = [...targets].filter((s) => s.readyState === s.OPEN);
    if (open.length === 0) continue;
    const data = JSON.stringify({ type: 'positions', roomId: room.id, players: serializePositions(room) });
    for (const s of open) s.send(data);
  }
}, POSITIONS_BROADCAST_MS);

// 리모컨 응답 현황: 문제 중에 1초마다 O / X / 아직 인원을 리모컨에만 보낸다.
setInterval(() => {
  for (const room of allRooms()) {
    if (room.status !== 'question') continue;
    let data = null;
    for (const s of room.hostSockets) {
      if (viewOf(s, room) !== 'remote' || s.readyState !== s.OPEN) continue;
      data ||= JSON.stringify({ type: 'remoteStatus', roomId: room.id, zoneCounts: zoneCounts(room) });
      s.send(data);
    }
  }
}, 1000);

wss.on('connection', (socket) => {
  socket.meta = { roomId: null, deviceId: null, role: null };
  socket.attachments = new Map(); // roomId -> 'host' | 'remote' | 'display'
  socket.pairCode = null; // 송출 화면 연결을 기다리는 중이면 그 코드
  socket.groupAuth = new Set(); // 이 소켓이 교사 PIN 으로 연 반 코드들
  socket.joinFails = { count: 0, lockedUntil: 0 }; // 방 PIN 틀린 횟수
  socket.hostFails = { count: 0, lockedUntil: 0 }; // 진행자 비밀번호 틀린 횟수
  socket.shopFails = { count: 0, lockedUntil: 0 }; // 홈 상점 닉네임 확인 실패 횟수
  socket.shopAuth = null; // 홈 화면 상점: { code, key } (닉네임 주인 확인을 통과한 경우만)

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
    dropPairCode(socket);
    const touched = new Set();
    for (const attachedRoomId of socket.attachments.keys()) {
      const attachedRoom = getRoom(attachedRoomId);
      if (!attachedRoom) continue;
      attachedRoom.hostSockets.delete(socket);
      attachedRoom.displaySockets.delete(socket);
      touched.add(attachedRoom);
    }
    socket.attachments.clear();
    const { roomId, deviceId, role } = socket.meta;
    const room = roomId ? getRoom(roomId) : null;
    if (room && role === 'player' && deviceId) {
      const player = room.players.get(deviceId);
      if (player && player.socket === socket) player.connected = false;
      touched.add(room);
    }
    for (const r of touched) broadcastRoom(r);
  });
});

function handleMessage(socket, msg) {
  switch (msg.type) {
    case 'searchChurches': {
      const results = searchChurches(msg.query);
      send(socket, 'churchList', {
        query: typeof msg.query === 'string' ? msg.query : '',
        churches: results.map((c) => ({ id: c.id, name: c.name })),
      });
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
      // questionBank: 난이도별 문제 은행 크기 (방 만들기 화면이 문제 수 선택지를 여기에 맞춘다)
      send(socket, 'roomList', { churchId: msg.churchId, rooms, questionBank: QUESTION_BANK, questionBankDetail: QUESTION_BANK_DETAIL });
      break;
    }

    // 방을 만들기 전(교회를 아직 모르는 송출 PC 등)에도 은행 개수를 물어볼 수 있다.
    case 'getQuestionBank': {
      send(socket, 'questionBank', { questionBank: QUESTION_BANK, questionBankDetail: QUESTION_BANK_DETAIL });
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
        hostPassword: msg.hostPassword,
      });
      if (msg.music) room.music = normalizeMusic(msg.music, room.music);
      attachSocket(socket, room, msg.as === 'remote' ? 'remote' : 'host');
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
      send(socket, 'roomCreated', { room: serializeRoom(room, { view: viewOf(socket, room) }), hostKey: room.hostKey });
      break;
    }

    case 'hostOpenRoom': {
      const room = getRoom(msg.roomId);
      // 진행자 화면: 방을 만든 브라우저(hostKey) 또는 진행자 비밀번호. 방 PIN 으로는 열 수 없다.
      if (checkHostAccess(socket, room, msg) !== 'ok') {
        send(socket, 'hostAuthRequired', { roomId: msg.roomId, message: '진행자 화면을 열려면 선생님용 진행자 비밀번호를 입력해 주세요.' });
        break;
      }
      // as: 'remote' = 선생님 휴대폰 리모컨. 진행자 화면과 리모컨은 동시에 여러 개 붙을 수 있다.
      attachSocket(socket, room, msg.as === 'remote' ? 'remote' : 'host');
      socket.meta = { roomId: room.id, deviceId: null, role: 'host' };
      send(socket, 'roomState', { room: serializeRoom(room, { view: viewOf(socket, room) }) });
      broadcastStaff(room, socket);
      break;
    }

    // ---- 입장 코드 → 방 (QR·짧은 주소) ----
    case 'resolveJoinCode': {
      const code = normalizeJoinCode(msg.code);
      const room = findRoomByJoinCode(code);
      send(socket, 'joinCodeResolved', { code, roomId: room ? room.id : null, title: room ? room.title : null });
      break;
    }

    // ---- 송출 화면 (프로젝터·TV) ----
    // 방을 아직 모르는 PC: 연결 코드를 받아 화면에 띄운다.
    case 'displayPairRequest': {
      send(socket, 'displayPairCode', { code: newPairCode(socket), ttlMs: PAIR_TTL_MS });
      break;
    }

    // 송출 화면 열기: 송출 전용 키, 방을 만든 브라우저, 또는 이미 진행자로 확인된 접속만.
    // 진행자 비밀번호는 받지 않는다 (프로젝터에 입력하게 하지 않는다).
    case 'displayOpen': {
      const room = getRoom(msg.roomId);
      const same = (a, b) => typeof a === 'string' && a.length > 0 && a === b;
      const ok = room && (same(msg.displayKey, room.displayKey) || same(msg.hostKey, room.hostKey) || same(msg.controlKey, room.controlKey) || room.hostSockets.has(socket));
      if (!ok) {
        send(socket, 'displayAuthRequired', { roomId: msg.roomId });
        break;
      }
      dropPairCode(socket);
      attachSocket(socket, room, 'display'); // 진행자였던 접속도 여기서부터는 보기 전용이 된다
      if (socket.meta.role === 'host' && socket.meta.roomId === room.id) socket.meta = { roomId: null, deviceId: null, role: null };
      send(socket, 'displayReady', { roomId: room.id, displayKey: room.displayKey });
      send(socket, 'roomState', { room: serializeRoom(room, { view: 'display' }) });
      broadcastStaff(room, socket);
      break;
    }

    // 리모컨(진행 권한 있음)이 PC 에 보이는 연결 코드를 넣어 그 PC 를 송출 화면으로 붙인다.
    case 'pairDisplay': {
      const room = requireHostRoom(socket, msg.roomId);
      const code = String(msg.code ?? '').replace(/\D/g, '');
      const entry = pairWaiting.get(code);
      if (!entry || entry.expiresAt <= Date.now() || entry.socket.readyState !== entry.socket.OPEN) {
        throw new Error('연결 코드가 맞지 않아요. PC 송출 화면에 보이는 숫자 6자리를 다시 확인해 주세요.');
      }
      const target = entry.socket;
      dropPairCode(target);
      attachSocket(target, room, 'display');
      send(target, 'displayPaired', { roomId: room.id, displayKey: room.displayKey });
      send(target, 'roomState', { room: serializeRoom(room, { view: 'display' }) });
      send(socket, 'displayLinked', { roomId: room.id });
      broadcastStaff(room, target);
      break;
    }

    // ---- 진행 (진행자 화면 · 리모컨) ----
    case 'pause': {
      const room = requireHostRoom(socket, msg.roomId);
      const changed = msg.paused === false ? resumeQuestion(room) : pauseQuestion(room);
      if (changed) broadcastRoom(room);
      break;
    }

    // 퀴즈를 일찍 끝내고 결과 화면으로: 지금까지 공개한 문제까지만 친다.
    case 'endQuiz': {
      const room = requireHostRoom(socket, msg.roomId);
      if (endQuiz(room)) {
        finalizeGame(room);
        broadcastRoom(room);
      }
      break;
    }

    case 'kickPlayer': {
      const room = requireHostRoom(socket, msg.roomId);
      const player = kickPlayer(room, msg.playerId);
      if (!player) throw new Error('참가자를 찾을 수 없어요.');
      if (player.socket) {
        send(player.socket, 'kicked', { roomId: room.id, message: '선생님이 이 방에서 내보냈어요.' });
        if (player.socket.meta.roomId === room.id && player.socket.meta.role === 'player') {
          player.socket.meta = { roomId: null, deviceId: null, role: null };
        }
      }
      broadcastRoom(room);
      break;
    }

    // 내보낸 친구들이 다시 들어올 수 있게 한다.
    case 'clearKicks': {
      const room = requireHostRoom(socket, msg.roomId);
      room.kicked.clear();
      broadcastStaff(room);
      break;
    }

    // 배경 음악 고르기: 소리는 송출 화면(없으면 진행자 PC)에서만 난다. 여기서는 고른 값만 맞춘다.
    case 'setMusic': {
      const room = requireHostRoom(socket, msg.roomId);
      room.music = normalizeMusic({ track: msg.track, enabled: msg.enabled, volume: msg.volume }, room.music);
      broadcastStaff(room);
      break;
    }

    case 'setDisplayOptions': {
      const room = requireHostRoom(socket, msg.roomId);
      if (typeof msg.showQr === 'boolean') room.showQr = msg.showQr;
      broadcastStaff(room);
      break;
    }

    case 'joinRoom': {
      if (socket.joinFails.lockedUntil > Date.now()) throw new Error('방 PIN을 여러 번 틀렸어요. 30초 뒤에 다시 시도해 주세요.');
      const room = getRoom(msg.roomId);
      if (!msg.deviceId || typeof msg.deviceId !== 'string') throw new Error('기기 정보를 확인할 수 없어요. 새로고침 후 다시 들어와 주세요.');
      // 이미 이 방에 들어와 있던 기기(새로고침·재접속)는 PIN 을 다시 묻지 않는다.
      const already = room?.players.get(msg.deviceId);
      if (!room || (!already && !pinMatches(room, msg.pin))) failJoin(socket);
      socket.joinFails.count = 0;
      if (room.kicked.has(msg.deviceId)) throw new Error('선생님이 이 방에서 내보냈어요. 다시 들어오려면 선생님께 말씀드려 주세요.');
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
      if (socket.meta.deviceId) {
        const requested = setPlayerInput(room, socket.meta.deviceId, { dir: msg.dir, run: msg.run, crawl: msg.crawl });
        if (requested) send(socket, 'gait', { roomId: room.id, ...requested });
      }
      break;
    }

    // 뛰기·기어가기 요청 (mode: 'run' | 'crawl' | 'walk'). 시간·쿨타임은 서버가 지키고,
    // 결과(켜졌는지, 남은 시간)를 요청한 학생에게만 돌려준다.
    case 'gait': {
      const room = getRoom(msg.roomId);
      if (!room) throw new Error('방을 찾을 수 없어요.');
      if (socket.meta.role !== 'player' || socket.meta.roomId !== room.id || !socket.meta.deviceId) break;
      const result = msg.mode === 'status' ? gaitStatus(room, socket.meta.deviceId) : requestGait(room, socket.meta.deviceId, msg.mode);
      if (result) send(socket, 'gait', { roomId: room.id, ...result });
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
    // 홈 화면 상점 입장: 반 코드 + 닉네임 + 이 기기가 그 닉네임의 주인인지 확인.
    case 'shopLogin': {
      if (socket.shopFails.lockedUntil > Date.now()) throw new Error('여러 번 틀렸어요. 30초 뒤에 다시 시도해 주세요.');
      socket.shopAuth = null;
      try {
        const who = verifyNicknameOwner(msg.code, { nickname: msg.nickname, deviceId: msg.deviceId });
        socket.shopAuth = { code: who.code, key: who.key };
        socket.shopFails.count = 0;
        send(socket, 'shopReady', { code: who.code, nickname: who.nickname });
      } catch (err) {
        bumpFail(socket.shopFails);
        throw err;
      }
      break;
    }

    case 'shopOpen': {
      const { code, key } = requireShopAccess(socket, msg.roomId);
      send(socket, 'shopData', { shop: shopState(code, key) });
      break;
    }

    case 'shopBuy': {
      const { code, key } = requireShopAccess(socket, msg.roomId);
      const { charged, state } = buyItem(code, key, msg.itemId);
      send(socket, 'shopData', { shop: state, charged, itemId: msg.itemId });
      syncCosmeticsToRooms(code, key, state.equipped);
      pushGroup(code);
      break;
    }

    case 'shopEquip': {
      const { code, key } = requireShopAccess(socket, msg.roomId);
      const state = equipItem(code, key, msg.itemId, msg.equip !== false);
      send(socket, 'shopData', { shop: state });
      syncCosmeticsToRooms(code, key, state.equipped);
      pushGroup(code);
      break;
    }

    case 'setHostPassword': {
      const room = requireHostRoom(socket, msg.roomId);
      setHostPassword(room, msg.hostPassword);
      broadcastRoom(room);
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

// 상점 접근: 방 안(roomId 있음)이면 그 방의 내 캐릭터, 홈 화면(roomId 없음)이면 shopLogin 으로 확인된 닉네임.
function requireShopAccess(socket, roomId) {
  if (roomId) {
    const { room, player } = requireShopPlayer(socket, roomId);
    return { code: room.groupCode, key: player.recordKey };
  }
  if (!socket.shopAuth) throw new Error('상점을 열려면 반 코드와 내 닉네임을 먼저 확인해 주세요.');
  return socket.shopAuth;
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
  // 진행자 화면·리모컨만. 송출 화면(display)과 학생은 여기서 막힌다.
  if (!room.hostSockets.has(socket)) throw new Error('호스트만 사용할 수 있어요.');
  return room;
}

console.log(`church-game server listening on ws://localhost:${PORT}`);
