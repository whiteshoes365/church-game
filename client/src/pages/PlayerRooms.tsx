import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { gameSocket } from '../ws';
import type { RoomSummary } from '../protocol';
import { LEVEL_CLASS, LEVEL_LABELS } from '../levels';

const MAP_LABEL: Record<string, string> = {
  sanctuary: '예배당',
  playground: '운동장',
  forest: '숲',
};

const CAPACITY_LABEL: Record<string, string> = {
  '4': '4명',
  '8': '8명',
  unlimited: '제한 없음',
};

export function PlayerRooms() {
  const { churchId } = useParams<{ churchId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const churchName = (location.state as { churchName?: string } | null)?.churchName ?? '우리 교회';
  const [rooms, setRooms] = useState<RoomSummary[]>([]);

  useEffect(() => {
    gameSocket.connect();
    const off = gameSocket.on('roomList', (msg) => {
      if (msg.churchId === churchId) setRooms(msg.rooms);
    });
    gameSocket.send('listRooms', { churchId });
    const interval = setInterval(() => gameSocket.send('listRooms', { churchId }), 3000);
    return () => {
      off();
      clearInterval(interval);
    };
  }, [churchId]);

  return (
    <div className="screen">
      <div className="screen-narrow stack">
        <h1 className="title">{churchName}</h1>
        <p className="subtitle">참여할 방을 골라주세요</p>

        {rooms.length === 0 && <p className="subtitle">아직 열린 방이 없어요. 선생님이 방을 만들면 여기에 나타나요.</p>}

        <div className="room-list">
          {rooms.map((room) => (
            <div key={room.id} className="room-item" onClick={() => navigate(`/play/${room.id}`)}>
              <div>
                <div className="room-item-title">{room.title}</div>
                <div className="room-item-meta">
                  {MAP_LABEL[room.map]} · 인원 {room.playerCount}/{CAPACITY_LABEL[String(room.capacity)]}
                </div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <span className={`badge badge-level ${LEVEL_CLASS[room.level]}`}>{LEVEL_LABELS[room.level]}</span>
                <span className="badge">{room.status === 'lobby' ? '대기중' : '진행중'}</span>
              </div>
            </div>
          ))}
        </div>

        <button className="link-btn" onClick={() => navigate('/')}>
          다른 교회 찾기
        </button>
      </div>
    </div>
  );
}
