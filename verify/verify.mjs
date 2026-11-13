import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import WebSocket from 'ws';
import { QUESTIONS_BY_LEVEL, LEVELS, DEFAULT_LEVEL, CATEGORIES, DEFAULT_QUESTION_COUNT, questionBankStats, getQuestionById, selectQuizQuestions, availableQuestionCount } from '../server/src/questions.js';
import { ZONES, MAP_BOUNDS, WALK_SPEED, RUN_SPEED, CRAWL_SPEED, GAIT_ACTIVE_MS, GAIT_COOLDOWN_MS } from '../server/src/state.js';
import * as gameState from '../server/src/state.js';
import {
  addQuestionReport,
  hiddenQuestionIds,
  applyReviewAction,
  listReviewItems,
  exportReviewPatch,
  checkReviewPassword,
  reviewPasswordConfigured,
  reportDeviceHash,
  _resetQuestionReports,
  REPORT_HIDE_DEVICE_THRESHOLD,
  REPORT_MEMO_MAX,
} from '../server/src/questionReports.js';

import * as records from '../server/src/records.js';

// Question text is unique across all levels (verify looks questions up by
// text alone), so a single flat lookup works regardless of which level a
// room is actually using.
const ALL_QUESTIONS = Object.values(QUESTIONS_BY_LEVEL).flat();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8799;
const TEST_ROOM_PIN = '4321'; // 기존 검사들이 쓰는 방 PIN (학생 입장용)
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

// 조이스틱 입력으로 구역 한가운데까지 간다. 뛰기는 3초짜리 기술이라 처음에 한 번만
// 요청하고(먼 길을 빨리 가려고), 그 뒤로는 위치를 보면서 가운데 근처에 닿으면 멈춘다.
async function moveIntoZone(host, roomId, client, deviceId, zoneBox) {
  const targetX = (zoneBox.xmin + zoneBox.xmax) / 2;
  const targetZ = (zoneBox.zmin + zoneBox.zmax) / 2;
  client.send('gait', { roomId, mode: 'run' });
  const deadline = Date.now() + 9000;
  while (Date.now() < deadline) {
    const pos = await freshPosition(host, roomId, deviceId);
    const dist = Math.hypot(targetX - pos.x, targetZ - pos.z);
    if (dist < 0.7) break;
    client.send('move', { roomId, dir: { x: (targetX - pos.x) / dist, z: (targetZ - pos.z) / dist } });
  }
  client.send('move', { roomId, dir: { x: 0, z: 0 } });
  client.send('gait', { roomId, mode: 'walk' });
  await sleep(150); // let the server settle on the final position
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
// direction, so run/walk/crawl can be compared end to end through the real
// input -> physics tick -> broadcast pipeline. Both samples are taken while
// the player is already moving (after a short lead-in), and the elapsed time
// comes from when the two broadcasts arrived, so start-up and stop delays do
// not blur the number.
// opts: { run, crawl } legacy flags on the move message, `gait` to request a
// burst first, `dir` to override the (possibly forged) direction vector,
// `extra` for extra forged fields on the move message.
async function measureSpeed(host, roomId, client, deviceId, opts = {}, durationMs = 700) {
  const current = await freshPosition(host, roomId, deviceId);
  // Head toward the center so a second of movement never clips a map bound.
  const sign = current.x > 0 ? -1 : 1;
  const dir = opts.dir ? { x: opts.dir.x * sign, z: opts.dir.z } : { x: sign, z: 0 };
  if (opts.gait) client.send('gait', { roomId, mode: opts.gait });
  const payload = { roomId, dir, ...(opts.extra || {}) };
  if (opts.run !== undefined) payload.run = opts.run;
  if (opts.crawl !== undefined) payload.crawl = opts.crawl;
  client.send('move', payload);
  const id = setInterval(() => client.send('move', payload), 80);
  try {
    await sleep(200); // lead-in: input has reached the server and the avatar is at speed
    const before = await freshPosition(host, roomId, deviceId);
    const t0 = Date.now();
    await sleep(durationMs);
    const after = await freshPosition(host, roomId, deviceId);
    const t1 = Date.now();
    return Math.hypot(after.x - before.x, after.z - before.z) / ((t1 - t0) / 1000);
  } finally {
    clearInterval(id);
    client.send('move', { roomId, dir: { x: 0, z: 0 } });
  }
}

// 'gait' 요청을 보내고 그 응답을 받는다 (이전에 쌓인 응답은 버린다).
async function requestGaitOverWire(client, roomId, mode) {
  client.buffer = client.buffer.filter((m) => m.type !== 'gait');
  client.send('gait', { roomId, mode });
  return client.waitFor('gait', (m) => m.roomId === roomId);
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

// ---------------------------------------------------------------------------
// 뛰기·기어가기 규칙 (단위 검증): 서버 시계를 직접 넣어 주므로 실제 시간이 걸리지 않고
// 타이밍에 흔들리지 않는다. 3초 유지 → 끝난 뒤 10초 쿨타임, 속도 상한, 위조 입력.
// ---------------------------------------------------------------------------
function verifyGaitUnit() {
  const S = gameState;
  assert(GAIT_ACTIVE_MS === 3000 && GAIT_COOLDOWN_MS === 10000, '뛰기·기어가기: 3초 유지, 10초 쿨타임');
  const church = S.findOrCreateChurch(`걸음걸이-단위-${Date.now()}`);
  const room = S.createRoom({ churchId: church.id, title: '걸음걸이', capacity: 'unlimited' });
  const id = 'gait-unit';
  const player = S.joinRoom(room, { deviceId: id, nickname: '걸음', avatar: 'circle-blue' });
  const m = player.motion;
  const TICK = S.PHYSICS_TICK_MS;
  let now = 1_000_000;
  // ms 동안 물리 틱을 돌리고 x 로 간 거리를 돌려준다 (매번 왼쪽 끝 근처에서 출발).
  const travel = (ms) => {
    m.pos.x = -7.5;
    m.pos.z = 8;
    const x0 = m.pos.x;
    for (let t = 0; t < ms; t += TICK) {
      now += TICK;
      S.tickRoomPhysics(room, TICK, now);
    }
    return m.pos.x - x0;
  };
  const near = (value, expected, label) => assert(Math.abs(value - expected) < 0.02, `${label}: ${value.toFixed(3)} (기대 ${expected})`);
  const posOf = () => S.serializePositions(room).find((p) => p.id === id);

  // 걷기: 기본, 제한 없음
  S.setPlayerInput(room, id, { dir: { x: 1, z: 0 } }, now);
  near(travel(1000), WALK_SPEED, '걷기 1초');
  assert(posOf().state === 'walk' && posOf().gait === undefined, '걷는 중에는 상태 walk, gait 없음');
  near(travel(6000), WALK_SPEED * 6, '걷기는 6초 내내 같은 속도 (제한 없음)');

  // 위조: 방향 크기를 크게 보내거나 속도 값을 끼워 넣어도 걷기 속도를 넘지 못한다
  S.setPlayerInput(room, id, { dir: { x: 50, z: 0 }, speed: 99, run: false }, now);
  near(travel(1000), WALK_SPEED, '위조한 큰 방향값');
  S.setPlayerInput(room, id, { dir: { x: 1, z: 1 } }, now);
  m.pos.x = -7.5; m.pos.z = 2;
  const p0 = { ...m.pos };
  for (let t = 0; t < 1000; t += TICK) { now += TICK; S.tickRoomPhysics(room, TICK, now); }
  near(Math.hypot(m.pos.x - p0.x, m.pos.z - p0.z), WALK_SPEED, '대각선도 걷기 속도');
  S.setPlayerInput(room, id, { dir: { x: 'abc', z: null } }, now);
  near(travel(500), 0, '숫자가 아닌 방향은 0');
  S.setPlayerInput(room, id, { dir: { x: 1, z: 0 } }, now);

  // 뛰기: 3초 동안만 빠르고, 그 뒤로는 걷기
  let r = S.requestGait(room, id, 'run', now);
  assert(r.ok && r.mode === 'run' && r.activeMs === GAIT_ACTIVE_MS && r.cooldownMs.run === GAIT_COOLDOWN_MS, '뛰기 시작: 남은 3초, 끝난 뒤 쿨타임 10초');
  const runStart = now;
  near(travel(1000), RUN_SPEED, '뛰는 1초');
  assert(posOf().state === 'run' && posOf().gait === 'run', '뛰는 중에는 상태 run + gait run (호스트 표시용)');
  r = S.requestGait(room, id, 'run', now);
  assert(!r.ok && r.reason === 'busy', '뛰는 중에 또 뛰기 요청은 거절');
  r = S.requestGait(room, id, 'crawl', now);
  assert(!r.ok && r.reason === 'busy' && r.mode === 'run', '뛰는 중에 기어가기 요청은 거절');
  near(travel(2000), RUN_SPEED * 2, '뛰는 나머지 2초');
  assert(now === runStart + GAIT_ACTIVE_MS, '시계 확인');
  near(travel(1000), WALK_SPEED, '3초가 지나면 걷기 속도');
  assert(posOf().state === 'walk' && posOf().gait === undefined, '뛰기가 끝나면 상태 walk');
  // 쿨타임: 끝난 순간부터 10초
  r = S.requestGait(room, id, 'run', now);
  assert(!r.ok && r.reason === 'cooldown' && r.cooldownMs.run === GAIT_COOLDOWN_MS - 1000, '쿨타임 중 뛰기 요청은 거절 (남은 9초)');
  near(travel(1000), WALK_SPEED, '거절된 뒤에도 걷기 속도');
  // 예전 방식: move 에 run:true 를 계속 실어 보내도 쿨타임 중에는 걷기
  const legacy = S.setPlayerInput(room, id, { dir: { x: 1, z: 0 }, run: true }, now);
  assert(legacy && !legacy.ok && legacy.reason === 'cooldown', 'move 의 run:true 도 쿨타임 중에는 거절');
  assert(S.setPlayerInput(room, id, { dir: { x: 1, z: 0 }, run: true }, now) === null, 'run:true 를 계속 보내는 것은 새 요청이 아님');
  near(travel(1000), WALK_SPEED, 'run:true 를 실어 보내도 걷기 속도');
  now = runStart + GAIT_ACTIVE_MS + GAIT_COOLDOWN_MS - 1;
  assert(S.requestGait(room, id, 'run', now).reason === 'cooldown', '쿨타임 끝나기 1ms 전에는 거절');
  // 뛰기 쿨타임 중에도 기어가기는 따로 쓸 수 있다
  r = S.requestGait(room, id, 'crawl', now);
  assert(r.ok && r.mode === 'crawl' && r.activeMs === GAIT_ACTIVE_MS, '기어가기 시작');
  const crawlStart = now;
  near(travel(1000), CRAWL_SPEED, '기어가는 1초');
  assert(posOf().state === 'crawl' && posOf().gait === 'crawl', '기어가는 중에는 상태 crawl + gait crawl');
  S.setPlayerInput(room, id, { dir: { x: 0, z: 0 } }, now);
  S.tickRoomPhysics(room, TICK, (now += TICK));
  assert(posOf().state === 'crawl', '멈춰 있어도 기어가기 자세');
  S.setPlayerInput(room, id, { dir: { x: 1, z: 0 } }, now);
  assert(S.requestGait(room, id, 'run', now).reason === 'busy', '기어가는 중에는 뛰기 거절 (쿨타임이 끝났어도)');
  now = crawlStart + GAIT_ACTIVE_MS;
  near(travel(1000), WALK_SPEED, '기어가기도 3초가 지나면 걷기');
  r = S.requestGait(room, id, 'crawl', now);
  assert(!r.ok && r.reason === 'cooldown', '기어가기 쿨타임 중 거절');
  now = crawlStart + GAIT_ACTIVE_MS + GAIT_COOLDOWN_MS;
  assert(S.requestGait(room, id, 'crawl', now).ok, '기어가기: 끝난 뒤 10초가 지나면 다시 가능');
  // 일찍 끄기: 그 순간부터 쿨타임
  now += 500;
  r = S.requestGait(room, id, 'walk', now);
  assert(r.ok && r.mode === null && r.cooldownMs.crawl === GAIT_COOLDOWN_MS, '일찍 끄면 그때부터 쿨타임 10초');
  near(travel(1000), WALK_SPEED, '일찍 끈 뒤 걷기');
  // 뛰기: 쿨타임이 끝났으니 다시 3초
  r = S.requestGait(room, id, 'run', now);
  assert(r.ok, '뛰기: 쿨타임이 끝나면 다시 가능');
  const total = travel(GAIT_ACTIVE_MS + 1000);
  near(total, RUN_SPEED * 3 + WALK_SPEED * 1, '3초 뛰고 1초 걷기 (뛰기 속도를 계속 유지할 수 없음)');
  assert(S.requestGait(room, id, 'fly', now).reason === 'unknown', '모르는 걸음걸이는 거절');
  assert(S.requestGait(room, 'nobody', 'run', now) === null, '없는 참가자');
  log('gait unit checks ok (walk default, run/crawl 3s burst, 10s cooldown after burst, busy/cooldown rejection, forged input clamped)');
}

// ---------------------------------------------------------------------------
// 뛰기·기어가기 규칙 (실제 서버 + 소켓): 넉넉한 여유를 두고 속도 구간만 비교한다.
// ---------------------------------------------------------------------------
async function verifyGaitRules() {
  log('--- run / crawl burst + cooldown (server enforced) ---');
  const gh = new Client('gait-host');
  const gp = new Client('gait-player');
  await Promise.all([gh.ready(), gp.ready()]);
  gh.send('findOrCreateChurch', { name: `검증교회-걸음걸이-${Date.now()}` });
  const church = await gh.waitFor('churchJoined');
  gh.send('createRoom', { pin: TEST_ROOM_PIN, churchId: church.church.id, title: '걸음걸이방', capacity: 'unlimited', questionSeconds: 60 });
  const roomId = (await gh.waitFor('roomCreated')).room.id;
  const id = 'device-gait';
  gp.send('joinRoom', { pin: TEST_ROOM_PIN, roomId, deviceId: id, nickname: '걸음이', avatar: 'circle-blue' });
  await gp.waitFor('joined');
  gh.send('startQuiz', { roomId, questionCount: 1 });
  await gh.waitFor('roomState', (m) => m.room.status === 'question');

  const RUN_MIN = (WALK_SPEED + RUN_SPEED) / 2; // 3.2: 이보다 빠르면 뛰는 중
  const WALK_MAX = WALK_SPEED * 1.3; // 2.86: 걷기는 이보다 느려야 함
  const WALK_MIN = (WALK_SPEED + CRAWL_SPEED) / 2; // 1.6

  const walk = await measureSpeed(gh, roomId, gp, id);
  assert(walk > WALK_MIN && walk < WALK_MAX, `기본은 걷기 속도여야 함 (${walk.toFixed(2)})`);

  // 위조: 방향 크기 40배 + 속도 필드 + (뛰기를 켜지 않은 채) 큰 값
  const forged = await measureSpeed(gh, roomId, gp, id, { dir: { x: 40, z: 0 }, extra: { speed: 99, maxSpeed: 99 } });
  assert(forged < WALK_MAX, `위조한 고속 입력도 걷기 속도를 넘지 못해야 함 (${forged.toFixed(2)})`);

  // 호스트·다른 기기는 기술을 켤 수 없다
  gh.buffer = gh.buffer.filter((m) => m.type !== 'gait');
  gh.send('gait', { roomId, mode: 'run' });
  await sleep(150);
  assert(!gh.buffer.some((m) => m.type === 'gait'), '참가자가 아닌 소켓의 gait 요청은 무시');

  // 뛰기 시작
  const started = await requestGaitOverWire(gp, roomId, 'run');
  const startedAt = Date.now();
  assert(started.ok && started.mode === 'run', '뛰기 요청이 받아들여져야 함');
  assert(started.activeMs > GAIT_ACTIVE_MS - 300 && started.activeMs <= GAIT_ACTIVE_MS, '뛰기 남은 시간 약 3초');
  assert(started.cooldownMs.run === GAIT_COOLDOWN_MS && started.durationMs === GAIT_ACTIVE_MS && started.cooldownTotalMs === GAIT_COOLDOWN_MS, '쿨타임은 끝난 뒤 10초');
  const running = await measureSpeed(gh, roomId, gp, id, {}, 800);
  assert(running > RUN_MIN, `뛰는 동안은 걷기보다 확실히 빨라야 함 (${running.toFixed(2)})`);
  const during = await freshPosition(gh, roomId, id);
  assert(during.gait === 'run', '호스트가 받는 positions 에 뛰는 중(gait: run) 표시가 있어야 함');
  const again = await requestGaitOverWire(gp, roomId, 'run');
  assert(!again.ok && again.reason === 'busy', '뛰는 중 두 번째 뛰기는 거절');

  // 3초가 지난 뒤: run:true 를 계속 실어 보내도 걷기 속도
  await sleep(Math.max(0, startedAt + GAIT_ACTIVE_MS + 250 - Date.now()));
  const after = await measureSpeed(gh, roomId, gp, id, { run: true }, 800);
  assert(after > WALK_MIN && after < WALK_MAX, `뛰기 시간이 끝나면 뛰기 속도를 유지할 수 없어야 함 (${after.toFixed(2)})`);
  const expired = await freshPosition(gh, roomId, id);
  assert(expired.gait === undefined, '뛰기가 끝나면 gait 표시가 없어야 함');
  const denied = await requestGaitOverWire(gp, roomId, 'run');
  assert(!denied.ok && denied.reason === 'cooldown' && denied.mode === null, '쿨타임 중 두 번째 뛰기는 거절');
  assert(denied.cooldownMs.run > GAIT_COOLDOWN_MS - 4000 && denied.cooldownMs.run < GAIT_COOLDOWN_MS, '남은 쿨타임을 알려 줘야 함');
  const stillWalk = await measureSpeed(gh, roomId, gp, id, {}, 600);
  assert(stillWalk < WALK_MAX, `쿨타임 중에는 걷기 (${stillWalk.toFixed(2)})`);

  // 기어가기: 따로 쓸 수 있고, 느리다
  const crawl = await requestGaitOverWire(gp, roomId, 'crawl');
  const crawlAt = Date.now();
  assert(crawl.ok && crawl.mode === 'crawl' && crawl.cooldownMs.run > 0, '기어가기는 뛰기 쿨타임과 따로');
  const crawling = await measureSpeed(gh, roomId, gp, id, {}, 800);
  assert(crawling < WALK_MIN, `기어가는 동안은 걷기보다 느려야 함 (${crawling.toFixed(2)})`);
  const crawlPos = await freshPosition(gh, roomId, id);
  assert(crawlPos.gait === 'crawl' && crawlPos.state === 'crawl', '호스트가 받는 positions 에 기어가는 중 표시');
  await sleep(Math.max(0, crawlAt + GAIT_ACTIVE_MS + 250 - Date.now()));
  const afterCrawl = await measureSpeed(gh, roomId, gp, id, { crawl: true }, 600);
  assert(afterCrawl > WALK_MIN && afterCrawl < WALK_MAX, `기어가기도 3초 뒤에는 걷기로 돌아와야 함 (${afterCrawl.toFixed(2)})`);
  const crawlDenied = await requestGaitOverWire(gp, roomId, 'crawl');
  assert(!crawlDenied.ok && crawlDenied.reason === 'cooldown', '기어가기 쿨타임 중 거절');
  const status = await requestGaitOverWire(gp, roomId, 'status');
  assert(status.mode === null && status.cooldownMs.run > 0 && status.cooldownMs.crawl > 0, '상태 조회는 남은 쿨타임을 알려 줌');

  log(
    `gait over the wire ok: walk=${walk.toFixed(2)} forged=${forged.toFixed(2)} run=${running.toFixed(2)} afterRun=${after.toFixed(2)} ` +
      `crawl=${crawling.toFixed(2)} afterCrawl=${afterCrawl.toFixed(2)}`,
  );
  gp.close();
  gh.close();
}

async function main() {
  verifyRecordsUnit();
  verifyRulesUnit();
  verifyGaitUnit();
  verifyPauseUnit();
  await verifyFloorMarks();
  await verifyQuestionTime();
  verifyQuestionReportsUnit();
  log(`starting server on port ${PORT}...`);
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(ROOT, 'server'),
    env: { ...process.env, PORT: String(PORT), RECORDS_DIR: SERVER_RECORDS_DIR, QUESTION_REVIEW_PASSWORD: 'VerifyReviewOnly1' },
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

    // 빈 검색어(없음·공백·문자열 아님)로는 교회 목록이 나오지 않아야 함 (학생 첫 화면에 다른 교회가 뜨지 않게)
    for (const emptyQuery of ['', '   ', undefined, null, 0]) {
      host.send('searchChurches', { query: emptyQuery });
      const emptyResult = await host.waitFor('churchList');
      assert(emptyResult.churches.length === 0, `빈 검색어(${JSON.stringify(emptyQuery)})에는 교회가 하나도 나오면 안 됨`);
    }

    // 문제 은행 개수: 서버가 실제 데이터 파일에서 센 값(전체·주제별)을 방 만들기 화면에 준다
    {
      const dataDir = path.join(ROOT, 'server', 'data', 'questions');
      const expected = {};
      for (const file of fs.readdirSync(dataDir).filter((f) => f.endsWith('.json'))) {
        for (const q of JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'))) {
          expected[q.level] ??= { total: 0, ...Object.fromEntries(CATEGORIES.map((c) => [c, 0])) };
          expected[q.level].total += 1;
          expected[q.level][q.category] = (expected[q.level][q.category] ?? 0) + 1;
        }
      }
      host.send('getQuestionBank');
      const bankMsg = await host.waitFor('questionBank');
      host.send('listRooms', { churchId });
      const listMsg = await host.waitFor('roomList', (m) => m.churchId === churchId);
      for (const level of ['elementary', 'middle', 'high', 'youth']) {
        const want = expected[level] ?? { total: 0, ...Object.fromEntries(CATEGORIES.map((c) => [c, 0])) };
        assert(want.total >= 25, `${level} 문제 은행은 최소 25문제 이상이어야 함 (지금 ${want.total})`);
        for (const [label, detail] of [['getQuestionBank', bankMsg.questionBankDetail], ['roomList', listMsg.questionBankDetail]]) {
          assert(detail && detail[level], `${label}: ${level} 은행 개수가 있어야 함`);
          assert(detail[level].total === want.total, `${label}: ${level} 전체 수가 데이터 파일과 같아야 함`);
          for (const cat of CATEGORIES) {
            assert(
              (detail[level][cat] ?? 0) === (want[cat] ?? 0),
              `${label}: ${level}/${cat} 개수가 데이터 파일과 같아야 함 (받음 ${detail[level][cat]}, 기대 ${want[cat]})`,
            );
          }
          const catSum = CATEGORIES.reduce((n, c) => n + (detail[level][c] ?? 0), 0);
          assert(catSum === detail[level].total, `${label}: ${level} 주제 합 = 전체`);
        }
        assert(bankMsg.questionBank[level] === want.total, `${level} questionBank(전체 수)도 같은 값이어야 함`);
      }
      // 은행보다 많이 고르면 은행만큼만 나온다
      const smallest = Object.entries(bankMsg.questionBank).sort((a, b) => a[1] - b[1])[0];
      // (다른 검사에 섞이지 않게 따로 연 소켓·교회에서 방을 만든다)
      const bankHost = new Client('bank-host');
      await bankHost.ready();
      bankHost.send('findOrCreateChurch', { name: `은행검증교회-${Date.now()}` });
      const bankChurch = await bankHost.waitFor('churchJoined');
      bankHost.send('createRoom', { churchId: bankChurch.church.id, title: '은행검증방', level: smallest[0], questionCount: smallest[1] + 50 });
      const bankRoom = await bankHost.waitFor('roomCreated');
      assert(bankRoom.room.questionCount === smallest[1], `은행(${smallest[1]})보다 많이 골라도 은행만큼만 나와야 함 (받음 ${bankRoom.room.questionCount})`);
      // 입장 코드 해석: 학생 첫 화면이 쓰는 경로 (코드 → 방 id). 소문자·공백도 같은 방.
      const jc = bankRoom.room.joinCode;
      assert(/^[0-9A-Z]{5}$/.test(jc), '방에는 5자리 입장 코드가 있어야 함');
      p1.send('resolveJoinCode', { code: ` ${jc.toLowerCase()} ` });
      const jr = await p1.waitFor('joinCodeResolved');
      assert(jr.roomId === bankRoom.room.id && jr.code === jc, '입장 코드로 그 방을 찾아야 함');
      // 방 PIN(숫자 4자리)만으로는 방을 찾지 않는다 (전역 PIN 검색 없음)
      p1.send('resolveJoinCode', { code: bankRoom.room.pin });
      const pinOnly = await p1.waitFor('joinCodeResolved');
      assert(pinOnly.roomId === null, '방 PIN만으로는 방을 찾을 수 없어야 함');
      bankHost.close();
      log('question bank counts, empty search, join code resolve OK');
    }

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

    // 플레이어 폰도 지도에 캐릭터를 그릴 수 있도록, 문제 진행 중에는 플레이어 소켓도 positions 를 받아야 함
    for (const [client, id] of [[m1, 'device-m1'], [m2, 'device-m2'], [m3, 'device-m3']]) {
      const playerPositions = await client.waitFor('positions', (m) => m.roomId === roomId2);
      const self = playerPositions.players.find((p) => p.id === id);
      assert(self && typeof self.x === 'number' && typeof self.z === 'number', `${id} 플레이어 소켓이 자기 좌표가 담긴 positions 를 받아야 함`);
      assert(playerPositions.players.length === 3, '플레이어가 받는 positions 에도 방의 모든 플레이어가 들어 있어야 함');
    }
    log('player sockets receive positions during a question');

    // m1은 입력으로 걸어서 정답 구역으로, m2는 오답 구역으로, m3는 가만히 있어서 두 구역 밖에 남음
    await Promise.all([
      moveIntoZone(host2, roomId2, m1, 'device-m1', ZONES[correct1]),
      moveIntoZone(host2, roomId2, m2, 'device-m2', ZONES[wrong1]),
    ]);
    const m1Pos = await freshPosition(host2, roomId2, 'device-m1');
    assert(inZone(m1Pos, ZONES[correct1]), 'm1이 조이스틱 입력으로 이동해서 정답 구역 안에 서 있어야 함');
    const m2Pos = await freshPosition(host2, roomId2, 'device-m2');
    assert(inZone(m2Pos, ZONES[wrong1]), 'm2가 조이스틱 입력으로 이동해서 오답 구역 안에 서 있어야 함');

    const m3Pos = await freshPosition(host2, roomId2, 'device-m3');
    assert(!inZone(m3Pos, ZONES.O) && !inZone(m3Pos, ZONES.X), 'm3는 이동하지 않아 두 구역 모두 밖에 있어야 함');
    log('zone entry via manual move input verified (m1 O/X correct, m2 wrong, m3 outside)');

    // 달리기(run) > 걷기(walk) > 기어가기(crawl) 속도 비교 (m3로 측정, x축만 이동해 구역에는 안 들어감)
    // (예전 방식인 move 의 run/crawl 값도 "기술 요청"으로 받아 준다. 자세한 시간·쿨타임 검사는 verifyGaitRules)
    const walkSpeed = await measureSpeed(host2, roomId2, m3, 'device-m3', {}, 600);
    const runSpeedMeasured = await measureSpeed(host2, roomId2, m3, 'device-m3', { run: true }, 600);
    m3.send('gait', { roomId: roomId2, mode: 'walk' }); // 뛰기를 일찍 끝내야 기어가기를 켤 수 있다
    const crawlSpeedMeasured = await measureSpeed(host2, roomId2, m3, 'device-m3', { crawl: true }, 600);
    m3.send('gait', { roomId: roomId2, mode: 'walk' });
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

    // 7a. 기본(30문제) 게임: 카테고리가 유효하고, 뱅크가 요청한 수보다 작으면 에러 없이
    // 뱅크 전체를 그대로(중복 없이) 다 써야 함. 모두 선택한 level 소속이어야 함.
    // 비성경 주제가 뱅크에 있으면 한 게임에도 적어도 한 문제는 섞여야 함(비율은 뱅크 크기에 따라 유동).
    host4.send('createRoom', { pin: TEST_ROOM_PIN, churchId: church4Id, title: '카테고리방', map: 'sanctuary', capacity: 'unlimited', level: 'elementary' });
    const catRoom = await host4.waitFor('roomCreated');
    const catRoomId = catRoom.room.id;
    assert(catRoom.room.level === 'elementary', '카테고리 검증방의 level이 elementary여야 함');

    const elemPoolSize = QUESTIONS_BY_LEVEL.elementary.length;
    const elemNonBible = QUESTIONS_BY_LEVEL.elementary.filter((q) => q.category !== 'bible').length;
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

    const game1Counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
    for (const q of game1) game1Counts[q.category] += 1;
    log(`question mix (bank size ${elemPoolSize}): ${JSON.stringify(game1Counts)}`);
    if (elemNonBible === 0) {
      assert(game1Counts.bible === game1.length, `뱅크에 비성경 문항이 없으면 전부 성경이어야 하는데 성경 ${game1Counts.bible}/${game1.length}개`);
    } else {
      const mixed = game1.filter((q) => q.category !== 'bible').length;
      assert(mixed >= 1, `뱅크에 비성경 문항이 있으면 게임에 적어도 1개는 섞여야 함 (지금 ${mixed})`);
    }
    log('category presence + mixed topics (or all-bible fallback) + level sourcing + no-repeats-in-game all ok');

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
    // 이미 교사 PIN 으로 연 접속은 장부를 다시 열 때 PIN 을 또 내지 않아도 됨. 인증 안 된 접속은 여전히 거절.
    teacher.buffer = teacher.buffer.filter((m) => m.type !== 'groupData');
    teacher.send('groupOpen', { code: groupCode });
    assert((await teacher.waitFor('groupData')).group.code === opened.group.code, '인증된 접속은 PIN 없이 장부를 다시 열 수 있음');
    await expectError(stranger, 'groupOpen', { code: groupCode }, /PIN/, '인증 안 된 접속이 PIN 없이 장부 열기');
    await expectError(stranger, 'groupAdjust', { code: groupCode, nickname: '블록1', delta: 1, reason: '재시도' }, /PIN 확인/, 'PIN 없는 시도 뒤에도 미인증');

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
    assert(/진행자 비밀번호가 맞지 않아요/.test(wrongHostMsg) && /방 PIN이 아니라/.test(wrongHostMsg) && !/입장 PIN/.test(wrongHostMsg), `방 PIN 으로는 거절: ${wrongHostMsg}`);
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
    // 잠금은 틀린 그 접속(소켓)에만 걸린다: 같은 방이라도 다른 접속은 계속 시도할 수 있다.
    assert((await hostFail(hostPw, { roomId: tRoomId, hostPassword: 'wrong600' })) === wrongHostMsg, '다른 접속은 잠기지 않고 일반 안내를 받음(방 단위 잠금 아님)');
    hostPw.buffer = hostPw.buffer.filter((m) => m.type !== 'roomState' && m.type !== 'error');
    hostPw.send('hostOpenRoom', { roomId: tRoomId, hostPassword: autoHostPw });
    const otherSocketOpened = await hostPw.waitFor('roomState', (m) => m.room.id === tRoomId);
    assert(otherSocketOpened.room.hostPassword === autoHostPw, '한 접속이 잠겨 있어도 다른 접속은 맞는 비밀번호로 진행자 화면을 열 수 있음');
    assert(!hostPw.buffer.some((m) => m.type === 'error'), '다른 접속에는 잠금 오류가 가지 않음');
    assert((await hostFail(pinTester, { roomId: tRoomId, hostPassword: autoHostPw })) === lockMsg, '잠긴 접속은 30초 동안 계속 잠겨 있음');
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

    await verifyGuideFindings();
    await verifyGaitRules();
    await verifyDisplayRemote();
    await verifyClientScreens();
    await verifyQuestionReports();

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

// ---------------------------------------------------------------------------
// 10. 실전 가이드 점검 반영: 문제 수 상한, 4:4 팀 합계·평균, 구역 안 흩어 서기
// ---------------------------------------------------------------------------
async function verifyGuideFindings() {
  log('--- guide findings: question-count cap, 4v4 team totals, zone spread ---');
  const gh = new Client('guide-host');
  await gh.ready();
  gh.send('findOrCreateChurch', { name: `검증교회-가이드-${Date.now()}` });
  const churchId = (await gh.waitFor('churchJoined')).church.id;

  // --- 문제 수는 그 난이도 문제 은행 크기를 넘지 않는다 ---
  gh.send('listRooms', { churchId });
  const bank = (await gh.waitFor('roomList')).questionBank;
  for (const level of LEVELS) {
    const size = QUESTIONS_BY_LEVEL[level].length;
    assert(bank && bank[level] === size, `방 목록 응답에 ${level} 문제 은행 크기(${size})가 있어야 함: ${JSON.stringify(bank)}`);
    gh.send('createRoom', { churchId, title: `상한-${level}`, level, questionCount: 30 });
    const capped = await gh.waitFor('roomCreated', (m) => m.room.title === `상한-${level}`);
    assert(capped.room.questionCount === Math.min(30, size), `${level}: 30문제를 골라도 은행 크기(${size})까지만: ${capped.room.questionCount}`);
    gh.buffer = gh.buffer.filter((m) => m.type !== 'roomState');
    gh.send('startQuiz', { roomId: capped.room.id, questionCount: 999 });
    const started = await gh.waitFor('roomState', (m) => m.room.id === capped.room.id && m.room.status === 'question');
    assert(started.room.question.total === size, `${level}: 시작할 때도 은행 크기(${size})를 넘지 않음: ${started.room.question.total}`);
  }
  gh.send('createRoom', { churchId, title: '상한-작게', level: 'elementary', questionCount: 5 });
  assert((await gh.waitFor('roomCreated', (m) => m.room.title === '상한-작게')).room.questionCount === 5, '은행보다 작은 문제 수는 그대로');

  // --- 4:4 팀 대결: 빨강 5+3+5+5 = 18, 파랑 5+5+5+5 = 20 ---
  const RED = ['믿음', '기쁨', '평화', '충성'];
  const BLUE = ['은혜', '소망', '사랑', '온유'];
  const TARGET = { 기쁨: 3 }; // 나머지는 5점
  const ROUNDS = 5;
  gh.send('createRoom', { pin: TEST_ROOM_PIN, churchId, title: '4대4', capacity: 8, teamMode: true, questionCount: ROUNDS });
  const roomId = (await gh.waitFor('roomCreated', (m) => m.room.title === '4대4')).room.id;
  const kids = [...BLUE, ...RED].map((nickname, i) => ({ nickname, deviceId: `device-guide-${i}`, client: new Client(`guide-${i}`) }));
  await Promise.all(kids.map((k) => k.client.ready()));
  for (const k of kids) {
    k.client.send('joinRoom', { pin: TEST_ROOM_PIN, roomId, deviceId: k.deviceId, nickname: k.nickname, avatar: 's1b0h0' });
    await k.client.waitFor('joined');
  }
  const wanted = Object.fromEntries(kids.map((k) => [k.deviceId, RED.includes(k.nickname) ? 'red' : 'blue']));
  const teamOf = (room) => Object.fromEntries(room.players.map((pl) => [pl.id, pl.teamId]));
  for (const [playerId, teamId] of Object.entries(wanted)) gh.send('assignTeam', { roomId, playerId, teamId });
  const split = await gh.waitFor('roomState', (m) => m.room.id === roomId && m.room.players.length === 8 && JSON.stringify(teamOf(m.room)) === JSON.stringify(wanted));
  assert(split.room.team.teams.map((t) => t.size).join() === '4,4', '4:4 로 나뉘어야 함');

  // 합계 = 그 팀 팀원 점수의 합, 평균 = 합계 ÷ 인원, memberIds = 그 팀원들 — 한 스냅샷 안에서 항상 맞아야 한다.
  const assertStandings = (teams, players, label) => {
    for (const t of teams) {
      const members = players.filter((pl) => pl.teamId === t.id);
      const sum = members.reduce((acc, pl) => acc + pl.score, 0);
      assert(t.size === members.length, `${label} ${t.name}: 인원 ${t.size} ≠ ${members.length}`);
      assert(t.total === sum, `${label} ${t.name}: 합계 ${t.total} ≠ 팀원 점수 합 ${sum} (${members.map((pl) => pl.score).join('+')})`);
      assert(t.average === Math.round((sum / members.length) * 100) / 100, `${label} ${t.name}: 평균 ${t.average} ≠ ${sum}/${members.length}`);
      assert(t.memberIds.slice().sort().join() === members.map((pl) => pl.id).sort().join(), `${label} ${t.name}: memberIds 가 팀원과 달라요`);
    }
  };

  gh.buffer = gh.buffer.filter((m) => m.type !== 'roomState');
  gh.send('startQuiz', { roomId });
  for (let round = 0; round < ROUNDS; round++) {
    const q = await gh.waitFor('roomState', (m) => m.room.id === roomId && m.room.status === 'question' && m.room.question?.index === round);
    assert(q.room.question.total === ROUNDS, `문제 수 ${ROUNDS}`);
    const correct = answerFor(q.room.question.text);
    const choices = kids.map((k) => (round < (TARGET[k.nickname] ?? 5) ? correct : opposite(correct)));
    kids.forEach((k, i) => k.client.send('answer', { roomId, choice: choices[i] }));
    const targets = kids.map((k, i) => ({ deviceId: k.deviceId, zoneBox: ZONES[choices[i]] }));
    assert(await waitUntilAllInZones(gh, roomId, targets, ZONE_ARRIVAL_TIMEOUT_MS), `4대4 ${round + 1}번 문제: 모두 고른 구역에 도착해야 함`);

    // 같은 구역으로 걸어간 친구들은 가운데 한 점에 겹쳐 서지 않고 구역 안에 흩어져 선다.
    let settled = null;
    const settleBy = Date.now() + ZONE_ARRIVAL_TIMEOUT_MS;
    while (Date.now() < settleBy) {
      gh.buffer = gh.buffer.filter((m) => !(m.type === 'positions' && m.roomId === roomId));
      const msg = await gh.waitFor('positions', (m) => m.roomId === roomId);
      if (msg.players.length === 8 && msg.players.every((pl) => pl.state === 'idle')) {
        settled = msg.players;
        break;
      }
    }
    assert(settled, `4대4 ${round + 1}번 문제: 모두 자리에 멈춰 서야 함`);
    let minDist = Infinity;
    for (let i = 0; i < settled.length; i++) {
      const zi = kids.findIndex((k) => k.deviceId === settled[i].id);
      assert(inZone(settled[i], ZONES[choices[zi]]), `${kids[zi].nickname}: 흩어 선 자리도 고른 구역 안이어야 함 ${JSON.stringify(settled[i])}`);
      for (let j = i + 1; j < settled.length; j++) {
        minDist = Math.min(minDist, Math.hypot(settled[i].x - settled[j].x, settled[i].z - settled[j].z));
      }
    }
    assert(minDist >= 0.9, `4대4 ${round + 1}번 문제: 아바타가 겹쳐 서면 안 됨 (가장 가까운 두 명 ${minDist.toFixed(2)})`);
    if (round === 0) {
      // 첫 문제는 8명 모두 같은 구역: 예전에는 전부 구역 한가운데로 갔다.
      const box = ZONES[correct];
      const cx = (box.xmin + box.xmax) / 2;
      const cz = (box.zmin + box.zmax) / 2;
      const nearCenter = settled.filter((pl) => Math.hypot(pl.x - cx, pl.z - cz) < 0.6).length;
      assert(nearCenter <= 1, `8명이 같은 구역일 때 가운데에 몰리면 안 됨 (가운데 ${nearCenter}명)`);
    }

    gh.send('reveal', { roomId });
    const rev = await gh.waitFor('roomState', (m) => m.room.id === roomId && m.room.status === 'reveal' && m.room.question?.index === round);
    assertStandings(rev.room.team.teams, rev.room.players, `게임 중(${round + 1}번 문제)`);
    gh.send('nextQuestion', { roomId });
  }

  const fin = await gh.waitFor('roomState', (m) => m.room.id === roomId && m.room.status === 'finished' && m.room.finalResult);
  const scoreOf = (nick) => fin.room.players.find((pl) => pl.nickname === nick).score;
  assert(RED.map(scoreOf).join('+') === '5+3+5+5' && BLUE.map(scoreOf).join('+') === '5+5+5+5', `개인 점수: 빨강 ${RED.map(scoreOf)} / 파랑 ${BLUE.map(scoreOf)}`);
  const ft = fin.room.finalResult.team;
  assertStandings(ft.teams, fin.room.players, '최종 결과');
  assertStandings(fin.room.team.teams, fin.room.players, '종료 후 팀 현황');
  const red = ft.teams.find((t) => t.id === 'red');
  const blue = ft.teams.find((t) => t.id === 'blue');
  assert(red.total === 18 && red.average === 4.5 && red.size === 4, `빨강 벽돌팀은 합계 18 · 평균 4.5 여야 함(13 아님): ${JSON.stringify(red)}`);
  assert(blue.total === 20 && blue.average === 5 && blue.size === 4, `파랑 얼음팀은 합계 20 · 평균 5 여야 함: ${JSON.stringify(blue)}`);
  assert(ft.winnerTeamIds.join() === 'blue' && ft.loserTeamIds.join() === 'red' && ft.tie === false, `평균이 높은 파랑이 이김: ${JSON.stringify(ft)}`);
  // 학생 화면도 같은 숫자를 받는다
  const pFin = await kids[5].client.waitFor('roomState', (m) => m.room.status === 'finished' && m.room.finalResult);
  const pRed = pFin.room.finalResult.team.teams.find((t) => t.id === 'red');
  assert(pRed.total === 18 && pRed.average === 4.5, `학생 화면의 빨강팀 합계·평균: ${JSON.stringify(pRed)}`);

  // 끝난 뒤 다음 판을 위해 팀을 옮겨도, 이미 끝난 판의 결과(합계 18 / 20)는 바뀌지 않는다.
  const moved = kids.find((k) => k.nickname === '믿음');
  gh.buffer = gh.buffer.filter((m) => m.type !== 'roomState');
  gh.send('assignTeam', { roomId, playerId: moved.deviceId, teamId: 'blue' });
  const after = await gh.waitFor('roomState', (m) => m.room.id === roomId && m.room.players.find((pl) => pl.id === moved.deviceId)?.teamId === 'blue');
  const frozen = after.room.finalResult.team.teams;
  assert(frozen.find((t) => t.id === 'red').total === 18 && frozen.find((t) => t.id === 'blue').total === 20, `끝난 판의 결과는 그대로: ${JSON.stringify(frozen)}`);
  assert(frozen.find((t) => t.id === 'red').memberIds.includes(moved.deviceId), '끝난 판의 팀원 목록도 그대로');
  assertStandings(after.room.team.teams, after.room.players, '팀을 옮긴 뒤 팀 현황');
  assert(after.room.team.teams.find((t) => t.id === 'red').total === 13 && after.room.team.teams.find((t) => t.id === 'red').size === 3, '옮긴 뒤 빨강 현황은 3명 · 합계 13 (5+3+5)');

  for (const k of kids) k.client.close();
  gh.close();
  log('question-count cap per level, 4v4 totals (18 vs 20) + averages, frozen result, zone spread ok');
}

// ---------------------------------------------------------------------------
// 11. 송출 화면(display) · 입장 QR 주소 · 휴대폰 리모컨(remote) · 멈춤 · 내보내기
// ---------------------------------------------------------------------------

// 멈춤 계산은 시각을 직접 넣어 확인한다 (타이밍에 흔들리지 않는다).
function verifyPauseUnit() {
  const church = gameState.findOrCreateChurch(`멈춤단위-${Date.now()}`);
  const room = gameState.createRoom({ churchId: church.id, title: '멈춤', questionSeconds: 10, pin: '1357', hostPassword: 'PauseUnit1' });
  let timeouts = 0;
  gameState.startQuiz(room, 3);
  gameState.advanceQuestion(room, () => { timeouts += 1; });
  const t0 = room.deadline - 10000;
  assert(gameState.resumeQuestion(room, t0 + 1000) === false, '멈추지 않은 문제는 다시 시작할 것이 없음');
  assert(gameState.pauseQuestion(room, t0 + 4000) === true && room.paused && room.deadline === null && room.timer === null, '멈추면 타이머가 꺼짐');
  assert(room.remainingMs === 6000, `4초 지난 뒤 멈추면 6초 남음: ${room.remainingMs}`);
  assert(gameState.pauseQuestion(room, t0 + 9000) === false && room.remainingMs === 6000, '이미 멈춘 문제를 또 멈춰도 남은 시간은 그대로');
  const snap = gameState.serializeRoom(room);
  assert(snap.question.paused === true && snap.question.remainingMs === 6000 && snap.question.deadline === null, '학생 스냅샷에도 멈춤 상태와 남은 시간이 담김');
  assert(gameState.resumeQuestion(room, t0 + 60000) === true && !room.paused && room.deadline === t0 + 66000, '다시 시작하면 남은 6초만 더 셈 (멈춘 시간은 빼지 않음)');
  assert(gameState.serializeRoom(room).question.paused === false, '다시 시작하면 멈춤 표시가 꺼짐');
  // 멈춘 채로 정답 공개 → 멈춤이 풀리고 타이머도 남지 않는다
  gameState.pauseQuestion(room, t0 + 61000);
  gameState.revealAnswer(room);
  assert(room.status === 'reveal' && !room.paused && room.timer === null && room.remainingMs === null, '멈춘 채 공개해도 깨끗하게 공개 상태가 됨');
  // 다음 문제는 멈춤 없이 새 시간으로 시작
  gameState.advanceQuestion(room, () => { timeouts += 1; });
  assert(room.status === 'question' && !room.paused && room.deadline !== null, '다음 문제는 멈춤 없이 시작');
  // 일찍 끝내기: 공개하지 않은 지금 문제는 치지 않는다 (공개한 1문제만 남음)
  assert(gameState.endQuiz(room) === true && room.status === 'finished' && room.questions.length === 1 && room.timer === null, '일찍 끝내면 공개한 문제까지만 침');
  assert(room.finalResult && room.finalResult.totalQuestions === 1, '일찍 끝내도 결과 요약이 생김');
  assert(gameState.endQuiz(room) === false, '이미 끝난 게임은 다시 끝내지 않음');
  assert(timeouts === 0, '멈춤·끝내기 뒤에 남은 타이머가 없어야 함');

  // 첫 정답 공개 전에 끝내도 0점 결과 요약이 있어야 결과 띠·시상대가 비지 않는다
  const r0 = gameState.createRoom({ churchId: church.id, title: '공개전종료', pin: '1357', hostPassword: 'EarlyEnd1' });
  gameState.joinRoom(r0, { deviceId: 'early-a', nickname: '알파', avatar: 'circle-blue' });
  gameState.joinRoom(r0, { deviceId: 'early-b', nickname: '베타', avatar: 'circle-blue' });
  // 시작 위치는 O/X 구역(z 1~6.5) 밖 중립 지대여야 한다 (움직이지 않은 학생이 구역에 있으면 안 됨)
  for (const p of r0.players.values()) {
    const { x, z } = p.motion.pos;
    const inO = x >= ZONES.O.xmin && x <= ZONES.O.xmax && z >= ZONES.O.zmin && z <= ZONES.O.zmax;
    const inX = x >= ZONES.X.xmin && x <= ZONES.X.xmax && z >= ZONES.X.zmin && z <= ZONES.X.zmax;
    assert(!inO && !inX && z > ZONES.O.zmax, `시작 위치는 중립 지대(구역 밖): (${x.toFixed(2)}, ${z.toFixed(2)})`);
  }
  gameState.startQuiz(r0, 3);
  gameState.advanceQuestion(r0, () => {});
  assert(r0.status === 'question', '첫 문제 진행 중');
  assert(gameState.endQuiz(r0) === true && r0.status === 'finished' && r0.questions.length === 0, '공개 전 끝내면 공개한 문제 0개');
  assert(r0.finalResult && r0.finalResult.totalQuestions === 0 && Array.isArray(r0.finalResult.mvpIds) && r0.finalResult.mvpIds.length === 0, '공개 전 끝내도 finalResult(0점)가 생김');
  const earlySnap = gameState.serializeRoom(r0, { view: 'display' });
  assert(earlySnap.status === 'finished' && earlySnap.finalResult && earlySnap.finalResult.totalQuestions === 0 && earlySnap.players.length === 2, '송출 스냅샷에도 0점 결과·참가자가 담김');

  // 스냅샷 보기 권한: 학생 < 송출 화면 < 진행자 < 리모컨
  const r2 = gameState.createRoom({ churchId: church.id, title: '권한', pin: '2460', hostPassword: 'ViewUnit22' });
  gameState.startQuiz(r2, 2);
  gameState.advanceQuestion(r2, () => {});
  const views = Object.fromEntries(['player', 'display', 'host', 'remote'].map((v) => [v, gameState.serializeRoom(r2, { view: v })]));
  assert(!JSON.stringify(views.player).includes('ViewUnit22') && views.player.pin === undefined && views.player.joinPath === undefined, '학생 스냅샷: 방 PIN·진행자 비밀번호·입장 주소 없음');
  assert(!JSON.stringify(views.display).includes('ViewUnit22') && views.display.hostPassword === undefined && views.display.controlKey === undefined, '송출 화면 스냅샷: 진행자 비밀번호·재접속 키 없음');
  assert(views.display.pin === '2460' && views.display.joinPath === `/j/${r2.joinCode}?p=2460`, '송출 화면 스냅샷: 방 PIN 과 입장 주소는 있음');
  assert(views.host.hostPassword === 'ViewUnit22' && views.host.question.answer === undefined, '진행자 화면 스냅샷: 비밀번호는 있고 정답은 없음(큰 화면에 띄워도 안전)');
  assert(['O', 'X'].includes(views.remote.question.answer) && views.remote.question.answer === r2.questions[0].answer, '리모컨 스냅샷에만 지금 문제의 정답이 담김');
  for (const v of ['player', 'display', 'host']) assert(!('answer' in views[v].question), `${v} 스냅샷에는 정답이 없어야 함`);
  assert(gameState.serializeRoom(r2, { forHost: true }).hostPassword === 'ViewUnit22', '예전 forHost 옵션도 그대로 동작');
  gameState.endQuiz(r2);
  // 음악 값 다듬기
  assert(JSON.stringify(gameState.normalizeMusic({ track: 'nope', volume: 7, enabled: 'yes' })) === JSON.stringify({ track: 'upbeat', enabled: true, volume: 1 }), '음악: 모르는 곡은 무시, 소리 크기는 0~1');
  assert(gameState.normalizeMusic({ track: 'march', enabled: false, volume: 0.55 }).track === 'march', '음악: 아는 곡은 반영');
  log('pause/resume math, early end with empty-result finalResult, snapshot views (player < display < host < remote), music normalize ok');
}

// 화면 소스(개인정보 방침·학생 홈·문제은행 개수 표시)가 빠지지 않았는지 점검한다.
// 브라우저를 띄우지 않고 라우트·문구·컴포넌트를 파일에서 확인한다.
// 클라이언트의 순수 계산 파일(client/src/floorMarks.ts)을 그대로 불러온다 (타입만 걷어 낸다).
async function loadClientTs(relPath) {
  const source = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const esbuild = await import('esbuild');
  const { code } = await esbuild.transform(source, { loader: 'ts', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`);
}

// 문제 시간 게이지: 학생·송출·진행자·리모컨이 같은 계산을 쓰고, 기기 시계가 달라도 같은 값이 나오는지.
async function verifyQuestionTime() {
  log('--- question gauge: shared time math / server clock offset ---');
  const qt = await loadClientTs('client/src/questionTime.ts');
  const T = 1_800_000_000_000; // 서버 시계
  const room = (q, extra = {}) => ({ status: 'question', questionDurationMs: 20000, question: { index: 0, total: 5, deadline: null, paused: false, remainingMs: null, ...q }, ...extra });

  // 남은 시간·폭
  const running = room({ deadline: T + 20000 });
  assert(qt.questionLeftMs(running, T) === 20000 && qt.questionLeftPercent(running, T) === 100, '시작 순간에는 100%');
  assert(qt.questionLeftMs(running, T + 5000) === 15000 && qt.questionLeftPercent(running, T + 5000) === 75, '5초 뒤 75% (방의 questionDurationMs 20초 기준)');
  assert(qt.questionLeftPercent(running, T + 25000) === 0 && qt.questionLeftPercent(running, T - 5000) === 100, '폭은 0~100 을 벗어나지 않음');
  assert(qt.questionLeftPercent(room({ deadline: T + 7500 }, { questionDurationMs: undefined }), T) === 50, '길이가 없으면 기본 15초');
  const paused = room({ paused: true, remainingMs: 6000 });
  assert(qt.questionLeftMs(paused, T) === 6000 && qt.questionLeftMs(paused, T + 99999) === 6000, '멈춘 동안에는 시간이 흘러도 남은 시간 그대로');
  assert(qt.questionLeftPercent(paused, T + 99999) === 30, '멈춘 동안 폭 = remainingMs / 총 길이');
  assert(qt.questionLeftMs({ ...running, status: 'reveal' }, T) === 0 && qt.questionLeftMs({ status: 'question', question: null }, T) === 0, '문제 중이 아니면 0');

  // 시계 보정: 기기 시계가 달라도 서버 시계로 본 "지금"이 같다
  qt.resetServerClock();
  assert(qt.serverNowMs(123) === 123 && qt.serverClockOffsetMs() === 0, '표본이 없으면 기기 시계 그대로');
  const devices = [0, 7000, -5000, 3_600_000]; // 기기 시계 - 서버 시계
  const seen = devices.map((skew) => {
    qt.resetServerClock();
    qt.noteServerTime(T, T + skew + 40); // 40ms 걸려 도착
    const clientNow = T + skew + 5000; // 서버 시계로 5초 뒤
    return qt.questionLeftPercent(running, qt.serverNowMs(clientNow));
  });
  assert(seen.every((v) => Math.abs(v - seen[0]) < 1e-9), `시계가 다른 기기들의 게이지가 같음: ${seen.join(', ')}`);
  assert(Math.abs(seen[0] - 75) <= 0.5, `보정한 게이지가 서버 기준(75%)과 0.5%p 이내: ${seen[0]}`);
  const raw = qt.questionLeftPercent(running, T + 7000 + 5000);
  assert(Math.abs(raw - 75) > 30, `보정이 없으면 7초 빠른 폰은 크게 어긋남 (${raw}%)`);

  // 표본 고르기: 지연이 가장 적은 표본을 쓰고, 기기 시계가 바뀌면 다시 맞춘다
  qt.resetServerClock();
  qt.noteServerTime(T, T + 300); // 300ms 늦게 도착
  qt.noteServerTime(T + 1000, T + 1000 + 20); // 20ms 만에 도착 → 더 정확
  assert(qt.serverClockOffsetMs() === -20, '지연이 적은 표본으로 좁혀짐');
  qt.noteServerTime(T + 2000, T + 2000 + 400); // 느린 표본은 무시
  assert(qt.serverClockOffsetMs() === -20, '느리게 온 표본은 보정을 흐트러뜨리지 않음');
  qt.noteServerTime(T + 3000, T + 3000 + 60000); // 기기 시계가 1분 앞으로 바뀜
  assert(qt.serverClockOffsetMs() === -60000, '기기 시계가 크게 바뀌면 새로 맞춤');
  qt.noteServerTime('x', T);
  qt.noteServerTime(undefined, T);
  qt.noteServerTime(NaN, T);
  assert(qt.serverClockOffsetMs() === -60000, '서버 시각이 없는 메시지는 무시');
  qt.resetServerClock();

  // 서버 스냅샷: 모든 보기(view)에 서버 시각이 담기고, 타이머 값 자체는 서버 시계 그대로
  const r = gameState.createRoom({ churchId: gameState.findOrCreateChurch('게이지 검증 교회').id, title: '게이지', questionSeconds: 20 });
  gameState.startQuiz(r);
  gameState.advanceQuestion(r, () => {});
  for (const view of [undefined, 'display', 'host', 'remote']) {
    const before = Date.now();
    const snap = gameState.serializeRoom(r, view ? { view } : undefined);
    assert(typeof snap.serverNow === 'number' && snap.serverNow >= before && snap.serverNow <= Date.now(), `스냅샷(${view ?? 'player'})에 서버 시각이 담김`);
    assert(snap.questionDurationMs === 20000 && snap.question.deadline === r.deadline, '마감 시각·총 길이는 서버 값 그대로');
    assert(Math.abs(qt.questionLeftPercent(snap, snap.serverNow) - 100) < 1, '스냅샷의 서버 시각으로 계산하면 갓 시작한 문제는 100%');
  }
  gameState.pauseQuestion(r);
  const ps = gameState.serializeRoom(r);
  assert(qt.questionLeftMs(ps, ps.serverNow + 50000) === ps.question.remainingMs, '멈춘 스냅샷은 remainingMs 로 고정');
  gameState.clearTimer(r);

  // 화면 소스: 네 화면이 모두 공용 계산을 쓰고, 한쪽만 따로 계산하거나 CSS 로 늦게 따라가지 않는다
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const player = read('client/src/pages/PlayerRoom.tsx');
  assert(player.includes('<QuestionTimerBar') && player.includes('useQuestionClock'), '학생 화면이 공용 게이지·시계를 씀');
  assert(!/deadline\s*\?\?\s*now/.test(player) && !/setInterval\(\(\) => setNow\(Date\.now\(\)\)/.test(player), '학생 화면에 따로 만든 남은 시간 계산이 없음');
  assert(read('client/src/components/RoomStage.tsx').includes('<QuestionTimerBar'), '송출·진행자 문제 띠가 공용 게이지를 씀');
  const bar = read('client/src/components/QuestionTimerBar.tsx');
  assert(bar.includes('questionLeftPercent') && bar.includes('serverNowMs'), '공용 게이지는 서버 시계로 보정한 공용 계산을 씀');
  const remote = read('client/src/pages/RemoteRoom.tsx');
  assert(remote.includes('questionLeftMs') && remote.includes('useQuestionClock'), '리모컨 초 표시도 공용 계산을 씀');
  assert(read('client/src/roomTime.ts').includes('serverNowMs()') && !read('client/src/roomTime.ts').includes('Date.now()'), 'useQuestionClock 은 보정한 시계를 씀');
  assert(read('client/src/ws.ts').includes('noteServerTime(msg.room.serverNow)'), '소켓이 스냅샷의 서버 시각으로 시계를 맞춤');
  const css = read('client/src/index.css');
  const fillRule = css.match(/\.timer-bar-fill\s*\{[^}]*\}/)?.[0] ?? '';
  assert(fillRule && !/transition:\s*width/.test(fillRule), '게이지 막대에 CSS 폭 전환이 없음 (기기마다 늦게 따라가지 않게)');
  log('shared gauge math, pause freeze, clock-skew correction, serverNow in every snapshot view, all screens on shared code ok');
}

// 바닥 O/X 표시·표정·효과음: 구역 상수는 그대로이고, 바닥 표시가 채점 구역과 정확히 겹치는지.
async function verifyFloorMarks() {
  log('--- floor O/X marks / zone constants / reaction checks ---');
  const EXPECTED_ZONES = {
    O: { xmin: -7, xmax: -1.5, zmin: 1, zmax: 6.5 },
    X: { xmin: 1.5, xmax: 7, zmin: 1, zmax: 6.5 },
  };
  const SPAWN_Z = { min: 7, max: 8.5 };
  assert(JSON.stringify(ZONES) === JSON.stringify(EXPECTED_ZONES), `ZONES 상수가 바뀌면 안 됨: ${JSON.stringify(ZONES)}`);
  assert(JSON.stringify(MAP_BOUNDS) === JSON.stringify({ xmin: -8, xmax: 8, zmin: -1, zmax: 9 }), 'MAP_BOUNDS 상수가 바뀌면 안 됨');

  // 스폰: 항상 중립 지대 z 7~8.5, 지도 안, 두 구역 밖
  const church = gameState.findOrCreateChurch(`바닥표시-${Date.now()}`);
  let spawned = 0;
  for (let r = 0; r < 12; r++) {
    const room = gameState.createRoom({ churchId: church.id, title: `바닥표시${r}`, pin: '2468', hostPassword: 'FloorMark1' });
    for (let i = 0; i < 5; i++) gameState.joinRoom(room, { deviceId: `floor-${r}-${i}`, nickname: `바닥${r}${i}`, avatar: 'circle-blue' });
    for (const p of room.players.values()) {
      const { x, z } = p.motion.pos;
      assert(z >= SPAWN_Z.min && z <= SPAWN_Z.max, `스폰 z 는 7~8.5: ${z}`);
      assert(x >= MAP_BOUNDS.xmin && x <= MAP_BOUNDS.xmax, `스폰 x 는 지도 안: ${x}`);
      assert(!inZone({ x, z }, ZONES.O) && !inZone({ x, z }, ZONES.X), '스폰 자리는 O/X 구역 밖');
      spawned += 1;
    }
  }
  assert(spawned === 60, `스폰 검사 인원 (${spawned}명)`);

  // 바닥 타일: 서버 구역 사각형을 빈틈없이, 넘치지 않게 덮는다
  const floor = await loadClientTs('client/src/floorMarks.ts');
  const EPS = 1e-9;
  for (const key of ['O', 'X']) {
    const box = ZONES[key];
    const other = ZONES[key === 'O' ? 'X' : 'O'];
    const tiles = floor.floorTiles(key, box);
    assert(tiles.length === floor.FLOOR_GRID * floor.FLOOR_GRID, `${key} 바닥 칸 수`);
    let area = 0;
    let xmin = Infinity, xmax = -Infinity, zmin = Infinity, zmax = -Infinity;
    for (const t of tiles) {
      const x0 = t.x - t.w / 2, x1 = t.x + t.w / 2, z0 = t.z - t.d / 2, z1 = t.z + t.d / 2;
      assert(x0 >= box.xmin - EPS && x1 <= box.xmax + EPS && z0 >= box.zmin - EPS && z1 <= box.zmax + EPS, `${key} 바닥 칸이 채점 구역 밖으로 나가면 안 됨 (${t.col},${t.row})`);
      assert(z1 <= SPAWN_Z.min - 0.4, `${key} 바닥 칸이 스폰 지대(z 7~8.5)로 넘치면 안 됨`);
      assert(x1 <= other.xmin + EPS || x0 >= other.xmax - EPS, `${key} 바닥 칸이 반대 구역과 겹치면 안 됨`);
      assert(Math.abs(t.x) - t.w / 2 >= 1.5 - EPS, `${key} 바닥 칸이 가운데 담 쪽 간격(x -1.5~1.5)으로 넘치면 안 됨`);
      // 칸 중심에 서 있으면 서버도 그 구역으로 채점해야 한다
      assert(inZone({ x: t.x, z: t.z }, box) && !inZone({ x: t.x, z: t.z }, other), `${key} 바닥 칸 위 = ${key} 채점`);
      area += t.w * t.d;
      xmin = Math.min(xmin, x0); xmax = Math.max(xmax, x1); zmin = Math.min(zmin, z0); zmax = Math.max(zmax, z1);
    }
    const boxArea = (box.xmax - box.xmin) * (box.zmax - box.zmin);
    assert(Math.abs(area - boxArea) < 1e-6, `${key} 바닥 넓이 = 채점 구역 넓이 (${area} vs ${boxArea})`);
    assert(Math.abs(xmin - box.xmin) < EPS && Math.abs(xmax - box.xmax) < EPS && Math.abs(zmin - box.zmin) < EPS && Math.abs(zmax - box.zmax) < EPS, `${key} 바닥 범위 = 채점 구역 범위`);
    const letters = tiles.filter((t) => t.letter);
    assert(letters.length >= 20 && letters.length < tiles.length / 2, `${key} 글자 칸이 크게 그려져야 함 (${letters.length}칸)`);
    // 글자는 좌우·앞뒤 대칭이라 어느 쪽에서 봐도 같은 글자
    const n = floor.FLOOR_GRID - 1;
    for (const t of tiles) {
      assert(floor.isLetterCell(key, n - t.col, t.row) === t.letter && floor.isLetterCell(key, t.col, n - t.row) === t.letter, `${key} 글자 모양은 대칭`);
    }
  }
  const mid = (floor.FLOOR_GRID - 1) / 2;
  assert(floor.isLetterCell('X', mid, mid) === true && floor.isLetterCell('O', mid, mid) === false, 'X 는 가운데가 차 있고 O 는 가운데가 비어 있음');

  // 화면 소스: 바닥 표시는 서버가 보낸 zones 로 그리고, 구역 기본값은 서버 상수와 같아야 한다
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const zoneLiteral = 'O: { xmin: -7, xmax: -1.5, zmin: 1, zmax: 6.5 },\n  X: { xmin: 1.5, xmax: 7, zmin: 1, zmax: 6.5 },';
  const scene = read('client/src/three/HostScene3D.tsx');
  const playerMap = read('client/src/components/PlayerMap.tsx');
  assert(scene.includes(zoneLiteral) && playerMap.includes(zoneLiteral), '화면의 구역 기본값은 서버 ZONES 와 같아야 함');
  assert(/<FloorMark shape=\{key\} box=\{zones\[key\]\}/.test(scene), '3D 무대 바닥 표시는 zones 사각형으로 그려야 함');
  assert(read('client/src/three/FloorMarks.tsx').includes('floorTiles(shape, box)'), '3D 바닥 타일은 floorMarks 계산을 써야 함');
  assert(playerMap.includes('<FloorDecal shape={key} />') && playerMap.includes('left: px(z.xmin)') && playerMap.includes('top: pz(z.zmin)'), '학생 2D 지도도 같은 구역에 바닥 표시를 깔아야 함');
  const stage = read('client/src/components/RoomStage.tsx');
  assert(stage.includes('<FloorDecal shape={key} />') && stage.includes('room.zones'), '2D 대체 화면도 서버 구역에 바닥 표시를 깔아야 함');

  // 표정·반응
  const character = read('client/src/three/VoxelCharacter.tsx');
  assert(/type Expression = 'neutral' \| 'happy' \| 'sad'/.test(character), '표정은 기본·웃음·실망 세 가지');
  assert(character.includes("reveal === 'correct' ? 'happy' : reveal === 'wrong' ? 'sad' : 'neutral'"), '정답이면 웃음, 오답이면 실망, 평소에는 기본 표정');
  const reactionSeconds = Number(/REACTION_SECONDS = ([\d.]+)/.exec(character)?.[1]);
  assert(reactionSeconds >= 2 && reactionSeconds <= 3, `반응 동작은 2~3초 (${reactionSeconds})`);
  assert(read('client/src/three/ResultCanvas3D.tsx').includes('celebrate={column.winner}'), '시상대 우승 캐릭터는 환호 자세');
  const effects = read('client/src/three/RevealEffects.tsx');
  assert(effects.includes('instancedMesh') && /MAX_SPARKS = \d+/.test(effects), '이펙트는 인스턴스 메시 하나 + 개수 상한');

  // 효과음: 직접 합성, 배경 음악 설정(끄기·0)을 따른다
  const musicSrc = read('client/src/music.ts');
  assert(/canPlaySfx\(\): boolean \{\s*return this\.active && this\.prefs\.enabled && this\.prefs\.volume > 0/.test(musicSrc), '효과음은 음악이 꺼져 있거나 소리 크기가 0 이면 나지 않아야 함');
  assert(/playSfx\([^)]*\): boolean \{\s*if \(!this\.canPlaySfx\(\)\) return false;/.test(musicSrc), 'playSfx 는 먼저 음악 설정을 확인해야 함');
  assert(!/new Audio\(|\.(mp3|wav|ogg|m4a)\b|fetch\(|decodeAudioData/.test(musicSrc), '효과음·음악은 외부 음원 파일 없이 합성해야 함');
  const clientFiles = fs.readdirSync(path.join(ROOT, 'client'), { recursive: true }).filter((f) => !String(f).includes('node_modules') && !String(f).startsWith('dist'));
  assert(!clientFiles.some((f) => /\.(mp3|wav|ogg|m4a|glb|gltf|fbx)$/i.test(String(f))), '클라이언트에 외부 음원·3D 에셋 파일이 없어야 함');
  log('zone constants, spawn z 7~8.5, floor tiles == scoring zones (3D + 2D), expressions, synthesized sfx gating ok');
}

async function verifyClientScreens() {
  log('--- privacy / home / question-bank screen checks ---');
  const app = fs.readFileSync(path.join(ROOT, 'client/src/App.tsx'), 'utf8');
  assert(app.includes('path="/privacy"') && app.includes('path="/terms"'), 'App에 /privacy·/terms 라우트가 있어야 함');
  assert(app.includes('path="/review"') && app.includes('<QuestionReview'), 'App에 /review 검토 페이지 라우트가 있어야 함');
  assert(app.includes('path="/"') && app.includes('<PlayerJoin'), 'App 홈(/)은 PlayerJoin이어야 함');

  const legal = fs.readFileSync(path.join(ROOT, 'client/src/pages/Legal.tsx'), 'utf8');
  for (const phrase of [
    '학생은 계정을 만들지 않아요',
    '실명, 전화번호, 이메일, 생일',
    '광고가 없어요',
    '만 14세 미만',
    '문제 신고',
    '베타 기간 무료',
    'CONTACT_EMAIL',
    'CONTACT_MAILTO',
  ]) {
    assert(legal.includes(phrase), `개인정보처리방침·이용안내에 "${phrase}" 문구가 있어야 함`);
  }
  assert(!legal.includes('베타 안내에서 공개'), '문의처가 비어 있다는 문구는 남아 있으면 안 됨');
  assert(legal.includes("tab === 'privacy'") && legal.includes("tab === 'terms'"), '방침·이용안내 탭이 있어야 함');

  const contact = fs.readFileSync(path.join(ROOT, 'client/src/contact.ts'), 'utf8');
  assert(
    contact.includes("CONTACT_EMAIL = 'whiteshoes365@mail.grokbot.com'") && contact.includes('mailto:${CONTACT_EMAIL}'),
    'contact.ts에 공개 문의 이메일·mailto가 있어야 함',
  );

  const footer = fs.readFileSync(path.join(ROOT, 'client/src/components/LegalFooter.tsx'), 'utf8');
  assert(footer.includes('to="/privacy"') && footer.includes('개인정보처리방침'), '바닥글에 방침 링크가 있어야 함');
  assert(footer.includes('CONTACT_MAILTO') && footer.includes('CONTACT_EMAIL'), '바닥글에 문의 mailto 링크가 있어야 함');
  assert(!footer.includes('베타 안내에서 공개'), '바닥글에 문의처 미정 문구가 있으면 안 됨');

  const home = fs.readFileSync(path.join(ROOT, 'client/src/pages/PlayerJoin.tsx'), 'utf8');
  assert(home.includes('방 코드로 입장') && home.includes('id="join-code"'), '학생 홈에 방 코드 입장 카드가 있어야 함');
  assert(home.includes('codePrefill') && home.includes('location.state'), '잘못된 입장 코드 후 입력값이 남도록 prefill을 받아야 함');
  assert(home.includes('LegalFooter') && !/findOrCreateChurch/.test(home), '학생 홈은 방침 링크가 있고 교회를 만들지 않아야 함');

  const joinByCode = fs.readFileSync(path.join(ROOT, 'client/src/pages/JoinByCode.tsx'), 'utf8');
  assert(joinByCode.includes('codePrefill') && joinByCode.includes("navigate('/',"), '입장 실패 시 홈으로 가며 codePrefill을 넘겨야 함');

  const bankNote = fs.readFileSync(path.join(ROOT, 'client/src/components/QuestionBankNote.tsx'), 'utf8');
  assert(bankNote.includes('문제 은행: 전체') && bankNote.includes('CATEGORY_LABELS'), '문제은행 개수 안내에 전체·주제 라벨이 있어야 함');
  assert(bankNote.includes('data-testid="question-bank-note"'), '문제은행 안내 테스트 id가 있어야 함');

  const hostRooms = fs.readFileSync(path.join(ROOT, 'client/src/pages/HostRooms.tsx'), 'utf8');
  const display = fs.readFileSync(path.join(ROOT, 'client/src/pages/DisplayRoom.tsx'), 'utf8');
  assert(hostRooms.includes('QuestionBankNote') && display.includes('QuestionBankNote'), '호스트·송출 방 만들기에 은행 개수 표시가 있어야 함');
  assert(display.includes('display-scroll-hint') && display.includes('waitNeedsScroll'), '송출 시작 화면에 스크롤 안내가 있어야 함');

  const stats = questionBankStats();
  for (const level of LEVELS) {
    assert(stats[level].total >= 25, `화면용 은행 집계: ${level} ≥ 25`);
    const sum = CATEGORIES.reduce((n, c) => n + (stats[level][c] ?? 0), 0);
    assert(sum === stats[level].total, `화면용 은행 집계: ${level} 주제 합 = 전체`);
  }
  log('privacy / home / question-bank screen checks ok');
}

async function verifyDisplayRemote() {
  log('--- display / join QR url / phone remote / pause / kick ---');
  const HOST_PW = 'Remote77'; // 연습용
  const ROOM_PIN = '2468'; // 연습용
  const host = new Client('dr-host');
  const display = new Client('dr-display');
  const remote = new Client('dr-remote');
  const s1 = new Client('dr-student1');
  const s2 = new Client('dr-student2');
  await Promise.all([host, display, remote, s1, s2].map((c) => c.ready()));
  const drain = (c, ...types) => { c.buffer = c.buffer.filter((m) => !types.includes(m.type)); };

  host.send('findOrCreateChurch', { name: `검증교회-송출-${Date.now()}` });
  const churchId = (await host.waitFor('churchJoined')).church.id;
  host.send('createRoom', { churchId, title: '송출방', pin: ROOM_PIN, hostPassword: HOST_PW, questionSeconds: 3, questionCount: 3, music: { track: 'calm', volume: 0.4 } });
  const created = await host.waitFor('roomCreated');
  const roomId = created.room.id;
  const hostKey = created.hostKey;

  // ---- 입장 QR 주소: 짧은 입장 코드 + 방 PIN ----
  const { joinCode, joinPath, joinPathNoPin } = created.room;
  assert(/^[2-9A-HJKMNP-Z]{5}$/.test(joinCode), `입장 코드는 헷갈리지 않는 글자 5자: ${joinCode}`);
  assert(joinPath === `/j/${joinCode}?p=${ROOM_PIN}`, `QR 주소 경로에 입장 코드와 방 PIN 이 들어감: ${joinPath}`);
  assert(joinPathNoPin === `/j/${joinCode}`, `글자로 보여 주는 주소에는 방 PIN 이 없음: ${joinPathNoPin}`);
  assert(!joinPath.includes(HOST_PW) && !joinPath.includes(hostKey), '입장 주소에 진행자 비밀번호·호스트 키가 들어가면 안 됨');
  assert(created.room.music.track === 'calm' && created.room.music.volume === 0.4 && created.room.music.enabled === true, '방 만들 때 고른 음악이 방에 기억됨');
  // 실제 QR 에 들어가는 전체 주소를 클라이언트와 같은 방식(사이트 주소 + # + 경로)으로 만들어 풀어 본다.
  const qrUrl = new URL(`https://church-game.onrender.com/#${joinPath}`);
  const [hashPath, hashQuery] = qrUrl.hash.slice(1).split('?');
  const codeFromUrl = hashPath.split('/')[2];
  const pinFromUrl = new URLSearchParams(hashQuery).get('p');
  assert(hashPath.startsWith('/j/') && codeFromUrl === joinCode && pinFromUrl === ROOM_PIN, `QR 주소에서 입장 코드·방 PIN 을 읽을 수 있음: ${qrUrl.href}`);
  s1.send('resolveJoinCode', { code: codeFromUrl.toLowerCase() });
  const resolved = await s1.waitFor('joinCodeResolved');
  assert(resolved.roomId === roomId && resolved.title === '송출방', '입장 코드(소문자로 쳐도)가 그 방으로 이어짐');
  s1.send('resolveJoinCode', { code: 'ZZZZZ9' });
  assert((await s1.waitFor('joinCodeResolved', (m) => m.code === 'ZZZZZ9')).roomId === null, '없는 입장 코드는 방이 없다고 답함');
  // QR 로 들어온 학생: 주소에 있던 방 PIN 으로 바로 입장
  s1.send('joinRoom', { roomId: resolved.roomId, deviceId: 'dr-s1', nickname: '큐알하나', avatar: 'circle-blue', pin: pinFromUrl });
  const s1Joined = await s1.waitFor('joined');
  assert(s1Joined.room.pin === undefined && s1Joined.room.joinPath === undefined && s1Joined.room.music === undefined, '학생이 받는 방 상태에는 방 PIN·입장 주소·음악이 없음');
  s2.send('joinRoom', { roomId, deviceId: 'dr-s2', nickname: '큐알둘', avatar: 'circle-blue', pin: ROOM_PIN });
  await s2.waitFor('joined');

  // ---- 송출 화면: 키 없이는 못 붙고, 연결 코드로만 붙는다 ----
  display.send('displayOpen', { roomId });
  await display.waitFor('displayAuthRequired', (m) => m.roomId === roomId);
  display.send('displayOpen', { roomId, displayKey: 'guess', hostPassword: HOST_PW });
  await display.waitFor('displayAuthRequired', (m) => m.roomId === roomId);
  assert(!display.buffer.some((m) => m.type === 'roomState'), '확인 안 된 송출 화면에는 방 상태가 가지 않음 (진행자 비밀번호를 보내도 송출 화면은 열리지 않음)');
  display.send('displayPairRequest');
  const pairCode = (await display.waitFor('displayPairCode')).code;
  assert(/^\d{6}$/.test(pairCode), `연결 코드는 숫자 6자리: ${pairCode}`);
  await expectError(s1, 'pairDisplay', { roomId, code: pairCode }, /호스트만/, '학생은 송출 화면을 연결할 수 없음');

  // ---- 리모컨: 진행자 비밀번호로 들어온다 ----
  remote.send('hostOpenRoom', { roomId, as: 'remote' });
  await remote.waitFor('hostAuthRequired', (m) => m.roomId === roomId);
  remote.send('hostOpenRoom', { roomId, as: 'remote', hostPassword: HOST_PW });
  const remoteOpened = await remote.waitFor('roomState', (m) => m.room.id === roomId);
  assert(remoteOpened.room.hostPassword === HOST_PW && remoteOpened.room.pin === ROOM_PIN && typeof remoteOpened.room.controlKey === 'string', '리모컨은 진행자 비밀번호로 열리고 재접속 키를 받음');
  const controlKey = remoteOpened.room.controlKey;
  await host.waitFor('roomState', (m) => m.room.id === roomId && m.room.remoteCount === 1);

  await expectError(remote, 'pairDisplay', { roomId, code: pairCode === '000000' ? '000001' : '000000' }, /연결 코드/, '틀린 연결 코드');
  drain(display, 'roomState');
  remote.send('pairDisplay', { roomId, code: pairCode });
  const paired = await display.waitFor('displayPaired', (m) => m.roomId === roomId);
  await remote.waitFor('displayLinked', (m) => m.roomId === roomId);
  const displayState = await display.waitFor('roomState', (m) => m.room.id === roomId);
  assert(displayState.room.pin === ROOM_PIN && displayState.room.joinPath === joinPath && displayState.room.players.length === 2, '송출 화면이 방 상태(방 PIN·입장 주소·참가자)를 받음');
  assert(!('hostPassword' in displayState.room) && !('controlKey' in displayState.room), '송출 화면이 받는 방 상태에 진행자 비밀번호·재접속 키가 없음');
  await remote.waitFor('roomState', (m) => m.room.id === roomId && m.room.displayCount === 1);
  await host.waitFor('roomState', (m) => m.room.id === roomId && m.room.displayCount === 1 && m.room.remoteCount === 1);
  await expectError(remote, 'pairDisplay', { roomId, code: pairCode }, /연결 코드/, '한 번 쓴 연결 코드는 다시 못 씀');

  // 송출 화면은 진행 명령을 하나도 못 쓴다
  for (const [type, payload] of [
    ['startQuiz', {}],
    ['setHostPassword', { hostPassword: 'Stolen123' }],
    ['kickPlayer', { playerId: 'dr-s1' }],
    ['pause', { paused: true }],
    ['setMusic', { track: 'march' }],
    ['endQuiz', {}],
    ['setDisplayOptions', { showQr: false }],
    ['pairDisplay', { code: '123456' }],
  ]) {
    await expectError(display, type, { roomId, ...payload }, /호스트만/, `송출 화면의 ${type}`);
  }

  // ---- 음악·QR 표시는 리모컨이 정하고 송출 화면이 받는다 ----
  remote.send('setMusic', { roomId, track: 'march', volume: 0.55 });
  const musicOnDisplay = await display.waitFor('roomState', (m) => m.room.music?.track === 'march');
  assert(musicOnDisplay.room.music.volume === 0.55 && musicOnDisplay.room.music.enabled === true, '리모컨이 고른 곡·소리 크기가 송출 화면에 전달됨');
  await host.waitFor('roomState', (m) => m.room.music?.track === 'march' && m.room.music.volume === 0.55);
  remote.send('setMusic', { roomId, enabled: false });
  assert((await display.waitFor('roomState', (m) => m.room.music?.enabled === false)).room.music.track === 'march', '음악 끄기도 전달됨 (곡은 그대로)');
  remote.send('setDisplayOptions', { roomId, showQr: false });
  await display.waitFor('roomState', (m) => m.room.showQr === false);
  remote.send('setDisplayOptions', { roomId, showQr: true });
  await display.waitFor('roomState', (m) => m.room.showQr === true);

  // ---- 리모컨으로 시작 · 멈춤 · 다시 시작 · 공개 · 다음 문제 ----
  for (const c of [host, display, remote, s1, s2]) drain(c, 'roomState');
  remote.send('startQuiz', { roomId });
  const rq0 = await remote.waitFor('roomState', (m) => m.room.status === 'question' && m.room.question.index === 0);
  assert(rq0.room.question.answer === answerFor(rq0.room.question.text), '리모컨은 지금 문제의 정답을 봄');
  const dq0 = await display.waitFor('roomState', (m) => m.room.status === 'question' && m.room.question.index === 0);
  const hq0 = await host.waitFor('roomState', (m) => m.room.status === 'question' && m.room.question.index === 0);
  const sq0 = await s1.waitFor('roomState', (m) => m.room.status === 'question' && m.room.question.index === 0);
  for (const [who, snap] of [['송출 화면', dq0], ['진행자 화면', hq0], ['학생', sq0]]) {
    assert(!('answer' in snap.room.question) && !('explanation' in snap.room.question), `${who}에는 공개 전 정답·해설이 가지 않음`);
  }
  assert(dq0.room.question.text === rq0.room.question.text && sq0.room.question.text === rq0.room.question.text, '모든 화면이 같은 문제를 봄');
  // 진행자·송출·리모컨이 동시에 붙어 있어도 상태(문제 번호·제목·인원·음악)가 같다
  assert(
    hq0.room.question.index === dq0.room.question.index &&
      hq0.room.question.index === rq0.room.question.index &&
      hq0.room.players.length === dq0.room.players.length &&
      hq0.room.players.length === rq0.room.players.length &&
      hq0.room.title === dq0.room.title &&
      hq0.room.music?.track === rq0.room.music?.track &&
      hq0.room.displayCount === 1 &&
      hq0.room.remoteCount === 1 &&
      dq0.room.displayCount === 1 &&
      rq0.room.remoteCount === 1,
    '동시 연결(진행자+송출+리모컨) 상태 일치',
  );
  // 송출 화면도 캐릭터 위치를 받는다 (리모컨은 받지 않는다)
  await display.waitFor('positions', (m) => m.roomId === roomId);
  const status = await remote.waitFor('remoteStatus', (m) => m.roomId === roomId);
  assert(status.zoneCounts.O + status.zoneCounts.X + status.zoneCounts.none === 2, `리모컨 응답 현황은 참가자 수와 맞음: ${JSON.stringify(status.zoneCounts)}`);
  assert(!remote.buffer.some((m) => m.type === 'positions'), '리모컨에는 위치 정보를 보내지 않음');

  await expectError(s1, 'pause', { roomId, paused: true }, /호스트만/, '학생은 멈출 수 없음');
  remote.send('pause', { roomId, paused: true });
  const pausedSnap = await display.waitFor('roomState', (m) => m.room.question?.paused === true);
  assert(pausedSnap.room.status === 'question' && pausedSnap.room.question.deadline === null, '멈추면 마감 시각이 없어짐');
  assert(pausedSnap.room.question.remainingMs > 0 && pausedSnap.room.question.remainingMs <= 3000, `남은 시간이 담김: ${pausedSnap.room.question.remainingMs}`);
  await s1.waitFor('roomState', (m) => m.room.question?.paused === true);
  await host.waitFor('roomState', (m) => m.room.question?.paused === true);
  await remote.waitFor('roomState', (m) => m.room.question?.paused === true);
  // 문제 시간(3초)보다 오래 기다려도 멈춘 동안에는 정답이 공개되지 않는다
  await sleep(3600);
  assert(![display, s1, host, remote].some((c) => c.buffer.some((m) => m.type === 'roomState' && m.room.status === 'reveal')), '멈춘 동안에는 시간이 흘러도 정답이 공개되지 않음');
  const resumeAt = Date.now();
  host.send('pause', { roomId, paused: false }); // 진행자 화면과 리모컨 둘 다 진행할 수 있다
  const resumed = await display.waitFor('roomState', (m) => m.room.status === 'question' && m.room.question.paused === false && m.room.question.deadline !== null);
  const leftAfterResume = resumed.room.question.deadline - resumeAt;
  assert(Math.abs(leftAfterResume - pausedSnap.room.question.remainingMs) < 1000, `다시 시작하면 멈출 때 남은 시간부터 이어짐: 멈출 때 ${pausedSnap.room.question.remainingMs}ms, 다시 시작 후 ${leftAfterResume}ms`);
  // 남은 시간이 지나면 저절로 공개된다
  const autoReveal = await display.waitFor('roomState', (m) => m.room.status === 'reveal' && m.room.question.index === 0, 8000);
  assert(Date.now() - resumeAt >= pausedSnap.room.question.remainingMs - 300, '남은 시간을 다 쓴 뒤에 공개됨');
  assert(autoReveal.room.lastResult.correctAnswer === rq0.room.question.answer, '공개된 정답은 리모컨이 미리 본 정답과 같음');

  remote.send('nextQuestion', { roomId });
  const rq1 = await remote.waitFor('roomState', (m) => m.room.status === 'question' && m.room.question.index === 1);
  assert(rq1.room.question.paused === false && rq1.room.question.deadline !== null, '다음 문제는 멈춤 없이 시작');
  remote.send('reveal', { roomId });
  const rev1 = await display.waitFor('roomState', (m) => m.room.status === 'reveal' && m.room.question.index === 1);
  assert(rev1.room.lastResult.correctAnswer === rq1.room.question.answer, '리모컨의 「정답 공개」가 송출 화면에 반영됨');
  await s1.waitFor('roomState', (m) => m.room.status === 'reveal' && m.room.question.index === 1);

  // ---- 내보내기 ----
  await expectError(s1, 'kickPlayer', { roomId, playerId: 'dr-s2' }, /호스트만/, '학생은 내보낼 수 없음');
  drain(remote, 'roomState');
  remote.send('kickPlayer', { roomId, playerId: 'dr-s2' });
  await s2.waitFor('kicked', (m) => m.roomId === roomId);
  const afterKick = await remote.waitFor('roomState', (m) => m.room.players.length === 1);
  assert(afterKick.room.players[0].id === 'dr-s1' && afterKick.room.kickedCount === 1, '내보낸 친구는 참가자 목록에서 빠짐');
  await display.waitFor('roomState', (m) => m.room.players.length === 1);
  await expectError(s2, 'joinRoom', { roomId, deviceId: 'dr-s2', nickname: '큐알둘', avatar: 'circle-blue', pin: ROOM_PIN }, /내보냈/, '내보낸 기기는 방 PIN 을 알아도 다시 못 들어옴');
  await expectError(remote, 'kickPlayer', { roomId, playerId: 'dr-s2' }, /찾을 수 없/, '없는 참가자 내보내기');
  remote.send('clearKicks', { roomId });
  await remote.waitFor('roomState', (m) => m.room.kickedCount === 0);
  s2.send('joinRoom', { roomId, deviceId: 'dr-s2', nickname: '큐알둘', avatar: 'circle-blue', pin: ROOM_PIN });
  await s2.waitFor('joined');

  // ---- 일찍 끝내고 결과로 ----
  remote.send('endQuiz', { roomId });
  const fin = await display.waitFor('roomState', (m) => m.room.status === 'finished');
  assert(fin.room.finalResult && fin.room.finalResult.totalQuestions === 2, `3문제 중 공개한 2문제까지만 결과에 침: ${JSON.stringify(fin.room.finalResult)}`);
  await s1.waitFor('roomState', (m) => m.room.status === 'finished');

  // ---- 첫 공개 전에 끝내도 송출·리모컨에 결과 요약이 간다 ----
  drain(remote, 'roomState');
  remote.send('startQuiz', { roomId });
  await remote.waitFor('roomState', (m) => m.room.status === 'question');
  drain(display, 'roomState');
  remote.send('endQuiz', { roomId });
  const earlyFin = await display.waitFor('roomState', (m) => m.room.status === 'finished' && m.room.finalResult);
  assert(earlyFin.room.finalResult.totalQuestions === 0 && earlyFin.room.players.length >= 1, '공개 전 끝내도 송출에 0점 finalResult가 감');
  const earlyRemote = await remote.waitFor('roomState', (m) => m.room.status === 'finished' && m.room.finalResult);
  assert(earlyRemote.room.finalResult.totalQuestions === 0, '리모컨에도 0점 finalResult가 감');

  // ---- 재접속: 송출 화면은 송출 키, 리모컨은 재접속 키 ----
  const everythingDisplaySaw = JSON.stringify(display.buffer) + JSON.stringify([displayState, dq0, pausedSnap, resumed, autoReveal, rev1, fin, paired]);
  assert(!everythingDisplaySaw.includes(HOST_PW) && !everythingDisplaySaw.includes(controlKey) && !everythingDisplaySaw.includes(hostKey), '송출 화면이 받은 어떤 메시지에도 진행자 비밀번호·진행 키가 없음');
  display.close();
  await remote.waitFor('roomState', (m) => m.room.displayCount === 0);
  const display2 = new Client('dr-display2');
  const remote2 = new Client('dr-remote2');
  await Promise.all([display2.ready(), remote2.ready()]);
  display2.send('displayOpen', { roomId, displayKey: paired.displayKey });
  await display2.waitFor('displayReady', (m) => m.roomId === roomId);
  const d2 = await display2.waitFor('roomState', (m) => m.room.id === roomId);
  assert(d2.room.status === 'finished' && d2.room.pin === ROOM_PIN && !('hostPassword' in d2.room), '송출 화면을 새로 열어도 송출 키로 상태가 돌아옴 (비밀번호 없이)');
  remote2.send('hostOpenRoom', { roomId, as: 'remote', controlKey });
  const r2 = await remote2.waitFor('roomState', (m) => m.room.id === roomId);
  assert(r2.room.status === 'finished' && r2.room.hostPassword === HOST_PW && r2.room.displayCount === 1, '리모컨을 새로 열어도 재접속 키로 상태가 돌아옴');
  // 진행자 화면이었던 접속이 송출 화면으로 바뀌면 그때부터 진행 권한이 없다
  const hostTurnedDisplay = new Client('dr-host-as-display');
  await hostTurnedDisplay.ready();
  hostTurnedDisplay.send('hostOpenRoom', { roomId, hostKey });
  await hostTurnedDisplay.waitFor('roomState', (m) => m.room.id === roomId && m.room.hostPassword === HOST_PW);
  drain(hostTurnedDisplay, 'roomState');
  hostTurnedDisplay.send('displayOpen', { roomId });
  await hostTurnedDisplay.waitFor('displayReady', (m) => m.roomId === roomId);
  const turned = await hostTurnedDisplay.waitFor('roomState', (m) => m.room.id === roomId);
  assert(!('hostPassword' in turned.room), '송출 화면으로 바꾼 뒤에는 진행자 비밀번호를 받지 않음');
  await expectError(hostTurnedDisplay, 'startQuiz', { roomId }, /호스트만/, '송출 화면으로 바꾼 접속의 시작');
  await sleep(150);
  assert(!hostTurnedDisplay.buffer.some((m) => m.type === 'roomState' && 'hostPassword' in m.room), '송출 화면으로 바꾼 뒤 오는 방 상태에도 비밀번호가 없음');

  // ---- 잠금은 틀린 그 접속에만 ----
  const locked = new Client('dr-locked');
  await locked.ready();
  const tryRemote = async (client, hostPassword) => {
    drain(client, 'error', 'roomState');
    client.send('hostOpenRoom', { roomId, as: 'remote', hostPassword });
    return (await client.waitFor('error')).message;
  };
  for (let n = 1; n <= 4; n++) assert(/맞지 않아요/.test(await tryRemote(locked, `nope${n}000`)), `${n}번째 오답은 일반 안내`);
  const lockMsg = await tryRemote(locked, 'nope5000');
  assert(/여러 번 틀렸어요/.test(lockMsg) && /30초/.test(lockMsg), `5번째 오답에서 그 접속이 잠김: ${lockMsg}`);
  assert((await tryRemote(locked, HOST_PW)) === lockMsg, '잠긴 접속은 맞는 비밀번호도 거절');
  const fresh = new Client('dr-fresh');
  await fresh.ready();
  fresh.send('hostOpenRoom', { roomId, as: 'remote', hostPassword: HOST_PW });
  const freshOpened = await fresh.waitFor('roomState', (m) => m.room.id === roomId);
  assert(freshOpened.room.hostPassword === HOST_PW && !fresh.buffer.some((m) => m.type === 'error'), '한 접속이 잠겨 있어도 다른 접속(다른 휴대폰)은 바로 리모컨을 열 수 있음');
  drain(fresh, 'roomState');
  fresh.send('startQuiz', { roomId });
  await fresh.waitFor('roomState', (m) => m.room.status === 'question');
  fresh.send('endQuiz', { roomId });
  await fresh.waitFor('roomState', (m) => m.room.status === 'finished');

  // ---- 비밀번호를 바꾸면 예전 재접속 키는 더 못 쓴다 ----
  fresh.send('setHostPassword', { roomId, hostPassword: 'Changed88' });
  const changed = await fresh.waitFor('roomState', (m) => m.room.hostPassword === 'Changed88');
  assert(changed.room.controlKey !== controlKey, '진행자 비밀번호를 바꾸면 재접속 키도 바뀜');
  const stale = new Client('dr-stale');
  await stale.ready();
  stale.send('hostOpenRoom', { roomId, as: 'remote', controlKey });
  await stale.waitFor('hostAuthRequired', (m) => m.roomId === roomId);
  assert(!stale.buffer.some((m) => m.type === 'roomState'), '예전 재접속 키로는 방 상태를 받지 못함');
  stale.send('displayOpen', { roomId, controlKey });
  await stale.waitFor('displayAuthRequired', (m) => m.roomId === roomId);

  for (const c of [host, remote, s1, s2, display2, remote2, hostTurnedDisplay, locked, fresh, stale]) c.close();
  log('display attach without host password, pairing code, remote start/pause/reveal/next/kick/end, music relay, per-socket lock, reconnect keys ok');
}


function verifyQuestionReportsUnit() {
  log('--- question report unit ---');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'church-reports-unit-'));
  const prevDir = process.env.RECORDS_DIR;
  const prevPw = process.env.QUESTION_REVIEW_PASSWORD;
  process.env.RECORDS_DIR = dir;
  delete process.env.QUESTION_REVIEW_PASSWORD;
  _resetQuestionReports();
  try {
    assert(REPORT_HIDE_DEVICE_THRESHOLD === 3, '자동 숨김 기준은 기기 3대');
    assert(REPORT_MEMO_MAX === 200, '메모 상한은 200자');
    assert(!reviewPasswordConfigured(), '환경 변수가 없으면 검토 비밀번호가 꺼져 있어야 함');
    assert(!checkReviewPassword('anything'), '꺼진 상태에서는 어떤 비밀번호도 통과하면 안 됨');
    process.env.QUESTION_REVIEW_PASSWORD = 'UnitReviewOnly1';
    assert(reviewPasswordConfigured() && checkReviewPassword('UnitReviewOnly1'), '설정한 검토 비밀번호는 통과');
    assert(!checkReviewPassword('wrong-password') && !checkReviewPassword(''), '틀린·빈 검토 비밀번호는 거절');
    delete process.env.QUESTION_REVIEW_PASSWORD;

    const bank = QUESTIONS_BY_LEVEL.elementary;
    assert(bank.length >= 5, '초등 은행이 숨김 검사에 충분해야 함');
    const qA = bank[0];
    const qB = bank[1];
    const qC = bank[2];

    const first = addQuestionReport({ questionId: qA.id, role: 'student', reason: 'typo', memo: '  맞춤법  ', deviceId: 'device-alpha-001' });
    assert(first.ok && !first.duplicate && !first.hidden, '첫 학생 신고는 저장되고 아직 숨기지 않음');
    const dup = addQuestionReport({ questionId: qA.id, role: 'student', reason: 'ambiguous', memo: '다시', deviceId: 'device-alpha-001' });
    assert(!dup.ok && dup.duplicate, '같은 기기가 같은 문항을 두 번 신고하면 거절');

    let memoThrew = false;
    try {
      addQuestionReport({ questionId: qA.id, role: 'student', reason: 'other', memo: '가'.repeat(REPORT_MEMO_MAX + 1), deviceId: 'device-beta-002' });
    } catch (e) {
      memoThrew = /200자/.test(e.message);
    }
    assert(memoThrew, '메모 상한 초과는 거절');

    addQuestionReport({ questionId: qA.id, role: 'student', reason: 'ambiguous', deviceId: 'device-beta-002' });
    assert(!hiddenQuestionIds().has(qA.id), '학생 2대 신고만으로는 숨기지 않음');
    const third = addQuestionReport({ questionId: qA.id, role: 'student', reason: 'inappropriate', memo: '불편해요', deviceId: 'device-gamma-003' });
    assert(third.ok && third.hidden && hiddenQuestionIds().has(qA.id), '학생 3대 신고면 자동 숨김');

    const pickedHidden = selectQuizQuestions({
      level: 'elementary',
      count: bank.length,
      hiddenIds: hiddenQuestionIds(),
    });
    assert(pickedHidden.length === availableQuestionCount('elementary', hiddenQuestionIds()), '선정 개수 = 숨기지 않은 은행 수');
    assert(!pickedHidden.some((q) => q.id === qA.id), '숨긴 문항은 은행이 모자라도 선정되지 않음');

    const hostRep = addQuestionReport({ questionId: qB.id, role: 'host', reason: 'wrong_answer', memo: '답이 반대', deviceId: 'host-device-001' });
    assert(hostRep.ok && hostRep.hidden && hiddenQuestionIds().has(qB.id), '선생님 1건 신고만으로 숨김');

    const listed = listReviewItems();
    const itemA = listed.items.find((i) => i.questionId === qA.id);
    const itemB = listed.items.find((i) => i.questionId === qB.id);
    assert(itemA && itemA.deviceCount === 3 && itemA.hiddenBy === 'devices' && itemA.hostReported === false, '목록에 3대 기기 숨김이 보임');
    assert(itemB && itemB.hostReported && itemB.hiddenBy === 'host', '목록에 선생님 신고 숨김이 보임');
    assert(itemA.memos.every((m) => !('deviceHash' in m) && !('deviceId' in m) && !('nickname' in m)), '검토 목록 메모에 기기값·닉네임이 없음');

    const rawBeforeKeep = fs.readFileSync(path.join(dir, '_question-reports', 'reports.json'), 'utf8');
    assert(!rawBeforeKeep.includes('device-alpha-001') && !rawBeforeKeep.includes('host-device-001'), '저장 파일에 원문 기기 id가 있으면 안 됨');
    assert(!/"nickname"\s*:/.test(rawBeforeKeep), '저장 파일에 닉네임 칸이 있으면 안 됨');
    assert(rawBeforeKeep.includes(reportDeviceHash(qA.id, 'device-alpha-001')), '변환된 기기값만 저장됨');

    applyReviewAction({ questionId: qA.id, action: 'keep' });

    assert(!hiddenQuestionIds().has(qA.id), '유지하면 숨김이 풀림');
    const pickedAgain = selectQuizQuestions({ level: 'elementary', count: bank.length, hiddenIds: hiddenQuestionIds() });
    assert(pickedAgain.some((q) => q.id === qA.id), '유지 뒤에는 다시 선정될 수 있음');

    applyReviewAction({ questionId: qB.id, action: 'hide' });
    assert(hiddenQuestionIds().has(qB.id), '명시 숨김은 유지됨');
    const stillB = listReviewItems().items.find((i) => i.questionId === qB.id);
    assert(stillB && stillB.reportCount >= 1 && stillB.hiddenBy === 'review', '숨김은 신고를 비우지 않고 검토 숨김으로 남김');

    applyReviewAction({
      questionId: qC.id,
      action: 'suggest',
      suggestion: { text: '다듬은 문제', answer: 'X', note: '정답을 바꿈' },
    });
    const patch = exportReviewPatch();
    assert(patch.kind === 'church-game-question-review-export', '보내기 파일 형식이 맞음');
    assert(patch.suggestions.some((s) => s.id === qC.id && s.changes.text === '다듬은 문제' && s.changes.answer === 'X'), '수정 제안이 보내기 파일에 들어감');
    assert(patch.hidden.some((h) => h.id === qB.id), '숨긴 문항이 보내기 파일에 들어감');
    assert(getQuestionById(qC.id).text !== '다듬은 문제', '제안 저장이 문항 JSON을 직접 바꾸면 안 됨');


    let unknown = false;
    try {
      addQuestionReport({ questionId: 'not-a-real-id', role: 'student', reason: 'typo', deviceId: 'device-omega-009' });
    } catch (e) {
      unknown = /찾을 수 없어요/.test(e.message);
    }
    assert(unknown, '없는 문항 신고는 거절');
  } finally {
    _resetQuestionReports();
    if (prevDir === undefined) delete process.env.RECORDS_DIR;
    else process.env.RECORDS_DIR = prevDir;
    if (prevPw === undefined) delete process.env.QUESTION_REVIEW_PASSWORD;
    else process.env.QUESTION_REVIEW_PASSWORD = prevPw;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  log('question report unit ok');
}

async function verifyQuestionReports() {
  log('--- question report flow / hide rule (server) ---');
  const host = new Client('qr-host');
  const s1 = new Client('qr-s1');
  const admin = new Client('qr-admin');
  const outsider = new Client('qr-outsider');
  await Promise.all([host.ready(), s1.ready(), admin.ready(), outsider.ready()]);

  host.send('findOrCreateChurch', { name: `신고검증교회-${Date.now()}` });
  const church = await host.waitFor('churchJoined');
  const churchId = church.church.id;
  host.send('createRoom', { pin: TEST_ROOM_PIN, churchId, title: '신고검증방', capacity: 4, level: 'elementary', questionCount: 3 });
  const created = await host.waitFor('roomCreated', (m) => m.room && m.room.churchId === churchId);
  const roomId = created.room.id;

  const sid = 'qr-student-device-1';
  s1.send('joinRoom', { pin: TEST_ROOM_PIN, roomId, deviceId: sid, nickname: '신고학생', avatar: 'circle-blue' });
  await s1.waitFor('joined');

  host.send('startQuiz', { roomId, questionCount: 1 });
  const qState = await host.waitFor('roomState', (m) => m.room.status === 'question' && m.room.question);
  const qIndex = qState.room.question.index;
  const qText = qState.room.question.text;
  assert(typeof qIndex === 'number' && qText, '진행자에게 현재 문제가 보여야 함');
  assert(qState.room.prevQuestion == null, '첫 문제에서는 직전 문제가 없어야 함');

  await expectError(
    s1,
    'reportQuestion',
    { roomId, questionIndex: qIndex, reason: 'typo', memo: '아직', deviceId: sid },
    /정답이 공개된 뒤에만/,
    '학생 공개 전 신고',
  );

  host.send('getQuestionBank');
  const bankBefore = await host.waitFor('questionBank');
  const beforeTotal = bankBefore.questionBank.elementary;

  await expectError(
    outsider,
    'reportQuestion',
    { roomId, questionIndex: qIndex, reason: 'typo', deviceId: 'display-device' },
    /이 화면에서는 문제를 신고할 수 없어요/,
    '송출·외부 화면 신고',
  );

  host.send('reveal', { roomId });
  await s1.waitFor('roomState', (m) => m.room.status === 'reveal');

  s1.send('reportQuestion', { roomId, questionIndex: qIndex, reason: 'typo', memo: '맞춤법', deviceId: sid });
  const studentOk = await s1.waitFor('questionReportResult', (m) => m.roomId === roomId);
  assert(studentOk.ok && !studentOk.duplicate, `학생 공개 후 신고 성공: ${JSON.stringify(studentOk)}`);

  s1.send('reportQuestion', { roomId, questionIndex: qIndex, reason: 'ambiguous', deviceId: sid });
  const studentDup = await s1.waitFor('questionReportResult', (m) => m.roomId === roomId && m.duplicate);
  assert(!studentDup.ok && studentDup.duplicate, '같은 학생 기기 중복 신고는 거절');

  await expectError(
    s1,
    'reportQuestion',
    { roomId, questionIndex: qIndex, reason: 'other', memo: '나'.repeat(201), deviceId: sid },
    /200자/,
    '메모 상한 초과',
  );

  await expectError(admin, 'reviewList', {}, /검토 비밀번호 확인이 필요/, '로그인 전 검토 목록');
  await expectError(admin, 'reviewLogin', { password: 'wrong-password' }, /맞지 않아요/, '틀린 검토 비밀번호');
  await expectError(admin, 'reviewAction', { questionId: 'x', action: 'keep' }, /검토 비밀번호 확인이 필요/, '로그인 전 검토 동작');

  admin.send('reviewLogin', { password: 'VerifyReviewOnly1' });
  const loggedIn = await admin.waitFor('reviewData', (m) => m.review && Array.isArray(m.review.items));
  assert(loggedIn.review.items.some((i) => i.question && i.question.text === qText), '검토 목록에 신고한 문항이 묶여 보여야 함');

  const hostId = 'qr-host-device-1';
  host.send('reportQuestion', { roomId, questionIndex: qIndex, reason: 'wrong_answer', memo: '답이 이상해요', deviceId: hostId });
  const hostOk = await host.waitFor('questionReportResult', (m) => m.roomId === roomId);
  assert(hostOk.ok, '선생님 신고 성공');

  host.send('getQuestionBank');
  const bankHidden = await host.waitFor('questionBank');
  assert(bankHidden.questionBank.elementary === beforeTotal - 1, `선생님 신고 후 은행이 1 줄어야 함: ${beforeTotal} -> ${bankHidden.questionBank.elementary}`);

  admin.send('reviewList');
  const listed = await admin.waitFor('reviewData', (m) => m.review.items.some((i) => i.question && i.question.text === qText && i.hidden));
  const item = listed.review.items.find((i) => i.question && i.question.text === qText);
  assert(item.hostReported && item.hidden, '선생님 신고 후 숨김으로 표시');
  const questionId = item.questionId;
  assert(!JSON.stringify(item).includes(sid) && !JSON.stringify(item).includes('신고학생'), '검토 데이터에 원문 기기 id·닉네임이 없음');

  admin.send('reviewAction', { questionId, action: 'keep' });
  await admin.waitFor('reviewData', (m) => m.done && m.done.action === 'keep');
  host.send('getQuestionBank');
  const bankKept = await host.waitFor('questionBank');
  assert(bankKept.questionBank.elementary === beforeTotal, `유지 후 은행이 원래 수로 돌아와야 함: ${bankKept.questionBank.elementary}`);

  admin.send('reviewAction', { questionId, action: 'hide' });
  await admin.waitFor('reviewData', (m) => m.done && m.done.action === 'hide');
  host.send('getQuestionBank');
  const bankExplicit = await host.waitFor('questionBank');
  assert(bankExplicit.questionBank.elementary === beforeTotal - 1, '명시 숨김 후 새 방 은행에서 빠짐');

  admin.send('reviewAction', { questionId, action: 'suggest', suggestion: { note: '나중에 고칠 문제', text: qText } });
  await admin.waitFor('reviewData', (m) => m.done && m.done.action === 'suggest');
  admin.send('reviewExport');
  const exported = await admin.waitFor('reviewExport');
  assert(exported.export && exported.export.suggestions.some((s) => s.id === questionId), '보내기 파일에 수정 제안이 들어감');
  assert(exported.export.hidden.some((h) => h.id === questionId), '보내기 파일에 숨긴 문항이 들어감');

  // leave the item hidden? hide would affect later tests in this same server if they create elementary rooms with large counts.
  // Other tests usually use questionCount 1-3 and exclude is soft except hidden is hard. Hiding one elementary question
  // should be fine (bank still >> 3). Keep it hidden or keep() to be safe for bank-size assertions elsewhere.
  // verifyClientScreens already ran (questionBankStats() is in-process full bank, not hidden).
  // Remaining tests? This is last in main after client screens. Safe either way.
  admin.send('reviewAction', { questionId, action: 'keep' });
  await admin.waitFor('reviewData', (m) => m.done && m.done.action === 'keep');

  for (const c of [host, s1, admin, outsider]) c.close();
  log('question report flow / hide rule ok');
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
