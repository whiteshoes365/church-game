const STORAGE_KEY = 'church-game-device-id';

// 지금은 로컬 저장소에 임의 id를 저장해서 플레이어를 구분해요.
// TODO(Toss 연동): 토스 앱인토스 환경에서는 이 값을 window.getUserKeyForGame() (또는
// @apps-in-toss/web-framework가 제공하는 동등한 API)로 받아온 유저 키로 대체하세요.
// 그러면 기기를 바꿔도 같은 사용자로 인식할 수 있어요.
export function getDeviceId(): string {
  let id = localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}
