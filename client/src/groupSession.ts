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
