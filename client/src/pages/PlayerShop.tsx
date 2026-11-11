import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { gameSocket } from '../ws';
import { getDeviceId } from '../deviceId';
import { ShopPanel } from '../components/ShopPanel';
import { DEFAULT_AVATAR_ID } from '../avatars';

const KEY = 'church-game:shop-login';

function loadSaved(): { code: string; nickname: string } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { code: typeof v.code === 'string' ? v.code : '', nickname: typeof v.nickname === 'string' ? v.nickname : '' };
  } catch {
    return { code: '', nickname: '' };
  }
}

// 홈 화면 달란트 상점: 반 코드 + 내 닉네임으로 들어가요.
// 닉네임은 게임 방에 처음 들어갈 때 등록한 기기에서만 열려요(다른 친구 이름으로는 못 열어요).
export function PlayerShop() {
  const navigate = useNavigate();
  const deviceId = useMemo(() => getDeviceId(), []);
  const [code, setCode] = useState(() => loadSaved().code);
  const [nickname, setNickname] = useState(() => loadSaved().nickname);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    gameSocket.connect();
    const offReady = gameSocket.on('shopReady', (msg) => {
      try {
        localStorage.setItem(KEY, JSON.stringify({ code: msg.code, nickname: msg.nickname }));
      } catch {
        /* ignore */
      }
      setError(null);
      setReady(true);
    });
    const offError = gameSocket.on('error', (msg) => setError(msg.message));
    return () => {
      offReady();
      offError();
    };
  }, []);

  function open() {
    if (!code.trim() || !nickname.trim()) {
      setError('반 코드와 내 닉네임을 입력해 주세요.');
      return;
    }
    setError(null);
    gameSocket.send('shopLogin', { code: code.trim(), nickname: nickname.trim(), deviceId });
  }

  if (ready) return <ShopPanel avatarId={DEFAULT_AVATAR_ID} onClose={() => navigate('/')} />;

  return (
    <div className="screen">
      <div className="screen-narrow stack">
        <h1 className="title">
          <span className="talent-coin" aria-hidden /> 달란트 상점
        </h1>
        <p className="subtitle">모은 달란트로 내 블록 캐릭터를 꾸며요</p>
        <div className="card stack">
          <p className="picker-label">우리 반 코드</p>
          <input className="input" placeholder="예: 사랑반" maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} />
          <p className="picker-label">내 닉네임</p>
          <input
            className="input"
            placeholder="게임 방에서 쓰는 닉네임"
            maxLength={12}
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && open()}
          />
          {error && <p className="form-error join-error shop-login-error">{error}</p>}
          <button className="btn btn-primary" onClick={open} disabled={!code.trim() || !nickname.trim()}>
            상점 열기
          </button>
          <p className="fine-print">
            닉네임은 게임 방에 처음 들어갈 때 쓴 기기에서만 열 수 있어요. 아직 방에 들어온 적이 없다면 먼저 선생님 방에 들어가서 닉네임을 만들어 주세요.
          </p>
        </div>
        <button className="link-btn" onClick={() => navigate('/')}>
          처음 화면으로
        </button>
      </div>
    </div>
  );
}
