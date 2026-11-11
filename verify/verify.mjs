import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import WebSocket from 'ws';
import { QUESTIONS_BY_LEVEL, LEVELS, DEFAULT_LEVEL, CATEGORIES, DEFAULT_QUESTION_COUNT } from '../server/src/questions.js';
import { ZONES, MAP_BOUNDS, WALK_SPEED, RUN_SPEED, CRAWL_SPEED } from '../server/src/state.js';
import * as records from '../server/src/records.js';

// Question text is unique across all levels (verify looks questions up by
// text alone), so a single flat lookup works regardless of which level a
// room is actually using.
const ALL_QUESTIONS = Object.values(QUESTIONS_BY_LEVEL).flat();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8799;
const TEST_ROOM_PIN = '4321'; // 기존 검사들이 쓰는 방 입장 PIN
const REMOTE = process.env.VERIFY_WS_URL;
const WS_URL = REMOTE || `ws://localhost:${PORT}`;
const DEFAULT_WAIT_TIMEOUT_MS = REMOTE ? 10000 : 4000;
// Generous timeout for "all players simultaneously in zone" checks, since
// auto-walk arrival + separation-physics settling can take a few seconds.
const ZONE_ARRIVAL_TIMEOUT_MS = REMOTE ? 20000 : 10000;

function log(msg) {
  console.log(`[verify] ${msg}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function answerFor(questionText) {
  const q = ALL_QUESTIONS.find((q) => q.text === questionText);
  if (!q) throw new Error(`unknown question text: ${questionText}`);
  return q.answer;
}

function opposite(answer) {
  return answer === 'O' ? 'X' : 'O';
}

class Client {
  constructor(name) {
    this.name = name;
    this.socket = new WebSocket(WS_URL);
    this.buffer = [];
    this.waiters = [];
    this.socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const waiterIndex = this.waiters.findIndex((w) => w.predicate(msg));
      if (waiterIndex !== -1) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        waiter.resolve(msg);
      } else {
        this.buffer.push(msg);
      }
    });
    this.socket.on('error', (err) => {
      console.error(`[${this.name}] socket error`, err);
    });
  }

  ready() {
    return new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
  }

  send(type, payload = {}) {
    this.socket.send(JSON.stringify({ type, ...payload }));
  }

  // Messages can arrive before waitFor is called for them (e.g. a broadcast
  // sent in response to another client's message). Check the buffer of
  // already-received messages first, consuming a match if present, before
  // falling back to registering a waiter for a future message.
  waitFor(type, predicate = () => true, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
    const fullPredicate = (msg) => msg.type === type && predicate(msg);

    const bufferedIndex = this.buffer.findIndex(fullPredicate);
    if (bufferedIndex !== -1) {
      const [msg] = this.buffer.splice(bufferedIndex, 1);
      return Promise.resolve(msg);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        reject(new Error(`[${this.name}] timed out waiting for "${type}"`));
      }, timeoutMs);
      this.waiters.push({
        predicate: fullPredicate,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
    });
  }

  close() {
    this.socket.close();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Clears any already-buffered 'positions' messages for the room so the next
// wait resolves with a freshly broadcast sample (within ~one 80ms tick),
// which matters for the elapsed-time-based speed measurements below.
async function freshPosition(host, roomId, deviceId) {
  host.buffer = host.buffer.filter((m) => !(m.type === 'positions' && m.roomId === roomId));
  const msg = await host.waitFor('positions', (m) => m.roomId === roomId);
  const player = msg.players.find((p) => p.id === deviceId);
  if (!player) throw new Error(`positions broadcast missing player ${deviceId}`);
  return player;
}

// Mimics the phone's ~12 Hz throttled input stream for a fixed duration.
async function driveFor(client, roomId, dir, { run = false, crawl = false } = {}, durationMs) {
  const id = setInterval(() => client.send('move', { roomId, dir, run, crawl }), 80);
  await sleep(durationMs);
  clearInterval(id);
  client.send('move', { roomId, dir: { x: 0, z: 0 }, run: false, crawl: false });
  await sleep(150); // let the server settle on the final position
}

async function moveIntoZone(host, roomId, client, deviceId, zoneBox) {
  const start = await freshPosition(host, roomId, deviceId);
  const targetX = (zoneBox.xmin + zoneBox.xmax) / 2;
  const targetZ = (zoneBox.zmin + zoneBox.zmax) / 2;
  const dist = Math.hypot(targetX - start.x, targetZ - start.z);
  const dir = { x: (targetX - start.x) / dist, z: (targetZ - start.z) / dist };
  const travelMs = (dist / RUN_SPEED) * 1000 + 500;
  await driveFor(client, roomId, dir, { run: true }, travelMs);
}

function inZone(pos, zoneBox) {
  return pos.x >= zoneBox.xmin && pos.x <= zoneBox.xmax && pos.z >= zoneBox.zmin && pos.z <= zoneBox.zmax;
}

// Waits until every given player is simultaneously standing inside their target
// zone within a *single* positions broadcast. Checking each player independently
// (one-at-a-time) is racy: by the time the last player's arrival is confirmed, an
// earlier arrival can have been bumped out of their zone by avatar separation
// physics as other players converge, so reveal must only fire once one broadcast
// shows everyone in place at once.
async function waitUntilAllInZones(host, roomId, targets, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  host.buffer = host.buffer.filter((m) => !(m.type === 'positions' && m.roomId === roomId));
  while (Date.now() < deadline) {
    const remaining = Math.max(250, deadline - Date.now());
    let msg;
    try {
      msg = await host.waitFor('positions', (m) => m.roomId === roomId, remaining);
    } catch {
      return false;
    }
    const allIn = targets.every(({ deviceId, zoneBox }) => {
      const p = msg.players.find((pl) => pl.id === deviceId);
      return p && inZone(p, zoneBox);
    });
    if (allIn) return true;
  }
  return false;
}

// Measures actual on-wire speed (units/sec) for a player driven in a fixed
// direction for durationMs, so run/walk/crawl can be compared end to end
// through the real input -> physics tick -> broadcast pipeline.
async function measureSpeed(host, roomId, client, deviceId, opts, durationMs) {
  const current = await freshPosition(host, roomId, deviceId);
  // Head toward the center so a few seconds of movement never clips a map bound.
  const dir = { x: current.x > 0 ? -1 : 1, z: 0 };
  const before = await freshPosition(host, roomId, deviceId);
  const t0 = Date.now();
  await driveFor(client, roomId, dir, opts, durationMs);
  const after = await freshPosition(host, roomId, deviceId);
  const t1 = Date.now();
  const dist = Math.hypot(after.x - before.x, after.z - before.z);
  return dist / ((t1 - t0) / 1000);
}

// 출석·달란트 기록은 실제 데이터 폴더를 건드리지 않도록 임시 폴더에만 쓴다.
const SERVER_RECORDS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'church-records-e2e-'));
const UNIT_RECORDS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'church-records-unit-'));

// 오류 응답을 기대하는 요청: 이전에 쌓인 error 메시지를 비우고 보낸 뒤 기다린다.
async function expectError(client, type, payload, pattern, label) {
  client.buffer = client.buffer.filter((m) => m.type !== 'error');
  client.send(type, payload);
  const err = await client.waitFor('error');
  assert(pattern.test(err.message), `${label}: 예상한 오류가 아님 -> "${err.message}"`);
}

async function latestGroup(client, predicate) {
  const msg = await client.waitFor('groupData', (m) => predicate(m.group));
  return msg.group;
}

// records.js 단위 검증 (주 계산, 출석/연속 출석, 달란트 규칙, 파일 저장)
function verifyRecordsUnit() {
  process.env.RECORDS_DIR = UNIT_RECORDS_DIR;
  const at = (iso) => Date.parse(iso);

  // ISO 주는 한국 시간 기준: 일요일 23:59 KST 와 월요일 00:00 KST 는 다른 주
  assert(records.isoWeekKST(at('2026-11-08T23:59:00+09:00')) === '2026-W45', '일요일 밤(KST)은 W45');
  assert(records.isoWeekKST(at('2026-11-09T00:00:00+09:00')) === '2026-W46', '월요일 0시(KST)는 W46');
  assert(records.isoWeekKST(at('2027-01-01T12:00:00+09:00')) === '2026-W53', '2027-01-01 은 2026-W53');
  assert(records.prevWeek('2027-W01') === '2026-W53', '연도 경계의 이전 주');

  const code = '단위반';
  let threw = false;
  try { records.openGroup(code, '1234'); } catch { threw = true; }
  assert(threw, '없는 반은 create 없이 열 수 없어야 함');
  assert(records.openGroup(code, '1234', { create: true }).created === true, '새 반 생성');
  threw = false;
  try { records.openGroup(code, '9999'); } catch (e) { threw = /PIN/.test(e.message); }
  assert(threw, '틀린 PIN 은 거부되어야 함');
  threw = false;
  try { records.openGroup('../etc', '1234', { create: true }); } catch { threw = true; }
  assert(threw, '경로 문자가 들어간 반 코드는 거부되어야 함');

  // 3주 연속 출석 → 3주째에 연속 출석 보너스 +1, 같은 주 재입장은 중복 기록 없음
  const w1 = at('2026-10-25T11:00:00+09:00');
  const w2 = at('2026-11-01T11:00:00+09:00');
  const w3 = at('2026-11-08T11:00:00+09:00');
  const a1 = records.markAttendance(code, { nickname: '꼬마사자', now: w1 });
  assert(a1.newlyMarked && a1.streak === 1 && a1.streakBonus === 0, '첫 주 출석');
  const a2 = records.markAttendance(code, { nickname: ' 꼬마사자 ', now: w2 });
  assert(a2.streak === 2 && a2.streakBonus === 0, '2주 연속');
  const a3 = records.markAttendance(code, { nickname: '꼬마사자', now: w3 });
  assert(a3.streak === 3 && a3.streakBonus === records.TALENT_RULES.streakBonus, '3주 연속이면 보너스');
  const a3b = records.markAttendance(code, { nickname: '꼬마사자', now: w3 + 60000 });
  assert(!a3b.newlyMarked && a3b.streakBonus === 0, '같은 주에 다시 들어와도 한 번만 기록');
  records.markAttendance(code, { nickname: '토끼친구', now: w1 });
  records.markAttendance(code, { nickname: '토끼친구', now: w3 }); // 한 주 빠짐 → 연속 1주

  let sum = records.groupSummary(code, { now: w3 });
  const lion = sum.members.find((m) => m.nickname === '꼬마사자');
  const rabbit = sum.members.find((m) => m.nickname === '토끼친구');
  assert(lion.attendCount === 3 && lion.streak === 3 && lion.badge?.id === 'iron', '연속 3주 배지');
  assert(rabbit.attendCount === 2 && rabbit.streak === 1 && rabbit.badge === null, '빠진 주가 있으면 연속이 끊김');
  assert(lion.total === 1 && sum.mvp[0]?.nickname === '꼬마사자', '연속 출석 보너스가 누적·이번 주 MVP 에 반영');
  assert(sum.weeks.length === 8 && sum.weeks.at(-1).id === '2026-W45' && sum.weeks.at(-1).presentCount === 2, '주별 기록(최근 8주)');
  assert(sum.weeks.at(-2).presentCount === 1 && sum.weeks.at(-3).presentCount === 2, '주별 출석 인원');

  // 자동 달란트 규칙: 참가 +1, 1/2/3등 +3/+2/+1(동점 같은 등수, 0점 제외), 만점 +2(5문제 이상), 팀 승리 보너스
  const awards = records.computeGameAwards({
    totalQuestions: 5,
    players: [
      { id: 'a', nickname: 'A', score: 5, teamId: 'red' },
      { id: 'b', nickname: 'B', score: 3, teamId: 'blue' },
      { id: 'c', nickname: 'C', score: 3, teamId: 'red' },
      { id: 'd', nickname: 'D', score: 1, teamId: 'blue' },
      { id: 'e', nickname: 'E', score: 0, teamId: 'blue' },
    ],
    team: { bonus: 2, winnerTeamIds: ['red'], names: { red: '빨강 벽돌팀' } },
  });
  const delta = Object.fromEntries(awards.map((a) => [a.id, a.delta]));
  assert(delta.a === 1 + 3 + 2 + 2, `1등+만점+팀승리 = 8 이어야 하는데 ${delta.a}`);
  assert(delta.b === 1 + 2, `공동 2등 = 3 이어야 하는데 ${delta.b}`);
  assert(delta.c === 1 + 2 + 2, `공동 2등+팀승리 = 5 이어야 하는데 ${delta.c}`);
  assert(delta.d === 1, `4등은 참가 점수만: ${delta.d}`);
  assert(delta.e === 1, `0점은 참가 점수만: ${delta.e}`);

  // 수동 가감: 사유 필수, 0 불가, 음수 가능
  for (const bad of [{ delta: 0, reason: 'x' }, { delta: 3, reason: '  ' }, { delta: 1000, reason: 'x' }]) {
    threw = false;
    try { records.adjustTalent(code, { nickname: '꼬마사자', ...bad, now: w3 }); } catch { threw = true; }
    assert(threw, `잘못된 수동 조정은 거부되어야 함: ${JSON.stringify(bad)}`);
  }
  records.adjustTalent(code, { nickname: '꼬마사자', delta: 5, reason: '암송 완료', now: w3 });
  records.adjustTalent(code, { nickname: '꼬마사자', delta: -2, reason: '간식 교환', now: w3 });

  // 파일로 저장되고(임시 파일 안 남김), PIN 평문은 없고, 캐시를 비워도 다시 읽힘
  const files = fs.readdirSync(UNIT_RECORDS_DIR);
  assert(files.length === 1 && files[0] === `${code}.json`, `반 파일 하나만 있어야 함: ${files}`);
  const raw = fs.readFileSync(path.join(UNIT_RECORDS_DIR, files[0]), 'utf8');
  assert(!raw.includes('"1234"') && !/"pin"\s*:/.test(raw), 'PIN 평문이 파일에 저장되면 안 됨');
  records._clearCache();
  sum = records.groupSummary(code, { now: w3 });
  assert(sum.members.find((m) => m.nickname === '꼬마사자').total === 1 + 5 - 2, '재시작(캐시 초기화) 후에도 누적 달란트 유지');
  const hist = sum.ledger.filter((e) => e.nickname === '꼬마사자');
  assert(hist.length === 3 && hist[0].reason === '간식 교환' && hist[0].delta === -2 && hist[0].kind === 'manual', '개인 내역(최신순)에 사유가 남아야 함');
  assert(JSON.stringify(sum).includes('pinHash') === false, '요약에 PIN 해시가 나가면 안 됨');
  delete process.env.RECORDS_DIR;
  fs.rmSync(UNIT_RECORDS_DIR, { recursive: true, force: true });
  log('records unit checks ok (KST week, attendance, streak badge/bonus, award rules, manual adjust, atomic file persistence)');
}


// 규칙 단위 검증: 닉네임 중복 불가, 주간 상한, 수동 상한 예외, 잔액 음수 불가, 상점
function verifyRulesUnit() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'church-records-rules-'));
  process.env.RECORDS_DIR = dir;
  records._clearCache();
  const at = (iso) => Date.parse(iso);
  const t0 = at('2026-11-10T11:00:00+09:00'); // 2026-W46 (화)
  const throws = (fn, pattern) => {
    try { fn(); } catch (e) { return pattern ? pattern.test(e.message) : true; }
    return false;
  };

  // --- 1) 닉네임: 반 안에서 먼저 등록한 기기가 주인 ---
  assert(records.nickKey(' 블록 왕 ') === records.nickKey('블록왕'), '닉네임 비교는 공백을 무시');
  assert(records.nickKey('ＡＢc') === records.nickKey('abC'), '닉네임 비교는 전각/대소문자를 무시');
  records.openGroup('가반', '1111', { create: true });
  records.openGroup('나반', '2222', { create: true });
  const first = records.claimNickname('가반', { nickname: '블록왕', deviceId: 'dev-A', now: t0 });
  assert(first.key === records.nickKey('블록왕'), '첫 등록 성공');
  assert(throws(() => records.claimNickname('가반', { nickname: ' 블록 왕', deviceId: 'dev-B', now: t0 }), /이미 다른 친구.*다른 이름/), '같은 반에서 다른 기기가 같은 닉네임(공백만 다름)을 쓰면 친절한 오류');
  assert(records.claimNickname('가반', { nickname: '블록왕', deviceId: 'dev-A', now: t0 }).key === first.key, '주인 기기는 다시 들어올 수 있음');
  assert(records.claimNickname('나반', { nickname: '블록왕', deviceId: 'dev-B', now: t0 }).key === first.key, '다른 반에서는 같은 닉네임을 쓸 수 있음');
  assert(records.claimNickname('가반', { nickname: '다른이름', deviceId: 'dev-B', now: t0 }).key, '다른 닉네임으로는 들어올 수 있음');
  assert(throws(() => records.claimNickname('가반', { nickname: '블록왕', deviceId: '', now: t0 })), '기기 정보 없이는 등록 불가');
  records.releaseNickname('가반', '블록왕');
  assert(records.claimNickname('가반', { nickname: '블록왕', deviceId: 'dev-C', now: t0 }).key, '교사가 연결을 풀면 새 기기가 쓸 수 있음');
  assert(throws(() => records.claimNickname('가반', { nickname: '블록왕', deviceId: 'dev-A', now: t0 }), /다른 이름/), '풀린 뒤에는 새 주인이 우선');
  const rawA = fs.readFileSync(path.join(dir, '가반.json'), 'utf8');
  assert(!rawA.includes('dev-A') && !rawA.includes('dev-C'), '기기 id 원문은 파일에 저장하지 않음(해시만)');
  assert(!JSON.stringify(records.groupSummary('가반', { now: t0 })).includes(JSON.parse(rawA).members[first.key].owner), '요약에 기기 해시가 나가면 안 됨');

  // --- 홈 화면 상점용 닉네임 주인 확인 (여기서는 새로 주인이 될 수 없음) ---
  const errCode = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
  assert(records.verifyNicknameOwner('가반', { nickname: ' 블록 왕 ', deviceId: 'dev-C' }).key === first.key, '주인 기기는 반 코드+닉네임으로 확인 통과');
  assert(errCode(() => records.verifyNicknameOwner('가반', { nickname: '블록왕', deviceId: 'dev-A' })) === 'SHOP_NOT_OWNER', '다른 기기는 남의 닉네임으로 못 들어감');
  assert(errCode(() => records.verifyNicknameOwner('가반', { nickname: '없는친구', deviceId: 'dev-C' })) === 'SHOP_NOT_FOUND', '없는 닉네임');
  assert(errCode(() => records.verifyNicknameOwner('없는반', { nickname: '블록왕', deviceId: 'dev-C' })) === 'SHOP_NOT_FOUND', '없는 반도 같은 안내');
  assert(errCode(() => records.verifyNicknameOwner('../x', { nickname: '블록왕', deviceId: 'dev-C' })) === 'SHOP_NOT_FOUND', '이상한 반 코드도 같은 안내');
  records.markAttendance('가반', { nickname: '선생님이추가', via: 'teacher', now: t0 });
  assert(errCode(() => records.verifyNicknameOwner('가반', { nickname: '선생님이추가', deviceId: 'dev-Z' })) === 'SHOP_NOT_CLAIMED', '주인이 없는 닉네임은 홈에서 차지할 수 없음');
  assert(JSON.parse(fs.readFileSync(path.join(dir, '가반.json'), 'utf8')).members[records.nickKey('선생님이추가')].owner === undefined, '확인만으로는 주인이 등록되지 않음');

  // --- 2) 출석은 입장 순간 (게임과 무관), 같은 주 두 번 들어와도 1회 ---
  const att1 = records.markAttendance('가반', { nickname: '블록왕', now: t0 });
  const att2 = records.markAttendance('가반', { nickname: '블록왕', now: t0 + 3 * 86400000 }); // 같은 주 금요일
  let sum = records.groupSummary('가반', { now: t0 });
  let king = sum.members.find((m) => m.nickname === '블록왕');
  assert(att1.newlyMarked && !att2.newlyMarked && king.presentThisWeek && king.attendCount === 1 && sum.games.length === 0, '게임 없이 입장만으로 출석, 같은 주는 1회');

  // --- 3) 주간 상한 ---
  assert(sum.settings.weeklyCap === 20 && records.TALENT_RULES.weeklyCapDefault === 20, '주간 상한 기본값은 20');
  assert(throws(() => records.setWeeklyCap('가반', 0), /1~100/) && throws(() => records.setWeeklyCap('가반', 101), /1~100/) && throws(() => records.setWeeklyCap('가반', 'abc')), '상한 범위(1~100) 밖은 거부');
  assert(records.setWeeklyCap('가반', 5) === 5, '교사가 상한 변경');
  const game = (now) => records.recordGame('가반', { roomTitle: '단위', level: 'elementary', totalQuestions: 5, now, players: [{ id: 'k', nickname: '블록왕', score: 5, teamId: null }] });
  // 참가1 + 1등3 + 만점2 = 6 → 상한 5라서 5만 지급 (만점 2 중 1만)
  const g1 = game(t0).awards[0];
  assert(g1.requested === 6 && g1.delta === 5 && g1.capped === true && g1.weekRemaining === 0, `상한으로 깎여야 함: ${JSON.stringify(g1)}`);
  assert(g1.parts.map((x) => x.delta).join() === '1,3,1' && g1.parts[2].capped && g1.parts[2].requested === 2, '어느 항목이 깎였는지 표시');
  // 같은 주 두 번째 판 → 0개, 장부에는 0달란트 한 줄로 이유가 남음
  const g2 = game(t0 + 3600000).awards[0];
  assert(g2.delta === 0 && g2.capped && g2.parts.every((x) => x.delta === 0), '상한 도달 후에는 지급 없음');
  sum = records.groupSummary('가반', { now: t0 });
  king = sum.members.find((m) => m.nickname === '블록왕');
  assert(king.total === 5 && king.weekEarned === 5 && king.weekRemaining === 0, `상한 사용량: ${JSON.stringify(king)}`);
  const kingLedger = () => records.groupSummary('가반', { now: t0 }).ledger.filter((e) => e.nickname === '블록왕');
  assert(kingLedger().some((e) => e.capped && e.delta === 1 && e.requested === 2 && /주간 상한으로 1개만 지급/.test(e.reason)), '장부에 "상한으로 n개만 지급"');
  assert(kingLedger().some((e) => e.capped && e.delta === 0 && /주간 상한 5개 도달 · 지급 없음/.test(e.reason) && e.requested === 6), '장부에 "상한 도달 · 지급 없음"');
  // 다음 주에는 상한이 새로 시작
  const g3 = game(t0 + 7 * 86400000).awards[0];
  assert(g3.delta === 5 && g3.weekRemaining === 0, '다음 주(KST)에는 다시 받을 수 있음');

  // --- 수동 조정은 상한을 넘을 수 있고(상한 예외 표시), 잔액은 음수가 안 됨 ---
  const over = records.adjustTalent('가반', { nickname: '블록왕', delta: 10, reason: '성경 암송 대회', now: t0 });
  assert(over.delta === 10 && over.override === true && over.kind === 'manual', '상한을 넘는 수동 지급은 override 로 기록');
  const small = records.adjustTalent('나반', { nickname: '블록왕', delta: 3, reason: '칭찬', now: t0 });
  assert(small.override === undefined, '상한 안의 수동 지급은 예외 표시 없음');
  const bal = () => records.shopState('가반', first.key, { now: t0 }).balance;
  assert(bal() === 20, `잔액 5+5+10 = 20: ${bal()}`);
  assert(throws(() => records.adjustTalent('가반', { nickname: '블록왕', delta: -21, reason: '실수', now: t0 }), /뺄 수 없어요/) && bal() === 20, '수동 차감도 잔액 아래로는 불가');
  records.adjustTalent('가반', { nickname: '블록왕', delta: -5, reason: '정정', now: t0 });
  assert(bal() === 15, '잔액 범위 안의 차감은 가능');

  // --- 5) 상점 ---
  let st = records.shopState('가반', first.key, { now: t0 });
  assert(st.items.length >= 8 && st.items.every((i) => i.price >= 1 && i.price <= 20 && ['hat', 'outfit', 'extra'].includes(i.slot)), '카탈로그: 가격은 주간 상한(20) 이내');
  assert(st.owned.length === 0 && Object.keys(st.equipped).length === 0, '처음엔 아무것도 없음');
  let buy = records.buyItem('가반', first.key, 'hat-melon', { now: t0 });
  assert(buy.charged === 7 && buy.state.balance === 8 && buy.state.owned.includes('hat-melon') && buy.state.equipped.hat === 'hat-melon', '구입하면 차감 + 보유 + 자동 착용');
  buy = records.buyItem('가반', first.key, 'hat-melon', { now: t0 });
  assert(buy.charged === 0 && buy.state.balance === 8, '이미 가진 아이템은 다시 돈을 받지 않음');
  assert(throws(() => records.buyItem('가반', first.key, 'outfit-gold', { now: t0 }), /12개 모자라요/) && bal() === 8, '잔액이 모자라면 구입 불가(잔액 그대로)');
  assert(throws(() => records.buyItem('가반', first.key, 'no-such-item', { now: t0 }), /없는 아이템/), '없는 아이템');
  assert(throws(() => records.equipItem('가반', first.key, 'extra-pet', true), /사지 않은/), '안 산 아이템은 착용 불가');
  st = records.equipItem('가반', first.key, 'hat-melon', false);
  assert(st.equipped.hat === undefined && st.owned.includes('hat-melon') && st.balance === 8, '벗어도 보유는 유지, 무료');
  st = records.equipItem('가반', first.key, 'hat-melon', true);
  assert(st.equipped.hat === 'hat-melon', '다시 착용');
  buy = records.buyItem('가반', first.key, 'extra-cape', { now: t0 });
  assert(buy.charged === 8 && buy.state.balance === 0 && buy.state.equipped.extra === 'extra-cape' && buy.state.equipped.hat === 'hat-melon', '슬롯별로 따로 착용, 잔액 0까지 사용');
  assert(throws(() => records.buyItem('가반', first.key, 'hat-sprout', { now: t0 }), /모자라요/) && bal() === 0, '잔액 0에서는 구입 불가 (음수 안 됨)');
  assert(throws(() => records.adjustTalent('가반', { nickname: '블록왕', delta: -1, reason: '실수', now: t0 })), '잔액 0에서 수동 차감 불가');
  sum = records.groupSummary('가반', { now: t0 });
  king = sum.members.find((m) => m.nickname === '블록왕');
  const spends = sum.ledger.filter((e) => e.kind === 'shop');
  assert(spends.length === 2 && spends.every((e) => e.delta < 0) && spends.some((e) => e.delta === -7 && e.reason.includes('수박 헬멧') && e.itemId === 'hat-melon'), '구입은 장부에 지출(음수)로 기록, 중복 차감 없음');
  assert(king.total === 0 && king.equipped.hat === 'hat-melon' && king.ownedCount === 2, '요약에 잔액/착용 반영');
  assert(king.weekEarned === 5 && king.weekTalents === 5 + 10 - 5, '상점 지출은 주간 상한·이번 주 번 달란트 계산에 영향 없음');
  // 재시작해도 보유/착용/상한 설정 유지
  records._clearCache();
  st = records.shopState('가반', first.key, { now: t0 });
  assert(st.owned.length === 2 && st.equipped.extra === 'extra-cape' && st.weeklyCap === 5 && st.balance === 0, '파일에서 다시 읽어도 유지');

  delete process.env.RECORDS_DIR;
  records._clearCache();
  fs.rmSync(dir, { recursive: true, force: true });
  log('rule unit checks ok (unique nickname, attendance-on-enter, weekly cap trim, manual override, no negative balance, shop buy/equip/no double charge)');
}

async function main() {
  verifyRecordsUnit();
  verifyRulesUnit();
  log(`starting server on port ${PORT}...`);
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(ROOT, 'server'),
    env: { ...process.env, PORT: String(PORT), RECORDS_DIR: SERVER_RECORDS_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverReady = false;
  let finished = false;
  server.stdout.on('data', (d) => {
    const text = d.toString();
    if (text.includes('listening')) serverReady = true;
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  server.on('exit', (code) => {
    if (!finished) {
      console.error(`server exited early with code ${code}`);
      process.exit(1);
    }
  });

  try {
    await waitUntil(() => serverReady, 5000);
    log('server is up');

    const host = new Client('host');
    const p1 = new Client('player1');
    const p2 = new Client('player2');
    const p3 = new Client('player3');
    await Promise.all([host.ready(), p1.ready(), p2.ready(), p3.ready()]);
    log('all sockets connected');

    // 1. 교회 검색/생성
    const churchName = `검증교회-${Date.now()}`;
    host.send('findOrCreateChurch', { name: churchName });
    const churchJoined = await host.waitFor('churchJoined');
    const churchId = churchJoined.church.id;
    assert(churchJoined.church.name === churchName, '교회 이름이 일치해야 함');
    log(`church created: ${churchId}`);

    // 검색이 같은 교회를 다시 찾아주는지 확인 (search or create by name)
    host.send('searchChurches', { query: churchName.slice(0, 8) });
    const searchResult = await host.waitFor('churchList');
    assert(
      searchResult.churches.some((c) => c.id === churchId),
      '교회 검색 결과에 생성한 교회가 포함되어야 함',
    );

    host.send('findOrCreateChurch', { name: churchName });
    const churchAgain = await host.waitFor('churchJoined');
    assert(churchAgain.church.id === churchId, '같은 이름으로 다시 찾으면 같은 교회 id를 반환해야 함');

    // 2. 방 만들기 (host)
    host.send('createRoom', { pin: TEST_ROOM_PIN, churchId, title: '검증방', map: 'sanctuary', capacity: 4 });
    const roomCreated = await host.waitFor('roomCreated');
    const roomId = roomCreated.room.id;
    assert(roomCreated.room.capacity === 4, '방 정원이 요청한 값(4)과 같아야 함');
    assert(roomCreated.room.status === 'lobby', '새 방은 대기 상태여야 함');
    log(`room created: ${roomId}`);

    // 방 목록에 노출되는지 확인
    host.send('listRooms', { churchId });
    const roomList = await host.waitFor('roomList');
    assert(roomList.rooms.some((r) => r.id === roomId), '방 목록에 생성한 방이 있어야 함');

    // 3. 플레이어 3명 입장
    const players = [
      { client: p1, deviceId: 'device-p1', nickname: '꼬마사자', avatar: 'circle-blue' },
      { client: p2, deviceId: 'device-p2', nickname: '토끼친구', avatar: 'star-yellow' },
      { client: p3, deviceId: 'device-p3', nickname: '다람쥐', avatar: 'square-green' },
    ];
    for (const p of players) {
      p.client.send('joinRoom', { pin: TEST_ROOM_PIN, roomId, deviceId: p.deviceId, nickname: p.nickname, avatar: p.avatar });
      const joined = await p.client.waitFor('joined');
      assert(joined.playerId === p.deviceId, '입장한 플레이어 id가 deviceId와 같아야 함');
      assert(joined.room.players.length >= 1, '방에 플레이어가 있어야 함');
    }
    log('3 players joined');

    const hostRoomStateAfterJoins = await host.waitFor('roomState', (msg) => msg.room.players.length === 3);
    assert(hostRoomStateAfterJoins.room.players.length === 3, '호스트가 3명 입장을 모두 봐야 함');

    // 4. 퀴즈 시작 (문제 3개로 축소해서 빠르게 검증)
    host.send('startQuiz', { roomId, questionCount: 3 });
    const expectedScores = { [players[0].deviceId]: 0, [players[1].deviceId]: 0, [players[2].deviceId]: 0 };

    for (let round = 0; round < 3; round++) {
      const q = await host.waitFor('roomState', (msg) => msg.room.status === 'question' && msg.room.question?.index === round);
      const questionText = q.room.question.text;
      const correct = answerFor(questionText);
      log(`round ${round + 1}: "${questionText}" (정답: ${correct})`);

      // player1, player2는 정답, player3는 오답을 선택 (라운드마다 돌려가며 다양성 확보)
      const wrongIndex = round % players.length;
      const choices = players.map((p, i) => (i === wrongIndex ? opposite(correct) : correct));
      for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (choices[i] === correct) expectedScores[p.deviceId] += 1;
        p.client.send('answer', { roomId, choice: choices[i] });
      }

      // 모든 플레이어가 답을 고르면 서버가 각 answer마다 상태를 브로드캐스트함 -> 세 번째 답까지 기다림
      await host.waitFor('roomState', (msg) => msg.room.players.filter((pl) => pl.side !== null).length === 3);

      // OX 버튼(answer 메시지)은 이제 해당 구역으로 자동 이동시키기만 함 -> 정답 판정은 실제
      // 서 있는 구역으로 이뤄지므로, 공개하기 전에 모든 플레이어가 "동시에" 각자의 구역에
      // 도착할 때까지 기다림 (한 명씩 따로 확인하면, 마지막 사람이 도착할 때쯔음 분리(separation)
      // 물리에 밀려 먼저 도착한 사람이 구역 밖으로 밀려나는 경우가 있어 점수가 불안정해짐)
      const allArrived = await waitUntilAllInZones(
        host,
        roomId,
        players.map((p, i) => ({ deviceId: p.deviceId, zoneBox: ZONES[choices[i]] })),
        ZONE_ARRIVAL_TIMEOUT_MS,
      );
      assert(allArrived, '모든 플레이어가 OX 버튼 자동 이동으로 선택한 구역에 동시에 도착해야 함');

      // 호스트가 바로 정답 공개
      host.send('reveal', { roomId });
      const revealState = await host.waitFor('roomState', (msg) => msg.room.status === 'reveal');
      assert(revealState.room.lastResult.correctAnswer === correct, '공개된 정답이 서버 데이터와 같아야 함');
      for (const p of players) {
        const snap = revealState.room.players.find((pl) => pl.id === p.deviceId);
        assert(snap.score === expectedScores[p.deviceId], `${p.nickname}의 점수는 ${expectedScores[p.deviceId]}이어야 하는데 ${snap.score}`);
      }
      log(`round ${round + 1} scores ok: ${JSON.stringify(expectedScores)}`);

      host.send('nextQuestion', { roomId });
    }

    const finishedState = await host.waitFor('roomState', (msg) => msg.room.status === 'finished');
    for (const p of players) {
      const snap = finishedState.room.players.find((pl) => pl.id === p.deviceId);
      assert(snap.score === expectedScores[p.deviceId], `최종 점수 불일치: ${p.nickname}`);
    }
    log(`quiz finished. final scores: ${JSON.stringify(expectedScores)}`);

    // 5. 자유 이동: O/X 구역에 직접 걸어 들어가고, 정답은 "서 있는 구역"으로 판정됨을 확인
    log('--- movement & zone-based answer resolution tests ---');
    const church2Name = `검증교회-이동-${Date.now()}`;
    const host2 = new Client('host2');
    const m1 = new Client('m1');
    const m2 = new Client('m2');
    const m3 = new Client('m3');
    await Promise.all([host2.ready(), m1.ready(), m2.ready(), m3.ready()]);

    host2.send('findOrCreateChurch', { name: church2Name });
    const church2 = await host2.waitFor('churchJoined');
    const church2Id = church2.church.id;

    host2.send('createRoom', { pin: TEST_ROOM_PIN,
      churchId: church2Id,
      title: '이동검증방',
      map: 'playground',
      capacity: 'unlimited',
      questionSeconds: 12,
    });
    const room2Created = await host2.waitFor('roomCreated');
    const roomId2 = room2Created.room.id;
    assert(room2Created.room.questionDurationMs === 12000, 'questionSeconds 옵션이 room.questionDurationMs에 반영되어야 함');
    assert(JSON.stringify(room2Created.room.zones) === JSON.stringify(ZONES), '서버가 보낸 zones가 실제 판정 구역과 같아야 함');
    assert(JSON.stringify(room2Created.room.bounds) === JSON.stringify(MAP_BOUNDS), '서버가 보낸 bounds가 실제 맵 경계와 같아야 함');

    const movementPlayers = [
      { client: m1, deviceId: 'device-m1', nickname: '이동1' },
      { client: m2, deviceId: 'device-m2', nickname: '이동2' },
      { client: m3, deviceId: 'device-m3', nickname: '이동3' },
    ];
    for (const p of movementPlayers) {
      p.client.send('joinRoom', { pin: TEST_ROOM_PIN, roomId: roomId2, deviceId: p.deviceId, nickname: p.nickname, avatar: 'circle-blue' });
      await p.client.waitFor('joined');
    }
    await host2.waitFor('roomState', (msg) => msg.room.players.length === 3);
    log('movement test room ready with 3 players');

    host2.send('startQuiz', { roomId: roomId2, questionCount: 2 });
    const q1 = await host2.waitFor('roomState', (msg) => msg.room.status === 'question' && msg.room.question?.index === 0);
    const correct1 = answerFor(q1.room.question.text);
    const wrong1 = opposite(correct1);
    log(`movement round 1: "${q1.room.question.text}" (정답: ${correct1})`);

    // m1은 입력으로 걸어서 정답 구역으로, m2는 오답 구역으로, m3는 가만히 있어서 두 구역 밖에 남음
    await moveIntoZone(host2, roomId2, m1, 'device-m1', ZONES[correct1]);
    const m1Pos = await freshPosition(host2, roomId2, 'device-m1');
    assert(inZone(m1Pos, ZONES[correct1]), 'm1이 조이스틱 입력으로 이동해서 정답 구역 안에 서 있어야 함');

    await moveIntoZone(host2, roomId2, m2, 'device-m2', ZONES[wrong1]);
    const m2Pos = await freshPosition(host2, roomId2, 'device-m2');
    assert(inZone(m2Pos, ZONES[wrong1]), 'm2가 조이스틱 입력으로 이동해서 오답 구역 안에 서 있어야 함');

    const m3Pos = await freshPosition(host2, roomId2, 'device-m3');
    assert(!inZone(m3Pos, ZONES.O) && !inZone(m3Pos, ZONES.X), 'm3는 이동하지 않아 두 구역 모두 밖에 있어야 함');
    log('zone entry via manual move input verified (m1 O/X correct, m2 wrong, m3 outside)');

    // 달리기(run) > 걷기(walk) > 기어가기(crawl) 속도 비교 (m3로 측정, x축만 이동해 구역에는 안 들어감)
    const walkSpeed = await measureSpeed(host2, roomId2, m3, 'device-m3', {}, 700);
    const runSpeedMeasured = await measureSpeed(host2, roomId2, m3, 'device-m3', { run: true }, 700);
    const crawlSpeedMeasured = await measureSpeed(host2, roomId2, m3, 'device-m3', { crawl: true }, 700);
    log(
      `speeds measured: walk=${walkSpeed.toFixed(2)} run=${runSpeedMeasured.toFixed(2)} crawl=${crawlSpeedMeasured.toFixed(2)} ` +
        `(server consts walk=${WALK_SPEED} run=${RUN_SPEED} crawl=${CRAWL_SPEED})`,
    );
    assert(runSpeedMeasured > walkSpeed * 1.3, '달리기는 걷기보다 확실히 빨라야 함');
    assert(walkSpeed > crawlSpeedMeasured * 1.3, '걷기는 기어가기보다 확실히 빨라야 함');

    const m3PosAfterSpeed = await freshPosition(host2, roomId2, 'device-m3');
    assert(!inZone(m3PosAfterSpeed, ZONES.O) && !inZone(m3PosAfterSpeed, ZONES.X), 'm3는 속도 테스트 중에도 구역 밖에 있어야 함');

    // 점프: 입력 후 y가 0보다 커지는 순간이 있어야 하고, 그때 상태는 'jump'여야 함
    await freshPosition(host2, roomId2, 'device-m3'); // drain so the jump itself isn't missed in a stale buffered sample
    m3.send('jump', { roomId: roomId2 });
    let sawAirborne = false;
    const jumpDeadline = Date.now() + 700;
    while (Date.now() < jumpDeadline && !sawAirborne) {
      const pos = await freshPosition(host2, roomId2, 'device-m3');
      if (pos.y > 0.05) {
        sawAirborne = true;
        assert(pos.state === 'jump', '공중에 떠 있을 때 이동 상태는 jump여야 함');
      }
    }
    assert(sawAirborne, '점프 입력 후 y가 0보다 커지는 순간이 있어야 함');
    log('jump/run/crawl actions verified');

    host2.send('reveal', { roomId: roomId2 });
    const reveal1 = await host2.waitFor('roomState', (msg) => msg.room.status === 'reveal');
    const snap1 = (id) => reveal1.room.players.find((pl) => pl.id === id);
    assert(snap1('device-m1').side === correct1, 'm1의 최종 side는 서 있던 정답 구역이어야 함');
    assert(snap1('device-m1').score === 1, '정답 구역에 서 있던 m1은 점수를 얻어야 함');
    assert(snap1('device-m2').side === wrong1, 'm2의 최종 side는 서 있던 오답 구역이어야 함');
    assert(snap1('device-m2').score === 0, '오답 구역에 서 있던 m2는 점수를 얻지 못해야 함');
    assert(snap1('device-m3').side === null, '구역 밖에 있던 m3의 side는 null(무응답/오답)이어야 함');
    assert(snap1('device-m3').score === 0, '구역 밖에 있던 m3는 점수를 얻지 못해야 함');
    log('zone-based resolution scores ok (manual move input)');

    host2.send('nextQuestion', { roomId: roomId2 });
    const q2 = await host2.waitFor('roomState', (msg) => msg.room.status === 'question' && msg.room.question?.index === 1);
    const correct2 = answerFor(q2.room.question.text);
    log(`movement round 2: "${q2.room.question.text}" (정답: ${correct2}) - O/X 버튼 자동 이동 테스트`);

    // m3가 기존 OX 버튼(answer 메시지, 하위 호환)을 눌러서 자동으로 그 구역까지 걸어가는지 확인
    const beforeAuto = await freshPosition(host2, roomId2, 'device-m3');
    m3.send('answer', { roomId: roomId2, choice: correct2 });
    const autoAnswerState = await host2.waitFor(
      'roomState',
      (msg) => msg.room.players.find((pl) => pl.id === 'device-m3')?.side === correct2,
    );
    assert(
      autoAnswerState.room.players.find((pl) => pl.id === 'device-m3').side === correct2,
      'answer 메시지는 하위 호환으로 즉시 side를 표시해야 함',
    );

    const autoDist = Math.hypot(
      (ZONES[correct2].xmin + ZONES[correct2].xmax) / 2 - beforeAuto.x,
      (ZONES[correct2].zmin + ZONES[correct2].zmax) / 2 - beforeAuto.z,
    );
    await sleep((autoDist / RUN_SPEED) * 1000 + 700); // server's AUTO_WALK_SPEED === RUN_SPEED
    const m3AutoPos = await freshPosition(host2, roomId2, 'device-m3');
    assert(inZone(m3AutoPos, ZONES[correct2]), 'OX 버튼을 누르면 서버가 해당 구역으로 자동으로 걸어가야 함');

    host2.send('reveal', { roomId: roomId2 });
    const reveal2 = await host2.waitFor('roomState', (msg) => msg.room.status === 'reveal');
    const m3Final = reveal2.room.players.find((pl) => pl.id === 'device-m3');
    assert(m3Final.side === correct2, '자동 이동으로 도착한 구역이 최종 판정에 반영되어야 함');
    assert(m3Final.score === 1, 'OX 버튼 자동 이동으로 정답 구역에 도착하면 점수를 얻어야 함');
    log('auto-walk via O/X quick button verified');

    // 6. 난이도(level) 기능 검증
    log('--- difficulty level tests ---');
    const host3 = new Client('host3');
    const lp = new Client('level-player');
    await Promise.all([host3.ready(), lp.ready()]);

    const church3Name = `검증교회-난이도-${Date.now()}`;
    host3.send('findOrCreateChurch', { name: church3Name });
    const church3 = await host3.waitFor('churchJoined');
    const church3Id = church3.church.id;

    // 6a. level을 지정하지 않으면 기본값은 'elementary'여야 함
    host3.send('createRoom', { pin: TEST_ROOM_PIN, churchId: church3Id, title: '기본난이도방', map: 'sanctuary', capacity: 4 });
    const defaultRoom = await host3.waitFor('roomCreated');
    assert(defaultRoom.room.level === 'elementary', `level을 지정하지 않으면 기본값 'elementary'여야 하는데 '${defaultRoom.room.level}'`);
    assert(defaultRoom.room.level === DEFAULT_LEVEL, 'questions.js의 DEFAULT_LEVEL과 일치해야 함');
    log(`default level ok: ${defaultRoom.room.level}`);

    host3.send('listRooms', { churchId: church3Id });
    const listAfterDefault = await host3.waitFor('roomList');
    const defaultSummary = listAfterDefault.rooms.find((r) => r.id === defaultRoom.room.id);
    assert(defaultSummary && defaultSummary.level === 'elementary', '방 목록 요약(summary)에도 level이 포함되어야 함');

    // 6b. 유효하지 않은 level은 기본값(elementary)으로 대체되어야 함 (에러 없이)
    host3.send('createRoom', { pin: TEST_ROOM_PIN, churchId: church3Id, title: '이상한난이도방', map: 'sanctuary', capacity: 4, level: 'not-a-real-level' });
    const invalidLevelRoom = await host3.waitFor('roomCreated');
    assert(invalidLevelRoom.room.level === DEFAULT_LEVEL, `잘못된 level은 '${DEFAULT_LEVEL}'로 대체되어야 하는데 '${invalidLevelRoom.room.level}'`);
    log('invalid level falls back to elementary ok');

    // 6c. 각 level로 방을 만들면 그 level이 snapshot과 방 목록에 그대로 반영되어야 함
    const levelRoomIds = {};
    for (const level of LEVELS) {
      host3.send('createRoom', { pin: TEST_ROOM_PIN, churchId: church3Id, title: `${level}방`, map: 'sanctuary', capacity: 'unlimited', level });
      const created = await host3.waitFor('roomCreated', (msg) => msg.room.title === `${level}방`);
      assert(created.room.level === level, `createRoom({level:'${level}'})의 결과 room.level은 '${level}'이어야 하는데 '${created.room.level}'`);
      levelRoomIds[level] = created.room.id;
    }
    host3.send('listRooms', { churchId: church3Id });
    const listAfterLevels = await host3.waitFor('roomList');
    for (const level of LEVELS) {
      const summary = listAfterLevels.rooms.find((r) => r.id === levelRoomIds[level]);
      assert(summary, `방 목록에 ${level} 방이 있어야 함`);
      assert(summary.level === level, `방 목록 요약의 level이 '${level}'이어야 하는데 '${summary.level}'`);
    }
    log(`room level reflected in snapshot & room list for: ${LEVELS.join(', ')}`);

    // 6d. 퀴즈에 출제되는 문제가 실제로 선택한 level의 문제 세트에서만 나와야 함
    // (middle, youth 두 레벨을 샘플로 짧게 퀴즈를 돌려 확인)
    lp.send('joinRoom', { pin: TEST_ROOM_PIN, roomId: levelRoomIds.middle, deviceId: 'device-level-player', nickname: '레벨확인' });
    await lp.waitFor('joined');
    await host3.waitFor('roomState', (msg) => msg.room.id === levelRoomIds.middle && msg.room.players.length === 1);

    for (const level of ['middle', 'youth']) {
      const roomId = levelRoomIds[level];
      const levelTexts = new Set(QUESTIONS_BY_LEVEL[level].map((q) => q.text));
      const otherLevelTexts = new Set(
        LEVELS.filter((l) => l !== level).flatMap((l) => QUESTIONS_BY_LEVEL[l].map((q) => q.text)),
      );
      if (level !== 'middle') {
        lp.send('joinRoom', { pin: TEST_ROOM_PIN, roomId, deviceId: 'device-level-player', nickname: '레벨확인' });
        await lp.waitFor('joined');
        await host3.waitFor('roomState', (msg) => msg.room.id === roomId && msg.room.players.length === 1);
      }
      host3.send('startQuiz', { roomId, questionCount: 3 });
      for (let round = 0; round < 3; round++) {
        const q = await host3.waitFor(
          'roomState',
          (msg) => msg.room.id === roomId && msg.room.status === 'question' && msg.room.question?.index === round,
        );
        const text = q.room.question.text;
        assert(levelTexts.has(text), `'${level}' 퀴즈 문제 "${text}"는 ${level} 문제 세트에 포함되어야 함`);
        assert(!otherLevelTexts.has(text), `'${level}' 퀴즈 문제 "${text}"는 다른 level 문제 세트와 겹치면 안 됨`);
        host3.send('reveal', { roomId });
        await host3.waitFor('roomState', (msg) => msg.room.id === roomId && msg.room.status === 'reveal');
        host3.send('nextQuestion', { roomId });
      }
      log(`quiz questions for level '${level}' all drawn from that level's set (3/3 rounds)`);
    }

    // 7. 카테고리 혼합(성경/넌센스), 최근 출제 회피, 주간 문항 검증 스크립트
    log('--- category mixing & weekly question-bank tests ---');
    const host4 = new Client('host4');
    await host4.ready();
    const church4Name = `검증교회-카테고리-${Date.now()}`;
    host4.send('findOrCreateChurch', { name: church4Name });
    const church4 = await host4.waitFor('churchJoined');
    const church4Id = church4.church.id;

    // Plays a full game to completion (host-only, no players needed) and returns the
    // { text, category } of every question asked, in play order.
    async function playFullGame(host, roomId, questionCount) {
      host.send('startQuiz', { roomId, ...(questionCount ? { questionCount } : {}) });
      const seen = [];
      let state = await host.waitFor('roomState', (msg) => msg.room.id === roomId && msg.room.status === 'question');
      // eslint-disable-next-line no-constant-condition
      while (true) {
        seen.push({ text: state.room.question.text, category: state.room.question.category });
        host.send('reveal', { roomId });
        await host.waitFor('roomState', (msg) => msg.room.id === roomId && msg.room.status === 'reveal');
        host.send('nextQuestion', { roomId });
        state = await host.waitFor(
          'roomState',
          (msg) => msg.room.id === roomId && (msg.room.status === 'question' || msg.room.status === 'finished'),
        );
        if (state.room.status === 'finished') break;
      }
      return seen;
    }

    // 7a. 기본(30문제) 게임: 카테고리가 모두 채워져 있고, 뱅크에 넌센스가 있으면 비율이
    // 대략 90/10에 맞고 없으면 전부 성경이어야 하며, 뱅크가 요청한 수보다 작으면 에러 없이
    // 뱅크 전체를 그대로(중복 없이) 다 써야 함. 모두 선택한 level 소속이어야 함.
    host4.send('createRoom', { pin: TEST_ROOM_PIN, churchId: church4Id, title: '카테고리방', map: 'sanctuary', capacity: 'unlimited', level: 'elementary' });
    const catRoom = await host4.waitFor('roomCreated');
    const catRoomId = catRoom.room.id;
    assert(catRoom.room.level === 'elementary', '카테고리 검증방의 level이 elementary여야 함');

    const elemPoolSize = QUESTIONS_BY_LEVEL.elementary.length;
    const elemNonsenseCount = QUESTIONS_BY_LEVEL.elementary.filter((q) => q.category === 'nonsense').length;
    const expectedGame1Length = Math.min(DEFAULT_QUESTION_COUNT, elemPoolSize);

    const game1 = await playFullGame(host4, catRoomId); // questionCount 생략 -> 기본값
    assert(
      game1.length === expectedGame1Length,
      `뱅크(${elemPoolSize}개)가 기본 문제 수(${DEFAULT_QUESTION_COUNT})보다 작으면 뱅크 전체(${expectedGame1Length}개)를 써야 하는데 ${game1.length}개`,
    );
    assert(
      game1.every((q) => q.category && CATEGORIES.includes(q.category)),
      '모든 문제의 snapshot에 유효한 category가 있어야 함',
    );
    const elemTexts = new Set(QUESTIONS_BY_LEVEL.elementary.map((q) => q.text));
    assert(game1.every((q) => elemTexts.has(q.text)), '출제된 모든 문제가 선택한 level(elementary)의 문제 세트에 속해야 함');
    const game1Texts = game1.map((q) => q.text);
    assert(new Set(game1Texts).size === game1Texts.length, '한 게임 안에서 같은 문제가 중복 출제되면 안 됨');

    const game1Counts = { bible: 0, nonsense: 0 };
    for (const q of game1) game1Counts[q.category] += 1;
    log(`question mix (bank size ${elemPoolSize}): ${JSON.stringify(game1Counts)}`);
    if (elemNonsenseCount === 0) {
      assert(game1Counts.nonsense === 0, `뱅크에 넌센스 문항이 없으면 넌센스는 0개여야 하는데 ${game1Counts.nonsense}개`);
      assert(game1Counts.bible === game1.length, `뱅크에 넌센스 문항이 없으면 전부 성경이어야 하는데 성경 ${game1Counts.bible}/${game1.length}개`);
    } else {
      const expectedNonsense = Math.round(game1.length * 0.1);
      assert(
        Math.abs(game1Counts.nonsense - expectedNonsense) <= 2,
        `넌센스 비율은 대략 10%(≈${expectedNonsense}개)여야 하는데 ${game1Counts.nonsense}개`,
      );
    }
    log('category presence + ~90/10 mixing ratio (or all-bible fallback when no nonsense) + level sourcing + no-repeats-in-game all ok');

    // 7b. 같은 교회에서 연속으로 게임을 돌리면, 문제 뱅크가 허락하는 한 최근에 나온 문제를
    // 피해서 출제해야 함. 각 게임의 문제 수는 뱅크 크기에 맞춰 동적으로 계산해서(두 게임을
    // 합쳐도 뱅크를 다 못 쓰고 여유가 남도록), 큐레이션으로 뱅크가 작아져도 테스트가 깨지지
    // 않게 해요.
    host4.send('createRoom', { pin: TEST_ROOM_PIN, churchId: church4Id, title: '최근출제회피방', map: 'sanctuary', capacity: 'unlimited', level: 'middle' });
    const recentRoom = await host4.waitFor('roomCreated');
    const recentRoomId = recentRoom.room.id;

    const middlePoolSize = QUESTIONS_BY_LEVEL.middle.length;
    const recentGameSize = Math.max(1, Math.min(10, Math.floor(middlePoolSize / 2) - 1));
    log(`recent-avoidance using ${recentGameSize}-question games against a ${middlePoolSize}-question middle bank`);

    const recentGame1 = await playFullGame(host4, recentRoomId, recentGameSize);
    const recentGame2 = await playFullGame(host4, recentRoomId, recentGameSize);
    const bibleTexts1 = new Set(recentGame1.filter((q) => q.category === 'bible').map((q) => q.text));
    const bibleTexts2 = new Set(recentGame2.filter((q) => q.category === 'bible').map((q) => q.text));
    const overlap = [...bibleTexts1].filter((t) => bibleTexts2.has(t));
    assert(
      overlap.length === 0,
      `문제 뱅크가 충분한 상황(성경 ${middlePoolSize}개 중 ${recentGameSize}+${recentGameSize}개만 사용)에서는 같은 교회의 연속된 두 게임 사이에 겹치는 성경 문제가 없어야 하는데 겹침: ${JSON.stringify(overlap)}`,
    );
    log('recent-avoidance across two consecutive games in the same church verified (0 bible overlap)');

    host4.close();

    // 7c. add-week.mjs 검증 스크립트: 잘못된 파일은 거부하고, docs/example-week.json은
    // dry-run으로 받아들이면서 실제 파일을 쓰지는 않아야 함.
    const addWeekScript = path.join(ROOT, 'scripts/add-week.mjs');
    const exampleWeekPath = path.join(ROOT, 'docs/example-week.json');

    const badWeekPath = path.join(os.tmpdir(), `church-game-bad-week-${Date.now()}.json`);
    fs.writeFileSync(
      badWeekPath,
      JSON.stringify([
        {
          id: 'verify-bad-001',
          level: 'not-a-real-level',
          category: 'bible',
          text: '검증용으로 일부러 망가뜨린 문항이에요.',
          answer: 'O',
          explanation: 'ref가 빠져 있어요.',
          week: '2026-46',
        },
      ]),
    );
    const badResult = spawnSync(process.execPath, [addWeekScript, badWeekPath, '--dry-run'], { cwd: ROOT, encoding: 'utf-8' });
    fs.unlinkSync(badWeekPath);
    assert(badResult.status !== 0, 'add-week.mjs는 잘못된 level/ref 누락이 있는 파일을 거부(종료 코드 0이 아님)해야 함');
    log('add-week.mjs rejects an invalid file (non-zero exit) ok');

    // 'general' 카테고리는 더 이상 허용되지 않으므로, 이걸 쓰는 파일은 거부되어야 함
    const generalWeekPath = path.join(os.tmpdir(), `church-game-general-week-${Date.now()}.json`);
    fs.writeFileSync(
      generalWeekPath,
      JSON.stringify([
        {
          id: 'verify-general-001',
          level: 'elementary',
          category: 'general',
          text: '검증용으로 일부러 general 카테고리를 넣은 문항이에요.',
          answer: 'O',
          explanation: 'general 카테고리는 더 이상 허용되지 않아요.',
          week: '2026-46',
        },
      ]),
    );
    const generalResult = spawnSync(process.execPath, [addWeekScript, generalWeekPath, '--dry-run'], { cwd: ROOT, encoding: 'utf-8' });
    fs.unlinkSync(generalWeekPath);
    assert(generalResult.status !== 0, "add-week.mjs는 category: 'general'을 거부(종료 코드 0이 아님)해야 함");
    assert(
      generalResult.stderr.includes('category') && generalResult.stderr.includes('general'),
      `add-week.mjs의 오류 메시지가 category 'general'이 잘못되었음을 알려줘야 하는데: ${generalResult.stderr}`,
    );
    log("add-week.mjs rejects category 'general' (non-zero exit) ok");

    const exampleWeekFileBefore = fs.existsSync(path.join(ROOT, 'server/data/questions/2026-46.json'));
    const exampleResult = spawnSync(process.execPath, [addWeekScript, exampleWeekPath, '--dry-run'], { cwd: ROOT, encoding: 'utf-8' });
    assert(exampleResult.status === 0, `add-week.mjs는 docs/example-week.json을 dry-run으로 통과시켜야 하는데 종료 코드 ${exampleResult.status}\n${exampleResult.stdout}\n${exampleResult.stderr}`);
    const exampleWeekFileAfter = fs.existsSync(path.join(ROOT, 'server/data/questions/2026-46.json'));
    assert(exampleWeekFileAfter === exampleWeekFileBefore, 'add-week.mjs --dry-run은 실제 파일을 쓰면 안 됨');
    log('add-week.mjs accepts docs/example-week.json in --dry-run mode without writing ok');

    // ------------------------------------------------------------------
    // 9. 출석 · 달란트 · 팀 대결 (end-to-end)
    // ------------------------------------------------------------------
    log('--- attendance / talent ledger / team battle tests ---');
    const teacher = new Client('teacher');
    const stranger = new Client('stranger');
    const tp = [1, 2, 3, 4].map((n) => ({ client: new Client(`tp${n}`), deviceId: `device-tp${n}`, nickname: `블록${n}`, avatar: `s${n % 4}b${n}h${n}` }));
    await Promise.all([teacher.ready(), stranger.ready(), ...tp.map((p) => p.client.ready())]);
    const groupCode = `검증반${Date.now() % 100000}`;
    const PIN = '2468';

    await expectError(teacher, 'groupOpen', { code: groupCode, pin: PIN }, /없는 반/, '없는 반 열기');
    await expectError(teacher, 'groupOpen', { code: groupCode, pin: '12' }, /PIN/, '짧은 PIN');
    teacher.send('groupOpen', { code: groupCode, pin: PIN, create: true });
    const opened = await teacher.waitFor('groupData');
    assert(opened.created === true && opened.group.members.length === 0, '새 반이 비어 있는 상태로 만들어져야 함');
    const currentWeek = records.isoWeekKST();
    assert(opened.group.currentWeek === currentWeek, '이번 주(KST ISO week)가 맞아야 함');

    // 교사 PIN 보호: 틀린 PIN / 인증 안 된 소켓은 조회·수정 불가
    await expectError(stranger, 'groupOpen', { code: groupCode, pin: '0000' }, /PIN이 맞지/, '틀린 PIN');
    await expectError(stranger, 'groupAdjust', { code: groupCode, nickname: '블록1', delta: 99, reason: '몰래' }, /PIN 확인/, '미인증 달란트 조정');
    await expectError(stranger, 'groupMarkAttendance', { code: groupCode, nickname: '유령' }, /PIN 확인/, '미인증 출석 추가');

    // 반 연결 + 팀 대결 방 만들기 (교사 소켓이 호스트)
    teacher.send('findOrCreateChurch', { name: `검증교회-팀-${Date.now()}` });
    const tChurch = await teacher.waitFor('churchJoined');
    teacher.send('createRoom', { pin: TEST_ROOM_PIN, churchId: tChurch.church.id, title: '팀대결방', capacity: 8, groupCode, groupPin: PIN, teamMode: true });
    const tRoomCreated = await teacher.waitFor('roomCreated');
    const tRoomId = tRoomCreated.room.id;
    assert(tRoomCreated.room.groupCode === opened.group.code, '방이 반에 연결되어야 함');
    assert(tRoomCreated.room.team.enabled && tRoomCreated.room.team.teams.length === 2, '팀 대결(2팀)이 켜져 있어야 함');
    assert(tRoomCreated.room.team.bonus === 2, '승리 보너스 기본값은 2');

    // --- 방 PIN ---
    assert(tRoomCreated.room.pin === TEST_ROOM_PIN && typeof tRoomCreated.hostKey === 'string', '호스트는 자기가 정한 방 PIN 과 호스트 키를 받음');
    await expectError(stranger, 'createRoom', { churchId: tChurch.church.id, title: '이상한PIN', pin: '12ab' }, /숫자 4자리/, '잘못된 방 PIN');
    stranger.send('createRoom', { churchId: tChurch.church.id, title: '자동PIN방' });
    const autoPinRoom = await stranger.waitFor('roomCreated');
    assert(/^\d{4}$/.test(autoPinRoom.room.pin), `PIN 을 안 정하면 숫자 4자리 자동 생성: ${autoPinRoom.room.pin}`);
    const pinTester = new Client('pin-tester');
    await pinTester.ready();
    const joinFailText = async (payload) => {
      pinTester.buffer = pinTester.buffer.filter((m) => m.type !== 'error');
      pinTester.send('joinRoom', { deviceId: 'device-pin', nickname: '핀테스트', ...payload });
      return (await pinTester.waitFor('error')).message;
    };
    const wrongPinMsg = await joinFailText({ roomId: tRoomId, pin: '0000' });
    assert(/PIN/.test(wrongPinMsg) && /다시 확인/.test(wrongPinMsg), `틀린 PIN 은 친절한 안내: ${wrongPinMsg}`);
    assert((await joinFailText({ roomId: tRoomId })) === wrongPinMsg, 'PIN 없이도 입장 불가');
    assert((await joinFailText({ roomId: 'no-such-room', pin: '0000' })) === wrongPinMsg, '없는 방과 틀린 PIN 은 같은 안내(방 존재 여부를 알려 주지 않음)');
    // 호스트 화면: 호스트 키도 PIN 도 없으면 열 수 없음
    pinTester.send('hostOpenRoom', { roomId: tRoomId });
    await pinTester.waitFor('hostAuthRequired', (m) => m.roomId === tRoomId);
    await expectError(pinTester, 'startQuiz', { roomId: tRoomId }, /호스트만/, '호스트 확인 없이 게임 시작');
    teacher.buffer = teacher.buffer.filter((m) => m.type !== 'roomState');
    teacher.send('hostOpenRoom', { roomId: tRoomId, hostKey: tRoomCreated.hostKey });
    assert((await teacher.waitFor('roomState', (m) => m.room.id === tRoomId)).room.pin === TEST_ROOM_PIN, '호스트 키로 다시 열면 PIN 포함 상태를 받음');

    // --- 진행자 비밀번호 (방 PIN 과 별개) ---
    const autoHostPw = tRoomCreated.room.hostPassword;
    assert(/^\d{6}$/.test(autoHostPw) && autoHostPw !== TEST_ROOM_PIN, `안 정하면 숫자 6자리 자동 생성: ${autoHostPw}`);
    await expectError(stranger, 'createRoom', { churchId: tChurch.church.id, title: 'x', hostPassword: 'ab' }, /영문·숫자 4~12자/, '너무 짧은 진행자 비밀번호');
    await expectError(stranger, 'createRoom', { churchId: tChurch.church.id, title: 'x', hostPassword: '한글비밀번호' }, /영문·숫자 4~12자/, '허용 안 되는 문자');
    await expectError(stranger, 'createRoom', { churchId: tChurch.church.id, title: 'x', pin: '5555', hostPassword: '5555' }, /다르게/, '방 PIN 과 같은 진행자 비밀번호');
    stranger.send('createRoom', { churchId: tChurch.church.id, title: '비번지정방', pin: '5555', hostPassword: 'Teach2026' });
    const pwRoom = await stranger.waitFor('roomCreated', (m) => m.room.title === '비번지정방');
    assert(pwRoom.room.hostPassword === 'Teach2026' && pwRoom.room.pin === '5555', '방 만들 때 정한 진행자 비밀번호');
    // 맞는 진행자 비밀번호면 다른 브라우저(호스트 키 없음)에서도 열림
    const hostPw = new Client('host-pw');
    await hostPw.ready();
    hostPw.send('hostOpenRoom', { roomId: pwRoom.room.id, hostPassword: 'Teach2026' });
    const pwOpened = await hostPw.waitFor('roomState', (m) => m.room.id === pwRoom.room.id);
    assert(pwOpened.room.pin === '5555' && pwOpened.room.hostPassword === 'Teach2026', '진행자 비밀번호로 진행자 화면 열림');
    // 진행자가 비밀번호 변경 (호스트만, 방 PIN 과 같게는 불가)
    await expectError(pinTester, 'setHostPassword', { roomId: pwRoom.room.id, hostPassword: 'Hack1234' }, /호스트만/, '호스트 아닌 비밀번호 변경');
    await expectError(hostPw, 'setHostPassword', { roomId: pwRoom.room.id, hostPassword: '5555' }, /다르게/, 'PIN 과 같은 값으로 변경');
    hostPw.send('setHostPassword', { roomId: pwRoom.room.id, hostPassword: 'New12345' });
    await hostPw.waitFor('roomState', (m) => m.room.id === pwRoom.room.id && m.room.hostPassword === 'New12345');
    // 방 PIN 만 아는 학생은 진행자 화면을 열 수 없음 (PIN 을 비밀번호 칸에 넣어도, 예전 pin 필드로 보내도)
    const hostFail = async (client, payload) => {
      client.buffer = client.buffer.filter((m) => m.type !== 'error' && m.type !== 'roomState');
      client.send('hostOpenRoom', payload);
      return (await client.waitFor('error')).message;
    };
    const wrongHostMsg = await hostFail(pinTester, { roomId: tRoomId, hostPassword: TEST_ROOM_PIN });
    assert(/진행자 비밀번호가 맞지 않아요/.test(wrongHostMsg) && /방 입장 PIN이 아니라/.test(wrongHostMsg), `방 PIN 으로는 거절: ${wrongHostMsg}`);
    pinTester.send('hostOpenRoom', { roomId: tRoomId, pin: TEST_ROOM_PIN });
    await pinTester.waitFor('hostAuthRequired', (m) => m.roomId === tRoomId);
    await expectError(pinTester, 'reveal', { roomId: tRoomId }, /호스트만/, '방 PIN 만으로는 여전히 호스트 아님');
    assert(!pinTester.buffer.some((m) => m.type === 'roomState'), '거절된 소켓에는 방 상태(PIN·비밀번호)가 가지 않음');
    // 없는 방도 같은 문구 (방이 있는지 알려 주지 않음)
    assert((await hostFail(stranger, { roomId: 'no-such-room', hostPassword: 'whatever1' })) === wrongHostMsg, '없는 방과 틀린 비밀번호는 같은 안내');
    // 5번 틀리면 30초 잠금: 2~4번째는 일반 안내, 5번째부터 잠금 안내
    for (let n = 2; n <= 4; n++) assert((await hostFail(pinTester, { roomId: tRoomId, hostPassword: `wrong${n}00` })) === wrongHostMsg, `${n}번째 오답은 일반 안내`);
    const lockMsg = await hostFail(pinTester, { roomId: tRoomId, hostPassword: 'wrong500' });
    assert(/여러 번 틀렸어요/.test(lockMsg) && /30초/.test(lockMsg), `5번째 오답에서 잠금: ${lockMsg}`);
    assert((await hostFail(pinTester, { roomId: tRoomId, hostPassword: autoHostPw })) === lockMsg, '잠긴 동안에는 맞는 비밀번호도 거절');
    assert((await hostFail(hostPw, { roomId: tRoomId, hostPassword: autoHostPw })) === lockMsg, '방 단위 잠금: 다른 접속에서 이어서 시도해도 거절');
    // 방을 만든 브라우저(호스트 키)는 잠금과 상관없이 열림
    teacher.buffer = teacher.buffer.filter((m) => m.type !== 'roomState');
    teacher.send('hostOpenRoom', { roomId: tRoomId, hostKey: tRoomCreated.hostKey });
    const reopened = await teacher.waitFor('roomState', (m) => m.room.id === tRoomId);
    assert(reopened.room.hostPassword === autoHostPw && reopened.room.pin === TEST_ROOM_PIN, '호스트 키로는 잠금 중에도 열리고 PIN·비밀번호를 둘 다 받음');
    hostPw.close();

    // 틀린 PIN 으로는 다른 방을 이 반에 연결할 수 없음
    stranger.send('createRoom', { pin: TEST_ROOM_PIN, churchId: tChurch.church.id, title: '몰래방', groupCode, groupPin: '1111' });
    const sneaky = await stranger.waitFor('roomCreated');
    assert(sneaky.room.groupCode === null, '틀린 PIN 으로 만든 방은 반에 연결되면 안 됨');
    // 호스트가 아닌 소켓은 팀 설정 불가
    await expectError(stranger, 'setTeamMode', { roomId: tRoomId, enabled: false }, /호스트만/, '호스트 아닌 팀 설정');

    // 입장 = 출석. 닉네임 단위로만 기록됨
    for (const p of tp) {
      p.client.send('joinRoom', { pin: TEST_ROOM_PIN, roomId: tRoomId, deviceId: p.deviceId, nickname: p.nickname, avatar: p.avatar });
      const j = await p.client.waitFor('joined');
      assert(j.attendance && j.attendance.newlyMarked && j.attendance.week === currentWeek && j.attendance.streak === 1, `${p.nickname} 입장 시 출석이 기록되어야 함`);
      assert(j.room.pin === undefined && j.room.hostPassword === undefined, '학생에게 가는 방 상태에는 PIN·진행자 비밀번호가 없어야 함');
    }
    // 맞는 PIN 이면 입장 성공 (위 4명), 이후 학생용 roomState 에도 PIN 없음
    const pState = await tp[3].client.waitFor('roomState', (m) => m.room.players.length === 4);
    assert(pState.room.pin === undefined && pState.room.hostPassword === undefined, '학생용 roomState 에 PIN·진행자 비밀번호 없음');
    let g = await latestGroup(teacher, (x) => x.members.length === 4);
    // 출석은 "방 입장 순간" 집계: 아직 게임을 한 판도 안 했는데 4명 모두 출석
    assert(g.games.length === 0 && g.ledger.length === 0, '게임 시작 전(기록된 게임 0판)에 이미 출석 처리');

    // --- 닉네임 중복 불가 (먼저 등록한 친구 우선) ---
    const dup = new Client('dup');
    await dup.ready();
    const dupJoin = { roomId: tRoomId, pin: TEST_ROOM_PIN, deviceId: 'device-dup', avatar: 's0b0h0' };
    await expectError(dup, 'joinRoom', { ...dupJoin, nickname: '블록1' }, /이미 다른 친구가 쓰고 있는 이름.*다른 이름을 골라/, '같은 닉네임 입장');
    await expectError(dup, 'joinRoom', { ...dupJoin, nickname: ' 블록 1 ' }, /다른 이름을 골라/, '공백만 다른 닉네임 입장');
    // 같은 반에 연결된 다른 방에서도 그 닉네임은 주인 것
    teacher.send('createRoom', { churchId: tChurch.church.id, title: '같은반 둘째방', pin: '7777', groupCode });
    const room2 = await teacher.waitFor('roomCreated', (m) => m.room.title === '같은반 둘째방');
    assert(room2.room.groupCode === opened.group.code, '둘째 방도 같은 반에 연결');
    await expectError(dup, 'joinRoom', { roomId: room2.room.id, pin: '7777', deviceId: 'device-dup', nickname: '블록1' }, /우리 반에서 이미 다른 친구/, '같은 반 다른 방에서도 중복 닉네임 거부');
    // 다른 반에서는 같은 닉네임을 써도 됨
    const otherCode = `다른반${Date.now() % 100000}`;
    teacher.send('groupOpen', { code: otherCode, pin: '1357', create: true });
    await teacher.waitFor('groupData', (m) => m.group.code === otherCode);
    teacher.send('createRoom', { churchId: tChurch.church.id, title: '다른반방', pin: '8888', groupCode: otherCode });
    const room3 = await teacher.waitFor('roomCreated', (m) => m.room.title === '다른반방');
    dup.send('joinRoom', { roomId: room3.room.id, pin: '8888', deviceId: 'device-dup', nickname: '블록1' });
    assert((await dup.waitFor('joined')).playerId === 'device-dup', '다른 반에서는 같은 닉네임으로 입장 가능');
    // 원래 방은 여전히 4명, 반 기록도 4명 그대로. 그리고 다시 원래 방 호스트로 돌아옴
    teacher.buffer = teacher.buffer.filter((m) => m.type !== 'roomState' && m.type !== 'groupData');
    teacher.send('hostOpenRoom', { roomId: tRoomId, hostKey: tRoomCreated.hostKey });
    assert((await teacher.waitFor('roomState', (m) => m.room.id === tRoomId)).room.players.length === 4, '중복 닉네임 시도 후에도 방 인원 4명');
    teacher.send('groupOpen', { code: groupCode, pin: PIN });
    g = await latestGroup(teacher, (x) => x.code === opened.group.code);
    assert(g.members.length === 4 && g.members.every((m) => m.claimed), '반 기록 4명 그대로, 닉네임 주인 등록됨');
    assert(g.members.every((m) => m.presentThisWeek && m.attendedWeeks.includes(currentWeek) && m.attendCount === 1), '4명 모두 이번 주 출석');
    assert(g.weeks.at(-1).id === currentWeek && g.weeks.at(-1).presentCount === 4, '주별 기록의 이번 주 출석 인원 4');
    assert(Object.keys(g.members[0]).every((k) => !/name$|phone|birth/i.test(k) || k === 'nickname'), '닉네임 외 개인정보 필드가 없어야 함');
    // 같은 주 재입장은 출석 1회 그대로
    tp[0].client.send('joinRoom', { pin: TEST_ROOM_PIN, roomId: tRoomId, deviceId: tp[0].deviceId, nickname: tp[0].nickname, avatar: tp[0].avatar });
    const rejoin = await tp[0].client.waitFor('joined');
    assert(rejoin.attendance.newlyMarked === false, '같은 주 재입장은 새 출석이 아님');
    // 교사가 폰 없는 친구 출석 추가 / 취소
    teacher.send('groupMarkAttendance', { code: groupCode, nickname: '폰없는친구' });
    g = await latestGroup(teacher, (x) => x.members.length === 5);
    assert(g.members.find((m) => m.nickname === '폰없는친구').presentThisWeek, '교사 수동 출석');
    teacher.send('groupMarkAttendance', { code: groupCode, nickname: '폰없는친구', present: false });
    g = await latestGroup(teacher, (x) => x.members.some((m) => m.nickname === '폰없는친구' && !m.presentThisWeek));
    assert(g.weeks.at(-1).presentCount === 4, '출석 취소 후 인원 4');

    // 팀 나누기: 늦게 들어온 친구도 자동 배정되어 2:2 균형
    const teamOf = (room) => Object.fromEntries(room.players.map((pl) => [pl.id, pl.teamId]));
    const sizesOf = (room) => room.team.teams.map((t) => t.size).sort();
    teacher.buffer = teacher.buffer.filter((m) => m.type !== 'roomState');
    teacher.send('autoSplitTeams', { roomId: tRoomId });
    let tState = await teacher.waitFor('roomState', (m) => m.room.id === tRoomId);
    assert(JSON.stringify(sizesOf(tState.room)) === '[2,2]', `자동 나누기는 2:2 여야 하는데 ${sizesOf(tState.room)}`);
    assert(tState.room.team.teams.map((t) => t.name).join() === '빨강 벽돌팀,파랑 얼음팀', '블록 색 팀 이름');
    // 3팀으로 바꾸면 다시 균형 배정(2:1:1), 다시 2팀으로
    teacher.send('setTeamMode', { roomId: tRoomId, count: 3 });
    tState = await teacher.waitFor('roomState', (m) => m.room.id === tRoomId && m.room.team.count === 3);
    assert(JSON.stringify(sizesOf(tState.room)) === '[1,1,2]', `3팀 균형 배정: ${sizesOf(tState.room)}`);
    teacher.send('setTeamMode', { roomId: tRoomId, count: 2, bonus: 3 });
    tState = await teacher.waitFor('roomState', (m) => m.room.id === tRoomId && m.room.team.count === 2 && m.room.team.bonus === 3);
    // 수동 배정: 블록1·블록2 = 빨강, 블록3·블록4 = 파랑
    const wanted = { [tp[0].deviceId]: 'red', [tp[1].deviceId]: 'red', [tp[2].deviceId]: 'blue', [tp[3].deviceId]: 'blue' };
    for (const [playerId, teamId] of Object.entries(wanted)) teacher.send('assignTeam', { roomId: tRoomId, playerId, teamId });
    tState = await teacher.waitFor('roomState', (m) => m.room.id === tRoomId && JSON.stringify(teamOf(m.room)) === JSON.stringify(wanted));
    await expectError(teacher, 'assignTeam', { roomId: tRoomId, playerId: tp[0].deviceId, teamId: 'purple' }, /없는 팀/, '없는 팀 배정');

    // 2문제 게임: 빨강팀은 모두 정답, 파랑팀은 모두 오답
    teacher.buffer = teacher.buffer.filter((m) => m.type !== 'roomState');
    teacher.send('startQuiz', { roomId: tRoomId, questionCount: 2 });
    for (let round = 0; round < 2; round++) {
      const q = await teacher.waitFor('roomState', (m) => m.room.id === tRoomId && m.room.status === 'question' && m.room.question?.index === round);
      const correct = answerFor(q.room.question.text);
      await expectError(teacher, 'assignTeam', { roomId: tRoomId, playerId: tp[0].deviceId, teamId: 'blue' }, /시작 전에만/, '게임 중 팀 변경');
      const choices = tp.map((p) => (wanted[p.deviceId] === 'red' ? correct : opposite(correct)));
      tp.forEach((p, i) => p.client.send('answer', { roomId: tRoomId, choice: choices[i] }));
      const arrived = await waitUntilAllInZones(teacher, tRoomId, tp.map((p, i) => ({ deviceId: p.deviceId, zoneBox: ZONES[choices[i]] })), ZONE_ARRIVAL_TIMEOUT_MS);
      assert(arrived, '팀 대결: 모든 플레이어가 선택한 구역에 도착해야 함');
      teacher.send('reveal', { roomId: tRoomId });
      const rev = await teacher.waitFor('roomState', (m) => m.room.id === tRoomId && m.room.status === 'reveal' && m.room.question?.index === round);
      const red = rev.room.team.teams.find((t) => t.id === 'red');
      const blue = rev.room.team.teams.find((t) => t.id === 'blue');
      assert(red.total === (round + 1) * 2 && red.average === round + 1, `게임 중 빨강팀 점수: ${JSON.stringify(red)}`);
      assert(blue.total === 0 && blue.average === 0, `게임 중 파랑팀 점수: ${JSON.stringify(blue)}`);
      teacher.send('nextQuestion', { roomId: tRoomId });
    }
    const tFinal = await teacher.waitFor('roomState', (m) => m.room.id === tRoomId && m.room.status === 'finished');
    const fr = tFinal.room.finalResult;
    assert(fr && fr.team, '종료 시 팀 결과가 있어야 함');
    assert(fr.team.winnerTeamIds.join() === 'red' && fr.team.loserTeamIds.join() === 'blue' && fr.team.tie === false, `이긴 팀=빨강, 진 팀=파랑이어야 함: ${JSON.stringify(fr.team)}`);
    assert(fr.mvpIds.slice().sort().join() === [tp[0].deviceId, tp[1].deviceId].sort().join(), 'MVP 는 최고 득점자(공동)');
    assert(fr.recorded === true && fr.awards.length === 4, '달란트가 장부에 기록되어야 함');
    // 빨강: 참가1 + 1등3 + 팀 보너스3 = 7 (2문제라 만점 보너스 없음) / 파랑: 참가1
    for (const p of tp) {
      const award = fr.awards.find((a) => a.id === p.deviceId);
      const expected = wanted[p.deviceId] === 'red' ? 7 : 1;
      assert(award.delta === expected, `${p.nickname} 자동 달란트는 ${expected} 여야 하는데 ${award.delta}`);
    }
    assert(fr.awards.find((a) => a.id === tp[0].deviceId).parts.some((x) => x.kind === 'team' && x.delta === 3 && x.reason.includes('빨강 벽돌팀')), '팀 승리 보너스 항목');
    // 플레이어도 같은 결과를 받음
    const pFinal = await tp[2].client.waitFor('roomState', (m) => m.room.status === 'finished');
    assert(pFinal.room.finalResult.team.loserTeamIds.includes('blue'), '플레이어 화면에도 팀 결과 전달');
    // 끝난 뒤 nextQuestion 을 또 눌러도 달란트가 중복 지급되지 않음
    teacher.send('nextQuestion', { roomId: tRoomId });

    g = await latestGroup(teacher, (x) => x.games.length === 1);
    const totalOf = (grp, nick) => grp.members.find((m) => m.nickname === nick)?.total;
    assert(totalOf(g, '블록1') === 7 && totalOf(g, '블록2') === 7 && totalOf(g, '블록3') === 1 && totalOf(g, '블록4') === 1, `누적 달란트: ${g.members.map((m) => `${m.nickname}=${m.total}`)}`);
    assert(g.members[0].total === 7 && g.members.at(-1).total <= 1, '순위표는 누적 달란트 내림차순');
    assert(g.mvp.map((m) => m.nickname).sort().join() === '블록1,블록2' && g.mvp[0].weekTalents === 7, '이번 주 MVP');
    assert(g.games[0].team.winnerTeamIds.join() === 'red' && g.games[0].mvpNicknames.length === 2 && g.games[0].week === currentWeek, '게임 기록');
    assert(g.ledger.filter((e) => e.kind === 'team').length === 2 && g.ledger.filter((e) => e.kind === 'team').every((e) => e.delta === 3), '팀 보너스가 장부에 2건(승리 팀원)');

    // 교사 수동 가감 (사유 포함) → 누적/개인 내역 반영
    await expectError(teacher, 'groupAdjust', { code: groupCode, nickname: '블록3', delta: 5, reason: '' }, /사유/, '사유 없는 조정');
    teacher.send('groupAdjust', { code: groupCode, nickname: '블록3', delta: 5, reason: '암송 완료' });
    g = await latestGroup(teacher, (x) => totalOf(x, '블록3') === 6);
    teacher.send('groupAdjust', { code: groupCode, nickname: '블록1', delta: -4, reason: '간식 교환' });
    g = await latestGroup(teacher, (x) => totalOf(x, '블록1') === 3);
    const b1 = g.ledger.filter((e) => e.nickname === '블록1');
    assert(b1[0].kind === 'manual' && b1[0].delta === -4 && b1[0].reason === '간식 교환' && b1[0].week === currentWeek, '수동 차감 내역');
    assert(b1.reduce((s2, e) => s2 + e.delta, 0) === 3 && b1.length === 4, '개인 내역 합계 = 누적');
    assert(g.ledger.length === 4 + 2 + 2 + 2, `장부 항목 수(중복 지급 없음): ${g.ledger.length}`);

    // 주간 상한을 교사가 8로 낮춤 (교사 PIN 인증된 소켓만 가능)
    await expectError(stranger, 'groupSettings', { code: groupCode, weeklyCap: 1 }, /PIN 확인/, '미인증 상한 변경');
    await expectError(teacher, 'groupSettings', { code: groupCode, weeklyCap: 500 }, /1~100/, '범위 밖 상한');
    assert(g.settings.weeklyCap === 20, '상한 기본값 20');
    teacher.send('groupSettings', { code: groupCode, weeklyCap: 8 });
    g = await latestGroup(teacher, (x) => x.code === opened.group.code && x.settings.weeklyCap === 8);

    // 다시 시작해도 팀은 유지되고, 동점이면 공동 우승(진 팀 없음)
    teacher.buffer = teacher.buffer.filter((m) => m.type !== 'roomState'); // 첫 판의 남은 상태 메시지 제거
    teacher.send('startQuiz', { roomId: tRoomId, questionCount: 1 });
    const tq = await teacher.waitFor('roomState', (m) => m.room.id === tRoomId && m.room.status === 'question' && m.room.finalResult === null);
    assert(JSON.stringify(teamOf(tq.room)) === JSON.stringify(wanted), '다시 시작해도 팀 배정 유지');
    const tieAnswer = answerFor(tq.room.question.text);
    tp.forEach((p) => p.client.send('answer', { roomId: tRoomId, choice: tieAnswer }));
    assert(await waitUntilAllInZones(teacher, tRoomId, tp.map((p) => ({ deviceId: p.deviceId, zoneBox: ZONES[tieAnswer] })), ZONE_ARRIVAL_TIMEOUT_MS), '동점 판: 모두 정답 구역 도착');
    teacher.send('reveal', { roomId: tRoomId });
    await teacher.waitFor('roomState', (m) => m.room.id === tRoomId && m.room.status === 'reveal');
    teacher.send('nextQuestion', { roomId: tRoomId });
    const tie = await teacher.waitFor('roomState', (m) => m.room.id === tRoomId && m.room.status === 'finished' && m.room.finalResult);
    const tieTeam = tie.room.finalResult.team;
    assert(tieTeam.tie === true && tieTeam.loserTeamIds.length === 0 && tieTeam.winnerTeamIds.length === 2, `1:1 동점은 공동 우승(진 팀 없음): ${JSON.stringify(tieTeam)}`);
    // 공동 우승이면 두 팀 모두 보너스: 참가1 + 1등3 + 팀3 = 7 을 받을 차례인데,
    // 이 판 직전에 주간 상한을 8로 낮췄으므로 이미 7개 받은 빨강팀은 1개만 받는다.
    for (const p of tp) {
      const a = tie.room.finalResult.awards.find((x) => x.id === p.deviceId);
      if (wanted[p.deviceId] === 'red') {
        assert(a.requested === 7 && a.delta === 1 && a.capped === true && a.weekRemaining === 0 && a.weeklyCap === 8, `상한(8)으로 깎인 지급: ${JSON.stringify(a)}`);
      } else {
        assert(a.delta === 7 && a.capped === false && a.weekRemaining === 0, `상한 안이면 전부 지급(교사 수동 +5 는 상한에 안 들어감): ${JSON.stringify(a)}`);
      }
    }
    g = await latestGroup(teacher, (x) => x.code === opened.group.code && x.games.length === 2);
    assert(g.settings.weeklyCap === 8 && totalOf(g, '블록1') === 3 + 1 && totalOf(g, '블록3') === 6 + 7, `상한 적용 후 누적: ${g.members.map((m) => `${m.nickname}=${m.total}`)}`);
    const blk1 = g.members.find((m) => m.nickname === '블록1');
    assert(blk1.weekEarned === 8 && blk1.weekRemaining === 0, '상한 사용량 8/8, 남은 0');
    assert(g.ledger.some((e) => e.nickname === '블록1' && e.capped && e.delta === 0 && /주간 상한 8개 도달 · 지급 없음/.test(e.reason)), '장부에 상한으로 못 받은 항목이 남음');
    // 교사 수동 지급은 상한을 넘어도 들어가고 '상한 예외'로 표시
    teacher.send('groupAdjust', { code: groupCode, nickname: '블록1', delta: 5, reason: '예배 도우미' });
    g = await latestGroup(teacher, (x) => x.code === opened.group.code && totalOf(x, '블록1') === 9);
    assert(g.ledger.find((e) => e.nickname === '블록1' && e.reason === '예배 도우미').override === true, '수동 지급은 상한 예외로 기록');
    await expectError(teacher, 'groupAdjust', { code: groupCode, nickname: '블록1', delta: -10, reason: '너무 많이' }, /뺄 수 없어요/, '잔액보다 많이 차감');

    // --- 달란트 상점 (블록1: 잔액 9) ---
    const shopper = tp[0].client;
    const shopMsg = async (type, payload) => {
      shopper.buffer = shopper.buffer.filter((m) => m.type !== 'shopData');
      shopper.send(type, { roomId: tRoomId, ...payload });
      return shopper.waitFor('shopData');
    };
    let shop = await shopMsg('shopOpen', {});
    assert(shop.shop.balance === 9 && shop.shop.items.length >= 8 && shop.shop.weeklyCap === 8 && shop.shop.weekRemaining === 0, `상점 열기: ${JSON.stringify({ ...shop.shop, items: undefined })}`);
    teacher.buffer = teacher.buffer.filter((m) => m.type !== 'roomState');
    shop = await shopMsg('shopBuy', { itemId: 'hat-melon' });
    assert(shop.charged === 7 && shop.shop.balance === 2 && shop.shop.equipped.hat === 'hat-melon', '구입: 7 차감, 자동 착용');
    const worn = await teacher.waitFor('roomState', (m) => m.room.id === tRoomId && m.room.players.find((pl) => pl.id === tp[0].deviceId)?.cosmetics?.hat === 'hat-melon');
    assert(worn.room.players.find((pl) => pl.id === tp[1].deviceId).cosmetics.hat === undefined, '착용 아이템은 산 친구 캐릭터에만 보임');
    shop = await shopMsg('shopBuy', { itemId: 'hat-melon' });
    assert(shop.charged === 0 && shop.shop.balance === 2, '보유 아이템 재구입은 차감 없음');
    await expectError(shopper, 'shopBuy', { roomId: tRoomId, itemId: 'outfit-checker' }, /3개 모자라요/, '잔액 부족 구입');
    shop = await shopMsg('shopEquip', { itemId: 'hat-melon', equip: false });
    assert(shop.shop.equipped.hat === undefined && shop.shop.balance === 2, '벗기');
    shop = await shopMsg('shopEquip', { itemId: 'hat-melon', equip: true });
    assert(shop.shop.equipped.hat === 'hat-melon', '다시 착용');
    await expectError(shopper, 'shopEquip', { roomId: tRoomId, itemId: 'extra-wings' }, /사지 않은/, '안 산 아이템 착용');
    await expectError(stranger, 'shopBuy', { roomId: tRoomId, itemId: 'hat-sprout' }, /방에 먼저/, '방에 없는 소켓의 구입');
    g = await latestGroup(teacher, (x) => x.code === opened.group.code && totalOf(x, '블록1') === 2);
    const shopRows = g.ledger.filter((e) => e.kind === 'shop');
    assert(shopRows.length === 1 && shopRows[0].delta === -7 && shopRows[0].nickname === '블록1' && shopRows[0].reason.includes('수박 헬멧'), '상점 지출이 장부에 한 번만 기록');
    assert(g.members.every((m) => m.total >= 0) && g.members.find((m) => m.nickname === '블록1').equipped.hat === 'hat-melon', '누구도 잔액 음수 아님, 착용 정보 반영');
    // 다시 들어와도 착용 아이템 유지
    tp[0].client.send('joinRoom', { roomId: tRoomId, deviceId: tp[0].deviceId, nickname: tp[0].nickname, avatar: tp[0].avatar });
    const back = await tp[0].client.waitFor('joined');
    assert(back.room.players.find((pl) => pl.id === tp[0].deviceId).cosmetics.hat === 'hat-melon', '재입장(PIN 없이, 이미 방에 있던 기기) 후에도 착용 유지');

    // --- 홈 화면 상점: 방 밖에서 반 코드 + 닉네임으로 (닉네임 주인 기기만) ---
    const home = new Client('home-shop');
    await home.ready();
    await expectError(home, 'shopOpen', {}, /먼저 확인/, '확인 없이 홈 상점 열기');
    const loginFail = async (payload) => {
      home.buffer = home.buffer.filter((m) => m.type !== 'error');
      home.send('shopLogin', payload);
      return (await home.waitFor('error')).message;
    };
    const notFoundMsg = await loginFail({ code: groupCode, nickname: '없는닉네임', deviceId: tp[0].deviceId });
    assert(/다시 확인/.test(notFoundMsg) && /닉네임을 등록/.test(notFoundMsg), `없는 닉네임 안내: ${notFoundMsg}`);
    assert((await loginFail({ code: '없는반코드', nickname: '블록1', deviceId: tp[0].deviceId })) === notFoundMsg, '없는 반도 같은 안내');
    assert(/다른 친구의 닉네임/.test(await loginFail({ code: groupCode, nickname: '블록2', deviceId: tp[0].deviceId })), '남의 닉네임으로는 상점을 열 수 없음');
    assert(/주인이 정해지지 않았어요/.test(await loginFail({ code: groupCode, nickname: '폰없는친구', deviceId: 'device-new' })), '주인 없는 닉네임은 홈에서 열 수 없음(방에서 먼저 등록)');
    await expectError(home, 'shopBuy', { itemId: 'hat-sprout' }, /먼저 확인/, '확인 실패 후 구입 시도');
    teacher.buffer = teacher.buffer.filter((m) => m.type !== 'groupData'); // 예전 스냅샷 제거
    teacher.send('groupOpen', { code: groupCode, pin: PIN });
    g = await latestGroup(teacher, (x) => x.code === opened.group.code);
    assert(g.members.find((m) => m.nickname === '폰없는친구').claimed === false && totalOf(g, '블록2') === 8, '실패한 시도는 아무 기록도 바꾸지 않음');
    // 주인 기기: 공백이 달라도 같은 닉네임으로 확인
    home.send('shopLogin', { code: ` ${groupCode} `, nickname: ' 블록 1 ', deviceId: tp[0].deviceId });
    const ready = await home.waitFor('shopReady');
    assert(ready.nickname === '블록1' && ready.code === opened.group.code, '홈 상점 확인 통과');
    const homeMsg = async (type, payload) => {
      home.buffer = home.buffer.filter((m) => m.type !== 'shopData');
      home.send(type, payload);
      return home.waitFor('shopData');
    };
    let hs = await homeMsg('shopOpen', {});
    assert(hs.shop.balance === 2 && hs.shop.owned.join() === 'hat-melon' && hs.shop.equipped.hat === 'hat-melon' && hs.shop.items.length === 11 && hs.shop.avatar === tp[0].avatar, `홈 상점은 방 안 상점과 같은 지갑: ${JSON.stringify({ ...hs.shop, items: undefined })}`);
    await expectError(home, 'shopBuy', { itemId: 'outfit-checker' }, /3개 모자라요/, '홈 상점 잔액 부족');
    teacher.send('groupAdjust', { code: groupCode, nickname: '블록1', delta: 6, reason: '홈 상점 검증' });
    await latestGroup(teacher, (x) => x.code === opened.group.code && totalOf(x, '블록1') === 8);
    teacher.buffer = teacher.buffer.filter((m) => m.type !== 'roomState');
    hs = await homeMsg('shopBuy', { itemId: 'outfit-checker' });
    assert(hs.charged === 5 && hs.shop.balance === 3 && hs.shop.equipped.outfit === 'outfit-checker' && hs.shop.equipped.hat === 'hat-melon', '홈에서 구입: 5 차감, 자동 착용');
    // 홈에서 산 옷이 지금 들어가 있는 방의 캐릭터에도 바로 보임
    await teacher.waitFor('roomState', (m) => m.room.id === tRoomId && m.room.players.find((pl) => pl.id === tp[0].deviceId)?.cosmetics?.outfit === 'outfit-checker');
    hs = await homeMsg('shopBuy', { itemId: 'outfit-checker' });
    assert(hs.charged === 0 && hs.shop.balance === 3, '홈에서도 보유 아이템 재구입은 차감 없음');
    await expectError(home, 'shopBuy', { itemId: 'hat-sprout' }, /1개 모자라요/, '홈 상점: 잔액이 음수가 되는 구입 불가');
    hs = await homeMsg('shopEquip', { itemId: 'hat-melon', equip: false });
    assert(hs.shop.equipped.hat === undefined && hs.shop.equipped.outfit === 'outfit-checker' && hs.shop.balance === 3, '홈에서 착용 해제');
    hs = await homeMsg('shopEquip', { itemId: 'hat-melon', equip: true });
    assert(hs.shop.equipped.hat === 'hat-melon', '홈에서 다시 착용');
    // 방 안 상점에서 보는 잔액과 같음 (지갑은 하나)
    shop = await shopMsg('shopOpen', {});
    assert(shop.shop.balance === 3 && shop.shop.owned.length === 2, '방 안 상점과 홈 상점의 잔액·보유 목록이 같음');
    g = await latestGroup(teacher, (x) => x.code === opened.group.code && totalOf(x, '블록1') === 3);
    assert(g.ledger.filter((e) => e.kind === 'shop').length === 2 && g.ledger.some((e) => e.kind === 'shop' && e.delta === -5 && e.reason.includes('체크무늬')), '홈 구입도 같은 장부에 지출로 기록');
    // 확인 실패 5번이면 30초 잠금
    const homeLock = new Client('home-lock');
    await homeLock.ready();
    let lastLoginMsg = '';
    for (let n = 1; n <= 6; n++) {
      homeLock.buffer = homeLock.buffer.filter((m) => m.type !== 'error');
      homeLock.send('shopLogin', { code: groupCode, nickname: '블록2', deviceId: 'device-bad' });
      lastLoginMsg = (await homeLock.waitFor('error')).message;
    }
    assert(/30초/.test(lastLoginMsg), `홈 상점 확인도 5번 틀리면 잠금: ${lastLoginMsg}`);
    home.close();
    homeLock.close();

    // 서버가 실제로 파일에 저장했는지 (임시 폴더, 원자적 쓰기라 .tmp 가 남지 않음)
    const recFiles = fs.readdirSync(SERVER_RECORDS_DIR);
    assert(recFiles.length === 2 && recFiles.every((f) => f.endsWith('.json')), `반 기록 파일(반 2개): ${recFiles}`);
    const saved = JSON.parse(fs.readFileSync(path.join(SERVER_RECORDS_DIR, `${opened.group.code}.json`), 'utf8'));
    assert(saved.games.length === 2 && saved.pinHash && !JSON.stringify(saved).includes(`"${PIN}"`), '파일에 게임 2판 저장, PIN 평문 없음');
    log('attendance, talent auto-award + manual adjust, team split + winner/loser + bonus ok');
    log('room PIN, unique nickname, attendance-on-enter, weekly cap, manual override, shop purchase/equip/ledger ok');
    log('home-screen shop (class code + owned nickname) and separate host password with 5-try lockout ok');

    pinTester.close();
    dup.close();
    teacher.close();
    stranger.close();
    for (const p of tp) p.client.close();
    fs.rmSync(SERVER_RECORDS_DIR, { recursive: true, force: true });

    host3.close();
    lp.close();

    host2.close();
    m1.close();
    m2.close();
    m3.close();

    host.close();
    p1.close();
    p2.close();
    p3.close();

    finished = true;
    server.kill();
    log('ALL CHECKS PASSED ✅');
    process.exit(0);
  } catch (err) {
    finished = true;
    server.kill();
    console.error('[verify] FAILED:', err);
    process.exit(1);
  }
}

function waitUntil(predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const id = setInterval(() => {
      if (predicate()) {
        clearInterval(id);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(id);
        reject(new Error('timed out waiting for server to start'));
      }
    }, 50);
  });
}

main();
