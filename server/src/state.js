import { randomUUID } from 'node:crypto';
import { DEFAULT_LEVEL, DEFAULT_QUESTION_COUNT, normalizeLevel, selectQuizQuestions } from './questions.js';

export const QUESTION_DURATION_MS = 15000;

// Map bounds and O/X zone rectangles, shared verbatim with the client so the
// 3D scene and the authoritative server simulation agree on coordinates.
export const MAP_BOUNDS = { xmin: -8, xmax: 8, zmin: -1, zmax: 9 };
export const ZONES = {
  O: { xmin: -7, xmax: -1.5, zmin: 1, zmax: 6.5 },
  X: { xmin: 1.5, xmax: 7, zmin: 1, zmax: 6.5 },
};

export const WALK_SPEED = 2.2; // units/sec
export const RUN_SPEED = 4.2;
export const CRAWL_SPEED = 1.0;
export const AUTO_WALK_SPEED = RUN_SPEED; // O/X quick-button auto-walk gets there briskly
export const JUMP_SPEED = 4.5; // initial vertical velocity
export const GRAVITY = -12;
export const JUMP_COOLDOWN_MS = 600;
const SEPARATION_DIST = 0.6; // avatars start pushing apart below this distance
export const PHYSICS_TICK_MS = 50; // ~20 Hz authoritative simulation

const churches = new Map(); // id -> { id, name, normalized }
const rooms = new Map(); // id -> room

// Per-church memory of recently-played question ids, so a church doesn't see
// the same questions over and over across consecutive games. Keeps only the
// last RECENT_GAMES_PER_CHURCH games' worth of ids; resets on server restart
// (in-memory only, no DB), which is fine for this use case.
const RECENT_GAMES_PER_CHURCH = 5;
const recentGamesByChurch = new Map(); // churchId -> array of id-arrays, oldest first

function recentIdsForChurch(churchId) {
  const games = recentGamesByChurch.get(churchId) || [];
  return new Set(games.flat());
}

function recordPlayedForChurch(churchId, ids) {
  const games = recentGamesByChurch.get(churchId) || [];
  games.push(ids);
  while (games.length > RECENT_GAMES_PER_CHURCH) games.shift();
  recentGamesByChurch.set(churchId, games);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampToBounds(pos) {
  pos.x = clamp(pos.x, MAP_BOUNDS.xmin, MAP_BOUNDS.xmax);
  pos.z = clamp(pos.z, MAP_BOUNDS.zmin, MAP_BOUNDS.zmax);
}

function randomSpawn() {
  return {
    x: MAP_BOUNDS.xmin + 0.5 + Math.random() * (MAP_BOUNDS.xmax - MAP_BOUNDS.xmin - 1),
    z: 7 + Math.random() * 1.5,
  };
}

function createMotion() {
  const spawn = randomSpawn();
  return {
    pos: spawn,
    y: 0,
    vy: 0,
    input: { x: 0, z: 0 },
    run: false,
    crawl: false,
    jumpRequested: false,
    jumping: false,
    jumpCooldownUntil: 0,
    autoTarget: null,
    state: 'idle',
  };
}

// Which O/X zone a position falls in, or null for neither. This is the
// authoritative answer-resolution rule: whatever zone the avatar is
// physically standing in when time runs out / the host reveals wins,
// regardless of any earlier explicit 'answer' message.
export function zoneAt(pos) {
  const { O, X } = ZONES;
  if (pos.x >= O.xmin && pos.x <= O.xmax && pos.z >= O.zmin && pos.z <= O.zmax) return 'O';
  if (pos.x >= X.xmin && pos.x <= X.xmax && pos.z >= X.zmin && pos.z <= X.zmax) return 'X';
  return null;
}

export function setPlayerInput(room, deviceId, { dir, run, crawl } = {}) {
  const player = room.players.get(deviceId);
  if (!player) return;
  const m = player.motion;
  const x = clamp(Number(dir?.x) || 0, -1, 1);
  const z = clamp(Number(dir?.z) || 0, -1, 1);
  m.input.x = x;
  m.input.z = z;
  m.run = !!run;
  m.crawl = !!crawl;
  // Manual joystick/d-pad input always cancels an in-progress O/X auto-walk.
  if (Math.hypot(x, z) > 0.05) m.autoTarget = null;
}

export function requestPlayerJump(room, deviceId) {
  const player = room.players.get(deviceId);
  if (!player) return;
  player.motion.jumpRequested = true;
}

export function setAutoWalkTarget(room, deviceId, zone) {
  const player = room.players.get(deviceId);
  if (!player) return;
  const box = ZONES[zone];
  if (!box) return;
  player.motion.autoTarget = {
    x: (box.xmin + box.xmax) / 2,
    z: (box.zmin + box.zmax) / 2,
  };
}

export function tickRoomPhysics(room, dtMs) {
  const dt = dtMs / 1000;
  const now = Date.now();
  const players = [...room.players.values()];

  for (const player of players) {
    const m = player.motion;
    let dirX = 0;
    let dirZ = 0;
    let moving = false;
    let autoWalking = false;

    if (m.autoTarget) {
      const dx = m.autoTarget.x - m.pos.x;
      const dz = m.autoTarget.z - m.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.15) {
        m.autoTarget = null;
      } else {
        dirX = dx / dist;
        dirZ = dz / dist;
        moving = true;
        autoWalking = true;
      }
    } else {
      const mag = Math.hypot(m.input.x, m.input.z);
      if (mag > 0.05) {
        const clampedMag = Math.min(1, mag);
        dirX = (m.input.x / mag) * clampedMag;
        dirZ = (m.input.z / mag) * clampedMag;
        moving = true;
      }
    }

    if (moving) {
      const speed = autoWalking ? AUTO_WALK_SPEED : m.crawl ? CRAWL_SPEED : m.run ? RUN_SPEED : WALK_SPEED;
      m.pos.x += dirX * speed * dt;
      m.pos.z += dirZ * speed * dt;
      clampToBounds(m.pos);
    }

    if (m.jumpRequested) {
      m.jumpRequested = false;
      if (!m.jumping && now >= m.jumpCooldownUntil) {
        m.jumping = true;
        m.vy = JUMP_SPEED;
        m.jumpCooldownUntil = now + JUMP_COOLDOWN_MS;
      }
    }
    if (m.jumping) {
      m.vy += GRAVITY * dt;
      m.y += m.vy * dt;
      if (m.y <= 0) {
        m.y = 0;
        m.vy = 0;
        m.jumping = false;
      }
    }

    m.state = m.jumping ? 'jump' : m.crawl ? 'crawl' : moving ? (m.run ? 'run' : 'walk') : 'idle';
  }

  // Simple pairwise separation so avatars don't overlap heavily. O(n^2) is
  // fine at the player counts this game supports (dozens per room).
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i].motion;
      const b = players[j].motion;
      const dx = b.pos.x - a.pos.x;
      const dz = b.pos.z - a.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0 && dist < SEPARATION_DIST) {
        const push = (SEPARATION_DIST - dist) / 2;
        const nx = dx / dist;
        const nz = dz / dist;
        a.pos.x -= nx * push;
        a.pos.z -= nz * push;
        b.pos.x += nx * push;
        b.pos.z += nz * push;
        clampToBounds(a.pos);
        clampToBounds(b.pos);
      }
    }
  }
}

export function serializePositions(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id,
    x: Math.round(p.motion.pos.x * 100) / 100,
    z: Math.round(p.motion.pos.z * 100) / 100,
    y: Math.round(p.motion.y * 100) / 100,
    state: p.motion.state,
  }));
}

export function allRooms() {
  return [...rooms.values()];
}

function normalize(name) {
  return name.trim().toLowerCase().replace(/\s+/g, '');
}

export function searchChurches(query) {
  const q = normalize(query || '');
  const list = [...churches.values()];
  if (!q) return list.slice(0, 10);
  return list.filter((c) => c.normalized.includes(q)).slice(0, 10);
}

export function findOrCreateChurch(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('교회 이름을 입력해 주세요.');
  const normalized = normalize(trimmed);
  for (const c of churches.values()) {
    if (c.normalized === normalized) return c;
  }
  const church = { id: randomUUID(), name: trimmed, normalized };
  churches.set(church.id, church);
  return church;
}

export function getChurch(churchId) {
  return churches.get(churchId) || null;
}

export function listRooms(churchId) {
  return [...rooms.values()].filter((r) => r.churchId === churchId);
}

export function createRoom({ churchId, title, map, capacity, questionSeconds, level, questionCount }) {
  const church = getChurch(churchId);
  if (!church) throw new Error('교회를 찾을 수 없어요.');
  const room = {
    id: randomUUID(),
    churchId,
    title: (title || '방').trim(),
    map: map || 'sanctuary',
    level: normalizeLevel(level),
    capacity: capacity === 'unlimited' ? 'unlimited' : Number(capacity) || 8,
    hostSocket: null,
    players: new Map(), // deviceId -> player
    status: 'lobby', // lobby | question | reveal | finished
    questionCount: questionCount ? Math.max(1, Math.round(Number(questionCount))) : DEFAULT_QUESTION_COUNT,
    questions: [],
    currentIndex: -1,
    answers: new Map(), // deviceId -> 'O' | 'X'
    deadline: null,
    timer: null,
    lastResult: null,
    questionDurationMs: questionSeconds ? Math.max(1000, Math.round(Number(questionSeconds) * 1000)) : QUESTION_DURATION_MS,
  };
  rooms.set(room.id, room);
  return room;
}

export function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

export function joinRoom(room, { deviceId, nickname, avatar }) {
  let player = room.players.get(deviceId);
  if (!player) {
    const activeCount = room.players.size;
    if (room.capacity !== 'unlimited' && activeCount >= room.capacity) {
      throw new Error('방 인원이 가득 찼어요.');
    }
    player = {
      id: deviceId,
      nickname: (nickname || '친구').slice(0, 12),
      avatar: avatar || 'circle-blue',
      socket: null,
      side: null,
      score: 0,
      connected: true,
      motion: createMotion(),
    };
    room.players.set(deviceId, player);
  } else {
    player.nickname = (nickname || player.nickname).slice(0, 12);
    player.avatar = avatar || player.avatar;
    player.connected = true;
  }
  return player;
}

export function startQuiz(room, questionCount) {
  clearTimer(room);
  const count = questionCount ? Math.max(1, Math.round(Number(questionCount))) : room.questionCount;
  const excludeIds = recentIdsForChurch(room.churchId);
  room.questions = selectQuizQuestions({ level: room.level, count, excludeIds });
  recordPlayedForChurch(room.churchId, room.questions.map((q) => q.id));
  room.currentIndex = -1;
  room.lastResult = null;
  for (const p of room.players.values()) {
    p.score = 0;
    p.side = null;
  }
}

export function currentQuestion(room) {
  if (room.currentIndex < 0 || room.currentIndex >= room.questions.length) return null;
  return room.questions[room.currentIndex];
}

export function clearTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

export function advanceQuestion(room, onTimeout) {
  clearTimer(room);
  room.currentIndex += 1;
  room.answers = new Map();
  room.lastResult = null;
  for (const p of room.players.values()) p.side = null;

  if (room.currentIndex >= room.questions.length) {
    room.status = 'finished';
    room.deadline = null;
    return;
  }
  room.status = 'question';
  room.deadline = Date.now() + room.questionDurationMs;
  room.timer = setTimeout(() => onTimeout(room), room.questionDurationMs);
}

export function recordAnswer(room, deviceId, choice) {
  if (room.status !== 'question') return false;
  const player = room.players.get(deviceId);
  if (!player) return false;
  if (room.answers.has(deviceId)) return false;
  if (choice !== 'O' && choice !== 'X') return false;
  room.answers.set(deviceId, choice);
  player.side = choice;
  return true;
}

// Answer resolution rule: whichever O/X zone the avatar is physically
// standing in when the question is revealed (by timeout or host action) is
// authoritative, overriding any earlier explicit 'answer' message. Standing
// in neither zone counts as no answer / wrong.
export function revealAnswer(room) {
  if (room.status !== 'question') return;
  clearTimer(room);
  const q = currentQuestion(room);
  room.status = 'reveal';
  room.deadline = null;
  const correctPlayerIds = [];
  for (const [deviceId, player] of room.players) {
    const zone = zoneAt(player.motion.pos);
    player.side = zone;
    if (zone === q.answer) {
      player.score += 1;
      correctPlayerIds.push(deviceId);
    }
  }
  room.lastResult = {
    questionText: q.text,
    correctAnswer: q.answer,
    correctPlayerIds,
    explanation: q.explanation ?? null,
    category: q.category ?? null,
  };
}

export function serializeRoom(room) {
  const q = currentQuestion(room);
  return {
    id: room.id,
    churchId: room.churchId,
    title: room.title,
    map: room.map,
    level: room.level,
    capacity: room.capacity,
    status: room.status,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      nickname: p.nickname,
      avatar: p.avatar,
      side: p.side,
      score: p.score,
      connected: p.connected,
    })),
    hasHost: !!room.hostSocket,
    bounds: MAP_BOUNDS,
    zones: ZONES,
    questionDurationMs: room.questionDurationMs,
    question:
      room.status === 'question' || room.status === 'reveal'
        ? {
            index: room.currentIndex,
            total: room.questions.length,
            text: q ? q.text : null,
            category: q ? q.category : null,
            deadline: room.deadline,
          }
        : null,
    lastResult: room.lastResult,
  };
}

export function serializeRoomSummary(room) {
  return {
    id: room.id,
    title: room.title,
    map: room.map,
    level: room.level,
    capacity: room.capacity,
    playerCount: room.players.size,
    status: room.status,
  };
}
