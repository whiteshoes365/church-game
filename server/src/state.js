import { randomUUID } from 'node:crypto';
import { QUESTIONS } from './questions.js';

export const QUESTION_DURATION_MS = 15000;

const churches = new Map(); // id -> { id, name, normalized }
const rooms = new Map(); // id -> room

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

export function createRoom({ churchId, title, map, capacity }) {
  const church = getChurch(churchId);
  if (!church) throw new Error('교회를 찾을 수 없어요.');
  const room = {
    id: randomUUID(),
    churchId,
    title: (title || '방').trim(),
    map: map || 'sanctuary',
    capacity: capacity === 'unlimited' ? 'unlimited' : Number(capacity) || 8,
    hostSocket: null,
    players: new Map(), // deviceId -> player
    status: 'lobby', // lobby | question | reveal | finished
    questionOrder: [],
    currentIndex: -1,
    answers: new Map(), // deviceId -> 'O' | 'X'
    deadline: null,
    timer: null,
    lastResult: null,
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
    };
    room.players.set(deviceId, player);
  } else {
    player.nickname = (nickname || player.nickname).slice(0, 12);
    player.avatar = avatar || player.avatar;
    player.connected = true;
  }
  return player;
}

function shuffledIndices(n) {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function startQuiz(room, questionCount) {
  clearTimer(room);
  const count = Math.min(questionCount || QUESTIONS.length, QUESTIONS.length);
  room.questionOrder = shuffledIndices(QUESTIONS.length).slice(0, count);
  room.currentIndex = -1;
  room.lastResult = null;
  for (const p of room.players.values()) {
    p.score = 0;
    p.side = null;
  }
}

export function currentQuestion(room) {
  if (room.currentIndex < 0 || room.currentIndex >= room.questionOrder.length) return null;
  return QUESTIONS[room.questionOrder[room.currentIndex]];
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

  if (room.currentIndex >= room.questionOrder.length) {
    room.status = 'finished';
    room.deadline = null;
    return;
  }
  room.status = 'question';
  room.deadline = Date.now() + QUESTION_DURATION_MS;
  room.timer = setTimeout(() => onTimeout(room), QUESTION_DURATION_MS);
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

export function revealAnswer(room) {
  if (room.status !== 'question') return;
  clearTimer(room);
  const q = currentQuestion(room);
  room.status = 'reveal';
  room.deadline = null;
  const correctPlayerIds = [];
  for (const [deviceId, player] of room.players) {
    const choice = room.answers.get(deviceId);
    if (choice === q.answer) {
      player.score += 1;
      correctPlayerIds.push(deviceId);
    }
  }
  room.lastResult = {
    questionText: q.text,
    correctAnswer: q.answer,
    correctPlayerIds,
  };
}

export function serializeRoom(room) {
  const q = currentQuestion(room);
  return {
    id: room.id,
    churchId: room.churchId,
    title: room.title,
    map: room.map,
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
    question:
      room.status === 'question' || room.status === 'reveal'
        ? {
            index: room.currentIndex,
            total: room.questionOrder.length,
            text: q ? q.text : null,
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
    capacity: room.capacity,
    playerCount: room.players.size,
    status: room.status,
  };
}
