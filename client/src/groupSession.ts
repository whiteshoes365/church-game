// 교사가 연 반 코드/PIN을 이 브라우저 탭 세션에만 기억해요(sessionStorage).
// 탭을 닫으면 사라지고, 서버에는 PIN 해시만 저장돼요.
const KEY = 'church-game:group-session';

export interface GroupSession {
  code: string;
  pin: string;
}

export function normalizeGroupCode(code: string): string {
  return code.trim().toLowerCase().replace(/\s+/g, '');
}

export function loadGroupSession(): GroupSession | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (typeof v?.code === 'string' && typeof v?.pin === 'string') return v;
  } catch {
    /* ignore */
  }
  return null;
}

export function saveGroupSession(session: GroupSession) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ code: normalizeGroupCode(session.code), pin: session.pin }));
  } catch {
    /* ignore */
  }
}

export function clearGroupSession() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// 같은 브라우저의 다른 탭에 세션 넘겨주기
// ---------------------------------------------------------------------------
// 진행자 화면의 「출석 · 달란트」는 게임 화면을 그대로 두려고 새 탭으로 열려요.
// sessionStorage 는 탭마다 따로라서, 새 탭은 방금 연 반의 교사 PIN 을 모르고
// 다시 물어봤어요. 그래서 같은 브라우저(같은 주소) 안에서만 통하는
// BroadcastChannel 로 "이 반을 이미 연 탭"에게 세션을 물어봐요.
// 다른 브라우저·다른 기기에는 닿지 않으므로 거기서는 여전히 교사 PIN 을 입력해야 해요.
const CHANNEL = 'church-game:group-session';

type HandoffMessage =
  | { type: 'ask'; code: string; nonce: string }
  | { type: 'answer'; code: string; nonce: string; pin: string };

function openChannel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
  } catch {
    return null;
  }
}

let serving = false;

/** 이 탭이 반을 열어 둔 상태라면, 같은 브라우저의 새 탭이 물어볼 때 세션을 알려 줘요. */
export function serveGroupSession() {
  if (serving) return;
  const channel = openChannel();
  if (!channel) return;
  serving = true;
  channel.addEventListener('message', (event: MessageEvent<HandoffMessage>) => {
    const msg = event.data;
    if (!msg || msg.type !== 'ask') return;
    const session = loadGroupSession();
    if (session && session.code === msg.code) {
      channel.postMessage({ type: 'answer', code: msg.code, nonce: msg.nonce, pin: session.pin } satisfies HandoffMessage);
    }
  });
}

/** 같은 브라우저의 다른 탭이 이 반을 열어 뒀으면 그 세션을 받아 와요. 없으면 null. */
export function requestGroupSession(code: string, timeoutMs = 400): Promise<GroupSession | null> {
  return new Promise((resolve) => {
    const channel = openChannel();
    if (!channel) {
      resolve(null);
      return;
    }
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const finish = (session: GroupSession | null) => {
      clearTimeout(timer);
      channel.close();
      resolve(session);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    channel.addEventListener('message', (event: MessageEvent<HandoffMessage>) => {
      const msg = event.data;
      if (msg && msg.type === 'answer' && msg.nonce === nonce && msg.code === code && typeof msg.pin === 'string') {
        finish({ code, pin: msg.pin });
      }
    });
    channel.postMessage({ type: 'ask', code, nonce } satisfies HandoffMessage);
  });
}
