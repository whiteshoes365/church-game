type Listener = (payload: any) => void;

const WS_URL = (import.meta.env.VITE_WS_URL as string | undefined) ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

class GameSocket {
  private socket: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private queue: string[] = [];
  // 다시 연결됐을 때 부를 함수들 (송출 화면·리모컨·진행자 화면이 "방 다시 열기"를 여기에 건다).
  private openHooks = new Set<() => void>();
  private everOpened = false;
  private retryTimer: number | null = null;
  private watching = false;
  /** 연결을 시도했는데 아직 열리지 않은 시각 (열려 있거나 시도한 적 없으면 null). 서버 깨우기 안내에 쓴다. */
  waitingSince: number | null = null;

  connect() {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const socket = new WebSocket(WS_URL);
    this.socket = socket;
    if (this.waitingSince === null) this.waitingSince = Date.now();
    socket.addEventListener('open', () => {
      this.waitingSince = null;
      // 끊겼다가 다시 붙은 경우: 먼저 방을 다시 열고(권한 확인), 그 다음에 밀린 메시지를 보낸다.
      if (this.everOpened) for (const fn of [...this.openHooks]) fn();
      this.everOpened = true;
      for (const raw of this.queue) socket.send(raw);
      this.queue = [];
      this.emit('socketOpen');
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.emit('socketClose');
      // 한 번도 연결된 적이 없으면(서버가 자고 있다 깨어나는 중일 수 있음) 화면 종류와 상관없이 다시 시도한다.
      if (!this.everOpened) this.scheduleFirstConnectRetry();
      else if (this.openHooks.size === 0) this.waitingSince = null; // 다시 연결하지 않는 화면: 안내를 계속 띄우지 않는다
      this.scheduleRetry();
    });
    socket.addEventListener('message', (event) => {
      let msg: any;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      const set = this.listeners.get(msg.type);
      if (set) for (const fn of set) fn(msg);
    });
  }

  private emit(type: string) {
    const set = this.listeners.get(type);
    if (set) for (const fn of [...set]) fn({ type });
  }

  // 다시 연결은 "방 다시 열기"를 걸어 둔 화면이 있을 때만 한다 (다른 화면의 동작은 예전 그대로).
  private scheduleRetry() {
    if (this.openHooks.size === 0 || this.retryTimer !== null) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (this.openHooks.size > 0) this.connect();
    }, 1200);
  }

  private scheduleFirstConnectRetry() {
    if (this.retryTimer !== null) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (!this.everOpened) this.connect();
    }, 2000);
  }

  get isOpen() {
    return !!this.socket && this.socket.readyState === WebSocket.OPEN;
  }

  /**
   * 연결이 끊겼다가 다시 붙을 때마다 fn 을 부른다 (휴대폰이 잠겼다 켜질 때, 와이파이가 바뀔 때 등).
   * 이 함수를 걸어 둔 동안에는 끊기면 자동으로 다시 연결한다.
   */
  onReconnect(fn: () => void): () => void {
    this.openHooks.add(fn);
    if (!this.watching) {
      this.watching = true;
      const wake = () => {
        if (this.openHooks.size > 0 && document.visibilityState !== 'hidden') this.connect();
      };
      document.addEventListener('visibilitychange', wake);
      window.addEventListener('online', wake);
      window.addEventListener('focus', wake);
    }
    return () => {
      this.openHooks.delete(fn);
    };
  }

  send(type: string, payload: Record<string, unknown> = {}) {
    const raw = JSON.stringify({ type, ...payload });
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(raw);
    } else {
      this.queue.push(raw);
      this.connect();
    }
  }

  on(type: string, fn: Listener): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }
}

export const gameSocket = new GameSocket();
