import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { gameSocket } from '../ws';
import { getDeviceId } from '../deviceId';
import { BODY_COLORS, DEFAULT_AVATAR_CONFIG, HATS, SKIN_TONES, encodeAvatar, type AvatarConfig } from '../avatars';
import { AvatarIcon } from '../components/AvatarIcon';
import { isWebGLAvailable } from '../three/webgl';
import type { RoomSnapshot } from '../protocol';

const AvatarPreview3D = lazy(() => import('../three/AvatarPreview3D'));

const QUESTION_DURATION_MS = 15000;
const MOVE_SEND_INTERVAL_MS = 83; // ~12 Hz, as specified for the input throttle
const JOYSTICK_RADIUS = 52;

function Joystick({ onChange }: { onChange: (dir: { x: number; z: number }) => void }) {
  const baseRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [knob, setKnob] = useState({ x: 0, y: 0 });

  function updateFromEvent(e: ReactPointerEvent<HTMLDivElement>) {
    const base = baseRef.current;
    if (!base) return;
    const rect = base.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > JOYSTICK_RADIUS) {
      dx = (dx / dist) * JOYSTICK_RADIUS;
      dy = (dy / dist) * JOYSTICK_RADIUS;
    }
    setKnob({ x: dx, y: dy });
    onChange({ x: dx / JOYSTICK_RADIUS, z: dy / JOYSTICK_RADIUS });
  }

  function release() {
    draggingRef.current = false;
    setKnob({ x: 0, y: 0 });
    onChange({ x: 0, z: 0 });
  }

  return (
    <div
      ref={baseRef}
      className="joystick-base"
      onPointerDown={(e) => {
        e.preventDefault();
        draggingRef.current = true;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        updateFromEvent(e);
      }}
      onPointerMove={(e) => {
        if (!draggingRef.current) return;
        e.preventDefault();
        updateFromEvent(e);
      }}
      onPointerUp={(e) => {
        e.preventDefault();
        release();
      }}
      onPointerCancel={release}
      onPointerLeave={() => {
        if (draggingRef.current) release();
      }}
    >
      <div className="joystick-knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
    </div>
  );
}

function MovementControls({ roomId }: { roomId?: string }) {
  const dirRef = useRef({ x: 0, z: 0 });
  const runRef = useRef(false);
  const crawlRef = useRef(false);
  const [running, setRunning] = useState(false);
  const [crawling, setCrawling] = useState(false);

  useEffect(() => {
    const id = setInterval(() => {
      gameSocket.send('move', { roomId, dir: dirRef.current, run: runRef.current, crawl: crawlRef.current });
    }, MOVE_SEND_INTERVAL_MS);
    return () => clearInterval(id);
  }, [roomId]);

  function setRun(active: boolean) {
    runRef.current = active;
    setRunning(active);
  }

  return (
    <div className="movement-controls">
      <Joystick onChange={(dir) => { dirRef.current = dir; }} />
      <div className="action-buttons">
        <button
          type="button"
          className="action-btn jump-btn"
          onPointerDown={(e) => {
            e.preventDefault();
            gameSocket.send('jump', { roomId });
          }}
        >
          점프
        </button>
        <button
          type="button"
          className={`action-btn run-btn ${running ? 'active' : ''}`}
          onPointerDown={(e) => {
            e.preventDefault();
            setRun(true);
          }}
          onPointerUp={() => setRun(false)}
          onPointerCancel={() => setRun(false)}
          onPointerLeave={() => {
            if (runRef.current) setRun(false);
          }}
        >
          달리기
        </button>
        <button
          type="button"
          className={`action-btn crawl-btn ${crawling ? 'active' : ''}`}
          onPointerDown={(e) => {
            e.preventDefault();
            crawlRef.current = !crawlRef.current;
            setCrawling(crawlRef.current);
          }}
        >
          기어가기
        </button>
      </div>
    </div>
  );
}

export function PlayerRoom() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const deviceId = useMemo(() => getDeviceId(), []);

  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [joined, setJoined] = useState(false);
  const [nickname, setNickname] = useState('');
  const [avatarConfig, setAvatarConfig] = useState<AvatarConfig>(DEFAULT_AVATAR_CONFIG);
  const avatar = useMemo(() => encodeAvatar(avatarConfig), [avatarConfig]);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const webglAvailable = useMemo(() => isWebGLAvailable(), []);

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

          <div className="avatar-builder card">
            <div className="avatar-preview">
              {webglAvailable ? (
                <div className="avatar-preview-3d">
                  <Suspense fallback={<AvatarIcon avatarId={avatar} size={72} />}>
                    <AvatarPreview3D avatarId={avatar} />
                  </Suspense>
                </div>
              ) : (
                <AvatarIcon avatarId={avatar} size={72} />
              )}
            </div>

            <p className="picker-label">피부색</p>
            <div className="swatch-row">
              {SKIN_TONES.map((color, i) => (
                <button
                  key={color}
                  type="button"
                  aria-label={`피부색 ${i + 1}`}
                  className={`swatch ${avatarConfig.skin === i ? 'selected' : ''}`}
                  style={{ background: color }}
                  onClick={() => setAvatarConfig((c) => ({ ...c, skin: i }))}
                />
              ))}
            </div>

            <p className="picker-label">옷 색깔</p>
            <div className="swatch-row">
              {BODY_COLORS.map((color, i) => (
                <button
                  key={color}
                  type="button"
                  aria-label={`옷 색깔 ${i + 1}`}
                  className={`swatch ${avatarConfig.body === i ? 'selected' : ''}`}
                  style={{ background: color }}
                  onClick={() => setAvatarConfig((c) => ({ ...c, body: i }))}
                />
              ))}
            </div>

            <p className="picker-label">모자</p>
            <div className="hat-row">
              {HATS.map((h, i) => (
                <button
                  key={h.id}
                  type="button"
                  className={`hat-pick ${avatarConfig.hat === i ? 'selected' : ''}`}
                  onClick={() => setAvatarConfig((c) => ({ ...c, hat: i }))}
                >
                  <AvatarIcon avatarId={encodeAvatar({ ...avatarConfig, hat: i })} size={36} />
                  <span>{h.label}</span>
                </button>
              ))}
            </div>
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
            <MovementControls roomId={roomId} />

            <p className="picker-label" style={{ textAlign: 'center' }}>
              O/X 버튼을 누르면 캐릭터가 알아서 걸어가요
            </p>
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
