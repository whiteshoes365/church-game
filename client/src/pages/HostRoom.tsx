import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { gameSocket } from '../ws';
import type { PlayerSnapshot, RoomSnapshot, PlayerPosition } from '../protocol';
import { loadGroupSession, normalizeGroupCode, saveGroupSession } from '../groupSession';
import { controlKeys, hostCredentials } from '../hostKeys';
import { LEVEL_CLASS, LEVEL_LABELS } from '../levels';
import { MusicPicker } from '../components/MusicPicker';
import { QrCode } from '../components/QrCode';
import {
  PinDigits,
  QuestionBanners,
  ResultHud,
  ResultTeams,
  RoomStage,
  ScoreList,
  TeamBoard,
} from '../components/RoomStage';
import { StaffQuestionReports } from '../components/QuestionReport';
import { displayUrl, joinQrUrl, joinTextUrl, remoteUrl } from '../joinLink';
import { useQuestionClock } from '../roomTime';
import { useRoomMusic } from '../useRoomMusic';

export function HostRoom() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [positions, setPositions] = useState<Record<string, PlayerPosition>>({});
  const [error, setError] = useState<string | null>(null);
  const [linkCode, setLinkCode] = useState(() => loadGroupSession()?.code ?? '');
  const [linkPin, setLinkPin] = useState(() => loadGroupSession()?.pin ?? '');
  const [needHostPin, setNeedHostPin] = useState<string | null>(null);
  const [hostPin, setHostPin] = useState('');
  const [showHostPw, setShowHostPw] = useState(false);
  const [newHostPw, setNewHostPw] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const now = useQuestionClock(room);

  // 송출 PC가 붙어 있으면 소리는 송출에서만, 없으면 이 진행자 PC에서.
  const playHere = !!room && (room.displayCount ?? 0) === 0;
  useRoomMusic(room, { play: playHere, publish: true });

  useEffect(() => {
    if (!roomId) return;
    gameSocket.connect();
    const open = (password?: string) => {
      gameSocket.send('hostOpenRoom', {
        roomId,
        ...hostCredentials(roomId),
        ...(password ? { hostPassword: password } : {}),
      });
    };
    open();
    const offReconnect = gameSocket.onReconnect(() => open());
    const offAuth = gameSocket.on('hostAuthRequired', (msg) => {
      if (msg.roomId === roomId) setNeedHostPin(msg.message);
    });
    const offState = gameSocket.on('roomState', (msg) => {
      if (msg.room.id !== roomId) return;
      setRoom(msg.room);
      setNeedHostPin(null);
      if (msg.room.controlKey) controlKeys.save(roomId, msg.room.controlKey);
    });
    const offError = gameSocket.on('error', (msg) => {
      setError(msg.message);
      setTimeout(() => setError((cur) => (cur === msg.message ? null : cur)), 4000);
    });
    const offPositions = gameSocket.on('positions', (msg) => {
      if (msg.roomId !== roomId) return;
      setPositions((prev) => {
        const next = { ...prev };
        for (const p of msg.players as PlayerPosition[]) next[p.id] = p;
        return next;
      });
    });
    const offLinked = gameSocket.on('displayLinked', () => {
      setPairCode('');
      setError(null);
    });
    return () => {
      offReconnect();
      offState();
      offError();
      offPositions();
      offAuth();
      offLinked();
    };
  }, [roomId]);

  if (!room) {
    return (
      <div className="screen">
        <div className="screen-narrow stack">
          {needHostPin ? (
            <div className="card stack">
              <h2 className="card-title">
                <span className="title-block block-blue" aria-hidden />
                진행자 확인
              </h2>
              <p className="subtitle" style={{ textAlign: 'left', margin: 0 }}>
                {needHostPin}
              </p>
              <p className="picker-label">진행자 비밀번호 (선생님만, 영문·숫자 4~12자)</p>
              <input
                className="input host-pw-input"
                type="password"
                autoComplete="off"
                placeholder="진행자 비밀번호"
                maxLength={12}
                value={hostPin}
                onChange={(e) => setHostPin(e.target.value.replace(/[^0-9A-Za-z]/g, '').slice(0, 12))}
                onKeyDown={(e) =>
                  e.key === 'Enter' &&
                  hostPin.length >= 4 &&
                  gameSocket.send('hostOpenRoom', { roomId, hostPassword: hostPin })
                }
              />
              <button
                className="btn btn-primary"
                disabled={hostPin.length < 4}
                onClick={() => gameSocket.send('hostOpenRoom', { roomId, hostPassword: hostPin })}
              >
                진행자 화면 열기
              </button>
              <p className="fine-print">방 PIN(학생용, 숫자 4자리)으로는 열 수 없어요. 5번 틀리면 이 기기에서 30초 동안 잠겨요.</p>
            </div>
          ) : (
            <p className="subtitle">{error ?? '방 정보를 불러오는 중이에요...'}</p>
          )}
          {needHostPin && error && <p className="form-error">{error}</p>}
          <button className="link-btn" onClick={() => navigate('/host')}>
            호스트 홈으로
          </button>
        </div>
      </div>
    );
  }

  const team = room.team?.enabled ? room.team : null;
  const canSetup = room.status === 'lobby' || room.status === 'finished';
  const final = room.status === 'finished' ? room.finalResult ?? null : null;
  const qrUrl = joinQrUrl(room);
  const textUrl = joinTextUrl(room);
  const remUrl = remoteUrl(room);
  const paused = !!room.question?.paused;

  function linkGroup() {
    const code = normalizeGroupCode(linkCode);
    if (!code || !/^\d{4,8}$/.test(linkPin)) {
      setError('반 코드와 교사 PIN(숫자 4~8자리)을 입력해 주세요.');
      return;
    }
    saveGroupSession({ code, pin: linkPin });
    gameSocket.send('linkGroup', { roomId, code, pin: linkPin });
  }

  function nextTeamOf(p: PlayerSnapshot) {
    if (!team) return;
    const ids = team.teams.map((t) => t.id);
    const next = ids[(ids.indexOf(p.teamId ?? '') + 1) % ids.length];
    gameSocket.send('assignTeam', { roomId, playerId: p.id, teamId: next });
  }

  async function copyText(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied((c) => (c === label ? null : c)), 2000);
    } catch {
      setError('복사에 실패했어요. 주소를 길게 눌러 복사해 주세요.');
    }
  }

  function pairDisplay() {
    if (!/^\d{6}$/.test(pairCode)) {
      setError('PC 송출 화면의 숫자 6자리를 입력해 주세요.');
      return;
    }
    gameSocket.send('pairDisplay', { roomId, code: pairCode });
  }

  return (
    <div className="host-screen host-room-screen">
      <div className="host-header">
        <div>
          <h1 className="title" style={{ textAlign: 'left' }}>
            {room.title}
          </h1>
          <p className="subtitle" style={{ textAlign: 'left', margin: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            참여 인원 {room.players.length}명
            <span className={`badge badge-level ${LEVEL_CLASS[room.level]}`}>{LEVEL_LABELS[room.level]}</span>
            {team && <span className="badge badge-team">팀 대결</span>}
            {room.groupCode && <span className="badge badge-group">{room.groupCode} 반 기록 중</span>}
            {room.pin && room.status !== 'lobby' && <span className="badge badge-pin">방 PIN {room.pin}</span>}
            {(room.displayCount ?? 0) > 0 && <span className="badge">송출 {room.displayCount}</span>}
            {(room.remoteCount ?? 0) > 0 && <span className="badge">리모컨 {room.remoteCount}</span>}
          </p>
        </div>
        <div className="row host-header-actions">
          {!canSetup && <MusicPicker compact />}
          {(room.status === 'lobby' || room.status === 'finished') && (
            <button className="btn btn-primary btn-sm" onClick={() => gameSocket.send('startQuiz', { roomId })}>
              {room.status === 'finished' ? '다시 시작' : 'OX 퀴즈 시작'}
            </button>
          )}
          {room.status === 'question' && (
            <>
              <button className="btn btn-sm" onClick={() => gameSocket.send('pause', { roomId, paused: !paused })}>
                {paused ? '재개' : '일시정지'}
              </button>
              <button className="btn btn-sm" onClick={() => gameSocket.send('reveal', { roomId })}>
                바로 정답 공개
              </button>
            </>
          )}
          {room.status === 'reveal' && (
            <button className="btn btn-primary btn-sm" onClick={() => gameSocket.send('nextQuestion', { roomId })}>
              다음 문제
            </button>
          )}
          {!canSetup && (
            <button className="btn btn-sm" onClick={() => gameSocket.send('endQuiz', { roomId })}>
              결과로
            </button>
          )}
          {room.groupCode && (
            <a className="btn btn-sm btn-link" href={`#/host/group/${encodeURIComponent(room.groupCode)}`} target="_blank" rel="noreferrer">
              출석 · 달란트
            </a>
          )}
          <button className="btn btn-sm" onClick={() => navigate('/host')}>
            나가기
          </button>
        </div>
      </div>

      {error && <p className="form-error form-error-banner">{error}</p>}

      <QuestionBanners room={room} now={now} />

      <StaffQuestionReports
        roomId={room.id}
        current={room.question?.text ? { index: room.question.index, text: room.question.text } : null}
        prev={room.prevQuestion ?? null}
      />

      <div className="host-main">
        <div className="map-column">
          <ResultHud room={room} />

          {room.status === 'lobby' && room.pin && (
            <div className="pin-board">
              <span className="pin-board-label">
                방 PIN
                <small>학생 입장용 · 친구들에게 이 숫자 4자리를 알려 주세요</small>
              </span>
              <PinDigits pin={room.pin} />
            </div>
          )}

          <ResultTeams room={room} />
          <RoomStage room={room} positions={positions} />
        </div>

        <div className={`side-panel ${final ? 'side-finished' : ''}`}>
          {canSetup && (
            <div className="setup-panel link-guide-panel">
              <b>송출 PC · 리모컨</b>
              <p className="fine-print">프로젝터 PC는 `/#/display` 를 열고, 아래 짝 코드로 붙이세요. 진행자 비밀번호는 송출 화면에 넣지 않아요.</p>
              <div className="row" style={{ gap: 6 }}>
                <input
                  className="input input-sm"
                  inputMode="numeric"
                  placeholder="PC 짝 코드 6자리"
                  maxLength={6}
                  value={pairCode}
                  onChange={(e) => setPairCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                />
                <button className="btn btn-sm btn-primary" type="button" disabled={pairCode.length !== 6} onClick={pairDisplay}>
                  PC 연결
                </button>
              </div>
              <p className="fine-print">
                송출 {(room.displayCount ?? 0) > 0 ? `${room.displayCount}대 연결됨` : '아직 없음'} · 리모컨{' '}
                {(room.remoteCount ?? 0) > 0 ? `${room.remoteCount}대` : '아직 없음'}
              </p>
              <a className="btn btn-sm" href="#/display" target="_blank" rel="noreferrer">
                이 PC에서 송출 화면 열기
              </a>
              <div className="remote-guide">
                <p className="fine-print">선생님 폰 리모컨 주소 (비밀번호는 주소에 넣지 않음)</p>
                <p className="join-text-url">{displayUrl(remUrl)}</p>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn btn-sm" type="button" onClick={() => copyText('remote', remUrl)}>
                    {copied === 'remote' ? '복사됨' : '주소 복사'}
                  </button>
                  <a className="btn btn-sm btn-primary" href={remUrl.replace(/^[^#]*/, '')} target="_blank" rel="noreferrer">
                    리모컨 열기
                  </a>
                </div>
                <QrCode value={remUrl} label="리모컨 QR" className="qr-host-remote" />
              </div>
              {qrUrl && (
                <div className="join-guide">
                  <p className="fine-print">학생 입장 (QR에는 방 PIN 포함, 글자 주소에는 없음)</p>
                  <QrCode value={qrUrl} label="학생 입장 QR" className="qr-host-join" />
                  {textUrl && <p className="join-text-url">{textUrl}</p>}
                  {textUrl && (
                    <button className="btn btn-sm" type="button" onClick={() => copyText('join', textUrl)}>
                      {copied === 'join' ? '복사됨' : '글자 주소 복사'}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {canSetup && (
            <div className="setup-panel music-panel">
              <MusicPicker />
              {(room.displayCount ?? 0) > 0 && <p className="fine-print">송출 PC가 연결되어 소리가 그쪽에서 나요.</p>}
            </div>
          )}

          {canSetup && (
            <div className="setup-panel">
              <div className="setup-row">
                <b>팀 대결</b>
                <button className={`btn btn-sm ${team ? 'btn-primary' : ''}`} onClick={() => gameSocket.send('setTeamMode', { roomId, enabled: !team })}>
                  {team ? '켜짐' : '꺼짐'}
                </button>
              </div>
              {team && (
                <>
                  <div className="setup-row">
                    <span>팀 수</span>
                    <div className="row" style={{ gap: 4 }}>
                      {[2, 3, 4].map((n) => (
                        <button key={n} className={`chip ${team.count === n ? 'on' : ''}`} onClick={() => gameSocket.send('setTeamMode', { roomId, count: n })}>
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="setup-row">
                    <span>승리 보너스</span>
                    <div className="stepper">
                      <button onClick={() => gameSocket.send('setTeamMode', { roomId, bonus: Math.max(0, team.bonus - 1) })}>-</button>
                      <span>{team.bonus}</span>
                      <button onClick={() => gameSocket.send('setTeamMode', { roomId, bonus: Math.min(5, team.bonus + 1) })}>+</button>
                    </div>
                  </div>
                  <button className="btn btn-sm setup-wide" onClick={() => gameSocket.send('autoSplitTeams', { roomId })}>
                    팀 다시 섞기
                  </button>
                  <p className="fine-print">이름을 누르면 다음 팀으로 옮겨요.</p>
                </>
              )}
              {room.hostPassword && (
                <div className="setup-link host-pw-box">
                  <div className="setup-row">
                    <b>진행자 비밀번호</b>
                    <button className="chip" onClick={() => setShowHostPw((v) => !v)}>
                      {showHostPw ? '가리기' : '보기'}
                    </button>
                  </div>
                  <div className="host-pw-value">{showHostPw ? room.hostPassword : '•'.repeat(room.hostPassword.length)}</div>
                  <p className="fine-print">선생님만 알고 계세요(영문·숫자 4~12자). 학생에게는 방 PIN({room.pin})만 알려 주세요.</p>
                  <div className="row" style={{ gap: 6 }}>
                    <input
                      className="input input-sm"
                      placeholder="새 비밀번호 (4~12자)"
                      maxLength={12}
                      autoComplete="off"
                      value={newHostPw}
                      onChange={(e) => setNewHostPw(e.target.value.replace(/[^0-9A-Za-z]/g, '').slice(0, 12))}
                    />
                    <button
                      className="btn btn-sm"
                      disabled={newHostPw.length < 4}
                      onClick={() => {
                        gameSocket.send('setHostPassword', { roomId, hostPassword: newHostPw });
                        setNewHostPw('');
                      }}
                    >
                      변경
                    </button>
                  </div>
                </div>
              )}
              {!room.groupCode && (
                <div className="setup-link">
                  <b>반 기록 연결</b>
                  <input className="input input-sm" placeholder="반 코드" value={linkCode} maxLength={20} onChange={(e) => setLinkCode(e.target.value)} />
                  <div className="row" style={{ gap: 6 }}>
                    <input
                      className="input input-sm"
                      type="password"
                      inputMode="numeric"
                      placeholder="교사 PIN"
                      aria-label="교사 PIN (반 기록용, 숫자 4~8자리)"
                      value={linkPin}
                      onChange={(e) => setLinkPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                    />
                    <button className="btn btn-sm" onClick={linkGroup}>
                      연결
                    </button>
                  </div>
                  <p className="fine-print">교사 PIN은 반 기록용 숫자 4~8자리예요.</p>
                </div>
              )}
            </div>
          )}

          {team && <TeamBoard room={room} onMember={canSetup ? nextTeamOf : undefined} />}

          <ScoreList room={room} />
          {final?.recorded && <p className="fine-print side-note">달란트가 {room.groupCode} 반 장부에 기록됐어요.</p>}
          {!canSetup && (
            <p className="fine-print side-note">
              <Link to={`/remote/${room.joinCode ?? room.id}`} target="_blank">
                폰 리모컨
              </Link>
              {' · '}
              <Link to={`/display/${room.id}`} target="_blank">
                송출 화면
              </Link>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
