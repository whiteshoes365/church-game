// 달란트 상점 카탈로그 (게임 안 꾸미기 아이템 전용 — 실제 상품 교환이 아니에요).
// 모든 아이템은 직접 디자인한 블록 도형이에요. 다른 게임의 캐릭터·아이템·상표를 쓰지 않아요.
// 가격은 주간 상한(기본 20달란트)에 맞춰, 한두 판이면 살 수 있는 것부터
// 몇 주 모아야 하는 것까지 섞었어요.
export const SHOP_SLOTS = [
  { id: 'hat', label: '모자' },
  { id: 'outfit', label: '옷' },
  { id: 'extra', label: '특별' },
];

export const SHOP_ITEMS = [
  { id: 'hat-sprout', slot: 'hat', name: '새싹 화분 모자', price: 4, desc: '머리 위에서 새싹이 쏙!' },
  { id: 'hat-melon', slot: 'hat', name: '수박 헬멧', price: 7, desc: '시원한 줄무늬 헬멧' },
  { id: 'hat-propeller', slot: 'hat', name: '프로펠러 모자', price: 10, desc: '빙글빙글 돌아가요' },
  { id: 'hat-ruby', slot: 'hat', name: '루비 블록 왕관', price: 15, desc: '빨간 보석이 박힌 왕관' },
  { id: 'outfit-checker', slot: 'outfit', name: '체크무늬 블록 옷', price: 5, desc: '바둑판 무늬 옷' },
  { id: 'outfit-rainbow', slot: 'outfit', name: '무지개 줄무늬 옷', price: 9, desc: '알록달록 다섯 줄' },
  { id: 'outfit-ice', slot: 'outfit', name: '얼음 블록 갑옷', price: 13, desc: '반짝반짝 얼음 갑옷' },
  { id: 'outfit-gold', slot: 'outfit', name: '황금 블록 갑옷', price: 20, desc: '한 주 상한을 다 모아야 해요' },
  { id: 'extra-cape', slot: 'extra', name: '빨강 망토', price: 8, desc: '등 뒤에서 펄럭펄럭' },
  { id: 'extra-pet', slot: 'extra', name: '꼬마 블록 친구', price: 16, desc: '옆에서 둥둥 따라다녀요' },
  { id: 'extra-wings', slot: 'extra', name: '블록 날개', price: 18, desc: '파닥파닥 하얀 날개' },
];

const BY_ID = new Map(SHOP_ITEMS.map((item) => [item.id, item]));

export function getShopItem(itemId) {
  return BY_ID.get(String(itemId)) || null;
}
