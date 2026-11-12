import { useEffect, useState } from 'react';
import { gameSocket } from '../ws';
import { getDeviceId } from '../deviceId';

export const REPORT_REASONS = [
  { id: 'wrong_answer', label: '틀린 답' },
  { id: 'ambiguous', label: '애매함' },
  { id: 'inappropriate', label: '부적절' },
  { id: 'typo', label: '오타' },
  { id: 'other', label: '기타' },
] as const;

export const REPORT_MEMO_MAX = 200;

type Props = {
  roomId: string;
  questionIndex: number;
  questionText: string;
  /** 학생은 정답 공개 뒤에만, 작고 덜 눈에 띄게. */
  variant?: 'staff' | 'student';
  label?: string;
};

export function QuestionReportButton({ roomId, questionIndex, questionText, variant = 'staff', label }: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>('');
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!open) return;
    const offOk = gameSocket.on('questionReportResult', (msg) => {
      if (msg.roomId !== roomId || Number(msg.questionIndex) !== questionIndex) return;
      setBusy(false);
      setMessage(msg.message || (msg.duplicate ? '이미 신고한 문제예요.' : '신고를 보냈어요.'));
      setDone(true);
    });
    const offErr = gameSocket.on('error', (msg) => {
      if (!busy && !open) return;
      setBusy(false);
      if (typeof msg.message === 'string') setMessage(msg.message);
    });
    return () => {
      offOk();
      offErr();
    };
  }, [open, roomId, questionIndex, busy]);

  function close() {
    setOpen(false);
    setReason('');
    setMemo('');
    setBusy(false);
    setMessage(null);
    setDone(false);
  }

  function submit() {
    if (!reason || busy || done) return;
    setBusy(true);
    setMessage(null);
    gameSocket.send('reportQuestion', {
      roomId,
      questionIndex,
      reason,
      memo,
      deviceId: getDeviceId(),
    });
  }

  const memoLen = [...memo].length;
  const over = memoLen > REPORT_MEMO_MAX;

  return (
    <div className={`question-report ${variant}`}>
      <button className={variant === 'student' ? 'btn btn-sm question-report-open quiet' : 'btn btn-sm question-report-open'} type="button" onClick={() => setOpen(true)}>
        {label || (variant === 'student' ? '이 문제 신고' : '문제 신고')}
      </button>
      {open && (
        <div className="question-report-overlay" role="dialog" aria-modal="true" aria-labelledby={`report-title-${questionIndex}`}>
          <div className="question-report-panel card stack">
            <h2 id={`report-title-${questionIndex}`} className="card-title">
              문제 신고
            </h2>
            <p className="question-report-text">{questionText}</p>
            {done ? (
              <p className="question-report-thanks">{message}</p>
            ) : (
              <>
                <p className="fine-print">사유를 고른 뒤 보내 주세요. 한 문제는 이 기기에서 한 번만 신고할 수 있어요.</p>
                <div className="question-report-reasons">
                  {REPORT_REASONS.map((r) => (
                    <label key={r.id} className={`question-report-reason ${reason === r.id ? 'on' : ''}`}>
                      <input type="radio" name={`report-reason-${questionIndex}`} value={r.id} checked={reason === r.id} onChange={() => setReason(r.id)} />
                      {r.label}
                    </label>
                  ))}
                </div>
                <label className="question-report-memo">
                  <span>메모 (선택, {memoLen}/{REPORT_MEMO_MAX}자)</span>
                  <textarea
                    className="input"
                    value={memo}
                    maxLength={REPORT_MEMO_MAX}
                    rows={3}
                    placeholder="더 알려 줄 말이 있으면 짧게 적어 주세요"
                    onChange={(e) => setMemo(e.target.value)}
                  />
                </label>
                <p className="fine-print">실명·전화번호·닉네임 같은 개인정보는 적지 마세요. 남기는 것은 사유와 짧은 메모, 변환한 기기값뿐이에요.</p>
                {over && <p className="form-error">메모는 {REPORT_MEMO_MAX}자까지 쓸 수 있어요.</p>}
                {message && !done && <p className="form-error">{message}</p>}
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn-primary" type="button" disabled={!reason || busy || over} onClick={submit}>
                    {busy ? '보내는 중…' : '신고 보내기'}
                  </button>
                  <button className="btn" type="button" onClick={close}>
                    취소
                  </button>
                </div>
              </>
            )}
            {done && (
              <button className="btn" type="button" onClick={close}>
                닫기
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type Target = { index: number; text: string; kind: 'current' | 'prev' };

export function StaffQuestionReports({
  roomId,
  current,
  prev,
}: {
  roomId: string;
  current?: { index: number; text: string } | null;
  prev?: { index: number; text: string } | null;
}) {
  const targets: Target[] = [];
  if (current && current.text) targets.push({ ...current, kind: 'current' });
  if (prev && prev.text && prev.index !== current?.index) targets.push({ ...prev, kind: 'prev' });
  if (targets.length === 0) return null;
  return (
    <div className="question-report-staff row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      {targets.map((t) => (
        <QuestionReportButton
          key={t.index}
          roomId={roomId}
          questionIndex={t.index}
          questionText={t.text}
          variant="staff"
          label={t.kind === 'prev' ? '직전 문제 신고' : '이 문제 신고'}
        />
      ))}
    </div>
  );
}
