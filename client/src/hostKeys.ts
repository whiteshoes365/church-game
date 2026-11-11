// 방을 만든 브라우저가 호스트 화면을 다시 열 수 있게 방별 호스트 키를 기억해요.
// (키가 없으면 진행자 비밀번호를 입력해서 열 수 있어요. 방 PIN 으로는 열 수 없어요)
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

// ---------------------------------------------------------------------------
// 재접속 키 · 송출 키
// ---------------------------------------------------------------------------
// - 재접속 키(controlKey): 진행자 비밀번호로 확인받은 기기(휴대폰 리모컨 등)가 새로고침·재접속 때
//   비밀번호를 다시 치지 않게 해 준다. 비밀번호 자체는 저장하지 않는다. 비밀번호가 바뀌면 못 쓴다.
// - 송출 키(displayKey): 송출 화면(프로젝터 PC)이 새로고침 뒤에도 같은 방을 다시 띄우게 해 준다.
//   보기 전용이라 이 키로는 진행을 못 한다.
function makeStore(storageKey: string) {
  function loadAll(): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || '{}') || {};
    } catch {
      return {};
    }
  }
  return {
    get(roomId: string): string | undefined {
      return loadAll()[roomId];
    },
    save(roomId: string, value: string) {
      try {
        const all = loadAll();
        if (all[roomId] === value) return;
        delete all[roomId];
        all[roomId] = value;
        localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-30))));
      } catch {
        /* ignore */
      }
    },
    remove(roomId: string) {
      try {
        const all = loadAll();
        delete all[roomId];
        localStorage.setItem(storageKey, JSON.stringify(all));
      } catch {
        /* ignore */
      }
    },
  };
}

export const controlKeys = makeStore('church-game:control-keys');
export const displayKeys = makeStore('church-game:display-keys');

/** 방을 다시 열 때 보낼 값들 (있는 것만). */
export function hostCredentials(roomId: string | undefined): { hostKey?: string; controlKey?: string } {
  if (!roomId) return {};
  return { hostKey: getHostKey(roomId), controlKey: controlKeys.get(roomId) };
}

// 이 휴대폰이 마지막으로 연 리모컨 방 (PC 연결 QR 을 찍었을 때 어느 방에 붙일지 알기 위해)
const LAST_REMOTE = 'church-game:last-remote-room';

export function saveLastRemoteRoom(roomId: string) {
  try {
    localStorage.setItem(LAST_REMOTE, roomId);
  } catch {
    /* ignore */
  }
}

export function getLastRemoteRoom(): string | null {
  try {
    return localStorage.getItem(LAST_REMOTE);
  } catch {
    return null;
  }
}
