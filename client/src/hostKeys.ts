// 방을 만든 브라우저가 호스트 화면을 다시 열 수 있게 방별 호스트 키를 기억해요.
// (키가 없으면 방 PIN 4자리를 입력해서 열 수 있어요)
const KEY = 'church-game:host-keys';

function load(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch {
    return {};
  }
}

export function saveHostKey(roomId: string, hostKey: string) {
  try {
    const all = load();
    all[roomId] = hostKey;
    // 오래된 방 키가 끝없이 쌓이지 않게 최근 30개만 남긴다.
    const entries = Object.entries(all).slice(-30);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* ignore */
  }
}

export function getHostKey(roomId: string): string | undefined {
  return load()[roomId];
}
