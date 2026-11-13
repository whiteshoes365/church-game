// 진행자 화면(HostRoom)과 송출 화면(Display)이 함께 쓰는 "보여 주기" 조각들.
// 여기에는 진행 버튼이 없다 — 문제·정답 띠, 3D 무대, 결과, 점수판만 그린다.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { AvatarIcon } from './AvatarIcon';
import { FitText } from './FitText';
import { isWebGLAvailable } from '../three/webgl';
import type { PlayerPosition, PlayerSnapshot, RoomSnapshot } from '../protocol';
import type { ResultColumn } from '../three/ResultCanvas3D';
import { CATEGORY_CLASS, CATEGORY_LABELS } from '../categories';
import { questionLeftMs } from '../roomTime';
import { QuestionTimerBar } from './QuestionTimerBar';
import { music } from '../music';
import { FloorDecal } from './FloorDecal';

const HostCanvas3D = lazy(() => import('../three/HostCanvas3D'));
const ResultCanvas3D = lazy(() => import('../three/ResultCanvas3D'));

const RANK_COLORS = ['#f5c518', '#b8c2cc', '#c9803a'];

// 게임이 끝났을 때 3D 결과 무대에 세울 단상들.
// 팀 대결이면 팀별 단상(이긴 팀이 가장 높게), 아니면 1·2·3등 단상.
export function buildResultColumns(room: RoomSnapshot): ResultColumn[] {
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
        // 결과 카드의 합계·평균을 낸 바로 그 팀원들 (끝난 뒤 팀을 다시 섞어도 결과는 그대로)
        members: room.players.filter((p) => (t.memberIds ? t.memberIds.includes(p.id) : p.teamId === t.id)).map((p) => ({ id: p.id, nickname: p.nickname, avatar: p.avatar, cosmetics: p.cosmetics })),
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
    members: room.players.filter((p) => p.score === score).slice(0, 12).map((p) => ({ id: p.id, nickname: p.nickname, avatar: p.avatar, cosmetics: p.cosmetics })),
  }));
  // 시상대처럼 2등 - 1등 - 3등 순서로 세운다.
  if (cols.length >= 2) return [cols[1], cols[0], ...cols.slice(2)];
  return cols;
}

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

/** 문제·정답 띠: 화면 위쪽 전체 폭에 아주 크게 (3D 무대를 가리지 않게 무대 밖에 둔다). */
export function QuestionBanners({ room, now }: { room: RoomSnapshot; now: number }) {
  const paused = !!room.question?.paused;
  return (
    <>
      {room.status === 'question' && room.question && (
        <div className={`question-banner ${paused ? 'paused' : ''}`}>
          <div className="question-banner-meta">
            <span className="badge">
              문제 {room.question.index + 1} / {room.question.total}
            </span>
            {room.question.category && (
              <span className={`badge badge-category ${CATEGORY_CLASS[room.question.category]}`}>{CATEGORY_LABELS[room.question.category]}</span>
            )}
            {paused && <span className="badge badge-paused">잠깐 멈춤 · {Math.ceil(questionLeftMs(room, now) / 1000)}초 남음</span>}
            <QuestionTimerBar room={room} />
          </div>
          <FitText className="question-banner-text" text={room.question.text ?? ''} maxHeightRatio={0.34} minPx={30} />
        </div>
      )}

      {room.status === 'reveal' && room.lastResult && (
        <div className="question-banner reveal">
          <div className={`answer-block ${room.lastResult.correctAnswer === 'O' ? 'o' : 'x'}`}>
            <small>정답</small>
            <b>{room.lastResult.correctAnswer}</b>
          </div>
          <div className="question-banner-body">
            <FitText className="question-banner-text" text={room.lastResult.questionText} maxHeightRatio={0.27} minPx={30} />
            {(room.lastResult.explanation || room.lastResult.category) && (
              <p className="question-banner-explanation">
                {room.lastResult.category && (
                  <span className={`badge badge-category ${CATEGORY_CLASS[room.lastResult.category]}`}>{CATEGORY_LABELS[room.lastResult.category]}</span>
                )}
                {room.lastResult.explanation}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** 게임이 끝났을 때 무대 위에 뜨는 한 줄 결과 (이긴 팀 / MVP). 0점이어도 띠는 보여 준다. */
export function ResultHud({ room }: { room: RoomSnapshot }) {
  if (room.status !== 'finished') return <div className="host-hud empty" />;
  const final = room.finalResult ?? null;
  const mvpNames = final ? room.players.filter((p) => final.mvpIds.includes(p.id)).map((p) => p.nickname) : [];
  const winners = final?.team ? final.team.teams.filter((t) => final.team!.winnerTeamIds.includes(t.id)) : [];
  const noScoredQuestions = !final || final.totalQuestions === 0;
  return (
    <div className="host-hud">
      <div className={`result-banner ${final?.team ? 'team' : ''}`}>
        {final?.team ? (
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
            <span className="result-headline">
              {noScoredQuestions
                ? '기록 없음 · 모두 수고했어요!'
                : mvpNames.length > 0
                  ? `오늘의 MVP ${mvpNames.join(' · ')}`
                  : '모두 수고했어요!'}
            </span>
            {noScoredQuestions && <span className="result-bonus">정답을 공개한 문제가 없어 0점으로 끝났어요</span>}
          </>
        )}
      </div>
    </div>
  );
}

/** 팀 대결 결과 카드 (합계·평균). */
export function ResultTeams({ room }: { room: RoomSnapshot }) {
  const final = room.status === 'finished' ? room.finalResult ?? null : null;
  if (!final || !final.team) return null;
  return (
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
              <span className="result-team-stat">
                합계 <b>{t.total}</b>점
              </span>
              <span className="result-team-stat">
                평균 <b>{t.average}</b>점
              </span>
              <span className="result-team-stat dim">{t.size}명</span>
            </span>
            {!won && <span className="result-cheer">아쉽지만 잘했어요!</span>}
          </div>
        );
      })}
    </div>
  );
}

const FLAT_BOUNDS = { xmin: -8, xmax: 8, zmin: -1, zmax: 9 }; // server MAP_BOUNDS (스냅샷에 없을 때만)

/** 2D 대체 화면에서의 자리: 서버가 알려 준 실제 자리(x, z)가 있으면 그대로 쓴다. */
function flatPosition(room: RoomSnapshot, player: PlayerSnapshot, pos?: PlayerPosition): { left: string; top: string } {
  const playing = room.status === 'question' || room.status === 'reveal';
  if (!pos || !playing) return positionFor(player);
  const b = room.bounds ?? FLAT_BOUNDS;
  const fx = Math.max(0, Math.min(1, (pos.x - b.xmin) / (b.xmax - b.xmin)));
  const fz = Math.max(0, Math.min(1, (pos.z - b.zmin) / (b.zmax - b.zmin)));
  return { left: `${(fx * 100).toFixed(2)}%`, top: `${(fz * 100).toFixed(2)}%` };
}

/** 2D 대체 화면의 바닥 O/X: 서버 채점 구역(room.zones)과 같은 자리·크기. */
function FlatZones({ room }: { room: RoomSnapshot }) {
  const b = room.bounds ?? FLAT_BOUNDS;
  const zones = room.zones;
  if (!zones) return null;
  const w = b.xmax - b.xmin;
  const h = b.zmax - b.zmin;
  const answer = room.status === 'reveal' ? (room.lastResult?.correctAnswer ?? null) : null;
  return (
    <div className="map-zones-flat">
      {(['O', 'X'] as const).map((key) => {
        const z = zones[key];
        return (
          <div
            key={key}
            className={`map-zone-floor ${key.toLowerCase()} ${answer ? (answer === key ? 'correct' : 'wrong') : ''}`}
            style={{
              left: `${((z.xmin - b.xmin) / w) * 100}%`,
              top: `${((z.zmin - b.zmin) / h) * 100}%`,
              width: `${((z.xmax - z.xmin) / w) * 100}%`,
              height: `${((z.zmax - z.zmin) / h) * 100}%`,
            }}
          >
            <FloorDecal shape={key} />
          </div>
        );
      })}
    </div>
  );
}

/** 3D 무대 (WebGL 이 없으면 2D 지도). 게임이 끝나면 결과 단상. */
export function RoomStage({ room, positions }: { room: RoomSnapshot; positions: Record<string, PlayerPosition> }) {
  const webglAvailable = useMemo(() => isWebGLAvailable(), []);
  const finished = room.status === 'finished';
  const final = finished ? room.finalResult ?? null : null;
  const resultColumns = finished ? buildResultColumns(room) : [];
  const [resultReady, setResultReady] = useState(false);

  useEffect(() => {
    if (!finished) setResultReady(false);
  }, [finished, room.id]);

  // 정답 공개 순간의 효과음: 맞힌 친구가 있으면 짧은 환호, 틀린 친구가 있으면 짧은 아쉬움.
  // 소리는 배경 음악 재생기를 거치므로 음악을 틀고 있는 화면(송출, 또는 송출이 없을 때의
  // 진행자 화면)에서만, 음악 소리 크기대로 난다. 음악이 꺼져 있거나 0 이면 나지 않는다.
  const revealing = room.status === 'reveal' && !!room.lastResult;
  const wasRevealing = useRef(revealing); // 공개 도중에 화면을 연 경우에는 울리지 않는다
  useEffect(() => {
    if (revealing && !wasRevealing.current && room.lastResult) {
      const correct = room.lastResult.correctPlayerIds.length;
      const wrong = room.players.length - correct;
      if (correct > 0) music.playSfx('cheer');
      if (wrong > 0) music.playSfx('aww', correct > 0 ? 0.75 : 0);
    }
    wasRevealing.current = revealing;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealing]);

  const showResultLayer = finished && webglAvailable;
  const keepPlayLayer = !showResultLayer || !resultReady;

  return (
    <div className="map-area-3d">
      {showResultLayer && (
        <div className={`canvas-fill result-layer ${resultReady ? 'ready' : 'loading'}`} aria-hidden={!resultReady}>
          <Suspense fallback={null}>
            <ResultCanvas3D columns={resultColumns} onReady={() => setResultReady(true)} />
          </Suspense>
        </div>
      )}
      {keepPlayLayer && webglAvailable && (
        <Suspense fallback={<div className={`map-area ${MAP_CLASS[room.map]}`} />}>
          <div className={`canvas-fill play-layer ${showResultLayer ? 'under-result' : ''}`}>
            <HostCanvas3D
              players={room.players}
              status={finished ? 'lobby' : room.status}
              correctAnswer={finished ? null : (room.lastResult?.correctAnswer ?? null)}
              correctPlayerIds={finished ? undefined : room.lastResult?.correctPlayerIds}
              positions={positions}
              zones={room.zones}
            />
          </div>
        </Suspense>
      )}
      {!webglAvailable && (
        <div className={`map-area ${MAP_CLASS[room.map]}`}>
          {room.status !== 'lobby' && room.status !== 'finished' && (
            <FlatZones room={room} />
          )}
          <div className="map-avatars">
            {room.players.map((p) => {
              const pos = flatPosition(room, p, positions[p.id]);
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
      {finished && final && resultColumns.length === 0 && (
        <div className="result-empty-stage" role="status">
          <b>기록 없음</b>
          <small>정답을 공개한 문제가 없어 시상대를 비워 두었어요</small>
        </div>
      )}
      {room.status === 'question' && room.question?.paused && (
        <div className="stage-paused" role="status">
          <b>잠깐 멈춤</b>
          <small>선생님이 다시 시작하면 시간이 이어서 흘러요</small>
        </div>
      )}
    </div>
  );
}

/** 팀 점수판. onMember 를 주면(진행자 화면, 시작 전) 이름을 눌러 팀을 옮길 수 있다. */
export function TeamBoard({ room, onMember }: { room: RoomSnapshot; onMember?: (p: PlayerSnapshot) => void }) {
  const team = room.team?.enabled ? room.team : null;
  if (!team) return null;
  const canSetup = room.status === 'lobby' || room.status === 'finished';
  // 팀 점수(합계·평균)는 게임 중에만 보여 준다. 끝난 뒤에는 결과 카드가 그 판의 점수를 보여 주고,
  // 여기는 다음 판을 위한 팀 편성(인원)만 보여 준다.
  const showTeamScore = room.status === 'question' || room.status === 'reveal';
  const maxAvg = Math.max(1, ...team.teams.map((t) => t.average));
  return (
    <div className="team-board">
      {team.teams.map((t) => (
        <div key={t.id} className="team-box" style={{ borderColor: t.color }}>
          <div className="team-box-head" style={{ background: t.color }}>
            <span>{t.name}</span>
            <span className="team-box-score">{showTeamScore ? `합계 ${t.total} · 평균 ${t.average}` : `${t.size}명`}</span>
          </div>
          {showTeamScore && (
            <div className="team-bar">
              <div className="team-bar-fill" style={{ width: `${(t.average / maxAvg) * 100}%`, background: t.color }} />
            </div>
          )}
          {canSetup && (
            <div className="team-members">
              {room.players
                .filter((p) => p.teamId === t.id)
                .map((p) =>
                  onMember ? (
                    <button key={p.id} className="team-member" onClick={() => onMember(p)} title="누르면 다음 팀으로">
                      {p.nickname}
                    </button>
                  ) : (
                    <span key={p.id} className="team-member team-member-static">
                      {p.nickname}
                    </span>
                  ),
                )}
              {t.size === 0 && <span className="fine-print">아직 없음</span>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** 개인 점수판 (점수 높은 순). 끝나면 MVP·받은 달란트도 보여 준다. */
export function ScoreList({ room }: { room: RoomSnapshot }) {
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  const team = room.team?.enabled ? room.team : null;
  const teamById = new Map((team?.teams ?? []).map((t) => [t.id, t]));
  const final = room.status === 'finished' ? room.finalResult ?? null : null;
  const awardById = new Map((final?.awards ?? []).map((a) => [a.id, a]));
  return (
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
              {p.score}점
              {award && (
                <span className={`award-chip ${award.capped ? 'capped' : ''}`} title={award.capped ? `주간 상한으로 ${award.requested}개 중 ${award.delta}개만 지급` : undefined}>
                  +{award.delta}
                  {award.capped && ' 상한'}
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** 방 PIN 숫자판 (큰 숫자 4칸). */
export function PinDigits({ pin }: { pin: string }) {
  return (
    <span className="pin-digits">
      {pin.split('').map((d, i) => (
        <span key={i} className="pin-digit">
          {d}
        </span>
      ))}
    </span>
  );
}
