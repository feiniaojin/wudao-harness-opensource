// A tiny in-memory WebSocket double for protocol tests: the client side
// implements WebSocketLike; the server side scripts frames at it and records
// everything the client sent. No network, no jsdom — pure logic round-trips.
import type { WsEventMap, WebSocketLike } from "../src/protocol.js";

type Listener<K extends keyof WsEventMap> = (ev: WsEventMap[K]) => void;

export class FakeWebSocket implements WebSocketLike {
  /** Frames the CLIENT sent, raw (JSON strings) — in order. */
  readonly sent: string[] = [];
  /** 0 CONNECTING · 1 OPEN · 3 CLOSED (mirrors the DOM constants). */
  readyState = 0;
  private readonly listeners: { [K in keyof WsEventMap]: Listener<K>[] } = {
    open: [],
    message: [],
    close: [],
    error: [],
  };
  closedByClient = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closedByClient = true;
    this.emit("close", { code: 1000, reason: "client closed" });
  }

  addEventListener<K extends keyof WsEventMap>(type: K, cb: Listener<K>): void {
    this.listeners[type].push(cb);
  }

  private emit<K extends keyof WsEventMap>(type: K, ev: WsEventMap[K]): void {
    for (const cb of [...this.listeners[type]]) cb(ev);
  }

  // --- server-side scripting ---

  serverOpen(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  serverSend(frame: unknown): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }
}

export interface FakeServer {
  /** Every socket the client opened, in connect order. */
  readonly sockets: readonly FakeWebSocket[];
  /** The latest socket (script the live connection through this). */
  readonly socket: FakeWebSocket;
  /** Frames the client sent on the CURRENT socket, parsed. */
  clientFrames(): unknown[];
  /** wsFactory body: hand the client a fresh scripted socket. */
  spawn(): FakeWebSocket;
}

/** A scripted server + wsFactory pair: every WudaoClient connect() gets a
 *  fresh socket; the latest one is exposed for scripting. */
export function fakeServer(): FakeServer {
  const sockets: FakeWebSocket[] = [];
  return {
    sockets,
    get socket(): FakeWebSocket {
      const last = sockets[sockets.length - 1];
      if (last === undefined) throw new Error("no socket yet — the client has not connected");
      return last;
    },
    clientFrames(): unknown[] {
      return this.socket.sent.map((s) => JSON.parse(s) as unknown);
    },
    spawn(): FakeWebSocket {
      const s = new FakeWebSocket();
      sockets.push(s);
      return s;
    },
  };
}

/** The status frame a real server sends right after auth (PROTOCOL: on
 *  successful auth the server immediately sends state + history reset). */
export function authOk(
  socket: FakeWebSocket,
  status: Record<string, unknown> = {},
  history: readonly unknown[] = [],
): void {
  socket.serverSend({
    t: "state",
    state: {
      live: { reasoning: "", answer: "", busyTools: [] },
      busy: false,
      queued: [],
      boardProgress: null,
      ctxTokens: null,
      mode: "workspace",
      cachePercent: null,
      bg: { active: 0, spawned: 0 },
      pendingPermission: null,
      planBoard: null,
      sessionId: "wudao-test-0001",
      sidecar: null,
      ...status,
    },
  });
  socket.serverSend({ t: "history", entries: history, reset: true });
}
