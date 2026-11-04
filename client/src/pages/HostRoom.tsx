import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { gameSocket } from '../ws';
import { AvatarIcon } from '../components/AvatarIcon';
import { BannerAdSlot } from '../components/BannerAdSlot';
import { isWebGLAvailable } from '../three/webgl';
import type { PlayerSnapshot, RoomSnapshot } from '../protocol';

const HostCanvas3D = lazy(() => import('../three/HostCanvas3D'));

const QUESTION_DURATION_MS = 15000;

const MAP_CLASS: Record<string, string> = {
  sanctuary: 'map-sanctuary',
  playground: 'map-playground',
  forest: 'map-forest',
};

function hashUnit(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) >>> 0;
  return (h % 10000) / 10000;
}

function positionFor(player: PlayerSnapshot): { left: string; top: string } {
  const hx = hashUnit(player.id + ':x');
  const hy = hashUnit(player.id + ':y');
  const top = `${20 + hy * 60}%`;
  if (player.side === 'O') return { left: `${7 + hx * 36}%`, top };
  if (player.side === 'X') return { left: `${57 + hx * 36}%`, top };
  return { left: `${5 + hx * 90}%`, top };
}

export function HostRoom() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const webglAvailable = useMemo(() => isWebGLAvailable(), []);

  useEffect(() => {
    gameSocket.connect();
    gameSocket.send('hostOpenRoom', { roomId });
    const offState = gameSocket.on('roomState', (msg) => {
      if (msg.room.id === roomId) setRoom(msg.room);
    });
    const offError = gameSocket.on('error', (msg) => setError(msg.message));
    return () => {
      offState();
      offError();
    };
  }, [roomId]);

  useEffect(() => {
    if (room?.status !== 'question') return;
    const id = setInterval(() => setNow(Date.now()), 150);
    return () => clearInterval(id);
  }, [room?.status]);

  if (!room) {
    return (
      <div className="host-screen">
        <p className="subtitle">{error ?? '방 정보를 불러오는 중이에요...'}</p>
      </div>
    );
  }

  const sorted = [...room.players].sort((a, b) => b.score - a.score);

  return (
    <div className="host-screen">
      <div className="host-header">
        <div>
          <h1 className="title" style={{ textAlign: 'left' }}>
            {room.title}
          </h1>
          <p className="subtitle" style={{ textAlign: 'left', margin: 0 }}>
            참여 인원 {room.players.length}명
          </p>
        </div>
        <div className="row">
          {(room.status === 'lobby' || room.status === 'finished') && (
            <button className="btn btn-primary btn-sm" onClick={() => gameSocket.send('startQuiz', { roomId })}>
              {room.status === 'finished' ? '다시 시작' : 'OX 퀴즈 시작'}
            </button>
          )}
          {room.status === 'question' && (
            <button className="btn btn-sm" onClick={() => gameSocket.send('reveal', { roomId })}>
              바로 정답 공개
            </button>
          )}
          {room.status === 'reveal' && (
            <button className="btn btn-primary btn-sm" onClick={() => gameSocket.send('nextQuestion', { roomId })}>
              다음 문제
            </button>
          )}
          <button className="btn btn-sm" onClick={() => navigate('/host')}>
            나가기
          </button>
        </div>
      </div>

      <div className="host-main">
        <div className="map-column">
          <div className="host-hud">
            {room.status === 'question' && room.question && (
              <div className="question-strip">
                <span className="badge">
                  문제 {room.question.index + 1} / {room.question.total}
                </span>
                <p className="question-strip-text">{room.question.text}</p>
                <div className="timer-bar">
                  <div
                    className="timer-bar-fill"
                    style={{
                      width: `${Math.max(0, Math.min(100, (((room.question.deadline ?? now) - now) / QUESTION_DURATION_MS) * 100))}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {room.status === 'reveal' && room.lastResult && (
              <div className="reveal-banner">
                정답: {room.lastResult.correctAnswer} · {room.lastResult.questionText}
              </div>
            )}
          </div>

          <div className="map-area-3d">
            {webglAvailable ? (
              <Suspense fallback={<div className={`map-area ${MAP_CLASS[room.map]}`} />}>
                <div className="canvas-fill">
                  <HostCanvas3D
                    players={room.players}
                    status={room.status}
                    correctAnswer={room.lastResult?.correctAnswer ?? null}
                  />
                </div>
              </Suspense>
            ) : (
              <div className={`map-area ${MAP_CLASS[room.map]}`}>
                {room.status !== 'lobby' && (
                  <div className="map-zones">
                    <div className="map-zone">
                      <div className="map-zone-sign o">O</div>
                    </div>
                    <div className="map-zone">
                      <div className="map-zone-sign x">X</div>
                    </div>
                  </div>
                )}
                <div className="map-avatars">
                  {room.players.map((p) => {
                    const pos = positionFor(p);
                    return (
                      <div key={p.id} className="map-avatar" style={{ left: pos.left, top: pos.top }}>
                        <div className="map-avatar-sprite">
                          <AvatarIcon avatarId={p.avatar} size={36} />
                        </div>
                        <span className="map-avatar-name">{p.nickname}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="side-panel">
          <div className="scoreboard">
            {sorted.length === 0 && <p className="subtitle">아직 참여한 친구가 없어요.</p>}
            {sorted.map((p, i) => (
              <div key={p.id} className="scoreboard-row">
                <span>
                  {i + 1}. {p.nickname}
                </span>
                <span>{p.score}점</span>
              </div>
            ))}
          </div>
          <BannerAdSlot />
        </div>
      </div>
    </div>
  );
}
