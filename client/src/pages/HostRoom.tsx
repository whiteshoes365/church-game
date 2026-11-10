import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { gameSocket } from '../ws';
import { AvatarIcon } from '../components/AvatarIcon';
import { BannerAdSlot } from '../components/BannerAdSlot';
import { isWebGLAvailable } from '../three/webgl';
import type { PlayerPosition, PlayerSnapshot, RoomSnapshot } from '../protocol';
import type { ResultColumn } from '../three/ResultCanvas3D';
import { loadGroupSession, normalizeGroupCode, saveGroupSession } from '../groupSession';
import { LEVEL_CLASS, LEVEL_LABELS } from '../levels';
import { CATEGORY_CLASS, CATEGORY_LABELS } from '../categories';

const HostCanvas3D = lazy(() => import('../three/HostCanvas3D'));
const ResultCanvas3D = lazy(() => import('../three/ResultCanvas3D'));

const RANK_COLORS = ['#f5c518', '#b8c2cc', '#c9803a'];

// 게임이 끝났을 때 3D 결과 무대에 세울 단상들.
// 팀 대결이면 팀별 단상(이긴 팀이 가장 높게), 아니면 1·2·3등 단상.
function buildResultColumns(room: RoomSnapshot): ResultColumn[] {
  const final = room.finalResult;
  if (final?.team) {
    const order = [...final.team.teams].sort((a, b) => b.average - a.average);
    const cols = final.team.teams.map((t) => {
      const place = order.filter((o) => o.average > t.average).length; // 0 = 우승
      return {
        id: t.id,
        color: t.color,
        height: Math.max(1, 3 - place),
        winner: final.team!.winnerTeamIds.includes(t.id),
        members: room.players.filter((p) => p.teamId === t.id).map((p) => ({ id: p.id, nickname: p.nickname, avatar: p.avatar })),
      };
    });
    return cols;
  }
  const scores = [...new Set(room.players.map((p) => p.score))].sort((a, b) => b - a).slice(0, 3);
  const cols = scores.map((score, i) => ({
    id: `rank-${i}`,
    color: RANK_COLORS[i],
    height: 3 - i,
    winner: i === 0 && score > 0,
    members: room.players.filter((p) => p.score === score).slice(0, 12).map((p) => ({ id: p.id, nickname: p.nickname, avatar: p.avatar })),
  }));
  // 시상대처럼 2등 - 1등 - 3등 순서로 세운다.
  if (cols.length >= 2) return [cols[1], cols[0], ...cols.slice(2)];
  return cols;
}

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
  const [positions, setPositions] = useState<Record<string, PlayerPosition>>({});
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [linkCode, setLinkCode] = useState(() => loadGroupSession()?.code ?? '');
  const [linkPin, setLinkPin] = useState(() => loadGroupSession()?.pin ?? '');
  const webglAvailable = useMemo(() => isWebGLAvailable(), []);

  useEffect(() => {
    gameSocket.connect();
    gameSocket.send('hostOpenRoom', { roomId });
    const offState = gameSocket.on('roomState', (msg) => {
      if (msg.room.id === roomId) setRoom(msg.room);
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
    return () => {
      offState();
      offError();
      offPositions();
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
  const team = room.team?.enabled ? room.team : null;
  const teamById = new Map((team?.teams ?? []).map((t) => [t.id, t]));
  const canSetup = room.status === 'lobby' || room.status === 'finished';
  const final = room.status === 'finished' ? room.finalResult ?? null : null;
  const resultColumns = final ? buildResultColumns(room) : [];
  const mvpNames = final ? room.players.filter((p) => final.mvpIds.includes(p.id)).map((p) => p.nickname) : [];
  const winners = final?.team ? final.team.teams.filter((t) => final.team!.winnerTeamIds.includes(t.id)) : [];
  const awardById = new Map((final?.awards ?? []).map((a) => [a.id, a]));
  const maxAvg = Math.max(1, ...(team?.teams ?? []).map((t) => t.average));

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

  return (
    <div className="host-screen host-room-screen">
      <div className="host-header">
        <div>
          <h1 className="title" style={{ textAlign: 'left' }}>
            {room.title}
          </h1>
          <p className="subtitle" style={{ textAlign: 'left', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            참여 인원 {room.players.length}명
            <span className={`badge badge-level ${LEVEL_CLASS[room.level]}`}>{LEVEL_LABELS[room.level]}</span>
            {team && <span className="badge badge-team">팀 대결</span>}
            {room.groupCode && <span className="badge badge-group">{room.groupCode} 반 기록 중</span>}
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

      <div className="host-main">
        <div className="map-column">
          <div className="host-hud">
            {room.status === 'question' && room.question && (
              <div className="question-strip">
                <span className="badge">
                  문제 {room.question.index + 1} / {room.question.total}
                </span>
                {room.question.category && (
                  <span className={`badge badge-category ${CATEGORY_CLASS[room.question.category]}`}>
                    {CATEGORY_LABELS[room.question.category]}
                  </span>
                )}
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
              <div className="reveal-banner stack">
                <span>
                  정답: {room.lastResult.correctAnswer} · {room.lastResult.questionText}
                  {room.lastResult.category && (
                    <span className={`badge badge-category ${CATEGORY_CLASS[room.lastResult.category]}`} style={{ marginLeft: 8 }}>
                      {CATEGORY_LABELS[room.lastResult.category]}
                    </span>
                  )}
                </span>
                {room.lastResult.explanation && <p className="explanation-text">{room.lastResult.explanation}</p>}
              </div>
            )}

            {final && (
              <div className={`result-banner ${final.team ? 'team' : ''}`}>
                {final.team ? (
                  <>
                    <span className="result-tag win">{final.team.tie ? '공동 우승' : '이긴 팀'}</span>
                    <span className="result-headline">
                      {winners.map((t) => (
                        <span key={t.id} className="result-team-name" style={{ background: t.color }}>
                          {t.name}
                        </span>
                      ))}
                      {final.team.tie ? '무승부!' : '승리!'}
                    </span>
                    {final.team.bonus > 0 && room.groupCode && <span className="result-bonus">팀원 모두 +{final.team.bonus} 달란트</span>}
                  </>
                ) : (
                  <>
                    <span className="result-tag win">퀴즈 종료</span>
                    <span className="result-headline">{mvpNames.length > 0 ? `오늘의 MVP ${mvpNames.join(' · ')}` : '모두 수고했어요!'}</span>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="map-area-3d">
            {final && final.team && (
              <div className="result-teams">
                {final.team.teams.map((t) => {
                  const won = final.team!.winnerTeamIds.includes(t.id);
                  return (
                    <div key={t.id} className={`result-team-card ${won ? 'win' : 'lose'}`} style={{ borderColor: t.color }}>
                      <span className={`result-tag ${won ? 'win' : 'lose'}`}>{won ? (final.team!.tie ? '무승부' : '이긴 팀') : '진 팀'}</span>
                      <span className="result-team-title">
                        <span className="team-dot" style={{ background: t.color }} />
                        {t.name}
                      </span>
                      <span className="result-team-score">
                        평균 {t.average}점 <small>합계 {t.total}점 · {t.size}명</small>
                      </span>
                      {!won && <span className="result-cheer">아쉽지만 잘했어요! 다음엔 이기자!</span>}
                    </div>
                  );
                })}
              </div>
            )}
            {final && !final.team && mvpNames.length > 0 && (
              <div className="result-teams">
                <div className="result-team-card win" style={{ borderColor: '#f5c518' }}>
                  <span className="result-tag win">오늘의 MVP</span>
                  <span className="result-team-title">{mvpNames.join(' · ')}</span>
                </div>
              </div>
            )}
            {final && webglAvailable ? (
              <Suspense fallback={<div className={`map-area ${MAP_CLASS[room.map]}`} />}>
                <div className="canvas-fill">
                  <ResultCanvas3D columns={resultColumns} />
                </div>
              </Suspense>
            ) : webglAvailable ? (
              <Suspense fallback={<div className={`map-area ${MAP_CLASS[room.map]}`} />}>
                <div className="canvas-fill">
                  <HostCanvas3D
                    players={room.players}
                    status={room.status}
                    correctAnswer={room.lastResult?.correctAnswer ?? null}
                    positions={positions}
                    zones={room.zones}
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

        <div className={`side-panel ${final ? 'side-finished' : ''}`}>
          {canSetup && (
            <div className="setup-panel">
              <div className="setup-row">
                <b>팀 대결</b>
                <button
                  className={`btn btn-sm ${team ? 'btn-primary' : ''}`}
                  onClick={() => gameSocket.send('setTeamMode', { roomId, enabled: !team })}
                >
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
                      value={linkPin}
                      onChange={(e) => setLinkPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                    />
                    <button className="btn btn-sm" onClick={linkGroup}>
                      연결
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {team && (
            <div className="team-board">
              {team.teams.map((t) => (
                <div key={t.id} className="team-box" style={{ borderColor: t.color }}>
                  <div className="team-box-head" style={{ background: t.color }}>
                    <span>{t.name}</span>
                    <span>{room.status === 'lobby' ? `${t.size}명` : `평균 ${t.average}`}</span>
                  </div>
                  {room.status !== 'lobby' && (
                    <div className="team-bar">
                      <div className="team-bar-fill" style={{ width: `${(t.average / maxAvg) * 100}%`, background: t.color }} />
                    </div>
                  )}
                  {canSetup && (
                    <div className="team-members">
                      {room.players
                        .filter((p) => p.teamId === t.id)
                        .map((p) => (
                          <button key={p.id} className="team-member" onClick={() => nextTeamOf(p)} title="누르면 다음 팀으로">
                            {p.nickname}
                          </button>
                        ))}
                      {t.size === 0 && <span className="fine-print">아직 없음</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="scoreboard">
            {sorted.length === 0 && <p className="subtitle">아직 참여한 친구가 없어요.</p>}
            {sorted.map((p, i) => {
              const t = p.teamId ? teamById.get(p.teamId) : undefined;
              const award = awardById.get(p.id);
              return (
                <div key={p.id} className="scoreboard-row">
                  <span>
                    {t && <span className="team-dot" style={{ background: t.color }} />}
                    {i + 1}. {p.nickname}
                    {final?.mvpIds.includes(p.id) && <span className="mvp-chip">MVP</span>}
                  </span>
                  <span>
                    {p.score}점{award && <span className="award-chip">+{award.delta}</span>}
                  </span>
                </div>
              );
            })}
          </div>
          {final?.recorded && <p className="fine-print side-note">달란트가 {room.groupCode} 반 장부에 기록됐어요.</p>}
          <BannerAdSlot />
        </div>
      </div>
    </div>
  );
}
