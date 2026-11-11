import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { gameSocket } from '../ws';
import type { Capacity, Level, MapTheme, RoomSummary } from '../protocol';
import { loadGroupSession } from '../groupSession';
import { saveHostKey } from '../hostKeys';
import { DEFAULT_LEVEL, LEVEL_CLASS, LEVEL_LABELS, LEVEL_OPTIONS } from '../levels';

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
  const [questionCount, setQuestionCount] = useState<number>(30);
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
      if (msg.churchId === churchId) setRooms(msg.rooms);
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
      setFormError('진행자 비밀번호는 방 입장 PIN과 다르게 정해 주세요.');
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
      questionCount,
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
          <div className="row">
            {QUESTION_COUNT_OPTIONS.map((n) => (
              <button
                key={n}
                className={`btn btn-sm ${questionCount === n ? 'btn-primary' : ''}`}
                onClick={() => setQuestionCount(n)}
              >
                {n}문제
              </button>
            ))}
          </div>
          <p className="picker-label">방 PIN (학생 입장용 숫자 4자리)</p>
          <input
            className="input"
            inputMode="numeric"
            placeholder="비워 두면 자동으로 만들어요"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
          />
          <p className="picker-label">진행자 비밀번호 (선생님만, 영문·숫자 4~12자)</p>
          <input
            className="input"
            placeholder="비워 두면 자동으로 만들어요"
            maxLength={12}
            autoComplete="off"
            value={hostPassword}
            onChange={(e) => setHostPassword(e.target.value.replace(/[^0-9A-Za-z]/g, '').slice(0, 12))}
          />
          <p className="fine-print">방 PIN은 학생 입장용, 진행자 비밀번호는 진행자 화면을 다시 열 때 써요. 학생에게 알려 주지 마세요.</p>
          {formError && <p className="form-error">{formError}</p>}
          <p className="picker-label">더 재미있게</p>
          <div className="row">
            <button type="button" className={`btn btn-sm ${teamMode ? 'btn-primary' : ''}`} onClick={() => setTeamMode((v) => !v)}>
              팀 대결 {teamMode ? '켜짐' : '꺼짐'}
            </button>
            {session ? (
              <button type="button" className={`btn btn-sm ${useGroup ? 'btn-primary' : ''}`} onClick={() => setUseGroup((v) => !v)}>
                {session.code} 반 출석·달란트 {useGroup ? '기록' : '안 함'}
              </button>
            ) : (
              <span className="fine-print">출석·달란트 기록은 호스트 홈에서 반을 먼저 열어 주세요.</span>
            )}
          </div>
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
