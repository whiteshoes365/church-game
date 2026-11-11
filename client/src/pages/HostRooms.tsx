import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { gameSocket } from '../ws';
import type { Capacity, Level, MapTheme, RoomSummary } from '../protocol';
import { loadGroupSession } from '../groupSession';
import { saveHostKey } from '../hostKeys';
import { DEFAULT_LEVEL, LEVEL_CLASS, LEVEL_LABELS, LEVEL_OPTIONS } from '../levels';
import { MusicPicker } from '../components/MusicPicker';
import { music } from '../music';

const MAP_OPTIONS: { value: MapTheme; label: string }[] = [
  { value: 'sanctuary', label: '예배당' },
  { value: 'playground', label: '운동장' },
  { value: 'forest', label: '숲' },
];

const CAPACITY_OPTIONS: { value: Capacity; label: string }[] = [
  { value: 4, label: '4명' },
  { value: 8, label: '8명' },
  { value: 'unlimited', label: '제한 없음' },
];

const QUESTION_COUNT_OPTIONS = [10, 20, 30] as const;
const MAX_QUESTION_COUNT = QUESTION_COUNT_OPTIONS[QUESTION_COUNT_OPTIONS.length - 1];

type QuestionBank = Partial<Record<Level, number>>;

// 고를 수 있는 문제 수: 그 난이도 문제 은행보다 큰 선택지는 빼고,
// 은행이 가장 큰 선택지(30)보다 작으면 "전체 N문제"를 마지막 선택지로 넣는다.
// 은행 크기를 아직 모르면(서버 응답 전) 기본 선택지를 그대로 보여 준다.
function questionCountChoices(bankSize: number | undefined): { value: number; all: boolean }[] {
  if (!bankSize) return QUESTION_COUNT_OPTIONS.map((value) => ({ value, all: false }));
  const choices: { value: number; all: boolean }[] = QUESTION_COUNT_OPTIONS.filter((n) => n < bankSize).map((value) => ({ value, all: false }));
  choices.push({ value: Math.min(bankSize, MAX_QUESTION_COUNT), all: bankSize <= MAX_QUESTION_COUNT });
  return choices;
}

export function HostRooms() {
  const { churchId } = useParams<{ churchId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const churchName = (location.state as { churchName?: string } | null)?.churchName ?? '우리 교회';

  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [title, setTitle] = useState('OX 성경 퀴즈');
  const [map, setMap] = useState<MapTheme>('sanctuary');
  const [capacity, setCapacity] = useState<Capacity>(8);
  const [level, setLevel] = useState<Level>(DEFAULT_LEVEL);
  const [questionCount, setQuestionCount] = useState<number>(MAX_QUESTION_COUNT);
  const [questionBank, setQuestionBank] = useState<QuestionBank>({});
  const bankSize = questionBank[level];
  const countChoices = questionCountChoices(bankSize);
  // 난이도를 바꾸거나 은행 크기를 알게 됐을 때, 고른 문제 수가 선택지에 없으면
  // (은행보다 큼 등) 고를 수 있는 가장 가까운 아래 값으로 맞춘다.
  const effectiveCount = countChoices.some((c) => c.value === questionCount)
    ? questionCount
    : ([...countChoices].reverse().find((c) => c.value <= questionCount) ?? countChoices[0]).value;
  const session = loadGroupSession();
  const [useGroup, setUseGroup] = useState<boolean>(!!session);
  const [teamMode, setTeamMode] = useState(false);
  const [pin, setPin] = useState('');
  // 진행자 비밀번호: 반 기록을 열어 둔 선생님은 교사 PIN 을 기본값으로 (바꿀 수 있음)
  const [hostPassword, setHostPassword] = useState(() => session?.pin ?? '');
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    gameSocket.connect();
    const offList = gameSocket.on('roomList', (msg) => {
      if (msg.churchId !== churchId) return;
      setRooms(msg.rooms);
      if (msg.questionBank) setQuestionBank(msg.questionBank);
    });
    const offCreated = gameSocket.on('roomCreated', (msg) => {
      if (msg.hostKey) saveHostKey(msg.room.id, msg.hostKey);
      navigate(`/host/room/${msg.room.id}`);
    });
    const offError = gameSocket.on('error', (msg) => setFormError(msg.message));
    gameSocket.send('listRooms', { churchId });
    const interval = setInterval(() => gameSocket.send('listRooms', { churchId }), 3000);
    return () => {
      offList();
      offCreated();
      offError();
      clearInterval(interval);
    };
  }, [churchId, navigate]);

  // 미리 듣기를 켠 채로 화면을 떠나면 끈다 (방 화면이 열리면 거기서 다시 튼다).
  useEffect(() => () => music.stop(), []);

  function createRoom() {
    if (!title.trim()) return;
    if (pin && !/^\d{4}$/.test(pin)) {
      setFormError('방 PIN은 숫자 4자리로 정해 주세요. 비워 두면 자동으로 만들어요.');
      return;
    }
    if (hostPassword && !/^[0-9A-Za-z]{4,12}$/.test(hostPassword)) {
      setFormError('진행자 비밀번호는 영문·숫자 4~12자로 정해 주세요. 비워 두면 자동으로 만들어요.');
      return;
    }
    if (hostPassword && hostPassword === pin) {
      setFormError('진행자 비밀번호는 방 PIN과 다르게 정해 주세요.');
      return;
    }
    setFormError(null);
    gameSocket.send('createRoom', {
      pin: pin || undefined,
      hostPassword: hostPassword || undefined,
      churchId,
      title: title.trim(),
      map,
      capacity,
      level,
      questionCount: effectiveCount,
      teamMode,
      ...(useGroup && session ? { groupCode: session.code, groupPin: session.pin } : {}),
    });
  }

  return (
    <div className="screen">
      <div className="screen-narrow stack">
        <h1 className="title">{churchName}</h1>
        <p className="subtitle">새 방을 만들거나 기존 방을 열어주세요</p>

        <div className="card stack">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="방 제목" />
          <p className="picker-label">난이도를 골라주세요</p>
          <div className="level-picker">
            {LEVEL_OPTIONS.map((l) => (
              <button
                key={l.value}
                type="button"
                className={`level-block ${l.className} ${level === l.value ? 'selected' : ''}`}
                onClick={() => setLevel(l.value)}
              >
                {l.label}
              </button>
            ))}
          </div>
          <div className="row">
            {MAP_OPTIONS.map((m) => (
              <button
                key={m.value}
                className={`btn btn-sm ${map === m.value ? 'btn-primary' : ''}`}
                onClick={() => setMap(m.value)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="row">
            {CAPACITY_OPTIONS.map((c) => (
              <button
                key={String(c.value)}
                className={`btn btn-sm ${capacity === c.value ? 'btn-primary' : ''}`}
                onClick={() => setCapacity(c.value)}
              >
                {c.label}
              </button>
            ))}
          </div>
          <p className="picker-label">문제 수를 골라주세요</p>
          <div className="row row-wrap">
            {countChoices.map((c) => (
              <button
                key={c.value}
                className={`btn btn-sm ${effectiveCount === c.value ? 'btn-primary' : ''}`}
                onClick={() => setQuestionCount(c.value)}
              >
                {c.all ? `전체 ${c.value}문제` : `${c.value}문제`}
              </button>
            ))}
          </div>
          {bankSize !== undefined && bankSize < MAX_QUESTION_COUNT && (
            <p className="fine-print question-bank-note">
              {LEVEL_LABELS[level]} 문제 은행은 {bankSize}문제예요. {bankSize}문제까지만 고를 수 있어요.
            </p>
          )}
          <p className="picker-label">방 PIN (학생용, 숫자 4자리)</p>
          <input
            className="input"
            inputMode="numeric"
            placeholder="비워 두면 자동으로 만들어요"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
          />
          <p className="fine-print">학생 입장용이에요. 친구들에게 알려 주는 번호예요.</p>
          <p className="picker-label">진행자 비밀번호 (선생님만, 영문·숫자 4~12자)</p>
          <input
            className="input"
            placeholder="비워 두면 자동으로 만들어요"
            maxLength={12}
            autoComplete="off"
            value={hostPassword}
            onChange={(e) => setHostPassword(e.target.value.replace(/[^0-9A-Za-z]/g, '').slice(0, 12))}
          />
          <p className="fine-print">진행자 화면을 다른 기기에서 다시 열 때 써요. 학생에게 알려 주지 마세요.</p>
          {formError && <p className="form-error">{formError}</p>}
          <MusicPicker preview />
          <p className="picker-label">더 재미있게</p>
          <div className="row row-wrap toggle-row">
            <button type="button" className={`btn btn-sm toggle-btn ${teamMode ? 'btn-primary' : ''}`} onClick={() => setTeamMode((v) => !v)}>
              팀 대결 {teamMode ? '켜짐' : '꺼짐'}
            </button>
            {session && (
              <button type="button" className={`btn btn-sm toggle-btn ${useGroup ? 'btn-primary' : ''}`} onClick={() => setUseGroup((v) => !v)}>
                <span className="toggle-btn-code">{session.code}</span>
                <span>반 출석·달란트 {useGroup ? '기록' : '안 함'}</span>
              </button>
            )}
          </div>
          <p className="fine-print">
            {session
              ? '반 기록은 호스트 홈에서 교사 PIN(반 기록용, 숫자 4~8자리)으로 연 반에 남겨요.'
              : '출석·달란트 기록은 호스트 홈에서 교사 PIN(반 기록용, 숫자 4~8자리)으로 반을 먼저 열어 주세요.'}
          </p>
          <button className="btn btn-primary" onClick={createRoom} disabled={!title.trim()}>
            방 만들기
          </button>
        </div>

        <div className="room-list">
          {rooms.map((room) => (
            <div key={room.id} className="room-item" onClick={() => navigate(`/host/room/${room.id}`)}>
              <div>
                <div className="room-item-title">{room.title}</div>
                <div className="room-item-meta">참여 {room.playerCount}명</div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <span className={`badge badge-level ${LEVEL_CLASS[room.level]}`}>{LEVEL_LABELS[room.level]}</span>
                <span className="badge">{room.status === 'lobby' ? '대기중' : '진행중'}</span>
              </div>
            </div>
          ))}
        </div>

        <button className="link-btn" onClick={() => navigate('/host')}>
          다른 교회 찾기
        </button>
      </div>
    </div>
  );
}
