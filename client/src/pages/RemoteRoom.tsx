// 선생님 휴대폰 리모컨. 진행자 비밀번호로 권한을 얻고, 송출 PC·진행자 화면과 상태를 맞춘다.
// /#/remote/:codeOrId  · /#/remote/pair/:pairCode (PC 짝 코드 QR을 찍었을 때)
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MusicPicker } from '../components/MusicPicker';
import { QrCode } from '../components/QrCode';
import { AvatarIcon } from '../components/AvatarIcon';
import { controlKeys, getLastRemoteRoom, hostCredentials, saveLastRemoteRoom } from '../hostKeys';
import { displayUrl, joinTextUrl, normalizeJoinCode, remoteUrl } from '../joinLink';
import { CATEGORY_CLASS, CATEGORY_LABELS } from '../categories';
import { LEVEL_CLASS, LEVEL_LABELS } from '../levels';
import type { PlayerSnapshot, RoomSnapshot } from '../protocol';
import { questionLeftMs, useQuestionClock } from '../roomTime';
import { useRoomMusic } from '../useRoomMusic';
import { gameSocket } from '../ws';
import { StaffQuestionReports } from '../components/QuestionReport';

type ZoneCounts = { O: number; X: number; none: number };

export function RemoteRoom() {
  const { codeOrId, pairCode: routePair } = useParams<{ codeOrId?: string; pairCode?: string }>();
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [needAuth, setNeedAuth] = useState<string | null>(null);
  const [hostPassword, setHostPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [zoneCounts, setZoneCounts] = useState<ZoneCounts>({ O: 0, X: 0, none: 0 });
  const [pairInput, setPairInput] = useState(routePair ?? '');
  const [resolveHint, setResolveHint] = useState<string | null>(null);
  const pendingPairRef = useRef<string | null>(routePair ?? null);
  const roomIdRef = useRef<string | null>(null);
  const now = useQuestionClock(room);

  // 소리는 내지 않고, 고른 곡·음량만 서버(→ 송출 PC)로 보낸다.
  useRoomMusic(room, { play: false, publish: true });

  const openRemote = useCallback((id: string, password?: string) => {
    const creds = hostCredentials(id);
    gameSocket.send('hostOpenRoom', {
      roomId: id,
      as: 'remote',
      ...creds,
      ...(password ? { hostPassword: password } : {}),
    });
  }, []);

  useEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);

  useEffect(() => {
    gameSocket.connect();
    const offAuth = gameSocket.on('hostAuthRequired', (msg) => {
      setNeedAuth(msg.message);
      setRoom(null);
    });
    const offState = gameSocket.on('roomState', (msg) => {
      // 리모컨 스냅샷에는 controlKey·hostPassword 가 있다.
      if (!msg.room.controlKey && !msg.room.hostPassword) return;
      setRoom(msg.room);
      setRoomId(msg.room.id);
      roomIdRef.current = msg.room.id;
      setNeedAuth(null);
      setError(null);
      if (msg.room.controlKey) controlKeys.save(msg.room.id, msg.room.controlKey);
      saveLastRemoteRoom(msg.room.id);
      const pending = pendingPairRef.current;
      if (pending) {
        pendingPairRef.current = null;
        gameSocket.send('pairDisplay', { roomId: msg.room.id, code: pending });
      }
    });
    const offStatus = gameSocket.on('remoteStatus', (msg) => {
      if (roomIdRef.current && msg.roomId === roomIdRef.current) setZoneCounts(msg.zoneCounts);
    });
    const offLinked = gameSocket.on('displayLinked', () => {
      setError(null);
      setPairInput('');
    });
    const offResolved = gameSocket.on('joinCodeResolved', (msg) => {
      const wanted = normalizeJoinCode(codeOrId ?? '');
      if (wanted && normalizeJoinCode(msg.code) !== wanted) return;
      if (!msg.roomId) {
        setResolveHint('이 코드로 열린 방이 없어요. 방 id를 직접 넣거나 진행자 화면에서 리모컨 주소를 열어 주세요.');
        return;
      }
      setResolveHint(null);
      setRoomId(msg.roomId);
      roomIdRef.current = msg.roomId;
      openRemote(msg.roomId);
    });
    const offError = gameSocket.on('error', (msg) => {
      setError(msg.message);
      setTimeout(() => setError((cur) => (cur === msg.message ? null : cur)), 5000);
    });
    const reopen = () => {
      if (roomIdRef.current) openRemote(roomIdRef.current);
    };
    const offReconnect = gameSocket.onReconnect(reopen);

    // 진입: 짝 코드만 있으면 마지막 리모컨 방 또는 비밀번호 입력을 기다린다.
    if (routePair && !codeOrId) {
      const last = getLastRemoteRoom();
      if (last) {
        setRoomId(last);
        roomIdRef.current = last;
        openRemote(last);
      } else {
        setNeedAuth('송출 PC를 연결하려면 먼저 그 방의 진행자 비밀번호로 리모컨을 열어 주세요.');
      }
    } else if (codeOrId) {
      // 입장 코드(5자) 또는 방 uuid
      if (/^[0-9A-Za-z-]{20,}$/.test(codeOrId)) {
        setRoomId(codeOrId);
        roomIdRef.current = codeOrId;
        openRemote(codeOrId);
      } else {
        gameSocket.send('resolveJoinCode', { code: codeOrId });
      }
    }

    return () => {
      offAuth();
      offState();
      offStatus();
      offLinked();
      offResolved();
      offError();
      offReconnect();
    };
  }, [codeOrId, openRemote, routePair]);

  function submitPassword() {
    if (!roomId || hostPassword.length < 4) return;
    openRemote(roomId, hostPassword);
  }

  function pairNow() {
    if (!roomId || !/^\d{6}$/.test(pairInput)) {
      setError('PC 송출 화면에 보이는 숫자 6자리를 입력해 주세요.');
      return;
    }
    gameSocket.send('pairDisplay', { roomId, code: pairInput });
  }

  const answered = useMemo(() => {
    if (!room) return 0;
    return room.players.filter((p) => p.side === 'O' || p.side === 'X').length;
  }, [room]);

  if (!room) {
    return (
      <div className="screen remote-screen">
        <div className="screen-narrow stack">
          <h1 className="title">선생님 리모컨</h1>
          {resolveHint && <p className="form-error">{resolveHint}</p>}
          {needAuth ? (
            <div className="card stack">
              <h2 className="card-title">
                <span className="title-block block-blue" aria-hidden />
                진행자 확인
              </h2>
              <p className="subtitle" style={{ textAlign: 'left', margin: 0 }}>
                {needAuth}
              </p>
              {!roomId && (
                <input
                  className="input"
                  placeholder="방 입장 코드 또는 방 id"
                  value={codeOrId ?? ''}
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    if (/^[0-9A-Za-z-]{20,}$/.test(v)) {
                      setRoomId(v);
                    } else if (v.length >= 5) {
                      gameSocket.send('resolveJoinCode', { code: v });
                    }
                  }}
                />
              )}
              <p className="picker-label">진행자 비밀번호 (선생님만, 영문·숫자 4~12자)</p>
              <input
                className="input host-pw-input"
                type="password"
                autoComplete="off"
                placeholder="진행자 비밀번호"
                maxLength={12}
                value={hostPassword}
                onChange={(e) => setHostPassword(e.target.value.replace(/[^0-9A-Za-z]/g, '').slice(0, 12))}
                onKeyDown={(e) => e.key === 'Enter' && submitPassword()}
              />
              <button className="btn btn-primary" disabled={!roomId || hostPassword.length < 4} onClick={submitPassword}>
                리모컨 열기
              </button>
              <p className="fine-print">방 PIN으로는 열 수 없어요. 5번 틀리면 이 휴대폰만 30초 잠겨요.</p>
            </div>
          ) : (
            <p className="subtitle">방을 여는 중이에요…</p>
          )}
          {error && <p className="form-error">{error}</p>}
          <Link className="link-btn" to="/host">
            진행자 홈으로
          </Link>
        </div>
      </div>
    );
  }

  const q = room.question;
  const paused = !!q?.paused;
  const leftSec = Math.ceil(questionLeftMs(room, now) / 1000);
  const canSetup = room.status === 'lobby' || room.status === 'finished';
  const remoteLink = remoteUrl(room);
  const joinText = joinTextUrl(room);

  return (
    <div className="screen remote-screen">
      <div className="screen-narrow stack remote-stack">
        <header className="remote-head">
          <div>
            <h1 className="title" style={{ textAlign: 'left', fontSize: '1.35rem' }}>
              {room.title}
            </h1>
            <p className="subtitle" style={{ textAlign: 'left', margin: 0 }}>
              참가 {room.players.length}명
              <span className={`badge badge-level ${LEVEL_CLASS[room.level]}`}>{LEVEL_LABELS[room.level]}</span>
              {room.displayCount ? <span className="badge">송출 {room.displayCount}</span> : <span className="badge badge-warn">송출 없음</span>}
            </p>
          </div>
        </header>

        {error && <p className="form-error">{error}</p>}

        {/* 송출 PC 연결 */}
        <section className="card stack remote-card">
          <h2 className="card-title">
            <span className="title-block block-gold" aria-hidden />
            송출 PC 연결
          </h2>
          <p className="fine-print">PC `/#/display` 에 보이는 숫자 6자리(또는 QR)로 연결해요.</p>
          <div className="row" style={{ gap: 6 }}>
            <input
              className="input input-sm"
              inputMode="numeric"
              placeholder="000000"
              maxLength={6}
              value={pairInput}
              onChange={(e) => setPairInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
            <button className="btn btn-sm btn-primary" type="button" disabled={pairInput.length !== 6} onClick={pairNow}>
              연결
            </button>
          </div>
        </section>

        {/* 진행 버튼 */}
        <section className="card stack remote-card remote-controls">
          <h2 className="card-title">
            <span className="title-block block-blue" aria-hidden />
            진행
          </h2>
          <div className="remote-btn-grid">
            {canSetup && (
              <button className="btn btn-primary" type="button" onClick={() => gameSocket.send('startQuiz', { roomId: room.id })}>
                {room.status === 'finished' ? '다시 시작' : '퀴즈 시작'}
              </button>
            )}
            {room.status === 'question' && (
              <>
                <button
                  className="btn"
                  type="button"
                  onClick={() => gameSocket.send('pause', { roomId: room.id, paused: !paused })}
                >
                  {paused ? '재개' : '일시정지'}
                </button>
                <button className="btn" type="button" onClick={() => gameSocket.send('reveal', { roomId: room.id })}>
                  정답 공개
                </button>
              </>
            )}
            {room.status === 'reveal' && (
              <button className="btn btn-primary" type="button" onClick={() => gameSocket.send('nextQuestion', { roomId: room.id })}>
                다음 문제
              </button>
            )}
            {!canSetup && (
              <button className="btn" type="button" onClick={() => gameSocket.send('endQuiz', { roomId: room.id })}>
                결과로 끝내기
              </button>
            )}
          </div>
          {room.groupCode && (
            <a className="btn btn-sm" href={`#/host/group/${encodeURIComponent(room.groupCode)}`}>
              출석 · 달란트
            </a>
          )}
        </section>

        {/* 현재 문제 · 정답(리모컨만) · 응답 현황 */}
        {(room.status === 'question' || room.status === 'reveal') && q && (
          <section className="card stack remote-card">
            <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
              <span className="badge">
                문제 {q.index + 1} / {q.total}
              </span>
              {q.category && <span className={`badge badge-category ${CATEGORY_CLASS[q.category]}`}>{CATEGORY_LABELS[q.category]}</span>}
              {room.status === 'question' && (
                <span className={`badge ${paused ? 'badge-paused' : ''}`}>{paused ? `멈춤 · ${leftSec}초` : `${leftSec}초`}</span>
              )}
            </div>
            <p className="remote-question-text">{q.text}</p>
            {room.status === 'question' && q.answer && (
              <div className={`remote-answer-peek ${q.answer === 'O' ? 'o' : 'x'}`}>
                <span>선생님만 보는 정답</span>
                <b>{q.answer}</b>
                {q.explanation && <small>{q.explanation}</small>}
              </div>
            )}
            {room.status === 'reveal' && room.lastResult && (
              <div className={`remote-answer-peek ${room.lastResult.correctAnswer === 'O' ? 'o' : 'x'}`}>
                <span>공개된 정답</span>
                <b>{room.lastResult.correctAnswer}</b>
              </div>
            )}
            {room.status === 'question' && (
              <div className="remote-zones">
                <div className="remote-zone o">
                  O <b>{zoneCounts.O}</b>
                </div>
                <div className="remote-zone x">
                  X <b>{zoneCounts.X}</b>
                </div>
                <div className="remote-zone none">
                  미응답 <b>{zoneCounts.none}</b>
                </div>
                <p className="fine-print">
                  응답 {answered}/{room.players.length} (자리 기준)
                </p>
              </div>
            )}
          </section>
        )}

        <StaffQuestionReports
          roomId={room.id}
          current={q?.text ? { index: q.index, text: q.text } : null}
          prev={room.prevQuestion ?? null}
        />

        {/* 음악 · QR 표시 */}
        <section className="card stack remote-card">
          <h2 className="card-title">음악 · 송출 QR</h2>
          <p className="fine-print">소리는 송출 PC에서만 나요. 여기서는 곡·음량만 고릅니다.</p>
          <MusicPicker hint="소리는 송출 PC에서만 나요. 학생 폰·이 리모컨에서는 나지 않아요." />
          <div className="setup-row">
            <b>입장 QR 표시</b>
            <button
              className={`btn btn-sm ${room.showQr !== false ? 'btn-primary' : ''}`}
              type="button"
              onClick={() => gameSocket.send('setDisplayOptions', { roomId: room.id, showQr: room.showQr === false })}
            >
              {room.showQr === false ? '숨김' : '보임'}
            </button>
          </div>
        </section>

        {/* 참가자 · 강퇴 */}
        <section className="card stack remote-card">
          <h2 className="card-title">참가자</h2>
          {room.players.length === 0 && <p className="fine-print">아직 없어요.</p>}
          <ul className="remote-player-list">
            {[...room.players]
              .sort((a, b) => b.score - a.score)
              .map((p) => (
                <RemotePlayerRow key={p.id} player={p} roomId={room.id} />
              ))}
          </ul>
          {(room.kickedCount ?? 0) > 0 && (
            <button className="btn btn-sm" type="button" onClick={() => gameSocket.send('clearKicks', { roomId: room.id })}>
              내보낸 친구 다시 받기 ({room.kickedCount})
            </button>
          )}
        </section>

        {/* 안내 */}
        <section className="card stack remote-card">
          <h2 className="card-title">안내</h2>
          {room.pin && (
            <p>
              방 PIN <b>{room.pin}</b>
            </p>
          )}
          {joinText && <p className="join-text-url">{joinText}</p>}
          <p className="fine-print">이 리모컨 주소 (비밀번호는 넣지 않음)</p>
          <p className="join-text-url">{displayUrl(remoteLink)}</p>
          <QrCode value={remoteLink} label="리모컨 주소 QR" className="qr-remote-self" />
        </section>
      </div>
    </div>
  );
}

function RemotePlayerRow({ player, roomId }: { player: PlayerSnapshot; roomId: string }) {
  return (
    <li className="remote-player-row">
      <AvatarIcon avatarId={player.avatar} size={28} />
      <span className="remote-player-name">
        {player.nickname}
        {player.side && <span className={`badge side-${player.side.toLowerCase()}`}>{player.side}</span>}
      </span>
      <span>{player.score}점</span>
      <button
        className="btn btn-sm btn-danger"
        type="button"
        onClick={() => {
          if (confirm(`「${player.nickname}」을(를) 내보낼까요?`)) {
            gameSocket.send('kickPlayer', { roomId, playerId: player.id });
          }
        }}
      >
        강퇴
      </button>
    </li>
  );
}
