import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { gameSocket } from '../ws';
import type { ChurchRef } from '../protocol';

export function PlayerJoin() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ChurchRef[]>([]);

  useEffect(() => {
    gameSocket.connect();
    const offList = gameSocket.on('churchList', (msg) => setResults(msg.churches));
    const offJoined = gameSocket.on('churchJoined', (msg) => {
      navigate(`/rooms/${msg.church.id}`, { state: { churchName: msg.church.name } });
    });
    return () => {
      offList();
      offJoined();
    };
  }, [navigate]);

  useEffect(() => {
    gameSocket.send('searchChurches', { query });
  }, [query]);

  function selectChurch(church: ChurchRef) {
    navigate(`/rooms/${church.id}`, { state: { churchName: church.name } });
  }

  function createOrJoin() {
    if (!query.trim()) return;
    gameSocket.send('findOrCreateChurch', { name: query.trim() });
  }

  return (
    <div className="screen">
      <div className="screen-narrow stack">
        <h1 className="title">교회학교 게임 플랫폼</h1>
        <p className="subtitle">우리 교회를 검색하거나 새로 만들어요</p>

        <input
          className="input"
          placeholder="교회 이름을 입력하세요"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {results.length > 0 && (
          <div className="stack">
            {results.map((c) => (
              <div key={c.id} className="church-result" onClick={() => selectChurch(c)}>
                <span>{c.name}</span>
                <span className="badge">입장</span>
              </div>
            ))}
          </div>
        )}

        <button className="btn btn-primary" onClick={createOrJoin} disabled={!query.trim()}>
          {results.some((c) => c.name === query.trim()) ? '선택한 교회로 계속하기' : '이 이름으로 교회 만들기 / 찾기'}
        </button>

        <button className="link-btn" onClick={() => navigate('/host')}>
          선생님이신가요? 호스트 화면으로 이동
        </button>
      </div>
    </div>
  );
}
