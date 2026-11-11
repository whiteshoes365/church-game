// QR·짧은 주소 `/#/j/:code?p=1234` → 방 id 를 찾아 참가 화면으로 넘긴다.
// 방 PIN(p)이 있으면 참가 화면에 미리 채워 둔다. 진행자 비밀번호는 주소에 없다.
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { gameSocket } from '../ws';
import { normalizeJoinCode } from '../joinLink';

export function JoinByCode() {
  const { code: rawCode } = useParams<{ code: string }>();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const code = normalizeJoinCode(rawCode ?? '');
  const pinPrefill = (search.get('p') ?? '').replace(/\D/g, '').slice(0, 4);

  useEffect(() => {
    if (!code) {
      setError('입장 코드가 없어요. 선생님 화면에 있는 QR이나 짧은 주소를 다시 확인해 주세요.');
      return;
    }
    gameSocket.connect();
    const off = gameSocket.on('joinCodeResolved', (msg) => {
      if (normalizeJoinCode(msg.code) !== code) return;
      if (!msg.roomId) {
        setError('이 입장 코드로 열린 방이 없어요. 선생님이 방을 열었는지 확인해 주세요.');
        return;
      }
      navigate(`/play/${msg.roomId}`, {
        replace: true,
        state: {
          pinPrefill: /^\d{4}$/.test(pinPrefill) ? pinPrefill : undefined,
          fromJoinCode: code,
          roomTitle: msg.title ?? undefined,
        },
      });
    });
    gameSocket.send('resolveJoinCode', { code });
    return () => {
      off();
    };
  }, [code, navigate, pinPrefill]);

  return (
    <div className="screen">
      <div className="screen-narrow stack">
        <h1 className="title">방에 들어가는 중</h1>
        {error ? (
          <>
            <p className="form-error join-error">{error}</p>
            <button className="btn btn-primary" onClick={() => navigate('/')}>
              처음부터 찾기
            </button>
          </>
        ) : (
          <p className="subtitle">입장 코드 {code || '…'} 방을 찾는 중이에요…</p>
        )}
      </div>
    </div>
  );
}
