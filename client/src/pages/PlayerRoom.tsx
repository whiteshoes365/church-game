import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { gameSocket } from '../ws';
import { getDeviceId } from '../deviceId';
import { BODY_COLORS, DEFAULT_AVATAR_CONFIG, HATS, SKIN_TONES, encodeAvatar, type AvatarConfig } from '../avatars';
import { AvatarIcon } from '../components/AvatarIcon';
import { isWebGLAvailable } from '../three/webgl';
import type { Gait, GaitStatus, PlayerPosition, RoomSnapshot } from '../protocol';
import { PlayerMap } from '../components/PlayerMap';
import { CATEGORY_CLASS, CATEGORY_LABELS } from '../categories';
import { ShopPanel } from '../components/ShopPanel';
import { LegalFooter } from '../components/LegalFooter';

const AvatarPreview3D = lazy(() => import('../three/AvatarPreview3D'));

const QUESTION_DURATION_MS = 15000;
const MOVE_SEND_INTERVAL_MS = 83; // ~12 Hz, as specified for the input throttle
const JOYSTICK_MAX_RADIUS = 66;

function Joystick({ onChange }: { onChange: (dir: { x: number; z: number }) => void }) {
  const baseRef = useRef<HTMLDivElement>(null);
  const pointerIdRef = useRef<number | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });

  function updateFromEvent(e: ReactPointerEvent<HTMLDivElement>) {
    const base = baseRef.current;
    if (!base) return;
    const rect = base.getBoundingClientRect();
    // The base is smaller on small phones, so the travel radius follows its real size.
    const radius = Math.min(JOYSTICK_MAX_RADIUS, rect.width / 2 - 14);
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > radius) {
      dx = (dx / dist) * radius;
      dy = (dy / dist) * radius;
    }
    setKnob({ x: dx, y: dy });
    onChange({ x: dx / radius, z: dy / radius });
  }

  // Released only by pointerup/pointercancel of the finger that started the
  // drag. The base holds pointer capture, so the drag keeps tracking even when
  // the finger slides far outside the circle (no pointerleave release).
  function release(e: ReactPointerEvent<HTMLDivElement>) {
    if (pointerIdRef.current !== e.pointerId) return;
    pointerIdRef.current = null;
    setKnob({ x: 0, y: 0 });
    onChange({ x: 0, z: 0 });
  }

  // If the controls unmount mid-drag (question ends), stop moving.
  useEffect(() => () => onChange({ x: 0, z: 0 }), []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={baseRef}
      className="joystick-base"
      onPointerDown={(e) => {
        e.preventDefault();
        if (pointerIdRef.current !== null) return;
        pointerIdRef.current = e.pointerId;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* capture is best-effort */
        }
        updateFromEvent(e);
      }}
      onPointerMove={(e) => {
        if (pointerIdRef.current !== e.pointerId) return;
        e.preventDefault();
        updateFromEvent(e);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="joystick-knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
    </div>
  );
}

// ---- 조이스틱 자리 (이 기기에만 저장) ----
// 가로: 왼쪽 / 가운데 / 오른쪽, 세로: 아래(지도 밑, 기본) / 위(문제 바로 밑, 지도 위).
// 어느 자리든 조작판은 문제 카드와 겹치지 않는 자기 줄에 놓인다.
type DockSide = 'left' | 'center' | 'right';
type DockRow = 'bottom' | 'top';
interface DockPlace {
  side: DockSide;
  row: DockRow;
}
const DEFAULT_DOCK: DockPlace = { side: 'left', row: 'bottom' };
const DOCK_KEY = 'church-game:joystick-dock';
const DOCK_SIDES: DockSide[] = ['left', 'center', 'right'];
const DOCK_LABELS: Record<DockSide, string> = { left: '왼쪽', center: '가운데', right: '오른쪽' };
const DRAG_START_PX = 8; // 이보다 적게 움직이면 "누르기"(다음 자리로)로 본다

function loadDock(): DockPlace {
  try {
    const raw = JSON.parse(localStorage.getItem(DOCK_KEY) || 'null');
    if (raw && DOCK_SIDES.includes(raw.side) && (raw.row === 'bottom' || raw.row === 'top')) return { side: raw.side, row: raw.row };
  } catch {
    /* fall through */
  }
  return DEFAULT_DOCK;
}

function saveDock(place: DockPlace) {
  try {
    if (place.side === DEFAULT_DOCK.side && place.row === DEFAULT_DOCK.row) localStorage.removeItem(DOCK_KEY);
    else localStorage.setItem(DOCK_KEY, JSON.stringify(place));
  } catch {
    /* 저장이 안 되면 이번 화면에서만 유지 */
  }
}

// ---- 뛰기 · 기어가기 (서버가 시간을 정한다. 여기서는 남은 시간을 보여 주기만 한다) ----
interface GaitView {
  mode: Gait | null;
  activeUntil: number; // performance.now() 기준
  readyAt: Record<Gait, number>;
  durationMs: number;
  cooldownTotalMs: number;
}
const INITIAL_GAIT: GaitView = { mode: null, activeUntil: 0, readyAt: { run: 0, crawl: 0 }, durationMs: 3000, cooldownTotalMs: 10000 };
const GAIT_NAMES: Record<Gait, string> = { run: '뛰기', crawl: '기어가기' };

function gaitFromServer(msg: GaitStatus): GaitView {
  const t = performance.now();
  const activeUntil = msg.mode ? t + msg.activeMs : 0;
  const readyAt = { run: 0, crawl: 0 };
  for (const key of ['run', 'crawl'] as const) {
    // 쿨타임은 기술이 끝난 뒤부터 센다.
    readyAt[key] = (msg.mode === key ? activeUntil : t) + (msg.cooldownMs?.[key] ?? 0);
  }
  return { mode: msg.mode, activeUntil, readyAt, durationMs: msg.durationMs, cooldownTotalMs: msg.cooldownTotalMs };
}

function GaitButton({ kind, gait, now, roomId }: { kind: Gait; gait: GaitView; now: number; roomId?: string }) {
  const active = gait.mode === kind && now < gait.activeUntil;
  const activeLeft = active ? gait.activeUntil - now : 0;
  const coolLeft = active ? 0 : Math.max(0, gait.readyAt[kind] - now);
  const otherActive = !active && gait.mode !== null && now < gait.activeUntil;
  const cooling = coolLeft > 0;
  const pressedAt = useRef(0);
  // 남은 양 막대: 켜진 동안은 줄어들고, 쿨타임 동안은 다시 차오른다.
  const fill = active ? activeLeft / gait.durationMs : cooling ? 1 - coolLeft / gait.cooldownTotalMs : 0;
  return (
    <button
      type="button"
      className={`action-btn gait-btn ${kind}-btn ${active ? 'active' : ''} ${cooling ? 'cooling' : ''} ${otherActive ? 'waiting' : ''}`}
      aria-disabled={cooling || otherActive}
      aria-label={active ? `${GAIT_NAMES[kind]} 중, ${Math.ceil(activeLeft / 1000)}초 남음` : cooling ? `${GAIT_NAMES[kind]} 쿨타임 ${Math.ceil(coolLeft / 1000)}초` : GAIT_NAMES[kind]}
      onPointerDown={(e) => {
        e.preventDefault();
        if (cooling || otherActive) return;
        if (active) {
          // 켜진 버튼을 다시 누르면 일찍 끈다 (방금 누른 두 번 누르기는 무시).
          if (performance.now() - pressedAt.current > 500) gameSocket.send('gait', { roomId, mode: 'walk' });
          return;
        }
        pressedAt.current = performance.now();
        gameSocket.send('gait', { roomId, mode: kind });
      }}
    >
      <span className="gait-btn-fill" style={{ width: `${Math.max(0, Math.min(1, fill)) * 100}%` }} aria-hidden />
      <span className="gait-btn-label">{GAIT_NAMES[kind]}</span>
      <span className="gait-btn-time">{active ? `${(activeLeft / 1000).toFixed(1)}초 남음` : cooling ? `${Math.ceil(coolLeft / 1000)}초 뒤` : `${Math.round(gait.durationMs / 1000)}초 동안`}</span>
    </button>
  );
}

function MovementControls({ roomId, gait, children }: { roomId?: string; gait: GaitView; children?: ReactNode }) {
  const dirRef = useRef({ x: 0, z: 0 });
  const [dock, setDock] = useState<DockPlace>(loadDock);
  const [drag, setDrag] = useState<{ dx: number; dy: number; target: DockPlace } | null>(null);
  const dragRef = useRef<{ pointerId: number; x0: number; y0: number; moved: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    const id = setInterval(() => {
      gameSocket.send('move', { roomId, dir: dirRef.current });
    }, MOVE_SEND_INTERVAL_MS);
    return () => clearInterval(id);
  }, [roomId]);

  // 버튼의 남은 시간 숫자를 갱신한다 (켜져 있거나 쿨타임일 때만 돈다).
  const busyUntil = Math.max(gait.activeUntil, gait.readyAt.run, gait.readyAt.crawl);
  useEffect(() => {
    setNow(performance.now());
    if (busyUntil <= performance.now()) return;
    const id = setInterval(() => {
      const t = performance.now();
      setNow(t);
      if (t > busyUntil + 150) clearInterval(id);
    }, 100);
    return () => clearInterval(id);
  }, [busyUntil]);

  function place(next: DockPlace) {
    setDock(next);
    saveDock(next);
  }

  // 손가락 위치로 놓을 자리를 고른다: 화면을 가로로 3등분, 세로는 화면 가운데보다 위/아래.
  function targetAt(clientX: number, clientY: number): DockPlace {
    const w = window.innerWidth;
    const side: DockSide = clientX < w / 3 ? 'left' : clientX > (w * 2) / 3 ? 'right' : 'center';
    const row: DockRow = clientY < window.innerHeight * 0.5 ? 'top' : 'bottom';
    return { side, row };
  }

  function endDrag(e: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    if (cancelled) return;
    if (d.moved) place(targetAt(e.clientX, e.clientY));
    // 끌지 않고 누르기만 하면 다음 자리로 (왼쪽 → 가운데 → 오른쪽)
    else place({ side: DOCK_SIDES[(DOCK_SIDES.indexOf(dock.side) + 1) % DOCK_SIDES.length], row: dock.row });
  }

  const walking = !(gait.mode && now < gait.activeUntil);
  const isDefault = dock.side === DEFAULT_DOCK.side && dock.row === DEFAULT_DOCK.row;

  return (
    <div ref={rootRef} className={`movement-controls dock-${dock.side} dock-row-${dock.row} ${drag ? 'dragging' : ''}`} data-dock={`${dock.side}-${dock.row}`}>
      <div className="joy-slot" style={drag ? { transform: `translate(${drag.dx}px, ${drag.dy}px)` } : undefined}>
        <div className="joy-tools">
          <button
            type="button"
            className="joy-grip"
            aria-label={`조이스틱 자리 옮기기 (지금: ${DOCK_LABELS[dock.side]} ${dock.row === 'top' ? '위' : '아래'})`}
            onPointerDown={(e) => {
              e.preventDefault();
              if (dragRef.current) return;
              dragRef.current = { pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false };
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {
                /* best-effort */
              }
            }}
            onPointerMove={(e) => {
              const d = dragRef.current;
              if (!d || d.pointerId !== e.pointerId) return;
              e.preventDefault();
              const dx = e.clientX - d.x0;
              const dy = e.clientY - d.y0;
              if (!d.moved && Math.hypot(dx, dy) < DRAG_START_PX) return;
              d.moved = true;
              setDrag({ dx, dy, target: targetAt(e.clientX, e.clientY) });
            }}
            onPointerUp={(e) => endDrag(e, false)}
            onPointerCancel={(e) => endDrag(e, true)}
            onContextMenu={(e) => e.preventDefault()}
          >
            <span className="joy-grip-dots" aria-hidden />
            옮기기
          </button>
          <button type="button" className="joy-reset" disabled={isDefault} onClick={() => place(DEFAULT_DOCK)}>
            초기화
          </button>
        </div>
        <Joystick onChange={(dir) => { dirRef.current = dir; }} />
      </div>
      <div className="ox-slot">{children}</div>
      <div className="action-slot">
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
          <GaitButton kind="run" gait={gait} now={now} roomId={roomId} />
          <GaitButton kind="crawl" gait={gait} now={now} roomId={roomId} />
        </div>
        <p className={`gait-status ${walking ? '' : gait.mode ?? ''}`}>
          지금: <b>{walking ? '걷기' : GAIT_NAMES[gait.mode as Gait]}</b>
        </p>
      </div>
      {drag && (
        <div className="dock-drop-hint" role="status">
          놓으면 <b>{DOCK_LABELS[drag.target.side]} {drag.target.row === 'top' ? '위' : '아래'}</b>로 옮겨요
        </div>
      )}
    </div>
  );
}

export function PlayerRoom() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const joinState = (location.state as { pinPrefill?: string; roomTitle?: string } | null) ?? null;
  const deviceId = useMemo(() => getDeviceId(), []);

  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [positions, setPositions] = useState<Record<string, PlayerPosition>>({});
  const [joined, setJoined] = useState(false);
  const [nickname, setNickname] = useState('');
  const [pin, setPin] = useState(() => (/^\d{4}$/.test(joinState?.pinPrefill ?? '') ? joinState!.pinPrefill! : ''));
  const [shopOpen, setShopOpen] = useState(false);
  const [avatarConfig, setAvatarConfig] = useState<AvatarConfig>(DEFAULT_AVATAR_CONFIG);
  const avatar = useMemo(() => encodeAvatar(avatarConfig), [avatarConfig]);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [attendance, setAttendance] = useState<{ streak: number; streakBonus: number } | null>(null);
  const [gait, setGait] = useState<GaitView>(INITIAL_GAIT);
  const webglAvailable = useMemo(() => isWebGLAvailable(), []);

  useEffect(() => {
    gameSocket.connect();
    const offJoined = gameSocket.on('joined', (msg) => {
      setJoined(true);
      setError(null);
      setRoom(msg.room);
      if (msg.attendance) setAttendance(msg.attendance);
      // 새로고침·재접속 뒤에도 남은 쿨타임을 이어서 보여 준다.
      gameSocket.send('gait', { roomId, mode: 'status' });
    });
    const offGait = gameSocket.on('gait', (msg: GaitStatus) => {
      if (msg.roomId === roomId) setGait(gaitFromServer(msg));
    });
    const offState = gameSocket.on('roomState', (msg) => {
      if (msg.room.id === roomId) setRoom(msg.room);
    });
    const offError = gameSocket.on('error', (msg) => setError(msg.message));
    const offPositions = gameSocket.on('positions', (msg) => {
      if (msg.roomId !== roomId) return;
      const next: Record<string, PlayerPosition> = {};
      for (const p of msg.players as PlayerPosition[]) next[p.id] = p;
      setPositions(next);
    });
    return () => {
      offGait();
      offPositions();
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
    if (!/^\d{4}$/.test(pin)) {
      setError('선생님이 알려 준 방 PIN 숫자 4자리를 입력해 주세요.');
      return;
    }
    setError(null);
    gameSocket.send('joinRoom', { roomId, deviceId, nickname: nickname.trim(), avatar, pin });
  }

  function answer(choice: 'O' | 'X') {
    gameSocket.send('answer', { roomId, choice });
  }

  if (!joined || !room) {
    return (
      <div className="screen">
        <div className="screen-narrow stack">
          <h1 className="title">닉네임과 아바타를 골라주세요</h1>
          <p className="subtitle">{joinState?.roomTitle ? `「${joinState.roomTitle}」 방이에요` : '실명이나 전화번호는 필요 없어요'}</p>
          <div className="pin-entry card">
            <p className="picker-label">방 PIN (학생용, 숫자 4자리)</p>
            <input
              className="input pin-input"
              inputMode="numeric"
              autoComplete="off"
              placeholder="0000"
              maxLength={4}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            />
            <p className="fine-print">
              {/^\d{4}$/.test(pin) && joinState?.pinPrefill === pin
                ? 'QR에서 방 PIN을 미리 채웠어요. 맞는지 확인하고 입장해요.'
                : '선생님 화면에 크게 나와 있어요.'}
            </p>
          </div>

          {error && <p className="form-error join-error">{error}</p>}

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

          <p className="fine-print join-privacy-note">
            입장하면 <b>닉네임(최대 12자)</b>, <b>블록 아바타</b>, <b>기기 식별값</b>(출석·상점 아이템 확인용)만 써요. 실명·전화번호·이메일·생일은 받지 않아요. 닉네임에 실명을 쓰지 마세요.
          </p>
          <button className="btn btn-primary" onClick={join} disabled={!nickname.trim() || pin.length !== 4}>
            입장하기
          </button>
          <LegalFooter newTab />
        </div>
      </div>
    );
  }

  const me = room.players.find((p) => p.id === deviceId);
  const answered = !!me?.side && room.status === 'question';
  const playing = room.status === 'question' && !!room.question;

  return (
    <div className={`screen ${playing ? 'play-screen' : ''}`}>
      <div className="screen-narrow stack">
        <h1 className="title">{room.title}</h1>

        {(() => {
          const myTeam = room.team?.enabled ? room.team.teams.find((t) => t.id === me?.teamId) : undefined;
          if (!myTeam && !attendance) return null;
          return (
            <div className="player-chips">
              {myTeam && (
                <span className="team-chip" style={{ background: myTeam.color }}>
                  우리 팀: {myTeam.name}
                  {(room.status === 'question' || room.status === 'reveal') && ` · 합계 ${myTeam.total}점 · 평균 ${myTeam.average}점`}
                </span>
              )}
              {attendance && (
                <span className="team-chip attend-chip">
                  출석 완료{attendance.streak >= 2 ? ` · ${attendance.streak}주 연속!` : ''}
                  {attendance.streakBonus > 0 ? ` +${attendance.streakBonus} 달란트` : ''}
                </span>
              )}
            </div>
          );
        })()}

        {room.status === 'lobby' && (
          <div className="card stack">
            <p className="subtitle">선생님이 퀴즈를 시작하면 바로 알려드려요. 잠시만 기다려주세요!</p>
            <p>참여 인원: {room.players.length}명</p>
            {me && (
              <div className="my-character">
                <AvatarIcon avatarId={me.avatar} cosmetics={me.cosmetics} size={72} />
                <span>{me.nickname}</span>
              </div>
            )}
          </div>
        )}

        {room.status === 'question' && room.question && (
          <>
            <div className="card play-question">
              <div className="play-question-badges">
                <span className="badge">
                  문제 {room.question.index + 1} / {room.question.total}
                </span>
                {room.question.category && (
                  <span className={`badge badge-category ${CATEGORY_CLASS[room.question.category]}`}>
                    {CATEGORY_LABELS[room.question.category]}
                  </span>
                )}
              </div>
              <p className="question-text">{room.question.text}</p>
              <div className="timer-bar">
                <div
                  className="timer-bar-fill"
                  style={{
                    width: `${Math.max(0, Math.min(100, (((room.question.deadline ?? now) - now) / (room.questionDurationMs ?? QUESTION_DURATION_MS)) * 100))}%`,
                  }}
                />
              </div>
            </div>

            <PlayerMap
              className="player-map-fill"
              bounds={room.bounds}
              zones={room.zones}
              players={room.players}
              positions={positions}
              meId={deviceId}
              onPickZone={answered ? undefined : answer}
            />

            <p className="play-hint">
              {answered
                ? '선택 완료! 조이스틱으로 자리를 옮길 수도 있어요.'
                : '지도의 O/X 를 누르면 걸어가요. 조이스틱으로 직접 움직여도 돼요.'}
            </p>
            <p className="play-hint play-rule">정답 공개 때 서 있는 O/X 자리로 채점해요. (처음 누른 버튼이 아니에요)</p>

            <MovementControls roomId={roomId} gait={gait}>
              <div className="ox-buttons">
                <button className="ox-button o" disabled={answered} onClick={() => answer('O')}>
                  O
                </button>
                <button className="ox-button x" disabled={answered} onClick={() => answer('X')}>
                  X
                </button>
              </div>
            </MovementControls>
          </>
        )}

        {room.status === 'reveal' && room.lastResult && (
          <div className="card stack">
            <p className="question-text">{room.lastResult.questionText}</p>
            {room.lastResult.category && (
              <span className={`badge badge-category ${CATEGORY_CLASS[room.lastResult.category]}`}>
                {CATEGORY_LABELS[room.lastResult.category]}
              </span>
            )}
            <div className="reveal-banner">정답은 {room.lastResult.correctAnswer} 예요!</div>
            <PlayerMap
              bounds={room.bounds}
              zones={room.zones}
              players={room.players}
              positions={positions}
              meId={deviceId}
              correctAnswer={room.lastResult.correctAnswer}
              correctPlayerIds={room.lastResult.correctPlayerIds}
            />
            {room.lastResult.explanation && <p className="explanation-text">{room.lastResult.explanation}</p>}
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
            {room.finalResult?.team &&
              me?.teamId &&
              (() => {
                const fr = room.finalResult!.team!;
                const mine = fr.teams.find((t) => t.id === me.teamId);
                if (!mine) return null;
                const won = fr.winnerTeamIds.includes(mine.id);
                return (
                  <p className="player-team-result" style={{ borderColor: mine.color }}>
                    <span className="team-dot" style={{ background: mine.color }} />
                    {mine.name} {won ? (fr.tie ? '무승부!' : '승리!') : '아쉽지만 잘했어요!'}
                    <small className="player-team-score">
                      합계 {mine.total}점 · 평균 {mine.average}점 · {mine.size}명
                    </small>
                  </p>
                );
              })()}
            {(() => {
              const award = room.finalResult?.awards.find((a) => a.id === me?.id);
              if (!award) return null;
              return (
                <p className="player-award">
                  달란트 +{award.delta}{' '}
                  <small>
                    (
                    {award.parts
                      .filter((x) => x.delta > 0)
                      .map((x) => `${x.reason} +${x.delta}`)
                      .join(', ') || '지급 없음'}
                    )
                  </small>
                  {award.capped && (
                    <span className="cap-note">
                      이번 주 상한({award.weeklyCap}개)이라 {award.requested}개 중 {award.delta}개만 받았어요.
                    </span>
                  )}
                </p>
              );
            })()}
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

        {me?.recorded && (room.status === 'lobby' || room.status === 'finished') && (
          <button className="btn shop-open-btn" onClick={() => setShopOpen(true)}>
            <span className="talent-coin" aria-hidden /> 달란트 상점 열기
          </button>
        )}

        <button className="link-btn" onClick={() => navigate('/')}>
          나가기
        </button>
      </div>
      {shopOpen && me && roomId && <ShopPanel roomId={roomId} avatarId={me.avatar} onClose={() => setShopOpen(false)} />}
    </div>
  );
}
