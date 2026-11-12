import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { gameSocket } from '../ws';
import type { ChurchRef } from '../protocol';
import { ClassGuide } from '../components/ClassGuide';
import { LegalFooter } from '../components/LegalFooter';
import { loadGroupSession, normalizeGroupCode, saveGroupSession } from '../groupSession';

export function HostHome() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ChurchRef[]>([]);
  const [groupCode, setGroupCode] = useState(() => loadGroupSession()?.code ?? '');
  const [groupPin, setGroupPin] = useState(() => loadGroupSession()?.pin ?? '');
  const [groupError, setGroupError] = useState<string | null>(null);

  useEffect(() => {
    gameSocket.connect();
    const offList = gameSocket.on('churchList', (msg) => setResults(msg.churches));
    const offJoined = gameSocket.on('churchJoined', (msg) => {
      navigate(`/host/rooms/${msg.church.id}`, { state: { churchName: msg.church.name } });
    });
    const offGroup = gameSocket.on('groupData', (msg) => {
      navigate(`/host/group/${encodeURIComponent(msg.group.code)}`);
    });
    const offError = gameSocket.on('error', (msg) => setGroupError(msg.message));
    return () => {
      offList();
      offJoined();
      offGroup();
      offError();
    };
  }, [navigate]);

  // 글자를 넣었을 때만 검색한다 (빈 검색어로는 교회 목록이 뜨지 않는다).
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    gameSocket.send('searchChurches', { query: query.trim() });
  }, [query]);

  function selectChurch(church: ChurchRef) {
    navigate(`/host/rooms/${church.id}`, { state: { churchName: church.name } });
  }

  function createOrJoin() {
    if (!query.trim()) return;
    gameSocket.send('findOrCreateChurch', { name: query.trim() });
  }

  function openGroup(create: boolean) {
    const code = normalizeGroupCode(groupCode);
    if (!/^[0-9a-z가-힣_-]{2,20}$/.test(code)) {
      setGroupError('반 코드는 한글·영문·숫자 2~20자로 정해 주세요.');
      return;
    }
    if (!/^\d{4,8}$/.test(groupPin)) {
      setGroupError('교사 PIN은 숫자 4~8자리예요.');
      return;
    }
    setGroupError(null);
    saveGroupSession({ code, pin: groupPin });
    gameSocket.send('groupOpen', { code, pin: groupPin, create });
  }

  return (
    <div className="screen">
      <h1 className="title host-home-title">호스트 (교사용)</h1>
      <ClassGuide className="host-home-guide" />
      <div className="host-home-grid">
      <div className="card stack">
        <h2 className="card-title">
          <span className="title-block block-blue" aria-hidden />
          OX 퀴즈 방 열기
        </h2>
        <p className="subtitle">교회를 검색하거나 새로 만들어요</p>

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
                <span className="badge">선택</span>
              </div>
            ))}
          </div>
        )}

        <button className="btn btn-primary" onClick={createOrJoin} disabled={!query.trim()}>
          {results.some((c) => c.name === query.trim()) ? '이 교회로 계속하기' : '이 이름으로 교회 만들기 · 계속하기'}
        </button>
        <p className="fine-print">같은 이름의 교회가 있으면 그 교회로 들어가고, 없으면 새로 만들어요.</p>

      </div>

      <div className="card stack">
        <h2 className="card-title">
          <span className="title-block block-gold" aria-hidden />
          우리 반 출석 · 달란트
        </h2>
        <p className="subtitle">반 코드와 교사 PIN으로 출석부와 달란트 장부를 열어요</p>
        <input
          className="input"
          placeholder="반 코드 (예: 사랑반)"
          maxLength={20}
          value={groupCode}
          onChange={(e) => setGroupCode(e.target.value)}
        />
        <p className="picker-label">교사 PIN (반 기록용, 숫자 4~8자리)</p>
        <input
          className="input"
          type="password"
          inputMode="numeric"
          placeholder="숫자 4~8자리"
          value={groupPin}
          onChange={(e) => setGroupPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
        />
        {groupError && <p className="form-error">{groupError}</p>}
        <div className="row">
          <button className="btn btn-primary" onClick={() => openGroup(false)} disabled={!groupCode.trim() || !groupPin}>
            반 기록 열기
          </button>
          <button className="btn" onClick={() => openGroup(true)} disabled={!groupCode.trim() || !groupPin}>
            새 반 만들기
          </button>
        </div>
        <p className="fine-print">닉네임만 기록해요. 실명·연락처·생일은 받지 않아요.</p>
      </div>
      </div>

      <div className="card stack host-home-links">
        <h2 className="card-title">
          <span className="title-block block-blue" aria-hidden />
          송출 PC · 폰 리모컨
        </h2>
        <p className="subtitle" style={{ textAlign: 'left', margin: 0 }}>
          프로젝터·TV용 PC는 송출 화면을 열고, 선생님 폰은 방에서 안내하는 리모컨 주소로 들어가세요. 진행자 비밀번호는 송출 PC에 넣지 않아요.
        </p>
        <button className="btn btn-primary" type="button" onClick={() => navigate('/display')}>
          송출 화면 열기
        </button>
        <p className="fine-print">방을 만든 뒤 진행자 화면에서 PC 짝 코드·리모컨 QR을 확인할 수 있어요.</p>
      </div>

      <button className="link-btn" onClick={() => navigate('/')}>
        학생 화면으로 이동
      </button>
      <LegalFooter />
    </div>
  );
}
