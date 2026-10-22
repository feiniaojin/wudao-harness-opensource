// @vitest-environment jsdom
// M76-ux2 §4 — the agent-finish notification: a busy→idle transition while
// the window is HIDDEN (document.hidden) tells the user the run landed —
// via the Tauri notification global when the desktop shell injected it, else
// a document.title flash (✅ 悟道Harness — 任务完成 ↔ normal, 3 flashes @300ms, then
// restored). One notification per busy→idle transition (a ref guard); a
// visible window never notifies; an idle→idle frame never re-arms.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { WudaoClient } from "../src/protocol.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const mount = (el: React.ReactElement): HTMLElement => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(el);
  });
  return container;
};

const setHidden = (hidden: boolean): void => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
};

interface Harness {
  container: HTMLElement;
  client: WudaoClient;
  server: FakeServer;
  answered: Set<number>;
}

function mountedApp(): Harness {
  const server = fakeServer();
  const client = new WudaoClient({
    url: "ws://127.0.0.1:1",
    token: "t",
    wsFactory: () => server.spawn(),
    reconnect: false,
  });
  const container = mount(<App client={client} />);
  act(() => {
    client.connect();
    server.socket.serverOpen();
  });
  return { container, client, server, answered: new Set<number>() };
}

type OpFrame = { id: number; op: Record<string, unknown> };

const opFrames = (h: Harness): OpFrame[] =>
  h.server
    .clientFrames()
    .filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f && "id" in f);

/** A full state frame with overrides — the same shape authOk sends, so a
 *  busy:true then busy:false pair drives the transition under test. */
function sendState(h: Harness, overrides: Record<string, unknown>): void {
  act(() => {
    h.server.socket.serverSend({
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
        ...overrides,
      },
    });
  });
}

async function connectedApp(): Promise<Harness> {
  const h = mountedApp();
  await act(async () => {
    authOk(h.server.socket);
  });
  await act(async () => {
    for (const f of opFrames(h)) {
      if (h.answered.has(f.id)) continue;
      h.answered.add(f.id);
      if (f.op.op === "settingsStatus") {
        h.server.socket.serverSend({
          t: "result",
          id: f.id,
          ok: {
            providers: [],
            credentials: { path: "/root/.wudao/credentials.json", keyCount: 0 },
            settings: {
              memoryEnabled: false,
              uiDefaultMode: null,
              wizardCompletedVersion: 1,
              uiTheme: null,
              uiAccent: null,
            },
            current: { provider: "deepseek", model: "deepseek-chat" },
            envKey: false,
            readiness: false,
            efforts: [],
          },
        });
      } else {
        h.server.socket.serverSend({ t: "result", id: f.id, ok: [] });
      }
    }
  });
  return h;
}

const DONE_TITLE = "✅ 悟道Harness — 任务完成";
const NORMAL_TITLE = "悟道Harness"; // the sessionId effect title (now just 悟道)

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  window.localStorage.removeItem("wudao.ui.v1"); // ui-review-r3 P2: reset the persisted layout between tests
  document.title = "";
  vi.useRealTimers();
  // workspace-ux A2: the mocks pin __TAURI_INTERNALS__.invoke — the tier the
  // real Tauri v2 webview ALWAYS injects (withGlobalTauri's core-only
  // `__TAURI__.core` is only tier 2).
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  delete (window as { __TAURI__?: unknown }).__TAURI__;
  delete (document as { hasFocus?: () => boolean }).hasFocus; // r3 P5's own-property mock
});

describe("agent finish notification (M76-ux2 §4)", () => {
  it("hidden + busy→idle flashes the title 3 times at 300ms, then restores; the guard fires once per transition", async () => {
    vi.useFakeTimers();
    const h = await connectedApp();
    expect(document.title).toBe(NORMAL_TITLE);
    setHidden(true);

    // busy → the arm; title untouched while the run is in flight.
    sendState(h, { busy: true });
    await act(async () => {});
    expect(document.title).toBe(NORMAL_TITLE);

    // → idle: the flash starts on the timer — nothing synchronous.
    sendState(h, { busy: false });
    await act(async () => {});
    expect(document.title).toBe(NORMAL_TITLE);

    const seen: string[] = [];
    for (let i = 0; i < 7; i++) {
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      seen.push(document.title);
    }
    // 3 flashes (done at 1st/3rd/5th tick), restored from the 6th on.
    expect(seen).toEqual([DONE_TITLE, NORMAL_TITLE, DONE_TITLE, NORMAL_TITLE, DONE_TITLE, NORMAL_TITLE, NORMAL_TITLE]);

    // The guard: another idle frame (no busy in between) never re-arms.
    sendState(h, { busy: false });
    await act(async () => {});
    await act(async () => {
      vi.advanceTimersByTime(2_100);
    });
    expect(document.title).toBe(NORMAL_TITLE);
  });

  it("a VISIBLE window never flashes; only the hidden transition arms the fallback", async () => {
    vi.useFakeTimers();
    const h = await connectedApp();
    // ui-review-r3 P5: the notify condition widened to visible-but-UNFOCUSED
    // — this pin means a visible AND FOCUSED window, so hasFocus is mocked
    // true (jsdom's native hasFocus() reads false, which now notifies by
    // design; the r3 suite covers that arm).
    document.hasFocus = () => true;
    setHidden(false);
    sendState(h, { busy: true });
    await act(async () => {});
    sendState(h, { busy: false });
    await act(async () => {});
    await act(async () => {
      vi.advanceTimersByTime(2_100);
    });
    expect(document.title).toBe(NORMAL_TITLE);

    // The arm resets per turn: a FRESH busy→idle while hidden flashes.
    setHidden(true);
    sendState(h, { busy: true });
    await act(async () => {});
    sendState(h, { busy: false });
    await act(async () => {});
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(document.title).toBe(DONE_TITLE);
  });

  // workspace-ux A2: the notification rides the shared tauriInvoke seam
  // (plugin:notification|notify through __TAURI_INTERNALS__.invoke — the
  // tier the Tauri v2 webview always injects). tauriNotify resolves true →
  // done; the two pins below are the false arms: no bridge at all (tests 1-2
  // above run bridge-less) and a REJECTED invoke — the A2 upgrade over the
  // old fire-and-forget, where a late rejection fell back to nothing.
  it("prefers the Tauri notification when the desktop shell injected the bridge — no title flash", async () => {
    vi.useFakeTimers();
    const calls: { cmd: string; args: unknown }[] = [];
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args: unknown) => { calls.push({ cmd, args }); return Promise.resolve(); },
    };
    const h = await connectedApp();
    setHidden(true);
    sendState(h, { busy: true });
    await act(async () => {});
    sendState(h, { busy: false });
    await act(async () => {});
    await act(async () => {
      vi.advanceTimersByTime(2_100);
    });
    // ω99-280 同类钉演进（回滚重做 T2a）：275 主题广播在挂载期经同一桥向
    // 宠物窗发 wudao-pet-theme（boot + settings 重应用，同值两发，消费者
    // 幂等）——notify 的意图不弱化：恰一次、文案钉死；桥上其余只许是已知
    // 形状的环境广播，不许出现第三类命令。
    const notifyCalls = calls.filter((c) => c.cmd === "plugin:notification|notify");
    expect(notifyCalls).toHaveLength(1);
    expect(JSON.stringify(notifyCalls[0]?.args)).toContain("悟道Harness — 任务完成");
    for (const c of calls) {
      if (c.cmd === "plugin:notification|notify") continue;
      expect(c.cmd).toBe("plugin:event|emit");
      expect((c.args as { event?: unknown })?.event).toBe("wudao-pet-theme");
    }
    expect(document.title).toBe(NORMAL_TITLE); // the fallback never ran
  });

  it("a REJECTED notify invoke lands on the title flash (A2: no more fire-and-forget silence)", async () => {
    vi.useFakeTimers();
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: () => Promise.reject(new Error("plugin gone")),
    };
    const h = await connectedApp();
    setHidden(true);
    sendState(h, { busy: true });
    await act(async () => {});
    sendState(h, { busy: false });
    await act(async () => {}); // the tauriNotify promise settles → flashTitle arms
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(document.title).toBe(DONE_TITLE);
  });
});
