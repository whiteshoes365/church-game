// 학생 첫 화면. 1순위는 "방 코드로 입장" — 송출 화면에 보이는 입장 코드와 방 PIN.
// 교회 이름 검색은 접어 두고, 여기서는 교회를 새로 만들 수 없다 (만들기는 호스트 화면에서만).
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { gameSocket } from '../ws';
import type { ChurchRef } from '../protocol';
import { parseJoinInput } from '../joinLink';
import { LegalFooter } from '../components/LegalFooter';

const MIN_CODE_LENGTH = 4;

type JoinPrefill = { codePrefill?: string; pinPrefill?: string };

export function PlayerJoin() {
  const navigate = useNavigate();
  const location = useLocation();
  const prefill = (location.state as JoinPrefill | null) ?? null;
  const [codeInput, setCodeInput] = useState(() => prefill?.codePrefill ?? '');
  const [pin, setPin] = useState(() => (prefill?.pinPrefill && /^\d{4}$/.test(prefill.pinPrefill) ? prefill.pinPrefill : ''));
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ChurchRef[]>([]);
  const [searched, setSearched] = useState('');

  const parsed = parseJoinInput(codeInput);
  const canJoin = parsed.code.length >= MIN_CODE_LENGTH;
  const trimmedQuery = query.trim();

  useEffect(() => {
    // 서버를 미리 깨워 둔다 (코드를 넣는 동안 연결).
    gameSocket.connect();
    const offList = gameSocket.on('churchList', (msg) => {
      setResults(msg.churches);
      setSearched(typeof msg.query === 'string' ? msg.query : '');
    });
    return () => {
      offList();
    };
  }, []);

  // 글자를 넣었을 때만 검색한다. 빈 검색어로는 교회 목록을 받지 않는다.
  useEffect(() => {
    if (!trimmedQuery) {
      setResults([]);
      return;
    }
    const id = window.setTimeout(() => gameSocket.send('searchChurches', { query: trimmedQuery }), 250);
    return () => window.clearTimeout(id);
  }, [trimmedQuery]);

  function joinByCode() {
    if (!canJoin) return;
    const usePin = /^\d{4}$/.test(pin) ? pin : parsed.pin;
    navigate(`/j/${parsed.code}${usePin ? `?p=${usePin}` : ''}`);
  }

  return (
    <div className="screen">
      <div className="screen-narrow stack">
        <h1 className="title">교회학교 게임 플랫폼</h1>
        <p className="subtitle">선생님 화면에 보이는 방 코드로 들어와요</p>

        <form
          className="card stack join-code-card"
          onSubmit={(e) => {
            e.preventDefault();
            joinByCode();
          }}
        >
          <h2 className="card-title">
            <span className="title-block block-blue" aria-hidden />
            방 코드로 입장
          </h2>
          <label className="picker-label" htmlFor="join-code">
            입장 코드
          </label>
          <input
            id="join-code"
            className="input join-code-input"
            placeholder="예: ABCDE"
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            maxLength={120}
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
          />
          <p className="fine-print">송출 화면 주소 끝의 글자예요 (…/#/j/<b>ABCDE</b>). QR을 찍으면 바로 들어가요.</p>
          <label className="picker-label" htmlFor="join-pin">
            방 PIN (숫자 4자리)
          </label>
          <input
            id="join-pin"
            className="input pin-input"
            inputMode="numeric"
            autoComplete="off"
            placeholder="0000"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
          />
          <p className="fine-print">선생님 화면에 크게 나와 있어요. 지금 비워 두면 다음 화면에서 넣어요.</p>
          <button className="btn btn-primary" type="submit" disabled={!canJoin}>
            입장하기
          </button>
        </form>

        <button className="btn shop-open-btn home-shop-btn" onClick={() => navigate('/shop')}>
          <span className="talent-coin" aria-hidden /> 달란트 상점
        </button>

        <details className="card church-search-fold">
          <summary>방 코드가 없나요? 교회 이름으로 찾기</summary>
          <div className="stack church-search-body">
            <input
              className="input"
              placeholder="교회 이름을 입력하세요"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {results.length > 0 && (
              <div className="stack">
                {results.map((c) => (
                  <div
                    key={c.id}
                    className="church-result"
                    onClick={() => navigate(`/rooms/${c.id}`, { state: { churchName: c.name } })}
                  >
                    <span>{c.name}</span>
                    <span className="badge">입장</span>
                  </div>
                ))}
              </div>
            )}
            {trimmedQuery && results.length === 0 && searched === trimmedQuery && (
              <p className="fine-print">그 이름의 교회를 찾지 못했어요. 선생님께 방 코드를 물어봐 주세요.</p>
            )}
            <p className="fine-print">교회는 선생님이 호스트 화면에서 만들어요. 학생 화면에서는 새로 만들 수 없어요.</p>
          </div>
        </details>

        <button className="link-btn" onClick={() => navigate('/host')}>
          선생님이신가요? 호스트 화면으로 이동
        </button>
        <LegalFooter />
      </div>
    </div>
  );
}
