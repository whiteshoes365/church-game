// 문제 시간 계산(순수 함수)과 서버-기기 시계 보정.
// 학생 폰·송출 PC·진행자 화면·리모컨이 모두 이 파일의 같은 함수로 남은 시간을 구한다.
// React 를 쓰지 않는다 (verify 가 이 파일을 그대로 불러와 검사한다).
import type { RoomSnapshot } from './protocol';

export const DEFAULT_QUESTION_DURATION_MS = 15000;

type TimedRoom = Pick<RoomSnapshot, 'status' | 'question' | 'questionDurationMs'>;

// ---- 서버 시계 보정 --------------------------------------------------------
// 마감 시각(deadline)은 서버 시계 기준이다. 기기 시계가 서버와 다르면 그만큼 게이지가 어긋나므로,
// 스냅샷에 담겨 오는 서버 시각(serverNow)으로 "서버 시계 - 내 시계" 차이를 기억해 둔다.
// 표본 = serverNow - 받은 시각 = (진짜 차이) - (전송 지연) 이므로, 가장 큰 표본이 지연이 가장 적은 표본이다.
const CLOCK_JUMP_MS = 1500; // 이보다 크게 뒤로 가면 기기 시계가 바뀐 것으로 보고 새로 맞춘다

let offsetMs = 0;
let hasSample = false;

/** 서버가 보낸 시각을 받은 순간에 부른다. */
export function noteServerTime(serverNow: unknown, clientNow: number = Date.now()): void {
  if (typeof serverNow !== 'number' || !Number.isFinite(serverNow)) return;
  const sample = serverNow - clientNow;
  if (!hasSample || sample > offsetMs || offsetMs - sample > CLOCK_JUMP_MS) {
    offsetMs = sample;
    hasSample = true;
  }
}

/** 서버 시계로 본 지금 시각. 표본이 아직 없으면 기기 시계 그대로. */
export function serverNowMs(clientNow: number = Date.now()): number {
  return clientNow + offsetMs;
}

export function serverClockOffsetMs(): number {
  return offsetMs;
}

export function resetServerClock(): void {
  offsetMs = 0;
  hasSample = false;
}

// ---- 남은 시간 -------------------------------------------------------------

/** 지금 문제에 남은 시간(ms). now 는 서버 시계 기준(serverNowMs()). 멈춘 동안에는 멈춘 순간의 남은 시간 그대로. */
export function questionLeftMs(room: TimedRoom, now: number): number {
  const q = room.question;
  if (!q || room.status !== 'question') return 0;
  if (q.paused) return Math.max(0, q.remainingMs ?? 0);
  return Math.max(0, (q.deadline ?? now) - now);
}

/** 타이머 막대 폭(0~100). 총 길이는 방마다 정해진 questionDurationMs. */
export function questionLeftPercent(room: TimedRoom, now: number): number {
  const total = room.questionDurationMs || DEFAULT_QUESTION_DURATION_MS;
  return Math.max(0, Math.min(100, (questionLeftMs(room, now) / total) * 100));
}
