// 호스트(교사용) 화면에만 쓰이는 광고 자리 표시용 컴포넌트예요.
// 실제 광고 SDK/스크립트는 아직 연결하지 않았어요 (placeholder only).
export function BannerAdSlot() {
  return (
    <div className="banner-ad-slot" data-testid="banner-ad-slot">
      광고 영역 (미연동 placeholder) · 320x50
    </div>
  );
}
