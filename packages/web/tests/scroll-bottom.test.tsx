// @vitest-environment jsdom
// M75-ux3 §9 — the chat column's scroll-to-bottom button. The chat flow
// tail-follows only while the user rides the bottom; scrolling >200px up
// floats a 36px accent ↓ circle at the column's bottom-right, clicking it
// SMOOTH-scrolls home (and hides), and the boundary is strict — exactly
// 200px stays hidden. jsdom's scroll geometry is all zeros, so the suite
// pins a tall scroller through defineProperty and drives the onScroll
// handler with real scroll events.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { WudaoClient } from "../src/protocol.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";
import { decl } from "./css-test-utils.js";
import "../src/styles.css";

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
const click = (el: Element | null | undefined): void => {
  act(() => {
    el?.dispatchEvent(new Event("click", { bubbles: true }));
  });
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  window.localStorage.removeItem("wudao.ui.v1"); // ui-review-r3 P2: reset the persisted layout between tests
});

interface Entry {
  name: string;
  type: "file" | "dir";
  size?: number;
  hidden?: boolean;
}

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

type OpFrame = { id: number; op: { op: string; path?: string } };

const opFrames = (h: Harness): OpFrame[] =>
  h.server
    .clientFrames()
    .filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f && "id" in f);

async function drain(h: Harness, listing: Record<string, readonly Entry[]>, settingsOver: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    for (const f of opFrames(h)) {
      if (h.answered.has(f.id)) continue;
      h.answered.add(f.id);
      if (f.op.op === "fileTree") {
        h.server.socket.serverSend({ t: "result", id: f.id, ok: { entries: listing[f.op.path ?? ""] ?? [] } });
      } else if (f.op.op === "settingsStatus") {
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
              ...settingsOver,
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
}

async function connectedApp(listing: Record<string, readonly Entry[]>, settingsOver: Record<string, unknown> = {}): Promise<Harness> {
  const h = mountedApp();
  await act(async () => {
    authOk(h.server.socket);
  });
  await drain(h, listing, settingsOver);
  await drain(h, {}, settingsOver);
  return h;
}

/** Pin a tall scroller on the chat column (jsdom's geometry is zeros) and
 *  scroll it: defineProperty shadows the prototype getters with fixed
 *  values, then a real scroll event drives the onScroll handler. The height
 *  defaults to 2000; the follow tests grow it between ticks to prove the
 *  stick survives content growth (which fires no scroll event). */
function scrollChatTo(chat: HTMLElement, scrollTop: number, scrollHeight = 2000): void {
  Object.defineProperty(chat, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(chat, "clientHeight", { configurable: true, value: 600 });
  act(() => {
    Object.defineProperty(chat, "scrollTop", { configurable: true, writable: true, value: scrollTop });
    chat.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

describe("chat scroll-to-bottom (M75-ux3 §9)", () => {
  it("hidden at the bottom; >200px up floats the 36px accent circle; exactly 200px stays hidden; click smooth-scrolls home and re-hides", async () => {
    const h = await connectedApp({ "": [{ name: "a.ts", type: "file" }] });
    const chat = h.container.querySelector<HTMLElement>(".ide-cell.ide-right .chat");
    expect(chat).not.toBeNull();
    expect(h.container.querySelector(".jump-bottom")).toBeNull(); // at the bottom: no button

    // 2000 - 1200 - 600 = 200 — the spec's threshold is strictly greater.
    scrollChatTo(chat!, 1200);
    expect(h.container.querySelector(".jump-bottom")).toBeNull();

    // One more pixel up floats it.
    scrollChatTo(chat!, 1199);
    const btn = h.container.querySelector<HTMLButtonElement>(".jump-bottom");
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute("aria-label")).toBe("回到底部");
    expect(btn?.textContent).toBe("↓");
    // The §9 look, pinned: the 36px accent circle.
    expect(decl(".jump-bottom", "width")).toBe("36px");
    expect(decl(".jump-bottom", "height")).toBe("36px");
    expect(decl(".jump-bottom", "border-radius")).toBe("50%");
    expect(decl(".jump-bottom", "background")).toBe("var(--accent)");
    expect(decl(".jump-bottom", "color")).toBe("var(--accent-ink)");

    // Click: smooth scroll to the bottom (the full scrollHeight), hidden.
    const scrollTo = vi.fn();
    chat!.scrollTo = scrollTo;
    click(btn);
    expect(scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: "smooth" });
    expect(h.container.querySelector(".jump-bottom")).toBeNull();

    // Scrolling back up re-floats it; riding to the bottom re-hides it.
    scrollChatTo(chat!, 0);
    expect(h.container.querySelector(".jump-bottom")).not.toBeNull();
    scrollChatTo(chat!, 1400); // 2000 - 1400 - 600 = 0 — home
    expect(h.container.querySelector(".jump-bottom")).toBeNull();
  });
});

// ui-review-r5 I3 — 简洁模式 gets the SAME jump affordance (the advanced and
// Buddy columns had it; the simple shell only tail-followed). The shared seam
// (src/use-jump-bottom.tsx) means the visibility rule, the look, and the
// reduced-motion-respecting scroll are one implementation.
describe("simple-mode jump-to-bottom (ui-review-r5 I3)", () => {
  it("scrolled-up mid-run floats the ↓ circle; click smooth-scrolls home and re-hides; the boundary is the shared 200px", async () => {
    const h = await connectedApp({ "": [{ name: "a.ts", type: "file" }] }, { uiDefaultMode: "simple" });
    expect(h.container.querySelector("[data-mode='simple']")).not.toBeNull();
    const chat = h.container.querySelector<HTMLElement>(".simple .chat");
    expect(chat).not.toBeNull();
    expect(h.container.querySelector(".jump-bottom")).toBeNull(); // at the bottom: no button

    // Busy run + scrolled away — the affordance the simple shell lacked.
    await act(async () => {
      h.server.socket.serverSend({
        t: "state",
        state: {
          live: { reasoning: "想", answer: "", busyTools: [] },
          busy: true, queued: [], boardProgress: null, ctxTokens: null, mode: "workspace",
          cachePercent: null, bg: { active: 0, spawned: 0 }, pendingPermission: null, planBoard: null,
          sessionId: "wudao-test-0001", sidecar: null,
        },
      });
    });
    scrollChatTo(chat!, 1199); // 2000 - 1199 - 600 = 201 > 200 — floats
    const btn = h.container.querySelector<HTMLButtonElement>(".simple .jump-bottom");
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute("aria-label")).toBe("回到底部");
    expect(btn?.textContent).toBe("↓");

    // Click: smooth scroll to the bottom (the reduced-motion twin lives in
    // the shared seam), hidden the moment it is used.
    const scrollTo = vi.fn();
    chat!.scrollTo = scrollTo;
    click(btn);
    expect(scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: "smooth" });
    expect(h.container.querySelector(".jump-bottom")).toBeNull();

    // Scrolling back up re-floats it; riding home re-hides it.
    scrollChatTo(chat!, 0);
    expect(h.container.querySelector(".jump-bottom")).not.toBeNull();
    scrollChatTo(chat!, 1400);
    expect(h.container.querySelector(".jump-bottom")).toBeNull();
  });

  it("reduced motion swaps the shared seam's smooth scroll for an instant jump (the r2-I6 twin, same helper)", async () => {
    const h = await connectedApp({}, { uiDefaultMode: "simple" });
    const chat = h.container.querySelector<HTMLElement>(".simple .chat");
    const media = vi.fn().mockReturnValue({ matches: true });
    window.matchMedia = media as unknown as typeof window.matchMedia;
    scrollChatTo(chat!, 0);
    const scrollTo = vi.fn();
    chat!.scrollTo = scrollTo;
    click(h.container.querySelector(".jump-bottom"));
    expect(scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: "auto" });
  });
});

// 0.3.4 反馈（会话上下晃）— tail-follow stability: the shells' old render-time
// `atBottom` read raced fast streaming ticks (render runs after the DOM grew,
// before the follow scroll → distance > 80 → follow flips off, next tick
// flips back on = wobble). The seam's stickRef is SCROLL-EVENT-driven: content
// growth fires no scroll event, so a stuck column follows every tick; a user
// scroll ≥ FOLLOW_BOTTOM_PX up disengages; riding back within the threshold
// re-engages. Both shells pin the same rule through their own column.
const busyState = () => ({
  t: "state",
  state: {
    live: { reasoning: "想", answer: "", busyTools: [] },
    busy: true, queued: [], boardProgress: null, ctxTokens: null, mode: "workspace",
    cachePercent: null, bg: { active: 0, spawned: 0 }, pendingPermission: null, planBoard: null,
    sessionId: "wudao-test-0001", sidecar: null,
  },
});

describe("chat tail-follow stability (0.3.4 反馈)", () => {
  it("stuck column follows content growth across ticks; scrolling up disengages; exactly 80px is not stuck, 79 re-engages", async () => {
    const h = await connectedApp({ "": [{ name: "a.ts", type: "file" }] });
    const chat = h.container.querySelector<HTMLElement>(".ide-cell.ide-right .chat");
    expect(chat).not.toBeNull();
    const scrollTo = vi.fn();
    chat!.scrollTo = scrollTo;

    // Tall scroller, user riding the bottom (distance 0 → stuck).
    scrollChatTo(chat!, 1400);
    // A streaming tick re-renders the column → the seam scrolls home.
    await act(async () => {
      h.server.socket.serverSend(busyState());
    });
    expect(scrollTo).toHaveBeenCalledWith({ top: 2000 });

    // Content GREW between ticks (2000 → 2600): no scroll event fired, stick
    // held, the next tick follows the new bottom — the render-time read used
    // to flip follow off here (distance 600 > 80) and wobble the column.
    Object.defineProperty(chat!, "scrollHeight", { configurable: true, value: 2600 });
    await act(async () => {
      h.server.socket.serverSend(busyState());
    });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 2600 });

    // The user scrolls 2000px up to read: follow disengages, ticks don't yank.
    scrollTo.mockClear();
    scrollChatTo(chat!, 0); // 2600 - 0 - 600 ≥ 80 → unstuck
    await act(async () => {
      h.server.socket.serverSend(busyState());
    });
    expect(scrollTo).not.toHaveBeenCalled();

    // The threshold is strict: exactly FOLLOW_BOTTOM_PX up stays unstuck…
    scrollChatTo(chat!, 1920, 2600); // 2600 - 1920 - 600 = 80
    await act(async () => {
      h.server.socket.serverSend(busyState());
    });
    expect(scrollTo).not.toHaveBeenCalled();
    // …one pixel closer re-engages and the column follows again.
    scrollChatTo(chat!, 1921, 2600); // distance 79
    await act(async () => {
      h.server.socket.serverSend(busyState());
    });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 2600 });
  });

  it("the simple shell rides the same seam (the reported shell)", async () => {
    const h = await connectedApp({}, { uiDefaultMode: "simple" });
    const chat = h.container.querySelector<HTMLElement>(".simple .chat");
    expect(chat).not.toBeNull();
    const scrollTo = vi.fn();
    chat!.scrollTo = scrollTo;

    scrollChatTo(chat!, 1400); // distance 0 → stuck
    await act(async () => {
      h.server.socket.serverSend(busyState());
    });
    expect(scrollTo).toHaveBeenCalledWith({ top: 2000 });
    Object.defineProperty(chat!, "scrollHeight", { configurable: true, value: 2600 });
    await act(async () => {
      h.server.socket.serverSend(busyState());
    });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 2600 }); // follows growth — no wobble

    scrollTo.mockClear();
    scrollChatTo(chat!, 0);
    await act(async () => {
      h.server.socket.serverSend(busyState());
    });
    expect(scrollTo).not.toHaveBeenCalled(); // user reading up: follow off
  });
});
