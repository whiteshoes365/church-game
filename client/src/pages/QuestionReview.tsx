import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { gameSocket } from '../ws';
import { CATEGORY_LABELS } from '../categories';
import { LEVEL_LABELS } from '../levels';

type ReasonCounts = Record<string, number>;

type ReviewItem = {
  questionId: string;
  question: {
    id: string;
    level: string;
    category: string;
    text: string;
    answer: 'O' | 'X';
    explanation: string | null;
    ref: string | null;
    week: string | null;
  } | null;
  reportCount: number;
  deviceCount: number;
  hostReported: boolean;
  reasonCounts: ReasonCounts;
  memos: { role: string; reason: string; memo: string; createdAt: number }[];
  lastReportAt: number;
  hidden: boolean;
  hiddenBy: 'review' | 'host' | 'devices' | null;
  suggestion: { text?: string; answer?: 'O' | 'X'; explanation?: string; ref?: string; note?: string } | null;
  lastAction: string | null;
  reviewedAt: number | null;
};

type ReviewPayload = {
  items: ReviewItem[];
  threshold: number;
  memoMax: number;
  reasonLabels: Record<string, string>;
  hiddenCount: number;
};

const HIDDEN_LABEL: Record<string, string> = {
  review: '검토에서 숨김',
  host: '선생님 신고로 숨김',
  devices: '여러 기기 신고로 숨김',
};

export function QuestionReview() {
  const [password, setPassword] = useState('');
  const [authed, setAuthed] = useState(false);
  const [review, setReview] = useState<ReviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState<string | null>(null);
  const [draft, setDraft] = useState({ text: '', answer: '', explanation: '', ref: '', note: '' });

  useEffect(() => {
    document.title = '문제 검토 · 교회학교 게임 플랫폼';
    gameSocket.connect();
    const offData = gameSocket.on('reviewData', (msg) => {
      setAuthed(true);
      setReview(msg.review);
      setBusy(false);
      setError(null);
      if (msg.done) {
        const label = msg.done.action === 'keep' ? '유지로 처리했어요.' : msg.done.action === 'hide' ? '숨겼어요.' : '수정 제안을 저장했어요.';
        setDone(label);
        setSuggesting(null);
      }
    });
    const offExport = gameSocket.on('reviewExport', (msg) => {
      setBusy(false);
      const blob = new Blob([JSON.stringify(msg.export, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'question-review-export.json';
      a.click();
      URL.revokeObjectURL(url);
      setDone('제안·숨김 목록 파일을 내려받았어요. 문항 JSON은 이 파일로 직접 고치면 돼요.');
    });
    const offErr = gameSocket.on('error', (msg) => {
      setBusy(false);
      setError(msg.message || '요청이 실패했어요.');
    });
    return () => {
      offData();
      offExport();
      offErr();
    };
  }, []);

  function login() {
    setBusy(true);
    setError(null);
    gameSocket.send('reviewLogin', { password });
  }

  function logout() {
    gameSocket.send('reviewLogout');
    setAuthed(false);
    setReview(null);
    setPassword('');
    setDone(null);
  }

  function act(questionId: string, action: 'keep' | 'hide' | 'suggest', suggestion?: unknown) {
    setBusy(true);
    setError(null);
    setDone(null);
    gameSocket.send('reviewAction', { questionId, action, suggestion });
  }

  function openSuggest(item: ReviewItem) {
    const s = item.suggestion || {};
    const q = item.question;
    setDraft({
      text: s.text || q?.text || '',
      answer: s.answer || q?.answer || '',
      explanation: s.explanation || q?.explanation || '',
      ref: s.ref || q?.ref || '',
      note: s.note || '',
    });
    setSuggesting(item.questionId);
  }

  if (!authed) {
    return (
      <div className="page review-page">
        <div className="card stack review-login">
          <h1 className="title">문제 검토</h1>
          <p className="subtitle">운영자만 들어갈 수 있어요. 비밀번호는 서버 설정에만 있어요.</p>
          <label>
            <span className="picker-label">검토 비밀번호</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') login();
              }}
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-primary" type="button" disabled={busy || !password} onClick={login}>
              {busy ? '확인 중…' : '들어가기'}
            </button>
            <Link className="btn" to="/">
              홈으로
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const items = review?.items ?? [];
  const labels = review?.reasonLabels ?? {};

  return (
    <div className="page review-page">
      <div className="review-head">
        <div>
          <h1 className="title" style={{ textAlign: 'left' }}>
            문제 검토
          </h1>
          <p className="subtitle" style={{ textAlign: 'left' }}>
            신고 {items.length}문항 · 숨김 {review?.hiddenCount ?? 0}문항
            {review ? ` · 기기 ${review.threshold}대 또는 선생님 1건이면 새 방에서 숨겨요` : ''}
          </p>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" type="button" disabled={busy} onClick={() => gameSocket.send('reviewList')}>
            새로고침
          </button>
          <button className="btn btn-sm" type="button" disabled={busy} onClick={() => { setBusy(true); gameSocket.send('reviewExport'); }}>
            제안 파일 받기
          </button>
          <button className="btn btn-sm" type="button" onClick={logout}>
            나가기
          </button>
        </div>
      </div>
      {error && <p className="form-error form-error-banner">{error}</p>}
      {done && <p className="question-report-thanks">{done}</p>}
      {items.length === 0 && <p className="subtitle">아직 검토할 신고가 없어요.</p>}
      {items.map((item) => {
        const q = item.question;
        return (
          <section key={item.questionId} className="card stack review-item">
            <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
              <span className="badge">{item.questionId}</span>
              {q && <span className="badge">{LEVEL_LABELS[q.level as keyof typeof LEVEL_LABELS] || q.level}</span>}
              {q && <span className="badge">{CATEGORY_LABELS[q.category as keyof typeof CATEGORY_LABELS] || q.category}</span>}
              {item.hidden ? (
                <span className="badge badge-paused">{HIDDEN_LABEL[item.hiddenBy || 'review'] || '숨김'}</span>
              ) : (
                <span className="badge">새 방에 나옴</span>
              )}
            </div>
            <p className="review-question-text">{q?.text || '(은행에서 이미 없는 문항)'}</p>
            {q && (
              <p className="fine-print">
                정답 {q.answer}
                {q.explanation ? ` · ${q.explanation}` : ''}
                {q.ref ? ` · ${q.ref}` : ''}
                {q.week ? ` · ${q.week}` : ''}
              </p>
            )}
            <p className="fine-print">
              신고 {item.reportCount}건 · 기기 {item.deviceCount}대
              {item.hostReported ? ' · 선생님 신고 있음' : ''}
              {Object.entries(item.reasonCounts)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => ` · ${labels[k] || k} ${n}`)
                .join('')}
            </p>
            {item.memos.length > 0 && (
              <ul className="review-memos">
                {item.memos.map((m, i) => (
                  <li key={i}>
                    {m.role === 'host' ? '선생님' : '학생'} · {labels[m.reason] || m.reason}: {m.memo}
                  </li>
                ))}
              </ul>
            )}
            {item.suggestion && (
              <div className="review-suggestion">
                <b>수정 제안</b>
                {item.suggestion.text && <p>문제: {item.suggestion.text}</p>}
                {item.suggestion.answer && <p>정답: {item.suggestion.answer}</p>}
                {item.suggestion.explanation && <p>해설: {item.suggestion.explanation}</p>}
                {item.suggestion.ref && <p>출처: {item.suggestion.ref}</p>}
                {item.suggestion.note && <p>메모: {item.suggestion.note}</p>}
              </div>
            )}
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-sm btn-primary" type="button" disabled={busy} onClick={() => act(item.questionId, 'keep')}>
                유지 (신고 비우고 다시 내기)
              </button>
              <button className="btn btn-sm" type="button" disabled={busy} onClick={() => act(item.questionId, 'hide')}>
                숨김
              </button>
              <button className="btn btn-sm" type="button" disabled={busy} onClick={() => openSuggest(item)}>
                수정 제안
              </button>
            </div>
            {suggesting === item.questionId && (
              <div className="stack review-suggest-form">
                <label>
                  문제
                  <textarea className="input" rows={3} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
                </label>
                <label>
                  정답
                  <select className="input" value={draft.answer} onChange={(e) => setDraft({ ...draft, answer: e.target.value })}>
                    <option value="">바꾸지 않음</option>
                    <option value="O">O</option>
                    <option value="X">X</option>
                  </select>
                </label>
                <label>
                  해설
                  <textarea className="input" rows={2} value={draft.explanation} onChange={(e) => setDraft({ ...draft, explanation: e.target.value })} />
                </label>
                <label>
                  출처
                  <input className="input" value={draft.ref} onChange={(e) => setDraft({ ...draft, ref: e.target.value })} />
                </label>
                <label>
                  메모
                  <input className="input" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
                </label>
                <p className="fine-print">저장만 해요. 문항 파일은 여기서 직접 고치지 않아요. 「제안 파일 받기」로 내려받아 나중에 적용하세요.</p>
                <div className="row" style={{ gap: 8 }}>
                  <button
                    className="btn btn-primary btn-sm"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      act(item.questionId, 'suggest', {
                        text: draft.text,
                        answer: draft.answer || undefined,
                        explanation: draft.explanation,
                        ref: draft.ref,
                        note: draft.note,
                      })
                    }
                  >
                    제안 저장
                  </button>
                  <button className="btn btn-sm" type="button" onClick={() => setSuggesting(null)}>
                    닫기
                  </button>
                </div>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
