// 반(그룹)별 출석 · 달란트 기록 저장소.
//
// - 저장 위치: server/data/church-records/<반코드>.json (RECORDS_DIR 로 변경 가능, gitignore).
// - 개인정보 최소화: 닉네임(+블록 아바타 문자열)만 저장해요. 실명/전화/생일 없음.
// - 쓰기는 임시 파일에 쓴 뒤 rename 하는 원자적 쓰기.
// - 교사 전용 동작은 반마다 정한 교사 PIN(scrypt 해시로만 저장)으로 보호해요.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { SHOP_ITEMS, getShopItem } from './shop.js';

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
  // 주간 상한: 학생 한 명이 한 주(KST)에 자동 지급(참가·등수·만점·연속 출석·팀 보너스)으로
  // 받을 수 있는 최대 달란트. 반마다 교사가 weeklyCapMin~weeklyCapMax 사이로 바꿀 수 있다.
  // 교사 수동 조정은 상한과 무관하게 적용되고(상한 예외로 장부에 표시), 상점 지출은 상한을 쓰지 않는다.
  weeklyCapDefault: 20,
  weeklyCapMin: 1,
  weeklyCapMax: 100,
};

const AUTO_KINDS = new Set(['game', 'team', 'streak']);

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

// 닉네임 비교 키: 전각/반각·조합형 차이(NFKC), 대소문자, 모든 공백을 무시한다.
// "꼬마 사자", " 꼬마사자 ", "꼬마사자" 는 같은 이름으로 본다.
export function nickKey(nickname) {
  return String(nickname ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
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
  group.settings ||= {};
  // 예전 파일의 닉네임 키(공백 유지)를 지금 규칙의 키로 옮긴다.
  for (const [oldKey, m] of Object.entries(group.members)) {
    const key = nickKey(m.nickname);
    if (key === oldKey || !key || group.members[key]) continue;
    group.members[key] = m;
    delete group.members[oldKey];
    for (const e of group.ledger) if (e.key === oldKey) e.key = key;
  }
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
    settings: { weeklyCap: TALENT_RULES.weeklyCapDefault },
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

// ---- 주간 상한 / 잔액 ----
export function weeklyCapOf(group) {
  const cap = Math.round(Number(group.settings?.weeklyCap));
  if (!Number.isFinite(cap)) return TALENT_RULES.weeklyCapDefault;
  return Math.min(TALENT_RULES.weeklyCapMax, Math.max(TALENT_RULES.weeklyCapMin, cap));
}

export function setWeeklyCap(code, cap) {
  const group = requireGroup(code);
  const n = Math.round(Number(cap));
  if (!Number.isFinite(n) || n < TALENT_RULES.weeklyCapMin || n > TALENT_RULES.weeklyCapMax) {
    throw new Error(`주간 상한은 ${TALENT_RULES.weeklyCapMin}~${TALENT_RULES.weeklyCapMax} 사이로 정해 주세요.`);
  }
  group.settings.weeklyCap = n;
  saveGroup(group);
  return n;
}

// 이번 주에 자동 지급으로 받은 달란트 (상한 계산에 쓰이는 값)
function weekAutoEarned(group, key, week) {
  let sum = 0;
  for (const e of group.ledger) if (e.key === key && e.week === week && AUTO_KINDS.has(e.kind) && e.delta > 0) sum += e.delta;
  return sum;
}

function balanceOf(group, key) {
  let sum = group.members[key]?.carried || 0;
  for (const e of group.ledger) if (e.key === key) sum += e.delta;
  return sum;
}

// 자동 지급 항목들을 주간 상한 안에서만 장부에 적는다.
// 상한에 걸리면 남은 만큼만 주고("주간 상한으로 n개만 지급"), 아예 못 준 항목들은
// 0달란트 한 줄로 묶어 기록해서 왜 안 들어왔는지 장부에서 보이게 한다.
function grantAuto(group, key, member, parts, { now, gameId = null }) {
  const week = isoWeekKST(now);
  const cap = weeklyCapOf(group);
  let remaining = Math.max(0, cap - weekAutoEarned(group, key, week));
  const granted = [];
  const skipped = [];
  for (const part of parts) {
    const give = Math.min(part.delta, remaining);
    remaining -= give;
    if (give === part.delta) {
      addLedger(group, { key, nickname: member.nickname, delta: give, reason: part.reason, kind: part.kind, gameId, now });
      granted.push({ ...part, requested: part.delta, capped: false });
    } else if (give > 0) {
      addLedger(group, {
        key,
        nickname: member.nickname,
        delta: give,
        reason: `${part.reason} (주간 상한으로 ${give}개만 지급)`,
        kind: part.kind,
        gameId,
        now,
        requested: part.delta,
        capped: true,
      });
      granted.push({ ...part, delta: give, requested: part.delta, capped: true });
    } else {
      skipped.push(part);
      granted.push({ ...part, delta: 0, requested: part.delta, capped: true });
    }
  }
  if (skipped.length > 0) {
    addLedger(group, {
      key,
      nickname: member.nickname,
      delta: 0,
      reason: `주간 상한 ${cap}개 도달 · 지급 없음 (${skipped.map((p) => `${p.reason} +${p.delta}`).join(', ')})`,
      kind: skipped[0].kind,
      gameId,
      now,
      requested: skipped.reduce((sum, p) => sum + p.delta, 0),
      capped: true,
    });
  }
  return { parts: granted, weekRemaining: remaining, weeklyCap: cap };
}

function addLedger(group, { key, nickname, delta, reason, kind, gameId = null, now, ...extra }) {
  const entry = {
    id: randomUUID(),
    at: now,
    week: isoWeekKST(now),
    key,
    nickname,
    delta,
    reason,
    kind, // 'game' | 'team' | 'streak' | 'manual' | 'shop'
    gameId,
    ...extra, // requested/capped (상한으로 깎임), override (교사 상한 예외), itemId (상점)
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
      const res = grantAuto(group, key, member, [{ delta: TALENT_RULES.streakBonus, reason: `연속 출석 ${streak}주 보너스`, kind: 'streak' }], { now });
      streakBonus = res.parts[0].delta;
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
  const balance = balanceOf(group, key);
  // 잔액은 0 아래로 내려가지 않는다.
  if (balance + d < 0) throw new Error(`${member.nickname} 친구는 지금 ${balance}달란트라서 ${-d}개를 뺄 수 없어요.`);
  // 수동 지급은 주간 상한과 상관없이 들어간다. 이번 주 받은 양이 상한을 넘게 되면 '상한 예외'로 표시.
  const extra = {};
  if (d > 0) {
    const week = isoWeekKST(now);
    let manualPlus = 0;
    for (const e of group.ledger) if (e.key === key && e.week === week && e.kind === 'manual' && e.delta > 0) manualPlus += e.delta;
    if (weekAutoEarned(group, key, week) + manualPlus + d > weeklyCapOf(group)) extra.override = true;
  }
  const entry = addLedger(group, { key, nickname: member.nickname, delta: d, reason: why, kind: 'manual', now, ...extra });
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
  const wanted = computeGameAwards({ players, totalQuestions, team });
  const byId = new Map(players.map((p) => [p.id, p]));
  const awards = wanted.map((award) => {
    const p = byId.get(award.id);
    const { key, member } = ensureMember(group, p.nickname, p.avatar, now);
    // 게임을 했다면 그 주 출석이기도 하다 (입장 때 이미 찍혔으면 그대로).
    if (!member.attendance[isoWeekKST(now)]) member.attendance[isoWeekKST(now)] = { at: now, via: 'game' };
    // 주간 상한 안에서만 지급 (넘는 만큼은 깎임)
    const res = grantAuto(group, key, member, award.parts, { now, gameId });
    const delta = res.parts.reduce((sum, x) => sum + x.delta, 0);
    return {
      id: award.id,
      nickname: member.nickname,
      delta,
      requested: award.delta,
      capped: delta < award.delta,
      weekRemaining: res.weekRemaining,
      weeklyCap: res.weeklyCap,
      parts: res.parts,
    };
  });
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

  const weeklyCap = weeklyCapOf(group);
  const totals = new Map();
  const weekTotals = new Map(); // 이번 주에 번 달란트 (상점 지출 제외) → 이번 주 MVP 기준
  const weekAuto = new Map(); // 이번 주 자동 지급분 → 주간 상한 사용량
  for (const [key, m] of Object.entries(group.members)) totals.set(key, m.carried || 0);
  for (const e of group.ledger) {
    totals.set(e.key, (totals.get(e.key) || 0) + e.delta);
    if (e.week !== currentWeek) continue;
    if (e.kind !== 'shop') weekTotals.set(e.key, (weekTotals.get(e.key) || 0) + e.delta);
    if (AUTO_KINDS.has(e.kind) && e.delta > 0) weekAuto.set(e.key, (weekAuto.get(e.key) || 0) + e.delta);
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
      weekEarned: weekAuto.get(key) || 0,
      weekRemaining: Math.max(0, weeklyCap - (weekAuto.get(key) || 0)),
      equipped: { ...(m.equipped || {}) },
      ownedCount: (m.owned || []).length,
      claimed: !!m.owner, // 이 닉네임을 쓰는 기기가 정해졌는지 (기기 식별값 자체는 내보내지 않는다)
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
    settings: { weeklyCap },
  };
}

// ---------------------------------------------------------------------------
// 닉네임 주인 (반 안에서 닉네임은 한 명만)
// ---------------------------------------------------------------------------
// 기기 id 는 그대로 저장하지 않고 반 코드와 섞은 해시만 남긴다.
function ownerHash(code, deviceId) {
  return createHash('sha256').update(`${code}:${deviceId}`).digest('hex').slice(0, 24);
}

// 이 기기가 이 닉네임을 쓸 수 있는지 확인하고, 주인이 없으면 주인으로 등록한다.
// 다른 기기가 먼저 쓰고 있는 닉네임이면 친절한 안내와 함께 거절한다.
export function claimNickname(code, { nickname, deviceId, avatar = null, now = Date.now() }) {
  const group = requireGroup(code);
  if (!deviceId) throw new Error('기기 정보를 확인할 수 없어요. 새로고침 후 다시 들어와 주세요.');
  const display = cleanNickname(nickname);
  const key = nickKey(display);
  const owner = ownerHash(group.code, String(deviceId));
  const existing = group.members[key];
  if (existing && existing.owner && existing.owner !== owner) {
    const err = new Error(`"${existing.nickname}"은(는) 우리 반에서 이미 다른 친구가 쓰고 있는 이름이에요. 다른 이름을 골라 주세요!`);
    err.code = 'NICK_TAKEN';
    throw err;
  }
  const { member } = ensureMember(group, display, avatar, now);
  if (!member.owner) member.owner = owner;
  saveGroup(group);
  return { key, nickname: member.nickname, equipped: { ...(member.equipped || {}) } };
}

// 홈 화면 상점용: 반 코드 + 닉네임 + 기기가 "이미 등록된 닉네임 주인"인지 확인만 한다.
// 여기서는 새로 주인이 될 수 없다(주인 등록은 방 PIN 을 알고 방에 들어올 때만).
// 반이 없거나 닉네임이 없을 때는 같은 안내를 준다(어떤 반·이름이 있는지 알려 주지 않는다).
export function verifyNicknameOwner(code, { nickname, deviceId }) {
  const notFound = () => {
    const err = new Error('반 코드나 닉네임을 다시 확인해 주세요. 아직 게임 방에 들어온 적이 없다면, 먼저 선생님 방에 들어가서 닉네임을 등록해 주세요.');
    err.code = 'SHOP_NOT_FOUND';
    return err;
  };
  let group;
  try {
    group = loadGroup(normalizeCode(code));
  } catch {
    throw notFound();
  }
  const key = nickKey(nickname);
  const member = group && key ? group.members[key] : null;
  if (!member) throw notFound();
  if (!member.owner) {
    const err = new Error(`"${member.nickname}" 닉네임은 아직 주인이 정해지지 않았어요. 선생님 방에 먼저 들어가서 내 닉네임으로 등록한 뒤에 상점을 열 수 있어요.`);
    err.code = 'SHOP_NOT_CLAIMED';
    throw err;
  }
  if (!deviceId || member.owner !== ownerHash(group.code, String(deviceId))) {
    const err = new Error(`"${member.nickname}"은(는) 다른 친구의 닉네임이에요. 다른 친구 이름으로는 상점을 열 수 없어요. 내 닉네임을 등록한 기기에서 열어 주세요.`);
    err.code = 'SHOP_NOT_OWNER';
    throw err;
  }
  return { code: group.code, key, nickname: member.nickname };
}

// 교사용: 폰을 바꾼 친구가 다시 같은 닉네임으로 들어올 수 있게 주인 표시를 지운다.
export function releaseNickname(code, nickname) {
  const group = requireGroup(code);
  const member = group.members[nickKey(nickname)];
  if (!member) throw new Error('그 닉네임을 찾을 수 없어요.');
  delete member.owner;
  saveGroup(group);
}

// ---------------------------------------------------------------------------
// 달란트 상점 (게임 안 꾸미기 아이템)
// ---------------------------------------------------------------------------
function requireMember(group, key) {
  const member = group.members[key];
  if (!member) throw new Error('우리 반 기록에서 친구를 찾을 수 없어요.');
  member.owned ||= [];
  member.equipped ||= {};
  return member;
}

export function shopState(code, key, { now = Date.now() } = {}) {
  const group = requireGroup(code);
  const member = requireMember(group, key);
  const cap = weeklyCapOf(group);
  const earned = weekAutoEarned(group, key, isoWeekKST(now));
  return {
    nickname: member.nickname,
    avatar: member.avatar || null,
    balance: balanceOf(group, key),
    owned: [...member.owned],
    equipped: { ...member.equipped },
    weeklyCap: cap,
    weekEarned: earned,
    weekRemaining: Math.max(0, cap - earned),
    items: SHOP_ITEMS,
  };
}

// 아이템 구입: 잔액이 모자라면 거절(잔액은 절대 음수가 되지 않는다),
// 이미 가진 아이템은 다시 돈을 받지 않고 그냥 착용만 한다. 반환: { charged, state }
export function buyItem(code, key, itemId, { now = Date.now() } = {}) {
  const group = requireGroup(code);
  const member = requireMember(group, key);
  const item = getShopItem(itemId);
  if (!item) throw new Error('상점에 없는 아이템이에요.');
  let charged = 0;
  if (!member.owned.includes(item.id)) {
    const balance = balanceOf(group, key);
    if (balance < item.price) throw new Error(`달란트가 ${item.price - balance}개 모자라요. (${item.name} ${item.price}개, 지금 ${balance}개)`);
    addLedger(group, { key, nickname: member.nickname, delta: -item.price, reason: `상점: ${item.name} 구입`, kind: 'shop', now, itemId: item.id });
    member.owned.push(item.id);
    charged = item.price;
  }
  member.equipped[item.slot] = item.id;
  saveGroup(group);
  return { charged, state: shopState(code, key, { now }) };
}

// 가진 아이템 착용/해제 (무료)
export function equipItem(code, key, itemId, equip = true, { now = Date.now() } = {}) {
  const group = requireGroup(code);
  const member = requireMember(group, key);
  const item = getShopItem(itemId);
  if (!item) throw new Error('상점에 없는 아이템이에요.');
  if (!member.owned.includes(item.id)) throw new Error('아직 사지 않은 아이템이에요.');
  if (equip) member.equipped[item.slot] = item.id;
  else if (member.equipped[item.slot] === item.id) delete member.equipped[item.slot];
  saveGroup(group);
  return shopState(code, key, { now });
}

// 테스트용: 메모리 캐시 비우기 (파일에서 다시 읽는지 확인할 때)
export function _clearCache() {
  cache.clear();
}
