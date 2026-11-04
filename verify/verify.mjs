import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import WebSocket from 'ws';
import { QUESTIONS_BY_LEVEL, LEVELS, DEFAULT_LEVEL, CATEGORIES, DEFAULT_QUESTION_COUNT } from '../server/src/questions.js';
import { ZONES, MAP_BOUNDS, WALK_SPEED, RUN_SPEED, CRAWL_SPEED } from '../server/src/state.js';

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

async function waitUntilInZone(host, roomId, deviceId, zoneBox, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const pos = await freshPosition(host, roomId, deviceId);
    if (inZone(pos, zoneBox)) return true;
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

async function main() {
  log(`starting server on port ${PORT}...`);
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(ROOT, 'server'),
    env: { ...process.env, PORT: String(PORT) },
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
      // 서 있는 구역으로 이뤄지므로, 공개하기 전에 각자 자기 구역에 도착할 때까지 기다림
      const arrived = await Promise.all(
        players.map((p, i) => waitUntilInZone(host, roomId, p.deviceId, ZONES[choices[i]], 5000)),
      );
      assert(arrived.every(Boolean), '모든 플레이어가 OX 버튼 자동 이동으로 선택한 구역에 도착해야 함');

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

    // 7. 카테고리 혼합(성경/상식/넌센스), 최근 출제 회피, 주간 문항 검증 스크립트
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

    // 7a. 기본(30문제) 게임: 카테고리가 모두 채워져 있고, 비율이 대략 70/20/10(정확히
    // 21/6/3)에 맞고, 모두 선택한 level 소속이며, 한 게임 안에서 중복이 없어야 함.
    host4.send('createRoom', { churchId: church4Id, title: '카테고리방', map: 'sanctuary', capacity: 'unlimited', level: 'elementary' });
    const catRoom = await host4.waitFor('roomCreated');
    const catRoomId = catRoom.room.id;
    assert(catRoom.room.level === 'elementary', '카테고리 검증방의 level이 elementary여야 함');

    const game1 = await playFullGame(host4, catRoomId); // questionCount 생략 -> 기본값
    assert(game1.length === DEFAULT_QUESTION_COUNT, `기본 문제 수는 ${DEFAULT_QUESTION_COUNT}개여야 하는데 ${game1.length}개`);
    assert(
      game1.every((q) => q.category && CATEGORIES.includes(q.category)),
      '모든 문제의 snapshot에 유효한 category가 있어야 함',
    );
    const elemTexts = new Set(QUESTIONS_BY_LEVEL.elementary.map((q) => q.text));
    assert(game1.every((q) => elemTexts.has(q.text)), '출제된 모든 문제가 선택한 level(elementary)의 문제 세트에 속해야 함');
    const game1Texts = game1.map((q) => q.text);
    assert(new Set(game1Texts).size === game1Texts.length, '한 게임 안에서 같은 문제가 중복 출제되면 안 됨');

    const game1Counts = { bible: 0, general: 0, nonsense: 0 };
    for (const q of game1) game1Counts[q.category] += 1;
    log(`30-question mix: ${JSON.stringify(game1Counts)}`);
    assert(game1Counts.bible === 21, `30문제 중 성경(bible)은 21개여야 하는데 ${game1Counts.bible}개`);
    assert(game1Counts.general === 6, `30문제 중 상식(general)은 6개여야 하는데 ${game1Counts.general}개`);
    assert(game1Counts.nonsense === 3, `30문제 중 넌센스(nonsense)는 3개여야 하는데 ${game1Counts.nonsense}개`);
    log('category presence + 70/20/10 mixing ratio + level sourcing + no-repeats-in-game all ok');

    // 7b. 같은 교회에서 연속으로 게임을 돌리면, 문제 뱅크가 허락하는 한(이번 경우 성경
    // 문제 풀 30개 중 7+7=14개만 쓰므로 충분히 허락됨) 최근에 나온 문제를 피해서 출제해야 함.
    host4.send('createRoom', { churchId: church4Id, title: '최근출제회피방', map: 'sanctuary', capacity: 'unlimited', level: 'middle' });
    const recentRoom = await host4.waitFor('roomCreated');
    const recentRoomId = recentRoom.room.id;

    const recentGame1 = await playFullGame(host4, recentRoomId, 10);
    const recentGame2 = await playFullGame(host4, recentRoomId, 10);
    const bibleTexts1 = new Set(recentGame1.filter((q) => q.category === 'bible').map((q) => q.text));
    const bibleTexts2 = new Set(recentGame2.filter((q) => q.category === 'bible').map((q) => q.text));
    const overlap = [...bibleTexts1].filter((t) => bibleTexts2.has(t));
    assert(
      overlap.length === 0,
      `문제 뱅크가 충분한 상황(성경 30개 중 7+7=14개만 사용)에서는 같은 교회의 연속된 두 게임 사이에 겹치는 성경 문제가 없어야 하는데 겹침: ${JSON.stringify(overlap)}`,
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

    const exampleWeekFileBefore = fs.existsSync(path.join(ROOT, 'server/data/questions/2026-46.json'));
    const exampleResult = spawnSync(process.execPath, [addWeekScript, exampleWeekPath, '--dry-run'], { cwd: ROOT, encoding: 'utf-8' });
    assert(exampleResult.status === 0, `add-week.mjs는 docs/example-week.json을 dry-run으로 통과시켜야 하는데 종료 코드 ${exampleResult.status}\n${exampleResult.stdout}\n${exampleResult.stderr}`);
    const exampleWeekFileAfter = fs.existsSync(path.join(ROOT, 'server/data/questions/2026-46.json'));
    assert(exampleWeekFileAfter === exampleWeekFileBefore, 'add-week.mjs --dry-run은 실제 파일을 쓰면 안 됨');
    log('add-week.mjs accepts docs/example-week.json in --dry-run mode without writing ok');

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
