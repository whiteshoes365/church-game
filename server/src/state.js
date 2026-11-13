import { randomInt, randomUUID } from 'node:crypto';
import { DEFAULT_QUESTION_COUNT, normalizeLevel, availableQuestionCount, selectQuizQuestions } from './questions.js';
import { hiddenQuestionIds } from './questionReports.js';

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
// 뛰기·기어가기는 "잠깐 쓰는 기술": 버튼을 누르면 GAIT_ACTIVE_MS 동안만 켜지고,
// 끝난 순간부터 GAIT_COOLDOWN_MS 동안은 다시 쓸 수 없다 (뛰기·기어가기 따로 센다).
// 걷기는 기본이고 제한이 없다. 시간·속도는 모두 서버가 정한다 — 클라이언트가
// 보내는 것은 "방향(크기 1 이하)"과 "기술을 써 달라는 요청"뿐이다.
export const GAIT_ACTIVE_MS = 3000;
export const GAIT_COOLDOWN_MS = 10000;
export const GAIT_SPEEDS = { run: RUN_SPEED, crawl: CRAWL_SPEED };
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
const joinCodes = new Map(); // 입장 코드(짧은 글자) -> room id

// 배경 음악: 소리는 송출 화면(또는 진행자 PC)에서만 난다. 서버는 "지금 고른 곡·크기"만 기억해서
// 진행자 화면·리모컨·송출 화면이 같은 값을 보게 한다. 곡 id 는 client/src/music.ts 와 같다.
export const MUSIC_TRACK_IDS = ['upbeat', 'calm', 'countdown', 'chiptune', 'march', 'musicbox'];
export const DEFAULT_MUSIC = { track: 'upbeat', enabled: true, volume: 0.3 };

export function normalizeMusic(input, base = DEFAULT_MUSIC) {
  const next = { ...base };
  if (input && typeof input === 'object') {
    if (MUSIC_TRACK_IDS.includes(input.track)) next.track = input.track;
    if (typeof input.enabled === 'boolean') next.enabled = input.enabled;
    const v = Number(input.volume);
    if (input.volume !== undefined && input.volume !== null && Number.isFinite(v)) next.volume = Math.round(clamp(v, 0, 1) * 100) / 100;
  }
  return next;
}

// 입장 코드: QR·주소에 넣는 짧은 방 이름표 (헷갈리는 0/O, 1/I/L 은 뺀다). 비밀이 아니다 — 방 PIN 이 따로 있다.
const JOIN_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const JOIN_CODE_LENGTH = 5;

function newJoinCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < JOIN_CODE_LENGTH; i++) code += JOIN_CODE_ALPHABET[randomInt(0, JOIN_CODE_ALPHABET.length)];
    if (!joinCodes.has(code)) return code;
  }
}

export function normalizeJoinCode(code) {
  return String(code ?? '').trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function findRoomByJoinCode(code) {
  const id = joinCodes.get(normalizeJoinCode(code));
  return id ? rooms.get(id) || null : null;
}

// 학생 입장 주소의 해시 경로. QR 에는 방 PIN 까지 넣고(withPin), 글자로 보여 주는 주소에는 넣지 않는다.
// 전체 주소 = <사이트 주소>/#<이 경로>
export function joinPathFor(room, { withPin = true } = {}) {
  return `/j/${room.joinCode}${withPin ? `?p=${room.pin}` : ''}`;
}

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
  // 반드시 O/X 구역(z 1~6.5) 밖 중립 지대에서 시작한다 (움직이지 않은 학생이 구역에 있으면 안 됨).
  // 앞줄 발 잘림은 카메라·화면 여백으로 맞춘다 — 시작 z 를 구역 안으로 끌어오면 안 된다.
  return {
    x: MAP_BOUNDS.xmin + 0.5 + Math.random() * (MAP_BOUNDS.xmax - MAP_BOUNDS.xmin - 1),
    z: 7 + Math.random() * 1.5, // 7.0 ~ 8.5 (구역 zmax 6.5 밖)
  };
}

function createMotion() {
  const spawn = randomSpawn();
  return {
    pos: spawn,
    y: 0,
    vy: 0,
    input: { x: 0, z: 0 },
    // 지금 켜져 있는 기술('run' | 'crawl' | null)과 끝나는 시각, 기술별 다시 쓸 수 있는 시각
    gait: { mode: null, until: 0, readyAt: { run: 0, crawl: 0 } },
    // 예전 방식(move 메시지의 run/crawl 값)에서 "방금 눌렀는지"를 알아내기 위한 직전 값
    legacyFlags: { run: false, crawl: false },
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

// 반환값: 예전 방식(move 의 run/crawl 값이 false→true 로 바뀜)으로 기술을 요청했다면
// 그 결과({ ok, ... }), 아니면 null.
export function setPlayerInput(room, deviceId, { dir, run, crawl } = {}, now = Date.now()) {
  const player = room.players.get(deviceId);
  if (!player) return null;
  const m = player.motion;
  // 방향은 축마다 -1..1 로 자르고, 물리 계산에서 크기를 1 이하로 다시 자른다.
  // (클라이언트가 큰 숫자를 보내도 그 걸음걸이의 최고 속도를 넘을 수 없다.)
  const x = clamp(Number(dir?.x) || 0, -1, 1);
  const z = clamp(Number(dir?.z) || 0, -1, 1);
  m.input.x = x;
  m.input.z = z;
  // Manual joystick/d-pad input always cancels an in-progress O/X auto-walk.
  if (Math.hypot(x, z) > 0.05) m.autoTarget = null;
  // run/crawl 값은 "계속 뛰게 해 달라"가 아니라 "기술을 써 달라"는 요청으로만 본다.
  // 계속 true 를 보내도 한 번만 요청되고, 시간·쿨타임은 requestGait 가 지킨다.
  let requested = null;
  const wantRun = !!run;
  const wantCrawl = !!crawl;
  if (wantRun && !m.legacyFlags.run) requested = requestGait(room, deviceId, 'run', now);
  else if (wantCrawl && !m.legacyFlags.crawl) requested = requestGait(room, deviceId, 'crawl', now);
  m.legacyFlags.run = wantRun;
  m.legacyFlags.crawl = wantCrawl;
  return requested;
}

function expireGait(m, now) {
  if (m.gait.mode && now >= m.gait.until) m.gait.mode = null;
}

// 뛰기('run')·기어가기('crawl') 켜기, 또는 'walk' 로 지금 기술을 일찍 끄기.
// - 켜면 GAIT_ACTIVE_MS 동안만 유지되고, 끝난 순간부터 GAIT_COOLDOWN_MS 가 지나야 다시 쓸 수 있다.
// - 다른 기술이 켜져 있는 동안이나 쿨타임 중의 요청은 거절한다 (걷기 그대로).
// - 일찍 끄면 그 순간부터 쿨타임을 센다.
export function requestGait(room, deviceId, mode, now = Date.now()) {
  const player = room.players.get(deviceId);
  if (!player) return null;
  const m = player.motion;
  expireGait(m, now);
  let ok = false;
  let reason = null;
  if (mode === 'walk' || mode === null || mode === undefined) {
    if (m.gait.mode) {
      m.gait.readyAt[m.gait.mode] = now + GAIT_COOLDOWN_MS;
      m.gait.mode = null;
    }
    ok = true;
  } else if (mode !== 'run' && mode !== 'crawl') {
    reason = 'unknown';
  } else if (m.gait.mode) {
    reason = 'busy';
  } else if (now < m.gait.readyAt[mode]) {
    reason = 'cooldown';
  } else {
    m.gait.mode = mode;
    m.gait.until = now + GAIT_ACTIVE_MS;
    m.gait.readyAt[mode] = m.gait.until + GAIT_COOLDOWN_MS;
    ok = true;
  }
  return { ok, reason, ...gaitStatus(room, deviceId, now) };
}

// 학생 폰이 버튼에 남은 시간을 보여 줄 수 있게, 시각이 아니라 "남은 ms" 로 알려 준다
// (폰 시계가 서버와 달라도 맞는다).
export function gaitStatus(room, deviceId, now = Date.now()) {
  const player = room.players.get(deviceId);
  if (!player) return null;
  const m = player.motion;
  expireGait(m, now);
  const mode = m.gait.mode;
  const cooldownMs = {};
  for (const key of ['run', 'crawl']) {
    // 쿨타임은 기술이 끝난 뒤부터 센다: 켜져 있는 동안은 "끝난 뒤 남을 쿨타임" 전체.
    const from = mode === key ? m.gait.until : now;
    cooldownMs[key] = Math.max(0, m.gait.readyAt[key] - from);
  }
  return {
    mode,
    activeMs: mode ? Math.max(0, m.gait.until - now) : 0,
    cooldownMs,
    durationMs: GAIT_ACTIVE_MS,
    cooldownTotalMs: GAIT_COOLDOWN_MS,
  };
}

export function requestPlayerJump(room, deviceId) {
  const player = room.players.get(deviceId);
  if (!player) return;
  player.motion.jumpRequested = true;
}

// O/X 구역 안의 "설 자리" 격자. 여러 명이 같은 구역으로 걸어가도 한가운데에
// 겹쳐 서지 않도록, 인원이 늘수록 더 촘촘한 격자를 쓴다. 줄마다 반 칸씩 엇갈려
// 이름표가 앞뒤 줄끼리 덜 가리게 한다. 모든 자리는 구역 안쪽(가장자리에서 떨어진 곳)이다.
const ZONE_SLOT_GRIDS = [
  [3, 4],
  [4, 5],
  [5, 6],
  [7, 8],
  [9, 10],
];

export function zoneSlots(box, cols, rows) {
  const sx = (box.xmax - box.xmin) / cols;
  const sz = (box.zmax - box.zmin) / rows;
  const stagger = Math.max(0, Math.min(sx * 0.25, sx / 2 - 0.35));
  const slots = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      slots.push({
        x: box.xmin + sx * (c + 0.5) + (r % 2 === 0 ? -stagger : stagger),
        z: box.zmin + sz * (r + 0.5),
      });
    }
  }
  return { slots, clear: Math.min(sx, sz) * 0.6 };
}

function inBox(pos, box) {
  return pos.x >= box.xmin && pos.x <= box.xmax && pos.z >= box.zmin && pos.z <= box.zmax;
}

// 이 구역에서 아직 비어 있는 자리 중, 지금 위치에서 가장 가까운 곳을 고른다.
// "차 있음" = 다른 친구가 그 근처에 서 있거나, 그 근처로 걸어가는 중.
export function pickZoneSlot(room, deviceId, zone) {
  const box = ZONES[zone];
  const me = room.players.get(deviceId);
  if (!box || !me) return null;
  const taken = [];
  for (const other of room.players.values()) {
    if (other.id === deviceId) continue;
    const m = other.motion;
    if (m.autoTarget) {
      if (inBox(m.autoTarget, box)) taken.push(m.autoTarget);
    } else if (inBox(m.pos, box)) {
      taken.push(m.pos);
    }
  }
  for (const [cols, rows] of ZONE_SLOT_GRIDS) {
    const { slots, clear } = zoneSlots(box, cols, rows);
    let best = null;
    for (const slot of slots) {
      if (taken.some((t) => Math.hypot(t.x - slot.x, t.z - slot.z) < clear)) continue;
      const d = Math.hypot(slot.x - me.motion.pos.x, slot.z - me.motion.pos.z);
      if (!best || d < best.d) best = { slot, d };
    }
    if (best) return best.slot;
  }
  // 격자가 다 찰 만큼 많으면(구역당 90명 초과) 구역 안 아무 곳으로.
  return {
    x: box.xmin + 0.5 + Math.random() * (box.xmax - box.xmin - 1),
    z: box.zmin + 0.5 + Math.random() * (box.zmax - box.zmin - 1),
  };
}

export function setAutoWalkTarget(room, deviceId, zone) {
  const player = room.players.get(deviceId);
  if (!player) return;
  const slot = pickZoneSlot(room, deviceId, zone);
  if (!slot) return;
  player.motion.autoTarget = { x: slot.x, z: slot.z };
}

export function tickRoomPhysics(room, dtMs, now = Date.now()) {
  const dt = dtMs / 1000;
  const players = [...room.players.values()];

  for (const player of players) {
    const m = player.motion;
    // 이번 틱은 (now - dt, now] 구간을 움직인다: 그 구간이 시작될 때 켜져 있던 기술로 계산한다.
    const gait = m.gait.mode && now - dtMs < m.gait.until ? m.gait.mode : null; // 'run' | 'crawl' | null(걷기)
    expireGait(m, now);
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
      // 손으로 움직일 때의 최고 속도는 지금 켜져 있는 걸음걸이가 정한다 (기본은 걷기).
      const speed = autoWalking ? AUTO_WALK_SPEED : gait ? GAIT_SPEEDS[gait] : WALK_SPEED;
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

    m.state = m.jumping ? 'jump' : gait === 'crawl' ? 'crawl' : moving ? (gait === 'run' ? 'run' : 'walk') : 'idle';
  }

  // Simple pairwise separation so avatars don't overlap heavily. O(n^2) is
  // fine at the player counts this game supports (dozens per room).
  // An avatar that is auto-walking to its O/X spot passes through others until
  // it arrives: every auto-walker has its own reserved spot, and spots sit in
  // straight rows, so pushing would shove an already-standing player off their
  // spot (or stall two walkers meeting head-on in the same row).
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i].motion;
      const b = players[j].motion;
      if (a.autoTarget || b.autoTarget) continue;
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
    // 켜져 있는 기술 (호스트 3D 화면의 "뛰기!/기어가기" 표시용). 걷기일 때는 넣지 않는다.
    ...(p.motion.gait.mode ? { gait: p.motion.gait.mode } : {}),
  }));
}

export function allRooms() {
  return [...rooms.values()];
}

function normalize(name) {
  return name.trim().toLowerCase().replace(/\s+/g, '');
}

export function searchChurches(query) {
  // 빈 검색어에는 아무것도 돌려주지 않는다 (다른 교회 이름이 첫 화면에 그대로 보이지 않게).
  const q = normalize(typeof query === 'string' ? query : '');
  if (!q) return [];
  const list = [...churches.values()];
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

// 방 PIN(학생 입장용): 숫자 4자리. 호스트가 정하지 않으면 자동으로 만든다.
// (교사용 반 기록 PIN 과는 별개 — 이건 학생들에게 불러 주는 번호)
export function normalizeRoomPin(pin) {
  if (pin === undefined || pin === null || pin === '') return String(randomInt(0, 10000)).padStart(4, '0');
  const p = String(pin).trim();
  if (!/^\d{4}$/.test(p)) throw new Error('방 PIN은 숫자 4자리로 정해 주세요.');
  return p;
}

// 진행자(호스트) 비밀번호: 방 PIN 과 별개. 학생에게 불러 주는 PIN 만으로는
// 진행자 화면을 열 수 없다. 정하지 않으면 숫자 6자리를 자동으로 만든다.
export function normalizeHostPassword(password) {
  if (password === undefined || password === null || password === '') return String(randomInt(0, 1000000)).padStart(6, '0');
  const p = String(password).trim();
  if (!/^[0-9A-Za-z]{4,12}$/.test(p)) throw new Error('진행자 비밀번호는 영문·숫자 4~12자로 정해 주세요.');
  return p;
}

export function setHostPassword(room, password) {
  const p = normalizeHostPassword(password);
  if (p === room.pin) throw new Error('진행자 비밀번호는 방 PIN과 다르게 정해 주세요.');
  if (p !== room.hostPassword) room.controlKey = randomUUID(); // 예전 비밀번호로 들어왔던 기기는 다시 확인받는다
  room.hostPassword = p;
}

// 문제 수는 그 난이도 문제 은행 크기를 넘을 수 없다 (은행이 18문제면 30을 골라도 18).
// 은행 크기는 신고로 숨긴 문항을 뺀, 실제로 낼 수 있는 수로 센다.
export function clampQuestionCount(level, count) {
  const bank = availableQuestionCount(level, hiddenQuestionIds());
  const wanted = count ? Math.max(1, Math.round(Number(count)) || DEFAULT_QUESTION_COUNT) : DEFAULT_QUESTION_COUNT;
  return Math.max(1, Math.min(wanted, bank));
}

export function createRoom({ churchId, title, map, capacity, questionSeconds, level, questionCount, pin, hostPassword }) {
  const church = getChurch(churchId);
  if (!church) throw new Error('교회를 찾을 수 없어요.');
  const roomHostPassword = normalizeHostPassword(hostPassword);
  let roomPin = normalizeRoomPin(pin);
  if (roomPin === roomHostPassword) {
    if (pin) throw new Error('진행자 비밀번호는 방 PIN과 다르게 정해 주세요.');
    while (roomPin === roomHostPassword) roomPin = normalizeRoomPin(); // 자동 PIN 이 우연히 같으면 다시 뽑는다
  }
  const room = {
    id: randomUUID(),
    pin: roomPin,
    hostPassword: roomHostPassword,
    hostKey: randomUUID(), // 방을 만든 브라우저만 아는 값 (호스트 화면 다시 열 때 확인)
    // 진행자 비밀번호로 들어온 기기가 다시 접속할 때 쓰는 값. 비밀번호를 바꾸면 새로 만든다.
    controlKey: randomUUID(),
    // 송출 화면(프로젝터) 전용 값: 화면을 볼 수만 있고 진행은 못 한다.
    displayKey: randomUUID(),
    joinCode: newJoinCode(),
    churchId,
    title: (title || '방').trim(),
    map: map || 'sanctuary',
    level: normalizeLevel(level),
    capacity: capacity === 'unlimited' ? 'unlimited' : Number(capacity) || 8,
    hostSockets: new Set(), // 진행 권한이 있는 접속들 (진행자 화면 · 휴대폰 리모컨)
    displaySockets: new Set(), // 송출 화면 접속들 (보기만)
    kicked: new Set(), // 선생님이 내보낸 기기 id (다시 받기 전까지 못 들어온다)
    music: { ...DEFAULT_MUSIC },
    showQr: true, // 송출 화면에 입장 QR 을 보여 줄지
    paused: false, // 문제 시간 멈춤
    remainingMs: null, // 멈춘 순간 남아 있던 시간
    onTimeout: null,
    players: new Map(), // deviceId -> player
    status: 'lobby', // lobby | question | reveal | finished
    questionCount: clampQuestionCount(level, questionCount),
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
  joinCodes.set(room.joinCode, room.id);
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
  room.paused = false;
  room.remainingMs = null;
  const count = clampQuestionCount(room.level, questionCount || room.questionCount);
  const excludeIds = recentIdsForChurch(room.churchId);
  // excludeIds = 최근에 낸 문제(약한 제외), hiddenIds = 신고로 숨긴 문제(강한 제외: 모자라도 넣지 않음).
  // 숨김은 문제를 뽑는 이 시점에만 본다 — 이미 진행 중인 방의 문제는 중간에 빼지 않는다.
  room.questions = selectQuizQuestions({ level: room.level, count, excludeIds, hiddenIds: hiddenQuestionIds() });
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
  room.paused = false;
  room.remainingMs = null;
  room.onTimeout = onTimeout;
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

// 문제 시간 멈춤(진행자 전용): 남은 시간을 기억해 두고 타이머를 끈다.
// 다시 시작하면 그 남은 시간만큼만 더 센다. 멈춘 동안에도 캐릭터는 움직일 수 있다.
export function pauseQuestion(room, now = Date.now()) {
  if (room.status !== 'question' || room.paused) return false;
  clearTimer(room);
  room.remainingMs = Math.max(0, (room.deadline ?? now) - now);
  room.deadline = null;
  room.paused = true;
  return true;
}

export function resumeQuestion(room, now = Date.now()) {
  if (room.status !== 'question' || !room.paused) return false;
  const left = Math.max(0, room.remainingMs ?? 0);
  room.paused = false;
  room.remainingMs = null;
  room.deadline = now + left;
  const onTimeout = room.onTimeout;
  room.timer = setTimeout(() => onTimeout && onTimeout(room), left);
  return true;
}

// 퀴즈 일찍 끝내기(진행자 전용): 지금까지 공개한 문제까지만 치고 결과 화면으로 간다.
// 아직 정답을 공개하지 않은 문제는 점수에 넣지 않는다.
// 공개한 문제가 0개여도 finished + finalResult(0점)를 만들어 결과 띠·시상대가 비지 않게 한다.
export function endQuiz(room) {
  if (room.status !== 'question' && room.status !== 'reveal') return false;
  clearTimer(room);
  const played = room.status === 'reveal' ? room.currentIndex + 1 : room.currentIndex;
  room.questions = room.questions.slice(0, Math.max(0, played));
  room.currentIndex = room.questions.length;
  room.status = 'finished';
  room.deadline = null;
  room.paused = false;
  room.remainingMs = null;
  room.answers = new Map();
  room.lastResult = null;
  for (const p of room.players.values()) p.side = null;
  if (!room.finalResult) room.finalResult = buildFinalResult(room);
  return true;
}

// 내보내기(진행자 전용): 방에서 빼고, 「다시 받기」 전까지 같은 기기는 못 들어온다.
export function kickPlayer(room, playerId) {
  const player = room.players.get(playerId);
  if (!player) return null;
  room.players.delete(playerId);
  room.answers.delete(playerId);
  room.kicked.add(playerId);
  return player;
}

// O / X / 아무 데도 아님 — 지금 서 있는 자리 기준 인원 (리모컨의 응답 현황).
export function zoneCounts(room) {
  const counts = { O: 0, X: 0, none: 0 };
  for (const p of room.players.values()) counts[zoneAt(p.motion.pos) ?? 'none'] += 1;
  return counts;
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
  room.paused = false;
  room.remainingMs = null;
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

// 누가 보는 스냅샷인지(view)에 따라 담는 값이 다르다.
//  - 'player'  : 학생. 방 PIN·진행자 비밀번호·정답 없음.
//  - 'display' : 송출 화면(프로젝터). 방 PIN·입장 주소·음악은 있지만 진행자 비밀번호·정답은 없음.
//  - 'host'    : 진행자 화면. 방 PIN + 진행자 비밀번호.
//  - 'remote'  : 선생님 휴대폰 리모컨. host 와 같고, 지금 문제의 정답·해설도 담는다.
// (forHost: true 는 view: 'host' 의 예전 이름)
export function serializeRoom(room, { forHost = false, view } = {}) {
  const v = view || (forHost ? 'host' : 'player');
  const staff = v === 'host' || v === 'remote';
  const q = currentQuestion(room);
  let remotes = 0;
  for (const s of room.hostSockets) if (s.attachments?.get(room.id) === 'remote') remotes += 1;
  return {
    id: room.id,
    ...(staff || v === 'display'
      ? {
          pin: room.pin,
          joinCode: room.joinCode,
          joinPath: joinPathFor(room, { withPin: true }),
          joinPathNoPin: joinPathFor(room, { withPin: false }),
          music: { ...room.music },
          showQr: room.showQr,
          displayCount: room.displaySockets.size,
          remoteCount: remotes,
        }
      : {}),
    ...(staff ? { hostPassword: room.hostPassword, controlKey: room.controlKey, kickedCount: room.kicked.size } : {}),
    churchId: room.churchId,
    title: room.title,
    map: room.map,
    level: room.level,
    capacity: room.capacity,
    questionCount: room.questionCount,
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
    hasHost: room.hostSockets.size > 0,
    bounds: MAP_BOUNDS,
    zones: ZONES,
    questionDurationMs: room.questionDurationMs,
    // 표시용: 클라이언트가 자기 시계와 서버 시계의 차이를 맞춘다 (타이머 자체는 서버 시계 그대로).
    serverNow: Date.now(),
    question:
      room.status === 'question' || room.status === 'reveal'
        ? {
            index: room.currentIndex,
            total: room.questions.length,
            text: q ? q.text : null,
            category: q ? q.category : null,
            deadline: room.deadline,
            paused: !!room.paused,
            remainingMs: room.paused ? room.remainingMs : null,
            ...(v === 'remote' && q ? { answer: q.answer, explanation: q.explanation ?? null } : {}),
          }
        : null,
    lastResult: room.lastResult,
    // 진행자 화면·리모컨에만: 직전 문제 (문제 신고에서 "직전 문제"를 고를 때 보여 준다).
    ...(staff && prevQuestionOf(room) ? { prevQuestion: prevQuestionOf(room) } : {}),
  };
}

function prevQuestionOf(room) {
  const i = Math.min(room.currentIndex, room.questions.length) - 1;
  if (i < 0 || !room.questions[i]) return null;
  return { index: i, text: room.questions[i].text };
}

// 문제 신고 대상 확인: 이 방에서 index 번째로 나온 문항을 돌려준다.
//  - 선생님(host·remote): 지금 문제와 이미 지나간 문제.
//  - 학생: 정답이 공개된 문제만 (지금 문제는 정답 공개 뒤에만, 지나간 문제는 이미 공개된 것).
export function questionForReport(room, index, role) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= room.questions.length || i > room.currentIndex) {
    throw new Error('신고할 문제를 찾을 수 없어요.');
  }
  const revealed = i < room.currentIndex || room.status === 'reveal' || room.status === 'finished';
  if (role !== 'host' && !revealed) throw new Error('정답이 공개된 뒤에만 신고할 수 있어요.');
  return room.questions[i];
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

// 팀 점수: 합계 = 팀원 점수의 합, 평균 = 합계 ÷ 팀원 수(소수 2자리).
// 인원이 달라도 공평하도록 승패는 평균으로 가린다. 합계와 평균은 항상 같은
// 팀원 목록(memberIds)에서 한 번에 계산한다.
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
        memberIds: members.map((p) => p.id),
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
