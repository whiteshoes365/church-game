// 서버 연결이 몇 초 넘게 걸리면 "서버를 깨우는 중" 안내를 띄운다.
// 무료 서버는 한동안 안 쓰면 잠들고, 첫 접속에 최대 1분 정도 걸릴 수 있다 (호스팅 문서 기준).
import { useEffect, useState } from 'react';
import { gameSocket } from '../ws';

const SLOW_AFTER_MS = 4000;

export function ServerWakeNotice() {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const check = () => {
      const since = gameSocket.waitingSince;
      setSlow(since !== null && Date.now() - since >= SLOW_AFTER_MS);
    };
    const id = window.setInterval(check, 1000);
    const offOpen = gameSocket.on('socketOpen', check);
    return () => {
      window.clearInterval(id);
      offOpen();
    };
  }, []);

  if (!slow) return null;
  return (
    <div className="server-wake-notice" role="status" aria-live="polite">
      <span className="server-wake-dot" aria-hidden />
      서버를 깨우는 중이에요. 잠시 안 쓰던 서버는 첫 접속에 최대 1분 정도 걸릴 수 있어요. 이 화면을 그대로 두고 기다려 주세요.
    </div>
  );
}
