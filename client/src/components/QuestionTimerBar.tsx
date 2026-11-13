import { useEffect, useRef } from 'react';
import type { RoomSnapshot } from '../protocol';
import { questionLeftPercent, serverNowMs } from '../questionTime';

/**
 * 문제 시간 게이지. 학생 폰·송출 PC·진행자 화면이 모두 이 컴포넌트를 쓴다.
 * 매 프레임 "서버 마감 시각 - 보정한 지금"으로 폭을 직접 정한다 (CSS 전환 없음).
 * 그래서 어느 기기든 같은 순간에는 같은 폭이 된다. 멈춘 동안에는 남은 시간에서 멈춰 있다.
 */
export function QuestionTimerBar({ room }: { room: RoomSnapshot }) {
  const fillRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef(room);
  roomRef.current = room;
  const ticking = room.status === 'question' && !room.question?.paused;

  useEffect(() => {
    const paint = () => {
      const el = fillRef.current;
      if (!el) return;
      const pct = questionLeftPercent(roomRef.current, serverNowMs());
      el.style.width = `${pct.toFixed(2)}%`;
      el.dataset.percent = pct.toFixed(2);
    };
    paint();
    if (!ticking) return;
    let raf = requestAnimationFrame(function loop() {
      paint();
      raf = requestAnimationFrame(loop);
    });
    // 탭이 가려져 rAF 가 멈췄다가 돌아와도 바로 맞는 폭이 되게 한다.
    const timer = setInterval(paint, 500);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(timer);
    };
  }, [ticking, room.question?.index, room.question?.deadline, room.question?.remainingMs, room.questionDurationMs]);

  return (
    <div className="timer-bar">
      <div ref={fillRef} className="timer-bar-fill" />
    </div>
  );
}
