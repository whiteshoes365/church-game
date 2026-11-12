// PC 송출 화면 (프로젝터·TV). 보기만 — 진행자 비밀번호·진행 버튼·정답을 보여 주지 않는다.
// 1) /#/display          : 짝 코드로 폰/호스트와 연결, 또는 이 PC에서 방 만들기
// 2) /#/display/:roomId  : 저장된 displayKey/hostKey 로 다시 열기
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { QrCode } from '../components/QrCode';
import { MusicPicker } from '../components/MusicPicker';
import { PinDigits, QuestionBanners, ResultHud, ResultTeams, RoomStage, ScoreList, TeamBoard } from '../components/RoomStage';
import { displayKeys, getHostKey, saveHostKey } from '../hostKeys';
import { displayUrl, joinQrUrl, joinTextUrl, pairUrl, remoteUrl } from '../joinLink';
import { LEVEL_CLASS, LEVEL_LABELS } from '../levels';
import { music } from '../music';
import type { Capacity, Level, MapTheme, PlayerPosition, RoomSnapshot } from '../protocol';
import { useQuestionClock } from '../roomTime';
import { useRoomMusic } from '../useRoomMusic';
import { gameSocket } from '../ws';

const MAP_OPTIONS: { value: MapTheme; label: string }[] = [
  { value: 'sanctuary', label: '예배당' },
  { value: 'playground', label: '운동장' },
  { value: 'forest', label: '숲' },
];

const SETUP_AUTO_HIDE_MS = 45000;

interface RemoteSetupCard {
  roomId: string;
  joinCode: string;
  pin: string;
  hostPassword: string;
}

export function DisplayRoom() {
  const { roomId: routeRoomId } = useParams<{ roomId?: string }>();
  const navigate = useNavigate();
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(routeRoomId ?? null);
  const [positions, setPositions] = useState<Record<string, PlayerPosition>>({});
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [pairTtl, setPairTtl] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('OX 성경 퀴즈');
  const [map, setMap] = useState<MapTheme>('sanctuary');
  const [capacity, setCapacity] = useState<Capacity>(8);
  const [level, setLevel] = useState<Level>('elementary');
  const [hostPasswordInput, setHostPasswordInput] = useState('');
  const [teamMode, setTeamMode] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [qrHidden, setQrHidden] = useState(false);
  const [setupCard, setSetupCard] = useState<RemoteSetupCard | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const activeRef = useRef<string | null>(routeRoomId ?? null);
  const now = useQuestionClock(room);

  useRoomMusic(room, { play: true, publish: false });

  const requestPair = useCallback(() => {
    gameSocket.send('displayPairRequest');
  }, []);

  const openDisplay = useCallback((id: string) => {
    gameSocket.send('displayOpen', {
      roomId: id,
      displayKey: displayKeys.get(id),
      hostKey: getHostKey(id),
    });
  }, []);

  useEffect(() => {
    activeRef.current = activeRoomId;
  }, [activeRoomId]);

  useEffect(() => {
    gameSocket.connect();

    const offPair = gameSocket.on('displayPairCode', (msg) => {
      setPairCode(msg.code);
      setPairTtl(Date.now() + (msg.ttlMs ?? 120000));
    });
    const offPaired = gameSocket.on('displayPaired', (msg) => {
      setActiveRoomId(msg.roomId);
      activeRef.current = msg.roomId;
      if (msg.displayKey) displayKeys.save(msg.roomId, msg.displayKey);
      navigate(`/display/${msg.roomId}`, { replace: true });
    });
    const offReady = gameSocket.on('displayReady', (msg) => {
      setActiveRoomId(msg.roomId);
      activeRef.current = msg.roomId;
      if (msg.displayKey) displayKeys.save(msg.roomId, msg.displayKey);
    });
    const offAuth = gameSocket.on('displayAuthRequired', () => {
      setError('이 PC에는 아직 송출 연결이 없어요. 아래 짝 코드로 선생님 폰·진행자 화면에서 연결해 주세요.');
      setRoom(null);
      setActiveRoomId(null);
      activeRef.current = null;
      if (routeRoomId) navigate('/display', { replace: true });
      requestPair();
    });
    const offCreated = gameSocket.on('roomCreated', (msg) => {
      if (msg.hostKey) saveHostKey(msg.room.id, msg.hostKey);
      setActiveRoomId(msg.room.id);
      activeRef.current = msg.room.id;
      // 송출로 전환하기 전에 진행자 비밀번호·리모컨 안내를 잠깐 보여 준다 (프로젝터에 계속 두지 않음).
      if (msg.room.hostPassword && msg.room.joinCode) {
        setSetupCard({
          roomId: msg.room.id,
          joinCode: msg.room.joinCode,
          pin: msg.room.pin ?? '',
          hostPassword: msg.room.hostPassword,
        });
        setSetupOpen(true);
      }
      gameSocket.send('displayOpen', { roomId: msg.room.id, hostKey: msg.hostKey });
      navigate(`/display/${msg.room.id}`, { replace: true });
      setCreating(false);
    });
    const offState = gameSocket.on('roomState', (msg) => {
      // 송출 스냅샷에는 hostPassword/controlKey 가 없다.
      if (msg.room.hostPassword || msg.room.controlKey) return;
      setRoom(msg.room);
      setActiveRoomId(msg.room.id);
      activeRef.current = msg.room.id;
      setError(null);
    });
    const offPositions = gameSocket.on('positions', (msg) => {
      if (!activeRef.current || msg.roomId !== activeRef.current) return;
      setPositions((prev) => {
        const next = { ...prev };
        for (const p of msg.players as PlayerPosition[]) next[p.id] = p;
        return next;
      });
    });
    const offError = gameSocket.on('error', (msg) => {
      setError(msg.message);
      setCreating(false);
      setTimeout(() => setError((cur) => (cur === msg.message ? null : cur)), 5000);
    });
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);

    const reopen = () => {
      if (activeRef.current) openDisplay(activeRef.current);
      else requestPair();
    };
    const offReconnect = gameSocket.onReconnect(reopen);

    if (routeRoomId) {
      setActiveRoomId(routeRoomId);
      activeRef.current = routeRoomId;
      openDisplay(routeRoomId);
    } else {
      requestPair();
    }

    return () => {
      offReconnect();
      offPair();
      offPaired();
      offReady();
      offAuth();
      offCreated();
      offState();
      offPositions();
      offError();
      document.removeEventListener('fullscreenchange', onFs);
    };
  }, [navigate, openDisplay, requestPair, routeRoomId]);

  useEffect(() => {
    if (room || !pairTtl) return;
    const left = pairTtl - Date.now();
    if (left <= 0) {
      requestPair();
      return;
    }
    const id = setTimeout(requestPair, Math.max(5000, left - 5000));
    return () => clearTimeout(id);
  }, [pairTtl, room, requestPair]);

  // 리모컨 안내 카드는 잠깐만 보이고 자동으로 숨긴다 (프로젝터에 비밀번호가 남지 않게).
  useEffect(() => {
    if (!setupOpen || !setupCard) return;
    const id = window.setTimeout(() => setSetupOpen(false), SETUP_AUTO_HIDE_MS);
    return () => window.clearTimeout(id);
  }, [setupOpen, setupCard]);

  function toggleFullscreen() {
    const el = document.documentElement;
    if (!document.fullscreenElement) el.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.().catch(() => {});
  }

  function createRoomHere() {
    if (hostPasswordInput && !/^[0-9A-Za-z]{4,12}$/.test(hostPasswordInput)) {
      setError('진행자 비밀번호는 영문·숫자 4~12자로 정해 주세요. 비워 두면 자동으로 만들어요.');
      return;
    }
    setCreating(true);
    setError(null);
    const local = music.getState();
    gameSocket.send('findOrCreateChurch', { name: '송출 PC' });
    const off = gameSocket.on('churchJoined', (msg) => {
      off();
      gameSocket.send('createRoom', {
        churchId: msg.church.id,
        title: title.trim() || 'OX 성경 퀴즈',
        map,
        capacity,
        level,
        questionCount: 10,
        hostPassword: hostPasswordInput || undefined,
        teamMode,
        music: { track: local.track, enabled: local.enabled, volume: local.volume },
      });
    });
  }

  const qrUrl = room ? joinQrUrl(room) : null;
  const textUrl = room ? joinTextUrl(room) : null;
  const showBigQr = !!room && room.status === 'lobby' && room.showQr !== false && !qrHidden;
  const showMiniQr = !!room && room.status !== 'lobby' && room.status !== 'finished' && room.showQr !== false && !qrHidden;
  const canSetup = room?.status === 'lobby' || room?.status === 'finished';

  if (!room) {
    return (
      <div className="display-screen display-wait">
        <header className="display-wait-head">
          <h1 className="title">송출 화면</h1>
          <p className="subtitle">프로젝터·TV에 띄울 PC 화면이에요. 진행자 비밀번호는 여기에 넣지 않아요.</p>
          <button className="btn btn-sm" type="button" onClick={toggleFullscreen}>
            {fullscreen ? '전체화면 끄기' : '전체화면'}
          </button>
        </header>
        {error && <p className="form-error form-error-banner">{error}</p>}
        <div className="display-wait-grid">
          <section className="display-pair-card card stack">
            <h2 className="card-title">
              <span className="title-block block-blue" aria-hidden />
              폰에서 만든 방 연결
            </h2>
            <p className="subtitle" style={{ textAlign: 'left', margin: 0 }}>
              선생님 폰 리모컨이나 진행자 화면에서 아래 숫자 6자리를 입력하면 이 PC가 그 방 송출 화면이 됩니다.
            </p>
            <div className="pair-code-big" aria-live="polite">
              {(pairCode ?? '······').split('').map((d, i) => (
                <span key={i} className="pair-digit">
                  {d}
                </span>
              ))}
            </div>
            {pairCode && (
              <div className="pair-qr-wrap">
                <QrCode value={pairUrl(pairCode)} label="송출 연결 QR" className="qr-pair" />
                <p className="fine-print">휴대폰으로 이 QR을 찍으면 리모컨에서 연결을 확인할 수 있어요.</p>
                <p className="join-text-url">{displayUrl(pairUrl(pairCode))}</p>
              </div>
            )}
            <button className="btn btn-sm" type="button" onClick={requestPair}>
              짝 코드 새로 받기
            </button>
          </section>

          <section className="display-create-card card stack">
            <h2 className="card-title">
              <span className="title-block block-gold" aria-hidden />
              이 PC에서 방 만들기
            </h2>
            <p className="subtitle" style={{ textAlign: 'left', margin: 0 }}>
              방을 만들면 바로 송출 화면으로 바뀌어요. 진행·음악·일시정지는 폰 리모컨으로 하세요.
            </p>
            <input className="input" value={title} maxLength={40} onChange={(e) => setTitle(e.target.value)} placeholder="방 제목" />
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              {MAP_OPTIONS.map((o) => (
                <button key={o.value} type="button" className={`chip ${map === o.value ? 'on' : ''}`} onClick={() => setMap(o.value)}>
                  {o.label}
                </button>
              ))}
            </div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              {([4, 8, 'unlimited'] as Capacity[]).map((c) => (
                <button key={String(c)} type="button" className={`chip ${capacity === c ? 'on' : ''}`} onClick={() => setCapacity(c)}>
                  {c === 'unlimited' ? '제한 없음' : `${c}명`}
                </button>
              ))}
            </div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              {(['elementary', 'middle', 'high', 'youth'] as Level[]).map((lv) => (
                <button key={lv} type="button" className={`chip ${level === lv ? 'on' : ''}`} onClick={() => setLevel(lv)}>
                  {LEVEL_LABELS[lv]}
                </button>
              ))}
            </div>
            <p className="picker-label">진행자 비밀번호 (선생님 폰 리모컨용, 영문·숫자 4~12자)</p>
            <input
              className="input host-pw-input"
              type="password"
              autoComplete="off"
              placeholder="비워 두면 자동으로 만들어요"
              maxLength={12}
              value={hostPasswordInput}
              onChange={(e) => setHostPasswordInput(e.target.value.replace(/[^0-9A-Za-z]/g, '').slice(0, 12))}
            />
            <p className="picker-label">더 재미있게</p>
            <div className="row row-wrap toggle-row">
              <button type="button" className={`btn btn-sm toggle-btn ${teamMode ? 'btn-primary' : ''}`} onClick={() => setTeamMode((v) => !v)}>
                팀 대결 {teamMode ? '켜짐' : '꺼짐'}
              </button>
            </div>
            <MusicPicker preview />
            <button className="btn btn-primary" type="button" disabled={creating || !title.trim()} onClick={createRoomHere}>
              {creating ? '만드는 중…' : '방 만들고 송출 시작'}
            </button>
            <p className="fine-print">방을 만들면 진행자 비밀번호와 리모컨 QR을 잠깐 보여 준 뒤 숨겨요. 프로젝터에 계속 두지 마세요.</p>
          </section>
        </div>
        <p className="fine-print display-wait-foot">
          <Link to="/host">진행자 화면</Link> · <Link to="/">학생 화면</Link>
        </p>
      </div>
    );
  }

  const remUrl = setupCard ? remoteUrl({ joinCode: setupCard.joinCode, id: setupCard.roomId }) : room ? remoteUrl(room) : null;

  return (
    <div className={`display-screen host-screen host-room-screen ${fullscreen ? 'is-fullscreen' : ''}`}>
      {setupOpen && setupCard && remUrl && (
        <div className="display-setup-overlay" role="dialog" aria-label="리모컨 연결 안내">
          <div className="display-setup-card card stack">
            <h2 className="card-title display-setup-title">
              <span className="title-block block-gold" aria-hidden />
              <span className="display-setup-title-text">폰 리모컨 연결</span>
            </h2>
            <p className="subtitle display-setup-lead">
              잠깐만 보여 준 뒤 숨겨요. 휴대폰으로 QR을 찍거나 주소를 연 다음, 진행자 비밀번호를 입력하세요.
            </p>
            <div className="display-setup-pw">
              <span>진행자 비밀번호</span>
              <b className="display-setup-pw-value">{setupCard.hostPassword}</b>
            </div>
            {setupCard.pin && (
              <p className="fine-print">
                방 PIN(학생용) <b>{setupCard.pin}</b> · 입장 코드 <b>{setupCard.joinCode}</b>
              </p>
            )}
            <div className="pair-qr-wrap">
              <QrCode value={remUrl} label="리모컨 QR" className="qr-pair" />
              <p className="join-text-url">{displayUrl(remUrl)}</p>
            </div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" type="button" onClick={() => setSetupOpen(false)}>
                숨기기
              </button>
              <a className="btn" href={`#/remote/${setupCard.joinCode}`} target="_blank" rel="noreferrer">
                이 기기에서 리모컨 열기
              </a>
            </div>
            <p className="fine-print">프로젝터에 비밀번호가 남지 않게, 확인한 뒤 바로 숨겨 주세요.</p>
          </div>
        </div>
      )}

      <div className="host-header display-header">
        <div>
          <h1 className="title" style={{ textAlign: 'left' }}>
            {room.title}
          </h1>
          <p className="subtitle" style={{ textAlign: 'left', margin: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            참여 {room.players.length}명
            <span className={`badge badge-level ${LEVEL_CLASS[room.level]}`}>{LEVEL_LABELS[room.level]}</span>
            {room.team?.enabled && <span className="badge badge-team">팀 대결</span>}
            {room.pin && <span className="badge badge-pin">방 PIN {room.pin}</span>}
            <span className="badge">송출</span>
          </p>
        </div>
        <div className="row host-header-actions">
          {setupCard && room.status === 'lobby' && (
            <button className="btn btn-sm" type="button" onClick={() => setSetupOpen(true)}>
              리모컨 안내 잠깐 보기
            </button>
          )}
          {(room.status === 'question' || room.status === 'reveal') && (
            <button className="btn btn-sm" type="button" onClick={() => setQrHidden((v) => !v)}>
              {qrHidden || room.showQr === false ? 'QR 보이기' : 'QR 숨기기'}
            </button>
          )}
          <button className="btn btn-sm btn-primary" type="button" onClick={toggleFullscreen}>
            {fullscreen ? '전체화면 끄기' : '전체화면'}
          </button>
        </div>
      </div>

      {error && <p className="form-error form-error-banner">{error}</p>}

      <QuestionBanners room={room} now={now} />

      <div className="host-main display-main">
        <div className="map-column">
          <ResultHud room={room} />
          {room.status === 'lobby' && room.pin && (
            <div className="pin-board">
              <span className="pin-board-label">
                방 PIN
                <small>학생 입장용 · 숫자 4자리</small>
              </span>
              <PinDigits pin={room.pin} />
            </div>
          )}
          <ResultTeams room={room} />
          <RoomStage room={room} positions={positions} />
        </div>

        <div className={`side-panel display-side ${room.status === 'finished' ? 'side-finished' : ''}`}>
          {showBigQr && qrUrl && (
            <div className="display-qr-panel lobby">
              <QrCode value={qrUrl} label="학생 입장 QR" className="qr-lobby" />
              <p className="join-text-url">{textUrl}</p>
              <p className="fine-print">QR을 찍으면 방 PIN이 채워진 참가 화면이 열려요. 글자 주소에는 PIN이 없어요.</p>
            </div>
          )}
          {showMiniQr && qrUrl && (
            <div className="display-qr-panel mini">
              <QrCode value={qrUrl} label="학생 입장 QR (작게)" className="qr-mini" />
              {room.pin && <span className="badge badge-pin">PIN {room.pin}</span>}
            </div>
          )}
          {canSetup && <TeamBoard room={room} />}
          {!canSetup && room.team?.enabled && <TeamBoard room={room} />}
          <ScoreList room={room} />
          {room.status === 'finished' && room.finalResult?.recorded && room.groupCode && (
            <p className="fine-print side-note">달란트가 {room.groupCode} 반 장부에 기록됐어요.</p>
          )}
        </div>
      </div>
    </div>
  );
}
