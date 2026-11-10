import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { gameSocket } from '../ws';
import { AvatarIcon } from '../components/AvatarIcon';
import { DEFAULT_AVATAR_ID } from '../avatars';
import { loadGroupSession, normalizeGroupCode, saveGroupSession } from '../groupSession';
import { LEVEL_LABELS } from '../levels';
import type { GroupData, GroupMember, LedgerEntry } from '../protocol';

type Tab = 'attendance' | 'talent' | 'games';

const TABS: { id: Tab; label: string }[] = [
  { id: 'attendance', label: '출석부' },
  { id: 'talent', label: '달란트' },
  { id: 'games', label: '게임 기록' },
];

const KIND_LABEL: Record<LedgerEntry['kind'], string> = {
  game: '게임',
  team: '팀 대결',
  streak: '연속 출석',
  manual: '선생님',
  shop: '상점',
};

function formatWhen(at: number): string {
  return new Date(at).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function weekShort(id: string): string {
  return `${Number(id.slice(6))}주`;
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

function StreakBadge({ member }: { member: Pick<GroupMember, 'streak' | 'badge'> }) {
  if (!member.badge) return null;
  return (
    <span className={`streak-badge streak-${member.badge.id}`} title={member.badge.label}>
      <span className="streak-flame" aria-hidden />
      {member.streak}주 연속
    </span>
  );
}

export function HostGroup() {
  const { code: rawCode } = useParams<{ code: string }>();
  const code = normalizeGroupCode(rawCode ?? '');
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.id === params.get('tab'))?.id ?? 'attendance') as Tab;

  const [group, setGroup] = useState<GroupData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [needPin, setNeedPin] = useState(false);

  const [selected, setSelected] = useState<string | null>(null);
  const [delta, setDelta] = useState(1);
  const [reason, setReason] = useState('');
  const [newNick, setNewNick] = useState('');

  useEffect(() => {
    gameSocket.connect();
    const offData = gameSocket.on('groupData', (msg) => {
      if (msg.group.code !== code) return;
      setGroup(msg.group);
      setNeedPin(false);
      setError(null);
    });
    const offError = gameSocket.on('error', (msg) => {
      setError(msg.message);
      if (/PIN/.test(msg.message)) setNeedPin(true);
    });
    const session = loadGroupSession();
    if (session && session.code === code) gameSocket.send('groupOpen', { code, pin: session.pin });
    else setNeedPin(true);
    return () => {
      offData();
      offError();
    };
  }, [code]);

  function submitPin() {
    if (!/^\d{4,8}$/.test(pin)) {
      setError('교사 PIN은 숫자 4~8자리예요.');
      return;
    }
    saveGroupSession({ code, pin });
    gameSocket.send('groupOpen', { code, pin });
  }

  const selectedMember = useMemo(() => group?.members.find((m) => m.key === selected) ?? null, [group, selected]);
  const history = useMemo(
    () => (group ? (selected ? group.ledger.filter((e) => e.key === selected) : group.ledger).slice(0, 60) : []),
    [group, selected],
  );

  if (!group) {
    return (
      <div className="screen">
        <div className="screen-narrow stack">
          <h1 className="title">{code} 반 기록</h1>
          {needPin ? (
            <div className="card stack">
              <p className="picker-label">교사 PIN을 입력해 주세요</p>
              <input
                className="input"
                type="password"
                inputMode="numeric"
                placeholder="숫자 4~8자리"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                onKeyDown={(e) => e.key === 'Enter' && submitPin()}
              />
              <button className="btn btn-primary" onClick={submitPin}>
                열기
              </button>
            </div>
          ) : (
            <p className="subtitle">기록을 불러오는 중이에요...</p>
          )}
          {error && <p className="form-error">{error}</p>}
          <button className="link-btn" onClick={() => navigate('/host')}>
            호스트 홈으로
          </button>
        </div>
      </div>
    );
  }

  const present = group.members.filter((m) => m.presentThisWeek).sort((a, b) => a.nickname.localeCompare(b.nickname, 'ko'));
  const absent = group.members.filter((m) => !m.presentThisWeek);
  const byName = [...group.members].sort((a, b) => a.nickname.localeCompare(b.nickname, 'ko'));
  const thisWeek = group.weeks[group.weeks.length - 1];

  function applyAdjust(sign: 1 | -1) {
    if (!selectedMember) return;
    if (!reason.trim()) {
      setError('사유를 입력해 주세요.');
      return;
    }
    setError(null);
    gameSocket.send('groupAdjust', { code, nickname: selectedMember.nickname, delta: sign * delta, reason: reason.trim() });
    setReason('');
  }

  function changeCap(next: number) {
    const cap = Math.max(group!.rules.weeklyCapMin, Math.min(group!.rules.weeklyCapMax, next));
    if (cap !== group!.settings.weeklyCap) gameSocket.send('groupSettings', { code, weeklyCap: cap });
  }

  function addAttendance() {
    if (!newNick.trim()) return;
    gameSocket.send('groupMarkAttendance', { code, nickname: newNick.trim() });
    setNewNick('');
  }

  return (
    <div className="host-screen group-screen">
      <div className="host-header">
        <div>
          <h1 className="title" style={{ textAlign: 'left' }}>
            {group.code} 반 기록
          </h1>
          <p className="subtitle" style={{ textAlign: 'left', margin: 0 }}>
            이번 주 {weekShort(group.currentWeek)}차 ({thisWeek.label}) · 친구 {group.members.length}명
          </p>
        </div>
        <div className="row">
          {TABS.map((t) => (
            <button key={t.id} className={`btn btn-sm tab-btn ${tab === t.id ? 'btn-primary' : ''}`} onClick={() => setParams({ tab: t.id })}>
              {t.label}
            </button>
          ))}
          <button className="btn btn-sm" onClick={() => navigate('/host')}>
            나가기
          </button>
        </div>
      </div>

      {error && <p className="form-error form-error-banner">{error}</p>}

      {tab === 'attendance' && (
        <div className="group-grid">
          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">이번 주 출석</h2>
              <span className="count-block">
                {present.length}
                <small> / {group.members.length}명</small>
              </span>
            </div>

            {group.mvp.length > 0 && (
              <div className="mvp-banner">
                <span className="mvp-crown" aria-hidden />
                <div>
                  <div className="mvp-label">이번 주 MVP</div>
                  <div className="mvp-name">
                    {group.mvp.map((m) => m.nickname).join(' · ')} <small>+{group.mvp[0].weekTalents} 달란트</small>
                  </div>
                </div>
              </div>
            )}

            <div className="attend-cards">
              {present.length === 0 && <p className="subtitle">아직 이번 주에 출석한 친구가 없어요.</p>}
              {present.map((m) => (
                <div key={m.key} className="attend-card">
                  <AvatarIcon avatarId={m.avatar ?? DEFAULT_AVATAR_ID} cosmetics={m.equipped} size={44} />
                  <div className="attend-card-name">{m.nickname}</div>
                  <StreakBadge member={m} />
                </div>
              ))}
            </div>

            {absent.length > 0 && (
              <p className="absent-line">
                <b>아직 안 온 친구</b> {absent.map((m) => m.nickname).join(', ')}
              </p>
            )}

            <div className="row panel-foot">
              <input
                className="input input-sm"
                placeholder="폰 없는 친구 닉네임"
                maxLength={12}
                value={newNick}
                onChange={(e) => setNewNick(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addAttendance()}
              />
              <button className="btn btn-sm" onClick={addAttendance} disabled={!newNick.trim()}>
                출석 추가
              </button>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">주별 출석 기록</h2>
              <span className="panel-note">최근 {group.weeks.length}주</span>
            </div>
            <div className="table-scroll">
              <table className="attend-table">
                <thead>
                  <tr>
                    <th className="col-name">닉네임</th>
                    {group.weeks.map((w) => (
                      <th key={w.id} className={w.id === group.currentWeek ? 'col-now' : ''}>
                        {weekShort(w.id)}
                        <small>{w.label.split('~')[0]}</small>
                      </th>
                    ))}
                    <th>합계</th>
                    <th>연속</th>
                  </tr>
                </thead>
                <tbody>
                  {byName.map((m) => (
                    <tr key={m.key}>
                      <td className="col-name">{m.nickname}</td>
                      {group.weeks.map((w) => (
                        <td key={w.id} className={w.id === group.currentWeek ? 'col-now' : ''}>
                          <span className={`attend-cell ${m.attendedWeeks.includes(w.id) ? 'on' : ''}`} />
                        </td>
                      ))}
                      <td>{m.attendCount}회</td>
                      <td>{m.streak > 0 ? `${m.streak}주` : '-'}</td>
                    </tr>
                  ))}
                  <tr className="row-total">
                    <td className="col-name">출석 인원</td>
                    {group.weeks.map((w) => (
                      <td key={w.id} className={w.id === group.currentWeek ? 'col-now' : ''}>
                        {w.presentCount}
                      </td>
                    ))}
                    <td />
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {tab === 'talent' && (
        <div className="group-grid">
          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">달란트 순위 (누적)</h2>
              <span className="panel-note">이름을 누르면 내역을 볼 수 있어요</span>
            </div>
            <div className="cap-setting">
              <span className="cap-setting-label">
                <b>주간 상한</b>
                <small>
                  한 친구가 한 주에 자동으로 받을 수 있는 최대 달란트 ({group.rules.weeklyCapMin}~{group.rules.weeklyCapMax}, 기본 {group.rules.weeklyCapDefault})
                </small>
              </span>
              <div className="stepper stepper-lg">
                <button type="button" onClick={() => changeCap(group.settings.weeklyCap - 5)}>
                  -5
                </button>
                <button type="button" onClick={() => changeCap(group.settings.weeklyCap - 1)}>
                  -
                </button>
                <span className="cap-value">{group.settings.weeklyCap}</span>
                <button type="button" onClick={() => changeCap(group.settings.weeklyCap + 1)}>
                  +
                </button>
                <button type="button" onClick={() => changeCap(group.settings.weeklyCap + 5)}>
                  +5
                </button>
              </div>
            </div>
            <div className="leader-list">
              {group.members.length === 0 && <p className="subtitle">아직 기록된 친구가 없어요.</p>}
              {group.members.map((m, i) => {
                const rank = group.members.filter((o) => o.total > m.total).length + 1;
                return (
                  <button
                    key={m.key}
                    type="button"
                    className={`leader-row rank-${rank <= 3 ? rank : 'n'} ${selected === m.key ? 'selected' : ''}`}
                    onClick={() => setSelected(selected === m.key ? null : m.key)}
                    data-index={i}
                  >
                    <span className="leader-rank">{rank}</span>
                    <AvatarIcon avatarId={m.avatar ?? DEFAULT_AVATAR_ID} cosmetics={m.equipped} size={34} />
                    <span className="leader-name">
                      {m.nickname}
                      <StreakBadge member={m} />
                    </span>
                    <span className={`leader-cap ${m.weekRemaining === 0 ? 'full' : ''}`} title="이번 주 자동 지급 / 주간 상한">
                      <span className="leader-cap-text">
                        {m.weekRemaining === 0 ? '상한 도달 ' : '이번 주 '}
                        {m.weekEarned}/{group.settings.weeklyCap}
                      </span>
                      <span className="cap-bar">
                        <span className="cap-bar-fill" style={{ width: `${Math.min(100, (m.weekEarned / group.settings.weeklyCap) * 100)}%` }} />
                      </span>
                    </span>
                    <span className="leader-total">
                      <span className="talent-coin" aria-hidden />
                      {m.total}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">{selectedMember ? `${selectedMember.nickname} 달란트 내역` : '최근 달란트 내역'}</h2>
              {selectedMember && (
                <span className="count-block">
                  <span className="talent-coin" aria-hidden />
                  {selectedMember.total}
                </span>
              )}
            </div>

            {selectedMember ? (
              <div className="adjust-box">
                <div className="row adjust-row">
                  <span className="picker-label">달란트 조정</span>
                  <div className="stepper">
                    <button type="button" onClick={() => setDelta((d) => Math.max(1, d - 1))}>
                      -
                    </button>
                    <span>{delta}</span>
                    <button type="button" onClick={() => setDelta((d) => Math.min(group.rules.manualMax, d + 1))}>
                      +
                    </button>
                  </div>
                  {[1, 3, 5, 10].map((n) => (
                    <button key={n} type="button" className={`chip ${delta === n ? 'on' : ''}`} onClick={() => setDelta(n)}>
                      {n}
                    </button>
                  ))}
                </div>
                <div className="row adjust-row">
                  <input
                    className="input input-sm"
                    placeholder="사유 (예: 암송 완료, 간식 교환)"
                    maxLength={40}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <button className="btn btn-sm btn-plus" onClick={() => applyAdjust(1)}>
                    +{delta} 주기
                  </button>
                  <button className="btn btn-sm btn-minus" onClick={() => applyAdjust(-1)}>
                    -{delta} 빼기
                  </button>
                </div>
                <p className="fine-print">
                  선생님이 직접 주는 달란트는 주간 상한과 상관없이 들어가요(장부에 '상한 예외'로 표시). 잔액은 0 아래로 내려가지 않아요. 이번 주 자동 지급{' '}
                  {selectedMember.weekEarned}/{group.settings.weeklyCap}
                  {selectedMember.claimed && (
                    <>
                      {' · '}
                      <button
                        type="button"
                        className="link-btn inline-link"
                        title="폰을 바꾼 친구가 같은 닉네임으로 다시 들어올 수 있게 해요"
                        onClick={() => gameSocket.send('groupReleaseNickname', { code, nickname: selectedMember.nickname })}
                      >
                        닉네임 기기 연결 풀기
                      </button>
                    </>
                  )}
                </p>
              </div>
            ) : (
              <p className="panel-note rules-note">
                자동 지급: 참가 +{group.rules.participation} · 1/2/3등 +{group.rules.rank.join('/+')} · 만점 +{group.rules.perfect} · 연속 출석{' '}
                {group.rules.streakWeeks}주 이상 +{group.rules.streakBonus} · 팀 승리 보너스 · 한 주 최대 {group.settings.weeklyCap}개(넘으면 깎여요)
              </p>
            )}

            <div className="ledger-list">
              {history.length === 0 && <p className="subtitle">아직 내역이 없어요.</p>}
              {history.map((e) => (
                <div key={e.id} className={`ledger-row ${e.capped ? 'capped' : ''}`}>
                  <span className={`ledger-delta ${e.delta > 0 ? 'plus' : e.delta < 0 ? 'minus' : 'zero'}`}>{signed(e.delta)}</span>
                  <span className="ledger-main">
                    {!selectedMember && <b>{e.nickname}</b>} {e.reason}
                  </span>
                  {e.capped && <span className="ledger-kind kind-capped">상한{e.requested !== undefined ? ` ${e.requested}→${e.delta}` : ''}</span>}
                  {e.override && <span className="ledger-kind kind-override">상한 예외</span>}
                  <span className={`ledger-kind kind-${e.kind}`}>{KIND_LABEL[e.kind]}</span>
                  <span className="ledger-when">
                    {weekShort(e.week)} · {formatWhen(e.at)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {tab === 'games' && (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">최근 게임</h2>
            <span className="panel-note">최근 {group.games.length}판</span>
          </div>
          <div className="ledger-list">
            {group.games.length === 0 && <p className="subtitle">아직 기록된 게임이 없어요.</p>}
            {group.games.map((g) => (
              <div key={g.id} className="game-row">
                <span className="ledger-when">
                  {weekShort(g.week)} · {formatWhen(g.at)}
                </span>
                <span className="ledger-main">
                  <b>{g.roomTitle}</b> · {LEVEL_LABELS[g.level] ?? g.level} · {g.totalQuestions}문제 · {g.players.length}명
                </span>
                {g.mvpNicknames.length > 0 && <span className="ledger-kind kind-streak">MVP {g.mvpNicknames.join(', ')}</span>}
                {g.team && (
                  <span className="game-teams">
                    {g.team.teams.map((t) => (
                      <span key={t.id} className={`team-chip ${g.team!.winnerTeamIds.includes(t.id) ? 'win' : ''}`} style={{ background: t.color }}>
                        {t.name} {t.average}
                        {g.team!.winnerTeamIds.includes(t.id) ? (g.team!.tie ? ' 무승부' : ' 승') : ''}
                      </span>
                    ))}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
