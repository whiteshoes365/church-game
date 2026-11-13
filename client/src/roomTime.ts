import { useEffect, useState } from 'react';
import type { RoomSnapshot } from './protocol';
import { serverNowMs } from './questionTime';

export { DEFAULT_QUESTION_DURATION_MS, questionLeftMs, questionLeftPercent, serverNowMs } from './questionTime';

/**
 * 문제가 진행 중일 때만 150ms 마다 갱신되는 "서버 시계 기준" 현재 시각 (멈춘 동안에는 돌지 않는다).
 * 초 표시처럼 글자로 보여 줄 때 쓴다. 게이지 막대는 QuestionTimerBar 가 매 프레임 직접 그린다.
 */
export function useQuestionClock(room: RoomSnapshot | null): number {
  const [now, setNow] = useState(() => serverNowMs());
  const ticking = room?.status === 'question' && !room.question?.paused;
  useEffect(() => {
    if (!ticking) return;
    setNow(serverNowMs());
    const id = setInterval(() => setNow(serverNowMs()), 150);
    return () => clearInterval(id);
  }, [ticking, room?.question?.index, room?.question?.deadline]);
  return now;
}
