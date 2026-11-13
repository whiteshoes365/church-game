import { useLayoutEffect, useRef } from 'react';

interface Props {
  text: string;
  className?: string;
  /** 글자 상자가 차지해도 되는 최대 높이 = 화면 높이 × 이 비율 */
  maxHeightRatio: number;
  /** 넘칠 때만 줄이는 글자 크기의 바닥 (px) */
  minPx: number;
  /**
   * 부모가 정해 준 높이를 채우는 상자 안에 글을 넣고, 그 상자 높이도 넘지 않게 줄인다.
   * (문제 띠가 화면의 1/4 로 고정될 때 글자가 띠 밖으로 넘치거나 무대를 밀어내지 않게)
   */
  fill?: boolean;
}

/**
 * CSS 가 정한 큰 글자 크기(기본 4배)에서 시작해서, 줄바꿈한 글이 허용 높이를 넘칠
 * 때에만 넘치지 않을 때까지 조금씩 줄인다. 보통 길이의 문제는 줄어들지 않는다.
 */
export function FitText({ text, className, maxHeightRatio, minPx, fill }: Props) {
  const ref = useRef<HTMLParagraphElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.fontSize = ''; // CSS 의 기본(가장 큰) 크기로 되돌린 뒤 다시 맞춘다
      let limit = window.innerHeight * maxHeightRatio;
      // 상자 높이가 정해져 있으면 그 높이가 한도. (높이가 내용에 따라가는 좁은 화면에서는 상자 = 글 높이라 영향 없음)
      const box = boxRef.current;
      if (box && box.clientHeight > 0) limit = Math.min(limit, box.clientHeight);
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
    const watched = boxRef.current?.parentElement ?? el.parentElement;
    if (watched) observer?.observe(watched);
    if (boxRef.current) observer?.observe(boxRef.current);
    return () => {
      cancelled = true;
      window.removeEventListener('resize', fit);
      observer?.disconnect();
    };
  }, [text, maxHeightRatio, minPx, fill]);

  if (fill) {
    return (
      <div ref={boxRef} className="fit-text-box">
        <p ref={ref} className={className}>
          {text}
        </p>
      </div>
    );
  }

  return (
    <p ref={ref} className={className}>
      {text}
    </p>
  );
}
