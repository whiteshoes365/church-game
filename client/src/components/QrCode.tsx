import { useEffect, useState } from 'react';

interface Props {
  /** QR 에 담을 글자 (주소). */
  value: string;
  /** 접근성 설명. */
  label: string;
  className?: string;
}

/**
 * QR 코드를 이 브라우저 안에서 그린다 (`qrcode` 라이브러리, 외부 QR 서비스·네트워크 호출 없음).
 * 라이브러리를 못 불러오거나 그리다 실패하면 안내 글자를 보여 준다 —
 * 주소·방 PIN 은 QR 옆에 항상 글자로도 나와 있으므로 화면은 그대로 쓸 수 있다.
 */
export function QrCode({ value, label, className = '' }: Props) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    import('qrcode')
      .then((mod) => {
        const lib = (mod as unknown as { default?: typeof import('qrcode') }).default ?? mod;
        return lib.toString(value, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
      })
      .then((markup) => {
        if (!cancelled) setSvg(markup);
      })
      .catch(() => {
        if (!cancelled) {
          setSvg(null);
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [value]);

  if (failed) {
    return (
      <div className={`qr-box qr-failed ${className}`} role="img" aria-label={`${label} (QR을 만들지 못했어요)`}>
        <span>QR을 만들지 못했어요</span>
        <small>옆에 적힌 주소로 들어와 주세요</small>
      </div>
    );
  }
  return (
    <div
      className={`qr-box ${svg ? '' : 'qr-loading'} ${className}`}
      role="img"
      aria-label={label}
      data-qr-value={value}
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}
