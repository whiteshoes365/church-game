import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { gameSocket } from '../ws';
import { AvatarIcon } from './AvatarIcon';
import { isWebGLAvailable } from '../three/webgl';
import type { Cosmetics, ShopItem, ShopState } from '../protocol';

const AvatarPreview3D = lazy(() => import('../three/AvatarPreview3D'));

const SLOT_LABEL: Record<ShopItem['slot'], string> = { hat: '모자', outfit: '옷', extra: '특별 아이템' };
const SLOTS: ShopItem['slot'][] = ['hat', 'outfit', 'extra'];

interface Props {
  roomId?: string; // 없으면 홈 화면 상점 (반 코드 + 닉네임으로 확인된 상태)
  avatarId: string;
  onClose: () => void;
}

// 달란트 상점: 게임에서 모은 달란트로 내 블록 캐릭터를 꾸며요.
// (게임 안 꾸미기 전용 — 실제 선물 교환이 아니에요)
export function ShopPanel({ roomId, avatarId: fallbackAvatar, onClose }: Props) {
  const [shop, setShop] = useState<ShopState | null>(null);
  const [tryOn, setTryOn] = useState<ShopItem | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const webgl = useMemo(() => isWebGLAvailable(), []);
  const avatarId = shop?.avatar || fallbackAvatar;

  useEffect(() => {
    const offData = gameSocket.on('shopData', (msg) => {
      setShop(msg.shop);
      if (msg.charged > 0) {
        const item = (msg.shop as ShopState).items.find((i) => i.id === msg.itemId);
        setNotice({ kind: 'ok', text: `${item?.name ?? '아이템'}을(를) 샀어요! -${msg.charged} 달란트` });
      }
    });
    const offError = gameSocket.on('error', (msg) => setNotice({ kind: 'error', text: msg.message }));
    gameSocket.send('shopOpen', { roomId });
    return () => {
      offData();
      offError();
    };
  }, [roomId]);

  if (!shop) {
    return (
      <div className="shop-overlay">
        <div className="shop-panel">
          <p className="subtitle">{notice?.text ?? '상점을 여는 중이에요...'}</p>
          <button className="btn btn-sm" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    );
  }

  // 미리보기: 지금 착용 중인 것 + 눌러 본 아이템
  const preview: Cosmetics = tryOn ? { ...shop.equipped, [tryOn.slot]: tryOn.id } : shop.equipped;
  const capPct = Math.min(100, (shop.weekEarned / shop.weeklyCap) * 100);

  function act(item: ShopItem) {
    setNotice(null);
    setTryOn(null);
    const owned = shop!.owned.includes(item.id);
    const equipped = shop!.equipped[item.slot] === item.id;
    if (!owned) gameSocket.send('shopBuy', { roomId, itemId: item.id });
    else gameSocket.send('shopEquip', { roomId, itemId: item.id, equip: !equipped });
  }

  return (
    <div className="shop-overlay">
      <div className="shop-panel">
        <div className="shop-head">
          <h2 className="shop-title">
            <span className="title-block block-gold" aria-hidden />
            달란트 상점
          </h2>
          <span className="count-block shop-balance">
            <span className="talent-coin" aria-hidden />
            {shop.balance}
          </span>
          <button className="btn btn-sm" onClick={onClose}>
            닫기
          </button>
        </div>

        <div className="shop-body">
          <div className="shop-side">
            <div className="shop-preview">
              {webgl ? (
                <Suspense fallback={<AvatarIcon avatarId={avatarId} cosmetics={preview} size={120} />}>
                  <AvatarPreview3D avatarId={avatarId} cosmetics={preview} />
                </Suspense>
              ) : (
                <AvatarIcon avatarId={avatarId} cosmetics={preview} size={120} />
              )}
            </div>
            <p className="shop-preview-label">{tryOn ? `입어 보는 중: ${tryOn.name}` : `${shop.nickname}의 캐릭터`}</p>
            <div className="shop-wearing">
              {SLOTS.map((slot) => {
                const item = shop.items.find((i) => i.id === shop.equipped[slot]);
                return (
                  <span key={slot} className={`wear-chip ${item ? 'on' : ''}`}>
                    {SLOT_LABEL[slot]}: {item ? item.name : '기본'}
                  </span>
                );
              })}
            </div>
            <div className="cap-box">
              <div className="cap-line">
                <span>이번 주 받은 달란트</span>
                <b>
                  {shop.weekEarned} / {shop.weeklyCap}
                </b>
              </div>
              <div className="cap-bar">
                <div className={`cap-bar-fill ${shop.weekRemaining === 0 ? 'full' : ''}`} style={{ width: `${capPct}%` }} />
              </div>
              <p className="fine-print">
                {shop.weekRemaining === 0 ? '이번 주 상한을 다 채웠어요. 다음 주에 또 모아요!' : `이번 주에 ${shop.weekRemaining}개 더 받을 수 있어요.`}
              </p>
            </div>
            {notice && <p className={`shop-notice ${notice.kind}`}>{notice.text}</p>}
          </div>

          <div className="shop-catalog">
            {SLOTS.map((slot) => (
              <div key={slot} className="shop-section">
                <h3 className="shop-section-title">{SLOT_LABEL[slot]}</h3>
                <div className="shop-grid">
                  {shop.items
                    .filter((i) => i.slot === slot)
                    .map((item) => {
                      const owned = shop.owned.includes(item.id);
                      const equipped = shop.equipped[item.slot] === item.id;
                      const short = item.price - shop.balance;
                      return (
                        <div key={item.id} className={`shop-item ${equipped ? 'equipped' : ''} ${tryOn?.id === item.id ? 'trying' : ''}`}>
                          <button type="button" className="shop-item-look" onClick={() => setTryOn(tryOn?.id === item.id ? null : item)} title="눌러서 입어 보기">
                            <AvatarIcon avatarId={avatarId} cosmetics={{ [item.slot]: item.id }} size={56} />
                          </button>
                          <div className="shop-item-name">{item.name}</div>
                          <div className="shop-item-desc">{item.desc}</div>
                          {owned ? (
                            <button className={`btn btn-sm shop-btn ${equipped ? 'btn-primary' : ''}`} onClick={() => act(item)}>
                              {equipped ? '착용 중 · 벗기' : '착용하기'}
                            </button>
                          ) : short > 0 ? (
                            <button className="btn btn-sm shop-btn" disabled>
                              <span className="talent-coin" aria-hidden /> {item.price} · {short}개 모자라요
                            </button>
                          ) : (
                            <button className="btn btn-sm shop-btn btn-plus" onClick={() => act(item)}>
                              <span className="talent-coin" aria-hidden /> {item.price} 사기
                            </button>
                          )}
                          {owned && <span className="owned-tag">보유</span>}
                        </div>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
