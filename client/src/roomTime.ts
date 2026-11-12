import { useEffect, useState } from 'react';
import type { RoomSnapshot } from './protocol';

export const DEFAULT_QUESTION_DURATION_MS = 15000;

/** 지금 문제에 남은 시간(ms). 멈춘 동안에는 멈춘 순간의 남은 시간 그대로. */
export function questionLeftMs(room: RoomSnapshot, now: number): number {
  const q = room.question;
  if (!q || room.status !== 'question') return 0;
  if (q.paused) return Math.max(0, q.remainingMs ?? 0);
  return Math.max(0, (q.deadline ?? now) - now);
}

/** 타이머 막대 폭(0~100). */
export function questionLeftPercent(room: RoomSnapshot, now: number): number {
  const total = room.questionDurationMs ?? DEFAULT_QUESTION_DURATION_MS;
  return Math.max(0, Math.min(100, (questionLeftMs(room, now) / total) * 100));
}

/** 문제가 진행 중일 때만 150ms 마다 갱신되는 현재 시각 (멈춘 동안에는 돌지 않는다). */
export function useQuestionClock(room: RoomSnapshot | null): number {
  const [now, setNow] = useState(() => Date.now());
  const ticking = room?.status === 'question' && !room.question?.paused;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 150);
    return () => clearInterval(id);
  }, [ticking, room?.question?.index, room?.question?.deadline]);
  return now;
}
