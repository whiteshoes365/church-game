import { randomInt, randomUUID } from 'node:crypto';
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

// 블록 색 팀 (최대 4팀). 이름·색은 모두 직접 지은 것.
export const TEAM_DEFS = [
  { id: 'red', name: '빨강 벽돌팀', color: '#e2483d' },
  { id: 'blue', name: '파랑 얼음팀', color: '#3182f6' },
  { id: 'green', name: '초록 잔디팀', color: '#45b35c' },
  { id: 'yellow', name: '노랑 황금팀', color: '#f5b400' },
];
export const DEFAULT_TEAM_BONUS = 2;
export const MAX_TEAM_BONUS = 5;

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

// 방 입장 PIN: 숫자 4자리. 호스트가 정하지 않으면 자동으로 만든다.
// (교사용 반 기록 PIN 과는 별개 — 이건 학생들에게 불러 주는 번호)
export function normalizeRoomPin(pin) {
  if (pin === undefined || pin === null || pin === '') return String(randomInt(0, 10000)).padStart(4, '0');
  const p = String(pin).trim();
  if (!/^\d{4}$/.test(p)) throw new Error('방 PIN은 숫자 4자리로 정해 주세요.');
  return p;
}

// 진행자(호스트) 비밀번호: 방 입장 PIN 과 별개. 학생에게 불러 주는 PIN 만으로는
// 진행자 화면을 열 수 없다. 정하지 않으면 숫자 6자리를 자동으로 만든다.
export function normalizeHostPassword(password) {
  if (password === undefined || password === null || password === '') return String(randomInt(0, 1000000)).padStart(6, '0');
  const p = String(password).trim();
  if (!/^[0-9A-Za-z]{4,12}$/.test(p)) throw new Error('진행자 비밀번호는 영문·숫자 4~12자로 정해 주세요.');
  return p;
}

export function setHostPassword(room, password) {
  const p = normalizeHostPassword(password);
  if (p === room.pin) throw new Error('진행자 비밀번호는 방 입장 PIN과 다르게 정해 주세요.');
  room.hostPassword = p;
}

export function createRoom({ churchId, title, map, capacity, questionSeconds, level, questionCount, pin, hostPassword }) {
  const church = getChurch(churchId);
  if (!church) throw new Error('교회를 찾을 수 없어요.');
  const roomHostPassword = normalizeHostPassword(hostPassword);
  let roomPin = normalizeRoomPin(pin);
  if (roomPin === roomHostPassword) {
    if (pin) throw new Error('진행자 비밀번호는 방 입장 PIN과 다르게 정해 주세요.');
    while (roomPin === roomHostPassword) roomPin = normalizeRoomPin(); // 자동 PIN 이 우연히 같으면 다시 뽑는다
  }
  const room = {
    id: randomUUID(),
    pin: roomPin,
    hostPassword: roomHostPassword,
    hostFails: { count: 0, lockedUntil: 0 }, // 진행자 비밀번호 틀린 횟수 (방 단위)
    hostKey: randomUUID(), // 방을 만든 브라우저만 아는 값 (호스트 화면 다시 열 때 확인)
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
    groupCode: null, // 출석·달란트를 기록할 반 코드 (교사 PIN 확인 후에만 연결)
    team: { enabled: false, count: 2, bonus: DEFAULT_TEAM_BONUS },
    finalResult: null, // 게임이 끝나면 채워지는 결과 요약 (MVP, 팀 승패, 달란트)
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
      teamId: null,
      recordKey: null, // 반 기록에 연결된 닉네임 키 (닉네임 주인 확인을 통과한 경우만)
      cosmetics: {}, // 상점에서 사서 착용한 아이템 { hat, outfit, extra }
      motion: createMotion(),
    };
    room.players.set(deviceId, player);
    // 팀 대결이 켜진 방에 나중에 들어온 친구는 인원이 가장 적은 팀으로.
    if (room.team.enabled) player.teamId = smallestTeamId(room);
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
  room.finalResult = null;
  for (const p of room.players.values()) {
    p.score = 0;
    p.side = null;
    if (room.team.enabled && !activeTeamIds(room).includes(p.teamId)) p.teamId = smallestTeamId(room);
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

// forHost: true 일 때만 방 PIN 을 담는다 (학생 쪽 스냅샷에는 넣지 않는다).
export function serializeRoom(room, { forHost = false } = {}) {
  const q = currentQuestion(room);
  return {
    id: room.id,
    ...(forHost ? { pin: room.pin, hostPassword: room.hostPassword } : {}),
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
      teamId: room.team.enabled ? p.teamId : null,
      cosmetics: p.cosmetics || {},
      recorded: !!p.recordKey,
    })),
    groupCode: room.groupCode,
    team: serializeTeam(room),
    finalResult: room.status === 'finished' ? room.finalResult : null,
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

// ---------------------------------------------------------------------------
// 당일 내기 팀 대결
// ---------------------------------------------------------------------------

export function activeTeamIds(room) {
  return TEAM_DEFS.slice(0, room.team.count).map((t) => t.id);
}

function teamSizes(room) {
  const sizes = new Map(activeTeamIds(room).map((id) => [id, 0]));
  for (const p of room.players.values()) {
    if (sizes.has(p.teamId)) sizes.set(p.teamId, sizes.get(p.teamId) + 1);
  }
  return sizes;
}

function smallestTeamId(room) {
  let best = null;
  for (const [id, size] of teamSizes(room)) {
    if (best === null || size < best.size) best = { id, size };
  }
  return best ? best.id : null;
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 균형 랜덤 나누기: 섞은 뒤 한 명씩 돌아가며 배정 → 팀 인원 차이는 최대 1명.
// 어느 팀이 한 명 더 받을지도 매번 달라지도록 팀 순서도 섞는다.
export function autoSplitTeams(room) {
  const ids = shuffle(activeTeamIds(room));
  shuffle([...room.players.values()]).forEach((p, i) => {
    p.teamId = ids[i % ids.length];
  });
}

export function setTeamMode(room, { enabled, count, bonus } = {}) {
  if (room.status !== 'lobby' && room.status !== 'finished') {
    throw new Error('팀 설정은 게임 시작 전에만 바꿀 수 있어요.');
  }
  const t = room.team;
  const prevCount = t.count;
  if (count !== undefined) t.count = clamp(Math.round(Number(count)) || 2, 2, TEAM_DEFS.length);
  if (bonus !== undefined) t.bonus = clamp(Math.round(Number(bonus)) || 0, 0, MAX_TEAM_BONUS);
  const wasEnabled = t.enabled;
  if (enabled !== undefined) t.enabled = !!enabled;
  if (t.enabled && (!wasEnabled || t.count !== prevCount)) autoSplitTeams(room);
  if (!t.enabled) for (const p of room.players.values()) p.teamId = null;
}

export function assignTeam(room, playerId, teamId) {
  if (!room.team.enabled) throw new Error('팀 대결이 꺼져 있어요.');
  if (room.status !== 'lobby' && room.status !== 'finished') {
    throw new Error('팀은 게임 시작 전에만 바꿀 수 있어요.');
  }
  const player = room.players.get(playerId);
  if (!player) throw new Error('참가자를 찾을 수 없어요.');
  if (!activeTeamIds(room).includes(teamId)) throw new Error('없는 팀이에요.');
  player.teamId = teamId;
}

// 팀 점수 = 팀원 정답 수의 평균(소수 2자리). 인원이 달라도 공평하도록
// 승패는 평균으로 가린다. 합계도 함께 보여 준다. 팀원이 없는 팀은 제외.
export function teamStandings(room) {
  return TEAM_DEFS.slice(0, room.team.count)
    .map((def) => {
      const members = [...room.players.values()].filter((p) => p.teamId === def.id);
      const total = members.reduce((s, p) => s + p.score, 0);
      return {
        id: def.id,
        name: def.name,
        color: def.color,
        size: members.length,
        total,
        average: members.length ? Math.round((total / members.length) * 100) / 100 : 0,
      };
    });
}

function serializeTeam(room) {
  if (!room.team.enabled) return { enabled: false, count: room.team.count, bonus: room.team.bonus, teams: [] };
  return { enabled: true, count: room.team.count, bonus: room.team.bonus, teams: teamStandings(room) };
}

// 게임 종료 시 결과 요약을 만든다 (기록 저장은 index.js 에서).
// - MVP: 최고 득점자(들), 0점이면 없음
// - 팀 승패: 평균이 가장 높은 팀이 이긴 팀. 동률이면 공동 우승(무승부),
//   모든 팀이 동률이면 진 팀 없음.
export function buildFinalResult(room) {
  const players = [...room.players.values()];
  const top = Math.max(0, ...players.map((p) => p.score));
  const mvpIds = top > 0 ? players.filter((p) => p.score === top).map((p) => p.id) : [];
  let team = null;
  if (room.team.enabled) {
    const teams = teamStandings(room).filter((t) => t.size > 0);
    if (teams.length >= 2) {
      const best = Math.max(...teams.map((t) => t.average));
      const winnerTeamIds = teams.filter((t) => t.average === best).map((t) => t.id);
      team = {
        teams,
        winnerTeamIds,
        loserTeamIds: teams.filter((t) => t.average !== best).map((t) => t.id),
        tie: winnerTeamIds.length > 1,
        bonus: room.team.bonus,
      };
    }
  }
  return {
    totalQuestions: room.questions.length,
    mvpIds,
    team,
    awards: [], // 반이 연결돼 있으면 index.js 가 채운다
    recorded: false,
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
    groupCode: room.groupCode,
    teamMode: room.team.enabled,
  };
}
