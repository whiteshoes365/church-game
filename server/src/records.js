// 반(그룹)별 출석 · 달란트 기록 저장소.
//
// - 저장 위치: server/data/church-records/<반코드>.json (RECORDS_DIR 로 변경 가능, gitignore).
// - 개인정보 최소화: 닉네임(+블록 아바타 문자열)만 저장해요. 실명/전화/생일 없음.
// - 쓰기는 임시 파일에 쓴 뒤 rename 하는 원자적 쓰기.
// - 교사 전용 동작은 반마다 정한 교사 PIN(scrypt 해시로만 저장)으로 보호해요.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

const DEFAULT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/church-records');

export function recordsDir() {
  return process.env.RECORDS_DIR ? path.resolve(process.env.RECORDS_DIR) : DEFAULT_DIR;
}

// ---- 달란트 규칙 (RESULT.md 에 문서화) ----
export const TALENT_RULES = {
  participation: 1, // 게임을 끝까지 함께한 모든 참가자
  rank: [3, 2, 1], // 1·2·3등 (동점은 같은 등수, 0점은 순위 보상 없음)
  perfect: 2, // 전 문제 정답 (5문제 이상인 게임만)
  perfectMinQuestions: 5,
  streakWeeks: 3, // 연속 출석 3주 이상이면
  streakBonus: 1, // 그 주 첫 출석 때 +1
  teamBonusDefault: 2, // 팀 대결 승리 팀원 보너스 기본값 (교사가 0~5로 조정)
  teamBonusMax: 5,
  manualMax: 100, // 교사 수동 조정 1회 한도 (±)
};

export const STREAK_BADGES = [
  { weeks: 8, id: 'diamond', label: '다이아 개근' },
  { weeks: 5, id: 'gold', label: '황금 개근' },
  { weeks: 3, id: 'iron', label: '철벽 출석' },
  { weeks: 2, id: 'wood', label: '연속 출석' },
];

const MAX_LEDGER = 5000;
const MAX_GAMES = 300;

// ---- 주(ISO week) 계산: 한국 시간(KST, UTC+9) 기준 ----
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function isoWeekKST(now = Date.now()) {
  const d = new Date(Number(now) + KST_OFFSET_MS); // UTC 필드를 KST 벽시계로 읽는다
  const day = d.getUTCDay() || 7; // 월=1 … 일=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // 그 주의 목요일
  const year = d.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// 해당 ISO 주의 월요일 00:00 (KST) 의 epoch ms
export function weekStartMs(weekId) {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekId);
  if (!m) throw new Error(`잘못된 주 형식: ${weekId}`);
  const year = Number(m[1]);
  const week = Number(m[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const mondayUtc = Date.UTC(year, 0, 4 - (jan4Day - 1) + (week - 1) * 7);
  return mondayUtc - KST_OFFSET_MS;
}

export function prevWeek(weekId) {
  return isoWeekKST(weekStartMs(weekId) - 3 * 86400000);
}

// "11/9~11/15" 같은 표시용 라벨
export function weekLabel(weekId) {
  const start = new Date(weekStartMs(weekId) + KST_OFFSET_MS);
  const end = new Date(start.getTime() + 6 * 86400000);
  return `${start.getUTCMonth() + 1}/${start.getUTCDate()}~${end.getUTCMonth() + 1}/${end.getUTCDate()}`;
}

// ---- 코드 / 닉네임 / PIN 정규화 ----
export function normalizeCode(code) {
  const c = String(code ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!/^[0-9a-z가-힣_-]{2,20}$/.test(c)) {
    throw new Error('반 코드는 한글·영문·숫자 2~20자로 정해 주세요.');
  }
  return c;
}

export function nickKey(nickname) {
  return String(nickname ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function cleanNickname(nickname) {
  const n = String(nickname ?? '').trim().replace(/\s+/g, ' ').slice(0, 12);
  if (!n) throw new Error('닉네임을 입력해 주세요.');
  return n;
}

function validPin(pin) {
  return typeof pin === 'string' && /^\d{4,8}$/.test(pin);
}

function hashPin(pin, salt) {
  return scryptSync(pin, salt, 32).toString('hex');
}

// ---- 파일 입출력 ----
const cache = new Map(); // code -> group

function fileFor(code) {
  return path.join(recordsDir(), `${code}.json`);
}

function saveGroup(group) {
  const dir = recordsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = fileFor(group.code);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(group, null, 1));
  fs.renameSync(tmp, file); // 같은 디렉터리 안 rename = 원자적 교체
}

function loadGroup(code) {
  if (cache.has(code)) return cache.get(code);
  const file = fileFor(code);
  if (!fs.existsSync(file)) return null;
  const group = JSON.parse(fs.readFileSync(file, 'utf8'));
  group.members ||= {};
  group.ledger ||= [];
  group.games ||= [];
  cache.set(code, group);
  return group;
}

export function groupExists(code) {
  return !!loadGroup(normalizeCode(code));
}

// 반을 열거나(기존 PIN 확인) 새로 만든다(PIN 설정). 반환: { group, created }
export function openGroup(code, pin, { create = false, now = Date.now() } = {}) {
  const c = normalizeCode(code);
  if (!validPin(pin)) throw new Error('교사 PIN은 숫자 4~8자리예요.');
  let group = loadGroup(c);
  if (group) {
    const a = Buffer.from(hashPin(pin, group.pinSalt), 'hex');
    const b = Buffer.from(group.pinHash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('교사 PIN이 맞지 않아요.');
    return { group, created: false };
  }
  if (!create) throw new Error('아직 없는 반 코드예요. "새 반 만들기"로 만들어 주세요.');
  const pinSalt = randomBytes(16).toString('hex');
  group = {
    version: 1,
    code: c,
    createdAt: now,
    pinSalt,
    pinHash: hashPin(pin, pinSalt),
    members: {},
    ledger: [],
    games: [],
  };
  cache.set(c, group);
  saveGroup(group);
  return { group, created: true };
}

function requireGroup(code) {
  const group = loadGroup(normalizeCode(code));
  if (!group) throw new Error('반을 찾을 수 없어요.');
  return group;
}

function ensureMember(group, nickname, avatar, now) {
  const display = cleanNickname(nickname);
  const key = nickKey(display);
  let member = group.members[key];
  if (!member) {
    member = { nickname: display, avatar: avatar || null, firstSeenAt: now, attendance: {} };
    group.members[key] = member;
  } else {
    member.nickname = display;
    if (avatar) member.avatar = avatar;
  }
  return { key, member };
}

// 기준 주(week)까지 이어지는 연속 출석 주 수. 기준 주에 출석이 없으면
// 바로 전 주까지의 연속을 센다(이번 주 모임 전에도 배지가 유지되도록).
export function streakOf(member, week) {
  let w = week;
  if (!member.attendance[w]) w = prevWeek(w);
  let n = 0;
  while (member.attendance[w]) {
    n += 1;
    w = prevWeek(w);
  }
  return n;
}

export function badgeFor(streak) {
  return STREAK_BADGES.find((b) => streak >= b.weeks) || null;
}

function pushLedger(group, entry) {
  group.ledger.push(entry);
  if (group.ledger.length > MAX_LEDGER) {
    // 오래된 내역은 닉네임별 이월 잔액으로 접어서 합계가 변하지 않게 한다.
    const drop = group.ledger.splice(0, group.ledger.length - MAX_LEDGER);
    for (const e of drop) {
      const m = group.members[e.key];
      if (m) m.carried = (m.carried || 0) + e.delta;
    }
  }
}

function addLedger(group, { key, nickname, delta, reason, kind, gameId = null, now }) {
  const entry = {
    id: randomUUID(),
    at: now,
    week: isoWeekKST(now),
    key,
    nickname,
    delta,
    reason,
    kind, // 'game' | 'team' | 'streak' | 'manual'
    gameId,
  };
  pushLedger(group, entry);
  return entry;
}

// 출석 표시. 같은 주에 여러 번 들어와도 1회만 기록. 반환: { week, newlyMarked, streak, streakBonus }
export function markAttendance(code, { nickname, avatar = null, via = 'join', now = Date.now() }) {
  const group = requireGroup(code);
  const { key, member } = ensureMember(group, nickname, avatar, now);
  const week = isoWeekKST(now);
  let newlyMarked = false;
  let streakBonus = 0;
  if (!member.attendance[week]) {
    member.attendance[week] = { at: now, via };
    newlyMarked = true;
    const streak = streakOf(member, week);
    if (streak >= TALENT_RULES.streakWeeks && TALENT_RULES.streakBonus > 0) {
      streakBonus = TALENT_RULES.streakBonus;
      addLedger(group, {
        key,
        nickname: member.nickname,
        delta: streakBonus,
        reason: `연속 출석 ${streak}주 보너스`,
        kind: 'streak',
        now,
      });
    }
  }
  saveGroup(group);
  return { week, newlyMarked, streak: streakOf(member, week), streakBonus };
}

// 교사가 실수로 찍힌 출석을 지울 때
export function unmarkAttendance(code, { nickname, week, now = Date.now() }) {
  const group = requireGroup(code);
  const member = group.members[nickKey(nickname)];
  const w = week || isoWeekKST(now);
  if (!member || !member.attendance[w]) return false;
  delete member.attendance[w];
  saveGroup(group);
  return true;
}

// 교사 수동 가감 (사유 필수)
export function adjustTalent(code, { nickname, delta, reason, now = Date.now() }) {
  const group = requireGroup(code);
  const d = Math.round(Number(delta));
  if (!Number.isFinite(d) || d === 0) throw new Error('더하거나 뺄 달란트 수를 입력해 주세요.');
  if (Math.abs(d) > TALENT_RULES.manualMax) throw new Error(`한 번에 ±${TALENT_RULES.manualMax}달란트까지만 조정할 수 있어요.`);
  const why = String(reason ?? '').trim().slice(0, 40);
  if (!why) throw new Error('사유를 입력해 주세요.');
  const { key, member } = ensureMember(group, nickname, null, now);
  const entry = addLedger(group, { key, nickname: member.nickname, delta: d, reason: why, kind: 'manual', now });
  saveGroup(group);
  return entry;
}

// 게임 한 판의 자동 달란트 계산 (순수 함수).
// players: [{ id, nickname, score, teamId? }], totalQuestions, team: { bonus, winnerTeamIds, names } | null
// 반환: [{ id, nickname, delta, parts: [{ delta, reason, kind }] }]
export function computeGameAwards({ players, totalQuestions, team = null }) {
  const R = TALENT_RULES;
  const distinct = [...new Set(players.map((p) => p.score).filter((s) => s > 0))].sort((a, b) => b - a);
  return players.map((p) => {
    const parts = [{ delta: R.participation, reason: '게임 참가', kind: 'game' }];
    if (p.score > 0) {
      // 경쟁 순위(1,1,3…): 나보다 점수가 높은 사람 수 + 1
      const rank = players.filter((o) => o.score > p.score).length + 1;
      if (rank <= R.rank.length && distinct.includes(p.score)) {
        parts.push({ delta: R.rank[rank - 1], reason: `${rank}등`, kind: 'game' });
      }
    }
    if (totalQuestions >= R.perfectMinQuestions && p.score === totalQuestions) {
      parts.push({ delta: R.perfect, reason: '만점', kind: 'game' });
    }
    if (team && team.bonus > 0 && p.teamId && team.winnerTeamIds.includes(p.teamId)) {
      parts.push({ delta: team.bonus, reason: `팀 대결 승리 (${team.names[p.teamId] || '우리 팀'})`, kind: 'team' });
    }
    return { id: p.id, nickname: p.nickname, delta: parts.reduce((s, x) => s + x.delta, 0), parts };
  });
}

// 끝난 게임을 기록하고 달란트를 원장에 적는다. 반환: { gameId, awards }
export function recordGame(code, { roomTitle, level, totalQuestions, players, team = null, mvpNicknames = [], now = Date.now() }) {
  const group = requireGroup(code);
  const gameId = randomUUID();
  const awards = computeGameAwards({ players, totalQuestions, team });
  const byId = new Map(players.map((p) => [p.id, p]));
  for (const award of awards) {
    const p = byId.get(award.id);
    const { key, member } = ensureMember(group, p.nickname, p.avatar, now);
    // 게임을 했다면 그 주 출석이기도 하다 (입장 때 이미 찍혔으면 그대로).
    if (!member.attendance[isoWeekKST(now)]) member.attendance[isoWeekKST(now)] = { at: now, via: 'game' };
    for (const part of award.parts) {
      addLedger(group, { key, nickname: member.nickname, delta: part.delta, reason: part.reason, kind: part.kind, gameId, now });
    }
  }
  group.games.push({
    id: gameId,
    at: now,
    week: isoWeekKST(now),
    roomTitle,
    level,
    totalQuestions,
    players: players.map((p) => ({ nickname: p.nickname, score: p.score, teamId: p.teamId || null })),
    mvpNicknames,
    team: team
      ? {
          bonus: team.bonus,
          tie: !!team.tie,
          teams: team.teams, // [{ id, name, color, size, total, average }]
          winnerTeamIds: team.winnerTeamIds,
        }
      : null,
  });
  if (group.games.length > MAX_GAMES) group.games.splice(0, group.games.length - MAX_GAMES);
  saveGroup(group);
  return { gameId, awards };
}

// 교사 화면용 요약 (PIN 해시는 절대 내보내지 않는다)
export function groupSummary(code, { now = Date.now(), weeksBack = 8 } = {}) {
  const group = requireGroup(code);
  const currentWeek = isoWeekKST(now);

  const weekIds = [];
  let w = currentWeek;
  for (let i = 0; i < weeksBack; i++) {
    weekIds.unshift(w);
    w = prevWeek(w);
  }

  const totals = new Map();
  const weekTotals = new Map();
  for (const [key, m] of Object.entries(group.members)) totals.set(key, m.carried || 0);
  for (const e of group.ledger) {
    totals.set(e.key, (totals.get(e.key) || 0) + e.delta);
    if (e.week === currentWeek) weekTotals.set(e.key, (weekTotals.get(e.key) || 0) + e.delta);
  }

  const members = Object.entries(group.members).map(([key, m]) => {
    const streak = streakOf(m, currentWeek);
    const badge = badgeFor(streak);
    return {
      key,
      nickname: m.nickname,
      avatar: m.avatar || null,
      total: totals.get(key) || 0,
      weekTalents: weekTotals.get(key) || 0,
      attendedWeeks: Object.keys(m.attendance).sort(),
      attendCount: Object.keys(m.attendance).length,
      presentThisWeek: !!m.attendance[currentWeek],
      streak,
      badge: badge ? { id: badge.id, label: badge.label } : null,
    };
  });
  members.sort((a, b) => b.total - a.total || a.nickname.localeCompare(b.nickname, 'ko'));

  // 이번 주 MVP: 이번 주에 달란트를 가장 많이 번 친구(들). 0 이하는 MVP 없음.
  const bestWeek = Math.max(0, ...members.map((m) => m.weekTalents));
  const mvp = bestWeek > 0 ? members.filter((m) => m.weekTalents === bestWeek).map((m) => ({ nickname: m.nickname, avatar: m.avatar, weekTalents: m.weekTalents })) : [];

  return {
    code: group.code,
    currentWeek,
    weeks: weekIds.map((id) => ({
      id,
      label: weekLabel(id),
      presentCount: Object.values(group.members).filter((m) => m.attendance[id]).length,
    })),
    members,
    mvp,
    ledger: group.ledger.slice(-400).reverse().map(({ key, ...rest }) => ({ key, ...rest })),
    games: group.games.slice(-30).reverse(),
    rules: TALENT_RULES,
  };
}

// 테스트용: 메모리 캐시 비우기 (파일에서 다시 읽는지 확인할 때)
export function _clearCache() {
  cache.clear();
}
