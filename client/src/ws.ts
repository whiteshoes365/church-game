type Listener = (payload: any) => void;

const WS_URL = (import.meta.env.VITE_WS_URL as string | undefined) ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

class GameSocket {
  private socket: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private queue: string[] = [];

  connect() {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const socket = new WebSocket(WS_URL);
    this.socket = socket;
    socket.addEventListener('open', () => {
      for (const raw of this.queue) socket.send(raw);
      this.queue = [];
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
