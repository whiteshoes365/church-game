import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { gameSocket } from '../ws';
import { getDeviceId } from '../deviceId';
import { AVATAR_OPTIONS } from '../avatars';
import { AvatarIcon } from '../components/AvatarIcon';
import type { RoomSnapshot } from '../protocol';

const QUESTION_DURATION_MS = 15000;

export function PlayerRoom() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const deviceId = useMemo(() => getDeviceId(), []);

  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [joined, setJoined] = useState(false);
  const [nickname, setNickname] = useState('');
  const [avatar, setAvatar] = useState(AVATAR_OPTIONS[0].id);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    gameSocket.connect();
    const offJoined = gameSocket.on('joined', (msg) => {
      setJoined(true);
      setRoom(msg.room);
    });
    const offState = gameSocket.on('roomState', (msg) => {
      if (msg.room.id === roomId) setRoom(msg.room);
    });
    const offError = gameSocket.on('error', (msg) => setError(msg.message));
    return () => {
      offJoined();
      offState();
      offError();
    };
  }, [roomId]);

  useEffect(() => {
    if (room?.status !== 'question') return;
    const id = setInterval(() => setNow(Date.now()), 150);
    return () => clearInterval(id);
  }, [room?.status]);

  function join() {
    if (!nickname.trim()) return;
    gameSocket.send('joinRoom', { roomId, deviceId, nickname: nickname.trim(), avatar });
  }

  function answer(choice: 'O' | 'X') {
    gameSocket.send('answer', { roomId, choice });
  }

  if (!joined || !room) {
    return (
      <div className="screen">
        <div className="screen-narrow stack">
          <h1 className="title">닉네임과 아바타를 골라주세요</h1>
          <p className="subtitle">실명이나 전화번호는 필요 없어요</p>
          {error && <p className="subtitle result-wrong">{error}</p>}

          <input
            className="input"
            placeholder="닉네임 (예: 꼬마사자)"
            maxLength={12}
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
          />

          <div className="avatar-grid">
            {AVATAR_OPTIONS.map((a) => (
              <div
                key={a.id}
                className={`avatar-pick ${avatar === a.id ? 'selected' : ''}`}
                onClick={() => setAvatar(a.id)}
              >
                <AvatarIcon avatarId={a.id} />
              </div>
            ))}
          </div>

          <button className="btn btn-primary" onClick={join} disabled={!nickname.trim()}>
            입장하기
          </button>
        </div>
      </div>
    );
  }

  const me = room.players.find((p) => p.id === deviceId);
  const answered = !!me?.side && room.status === 'question';

  return (
    <div className="screen">
      <div className="screen-narrow stack">
        <h1 className="title">{room.title}</h1>

        {room.status === 'lobby' && (
          <div className="card">
            <p className="subtitle">선생님이 퀴즈를 시작하면 바로 알려드려요. 잠시만 기다려주세요!</p>
            <p>참여 인원: {room.players.length}명</p>
          </div>
        )}

        {room.status === 'question' && room.question && (
          <div className="card stack">
            <span className="badge">
              문제 {room.question.index + 1} / {room.question.total}
            </span>
            <p className="question-text">{room.question.text}</p>
            <div className="timer-bar">
              <div
                className="timer-bar-fill"
                style={{
                  width: `${Math.max(0, Math.min(100, (((room.question.deadline ?? now) - now) / QUESTION_DURATION_MS) * 100))}%`,
                }}
              />
            </div>
            <div className="ox-buttons">
              <button className="ox-button o" disabled={answered} onClick={() => answer('O')}>
                O
              </button>
              <button className="ox-button x" disabled={answered} onClick={() => answer('X')}>
                X
              </button>
            </div>
            {answered && <p className="subtitle">선택 완료! 정답 발표를 기다려주세요.</p>}
          </div>
        )}

        {room.status === 'reveal' && room.lastResult && (
          <div className="card stack">
            <p className="question-text">{room.lastResult.questionText}</p>
            <div className="reveal-banner">정답은 {room.lastResult.correctAnswer} 예요!</div>
            {me && (
              <p className={room.lastResult.correctPlayerIds.includes(me.id) ? 'result-correct' : 'result-wrong'}>
                {room.lastResult.correctPlayerIds.includes(me.id) ? '정답이에요! 점수를 얻었어요.' : '아쉬워요, 틀렸어요.'}
              </p>
            )}
            <p>내 점수: {me?.score ?? 0}점</p>
            <p className="subtitle">선생님이 다음 문제를 준비하고 있어요.</p>
          </div>
        )}

        {room.status === 'finished' && (
          <div className="card stack">
            <h2 className="title">퀴즈 종료!</h2>
            <p>내 최종 점수: {me?.score ?? 0}점</p>
            <div className="stack">
              {[...room.players]
                .sort((a, b) => b.score - a.score)
                .map((p, i) => (
                  <div key={p.id} className="scoreboard-row">
                    <span>
                      {i + 1}. {p.nickname}
                    </span>
                    <span>{p.score}점</span>
                  </div>
                ))}
            </div>
          </div>
        )}

        <button className="link-btn" onClick={() => navigate('/')}>
          나가기
        </button>
      </div>
    </div>
  );
}
