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

async function main() {
  verifyRecordsUnit();
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
    host.send('createRoom', { churchId, title: '검증방', map: 'sanctuary', capacity: 4 });
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
      p.client.send('joinRoom', { roomId, deviceId: p.deviceId, nickname: p.nickname, avatar: p.avatar });
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

    host2.send('createRoom', {
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
      p.client.send('joinRoom', { roomId: roomId2, deviceId: p.deviceId, nickname: p.nickname, avatar: 'circle-blue' });
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
    host3.send('createRoom', { churchId: church3Id, title: '기본난이도방', map: 'sanctuary', capacity: 4 });
    const defaultRoom = await host3.waitFor('roomCreated');
    assert(defaultRoom.room.level === 'elementary', `level을 지정하지 않으면 기본값 'elementary'여야 하는데 '${defaultRoom.room.level}'`);
    assert(defaultRoom.room.level === DEFAULT_LEVEL, 'questions.js의 DEFAULT_LEVEL과 일치해야 함');
    log(`default level ok: ${defaultRoom.room.level}`);

    host3.send('listRooms', { churchId: church3Id });
    const listAfterDefault = await host3.waitFor('roomList');
    const defaultSummary = listAfterDefault.rooms.find((r) => r.id === defaultRoom.room.id);
    assert(defaultSummary && defaultSummary.level === 'elementary', '방 목록 요약(summary)에도 level이 포함되어야 함');

    // 6b. 유효하지 않은 level은 기본값(elementary)으로 대체되어야 함 (에러 없이)
    host3.send('createRoom', { churchId: church3Id, title: '이상한난이도방', map: 'sanctuary', capacity: 4, level: 'not-a-real-level' });
    const invalidLevelRoom = await host3.waitFor('roomCreated');
    assert(invalidLevelRoom.room.level === DEFAULT_LEVEL, `잘못된 level은 '${DEFAULT_LEVEL}'로 대체되어야 하는데 '${invalidLevelRoom.room.level}'`);
    log('invalid level falls back to elementary ok');

    // 6c. 각 level로 방을 만들면 그 level이 snapshot과 방 목록에 그대로 반영되어야 함
    const levelRoomIds = {};
    for (const level of LEVELS) {
      host3.send('createRoom', { churchId: church3Id, title: `${level}방`, map: 'sanctuary', capacity: 'unlimited', level });
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
    lp.send('joinRoom', { roomId: levelRoomIds.middle, deviceId: 'device-level-player', nickname: '레벨확인' });
    await lp.waitFor('joined');
    await host3.waitFor('roomState', (msg) => msg.room.id === levelRoomIds.middle && msg.room.players.length === 1);

    for (const level of ['middle', 'youth']) {
      const roomId = levelRoomIds[level];
      const levelTexts = new Set(QUESTIONS_BY_LEVEL[level].map((q) => q.text));
      const otherLevelTexts = new Set(
        LEVELS.filter((l) => l !== level).flatMap((l) => QUESTIONS_BY_LEVEL[l].map((q) => q.text)),
      );
      if (level !== 'middle') {
        lp.send('joinRoom', { roomId, deviceId: 'device-level-player', nickname: '레벨확인' });
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
    host4.send('createRoom', { churchId: church4Id, title: '카테고리방', map: 'sanctuary', capacity: 'unlimited', level: 'elementary' });
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
    host4.send('createRoom', { churchId: church4Id, title: '최근출제회피방', map: 'sanctuary', capacity: 'unlimited', level: 'middle' });
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
    teacher.send('createRoom', { churchId: tChurch.church.id, title: '팀대결방', capacity: 8, groupCode, groupPin: PIN, teamMode: true });
    const tRoomCreated = await teacher.waitFor('roomCreated');
    const tRoomId = tRoomCreated.room.id;
    assert(tRoomCreated.room.groupCode === opened.group.code, '방이 반에 연결되어야 함');
    assert(tRoomCreated.room.team.enabled && tRoomCreated.room.team.teams.length === 2, '팀 대결(2팀)이 켜져 있어야 함');
    assert(tRoomCreated.room.team.bonus === 2, '승리 보너스 기본값은 2');

    // 틀린 PIN 으로는 다른 방을 이 반에 연결할 수 없음
    stranger.send('createRoom', { churchId: tChurch.church.id, title: '몰래방', groupCode, groupPin: '1111' });
    const sneaky = await stranger.waitFor('roomCreated');
    assert(sneaky.room.groupCode === null, '틀린 PIN 으로 만든 방은 반에 연결되면 안 됨');
    // 호스트가 아닌 소켓은 팀 설정 불가
    await expectError(stranger, 'setTeamMode', { roomId: tRoomId, enabled: false }, /호스트만/, '호스트 아닌 팀 설정');

    // 입장 = 출석. 닉네임 단위로만 기록됨
    for (const p of tp) {
      p.client.send('joinRoom', { roomId: tRoomId, deviceId: p.deviceId, nickname: p.nickname, avatar: p.avatar });
      const j = await p.client.waitFor('joined');
      assert(j.attendance && j.attendance.newlyMarked && j.attendance.week === currentWeek && j.attendance.streak === 1, `${p.nickname} 입장 시 출석이 기록되어야 함`);
    }
    let g = await latestGroup(teacher, (x) => x.members.length === 4);
    assert(g.members.every((m) => m.presentThisWeek && m.attendedWeeks.includes(currentWeek) && m.attendCount === 1), '4명 모두 이번 주 출석');
    assert(g.weeks.at(-1).id === currentWeek && g.weeks.at(-1).presentCount === 4, '주별 기록의 이번 주 출석 인원 4');
    assert(Object.keys(g.members[0]).every((k) => !/name$|phone|birth/i.test(k) || k === 'nickname'), '닉네임 외 개인정보 필드가 없어야 함');
    // 같은 주 재입장은 출석 1회 그대로
    tp[0].client.send('joinRoom', { roomId: tRoomId, deviceId: tp[0].deviceId, nickname: tp[0].nickname, avatar: tp[0].avatar });
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
    // 공동 우승이면 두 팀 모두 보너스: 참가1 + 1등3 + 팀3 = 7
    assert(tie.room.finalResult.awards.every((a) => a.delta === 7), '공동 우승 팀원 모두 보너스');

    // 서버가 실제로 파일에 저장했는지 (임시 폴더, 원자적 쓰기라 .tmp 가 남지 않음)
    const recFiles = fs.readdirSync(SERVER_RECORDS_DIR);
    assert(recFiles.length === 1 && recFiles[0].endsWith('.json'), `반 기록 파일: ${recFiles}`);
    const saved = JSON.parse(fs.readFileSync(path.join(SERVER_RECORDS_DIR, recFiles[0]), 'utf8'));
    assert(saved.games.length === 2 && saved.pinHash && !JSON.stringify(saved).includes(`"${PIN}"`), '파일에 게임 2판 저장, PIN 평문 없음');
    log('attendance, talent auto-award + manual adjust, team split + winner/loser + bonus ok');

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
