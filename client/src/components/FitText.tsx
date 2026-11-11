import { useLayoutEffect, useRef } from 'react';

interface Props {
  text: string;
  className?: string;
  /** 글자 상자가 차지해도 되는 최대 높이 = 화면 높이 × 이 비율 */
  maxHeightRatio: number;
  /** 넘칠 때만 줄이는 글자 크기의 바닥 (px) */
  minPx: number;
}

/**
 * CSS 가 정한 큰 글자 크기(기본 4배)에서 시작해서, 줄바꿈한 글이 허용 높이를 넘칠
 * 때에만 넘치지 않을 때까지 조금씩 줄인다. 보통 길이의 문제는 줄어들지 않는다.
 */
export function FitText({ text, className, maxHeightRatio, minPx }: Props) {
  const ref = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.fontSize = ''; // CSS 의 기본(가장 큰) 크기로 되돌린 뒤 다시 맞춘다
      const limit = window.innerHeight * maxHeightRatio;
      let size = parseFloat(getComputedStyle(el).fontSize);
      while (el.scrollHeight > limit && size > minPx) {
        size = Math.max(minPx, size - 2);
        el.style.fontSize = `${size}px`;
      }
      el.dataset.fitPx = String(Math.round(size));
    };
    fit();
    window.addEventListener('resize', fit);
    // 웹폰트가 늦게 오면 줄바꿈이 달라지므로 한 번 더 맞춘다.
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) fit();
    });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    if (el.parentElement) observer?.observe(el.parentElement);
    return () => {
      cancelled = true;
      window.removeEventListener('resize', fit);
      observer?.disconnect();
    };
  }, [text, maxHeightRatio, minPx]);

  return (
    <p ref={ref} className={className}>
      {text}
    </p>
  );
}
