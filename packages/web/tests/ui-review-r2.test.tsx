// @vitest-environment jsdom
// ui-review-r2 — the round's fix suite. One test per brief finding:
//   C1  the unified clear (offline fallback + the + button's frontend reply)
//   I1  the composer draft survives an ask takeover (advanced + simple)
//   I2  a busy sidebar row click refuses (no resume op, a notice)
//   I3  Enter on an open PermissionModal DENIES (zero allow ops); the
//       ClearConfirm keeps its Enter-keep idiom with no autofocus
//   I4  the workspace-switch gate — RETIRED by workspace-ux B1: a pick
//       re-roots the file panel through panelRootSet (view root only), so
//       busy/draft no longer gate anything — the pins below now hold the
//       switch to that contract
//   I5  ResumePicker/AskUserCards: Esc and the scrim actually close
//   I6  the reduced-motion block exists (ONE) and the JS scroll respects it
//   I7  clearView bumps historyEpoch — write-tools count from zero after
//   I8  a mode chip flips the LIVE shell; the sidebar refetches on a
//       session change
//   P6  Esc with an overlay open closes the overlay, never interrupts
//   invoke  the desktop dialog/notification plugins through core.invoke
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { AskUserCards } from "../src/components/AskUserCards.js";
import { WudaoClient } from "../src/protocol.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";
// I6's CSS half: mount the stylesheet so the CSSOM exposes the media block.
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
const key = (el: Element | null | undefined, k: string): void => {
  act(() => {
    el?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  window.localStorage.removeItem("wudao.ui.v1"); // ui-review-r3 P2: reset the persisted layout between tests
  document.title = "";
  // workspace-ux A2: the bridge mocks pin __TAURI_INTERNALS__.invoke (the
  // tier Tauri v2 always injects); the core-only __TAURI__.core is tier 2.
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  delete (window as { __TAURI__?: unknown }).__TAURI__;
});

/** Type into a controlled textarea the way a browser does (native setter +
 *  the input event — React's onChange ignores a bare .value assignment). */
function type(el: HTMLTextAreaElement | HTMLInputElement, text: string): void {
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
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

type OpFrame = { id: number; op: Record<string, unknown> };

const opFrames = (h: Harness): OpFrame[] =>
  h.server
    .clientFrames()
    .filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f && "id" in f);

/** A full state frame with overrides (authOk's shape). */
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

/** Answer pending ops: settingsStatus (advanced default), fileTree (empty),
 *  recentWorkspaces (the scripted list), agentRootStatus (aligned at
 *  /w/root), panelRootSet (echo the path), everything else a bare ok. */
async function drain(h: Harness, recents: readonly { path: string; lastUsed: string }[] = []): Promise<void> {
  await act(async () => {
    for (const f of opFrames(h)) {
      if (h.answered.has(f.id)) continue;
      h.answered.add(f.id);
      let ok: unknown = [];
      if (f.op.op === "settingsStatus") {
        ok = {
          providers: [],
          credentials: { path: "/root/.wudao/credentials.json", keyCount: 0 },
          settings: { memoryEnabled: false, uiDefaultMode: null, wizardCompletedVersion: 1, uiTheme: null, uiAccent: null },
          current: { provider: "deepseek", model: "deepseek-chat" },
          envKey: false,
          readiness: false,
          efforts: [],
        };
      } else if (f.op.op === "fileTree") {
        ok = { entries: [] };
      } else if (f.op.op === "recentWorkspaces") {
        ok = { workspaces: f.op.add !== undefined ? [{ path: f.op.add, lastUsed: "now" }, ...recents] : recents };
      } else if (f.op.op === "agentRootStatus") {
        ok = { panelRoot: "/w/root", agentRoot: "/w/root", aligned: true };
      } else if (f.op.op === "panelRootSet") {
        ok = { root: f.op.path };
      }
      h.server.socket.serverSend({ t: "result", id: f.id, ok });
    }
  });
}

async function connectedApp(recents: readonly { path: string; lastUsed: string }[] = []): Promise<Harness> {
  const h = mountedApp();
  await act(async () => {
    authOk(h.server.socket);
  });
  await drain(h, recents);
  await drain(h, recents); // the tree mounts behind the settingsStatus reply
  return h;
}

/** Reply to the LAST unanswered op of a name with `ok`. */
const reply = async (h: Harness, opName: string, ok: unknown): Promise<void> => {
  await act(async () => {
    const op = [...opFrames(h)].reverse().find((o) => o.op.op === opName && !h.answered.has(o.id));
    if (op !== undefined) {
      h.answered.add(op.id);
      h.server.socket.serverSend({ t: "result", id: op.id, ok });
    }
  });
};

const hasOp = (h: Harness, pred: (op: Record<string, unknown>) => boolean): boolean =>
  opFrames(h).some((o) => pred(o.op));

// ---------------------------------------------------------------------------
// C1 — the unified clear.
// ---------------------------------------------------------------------------
describe("ui-review-r2 C1 — the unified /clear path", () => {
  it("the + confirm's 'frontend' reply wipes the view (the driver-deferred clear)", async () => {
    const h = await connectedApp();
    await act(async () => {
      h.server.socket.serverSend({ t: "history", entries: [{ kind: "user", text: "旧消息" }], reset: false });
    });
    click(h.container.querySelector(".topbar .new-chat"));
    click(h.container.querySelector(".modal-card .wudao.danger"));
    expect(hasOp(h, (o) => o.op === "submit" && o.text === "/clear")).toBe(true);
    await reply(h, "submit", "frontend");
    expect(h.container.textContent).not.toContain("旧消息");
    expect(h.container.textContent).toContain("历史已清空");
  });

  it("offline (gave-up) the confirm falls back to the view wipe — no submit op, an honest receipt", async () => {
    // The reconnect-cap harness: reconnect defaults ON with scripted timers.
    const server = fakeServer();
    const timers: ((() => void) | undefined)[] = [];
    const client = new WudaoClient({
      url: "ws://127.0.0.1:1",
      token: "t",
      wsFactory: () => server.spawn(),
      setTimeout: (fn) => {
        timers.push(fn);
        return timers.length - 1;
      },
      clearTimeout: (i) => {
        if (typeof i === "number") timers[i] = undefined;
      },
    });
    const container = mount(<App client={client} />);
    act(() => {
      client.connect();
      server.socket.serverOpen();
    });
    await act(async () => {
      authOk(server.socket, {}, [{ kind: "user", text: "离线前的对话" }]);
    });
    act(() => {
      for (let i = 0; i < 9; i++) {
        server.socket.serverClose(1006, "");
        if (client.getSnapshot().connection !== "reconnecting") break;
        timers[timers.length - 1]?.();
      }
    });
    expect(container.textContent).toContain("连接已断开"); // gave-up — the shell still renders
    const h: Harness = { container, client, server, answered: new Set<number>() };
    click(container.querySelector(".topbar .new-chat"));
    click(container.querySelector(".modal-card .wudao.danger"));
    // The wire is dead: NO submit went out (sendOp rejects pre-send), the
    // view wiped locally with the offline receipt.
    expect(hasOp(h, (o) => o.op === "submit")).toBe(false);
    expect(container.textContent).not.toContain("离线前的对话");
    expect(container.textContent).toContain("离线：仅视图");
  });
});

// ---------------------------------------------------------------------------
// I1 — the parked draft.
// ---------------------------------------------------------------------------
describe("ui-review-r2 I1 — the composer draft survives interruptions", () => {
  it("advanced: a permission ask popping mid-typing does not eat the draft", async () => {
    const h = await connectedApp();
    const input = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(input, "写到一半的提问");
    });
    // The ask takes over the input area (the composer unmounts).
    sendState(h, { busy: true, pendingPermission: { toolName: "write_file", summary: "src/a.ts", input: {} } });
    expect(h.container.querySelector("textarea.wudao-input")).toBeNull();
    // Resolved elsewhere (deny): the composer returns WITH the draft.
    sendState(h, { busy: false, pendingPermission: null });
    const back = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    expect(back).not.toBeNull();
    expect(back.value).toBe("写到一半的提问");
  });

  it("simple mode: the approval-card takeover keeps the draft too", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await reply(h, "settingsStatus", {
      providers: [],
      credentials: { path: "/c", keyCount: 0 },
      settings: { memoryEnabled: true, uiDefaultMode: "simple", wizardCompletedVersion: 1, uiTheme: null, uiAccent: null },
      current: { provider: "deepseek", model: "m" },
      envKey: false,
      readiness: true,
      efforts: [],
    });
    const input = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(input, "排队中的草稿");
    });
    sendState(h, { pendingPermission: { toolName: "write_file", summary: "src/a.ts", input: {} } });
    expect(h.container.querySelector("textarea.wudao-input")).toBeNull(); // the approval card took over
    // Answer ALLOW (the op resolves; no vanish receipt) — the composer returns.
    click(h.container.querySelector(".approval .wudao.primary, .approval-card .wudao.primary, button.wudao.primary"));
    await reply(h, "answerPermission", true);
    sendState(h, { pendingPermission: null });
    const back = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    expect(back).not.toBeNull();
    expect(back.value).toBe("排队中的草稿");
  });
});

// ---------------------------------------------------------------------------
// I2 — the busy sidebar guard.
// ---------------------------------------------------------------------------
describe("ui-review-r2 I2 — the sidebar resume busy guard", () => {
  it("a mid-run sidebar click refuses: no resume op, a notice", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await reply(h, "settingsStatus", {
      providers: [],
      credentials: { path: "/c", keyCount: 0 },
      settings: { memoryEnabled: true, uiDefaultMode: "buddy", wizardCompletedVersion: 1, uiTheme: null, uiAccent: null },
      current: { provider: "deepseek", model: "m" },
      envKey: false,
      readiness: true,
      efforts: [],
    });
    await reply(h, "sessions", [
      { id: "resume-target-1", mtime: new Date().toISOString(), messages: 2, firstUser: "hi", model: "m" },
    ]);
    sendState(h, { busy: true }); // a run is in flight
    click(h.container.querySelector(".sb-i"));
    expect(hasOp(h, (o) => o.op === "resume")).toBe(false); // nothing on the wire
    expect(h.container.textContent).toContain("运行中无法 切换会话（任务进行中）"); // the refusal notice
  });
});

// ---------------------------------------------------------------------------
// I3 — Enter takes the safe action.
// ---------------------------------------------------------------------------
describe("ui-review-r2 I3 — Enter-safe dialogs", () => {
  it("Enter on an open PermissionModal DENIES — zero allow ops; the dialog owns focus (no button autofocus)", async () => {
    const h = await connectedApp();
    sendState(h, { pendingPermission: { toolName: "shell", summary: "rm -rf", input: {} } });
    const card = h.container.querySelector(".permission-card") as HTMLElement;
    expect(card).not.toBeNull();
    expect(document.activeElement).toBe(card); // the container, never the allow button
    key(card, "Enter");
    expect(hasOp(h, (o) => o.op === "answerPermission" && o.allow === false)).toBe(true);
    expect(hasOp(h, (o) => o.op === "answerPermission" && o.allow === true)).toBe(false);
  });

  it("ClearConfirm: Enter keeps (no /clear submit); no button is autofocused", async () => {
    const h = await connectedApp();
    const input = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(input, "/clear");
    });
    key(input, "Enter");
    const modal = h.container.querySelector(".modal-card") as HTMLElement;
    expect(modal).not.toBeNull();
    expect(document.activeElement).toBe(modal);
    key(modal, "Enter");
    expect(h.container.querySelector(".modal-card")).toBeNull(); // cancelled
    expect(hasOp(h, (o) => o.op === "submit" && o.text === "/clear")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// I4 — the workspace-switch gate, retired by workspace-ux B1.
// ---------------------------------------------------------------------------
describe("ui-review-r2 I4 — the workspace pick (workspace-ux B1: panel re-root, no gate)", () => {
  it("busy: a recent pick re-roots the panel immediately — no confirm, no switchWorkspace, the run untouched", async () => {
    const h = await connectedApp([{ path: "/w/proj-b", lastUsed: "t" }]);
    sendState(h, { busy: true });
    click(h.container.querySelector(".ws-switcher"));
    await drain(h, [{ path: "/w/proj-b", lastUsed: "t" }]);
    click(h.container.querySelector(".ws-menu .ws-item"));
    await drain(h); // the panelRootSet reply + the remounted tree's fetches
    // The old r2 premise (the navigate kills the run) is gone: a view-root
    // switch disrupts nothing, so no confirm ever opens.
    expect(h.container.querySelector(".modal-card")).toBeNull();
    expect(hasOp(h, (o) => o.op === "panelRootSet" && o.path === "/w/proj-b")).toBe(true);
    expect(hasOp(h, (o) => o.op === "switchWorkspace")).toBe(false);
    // Still busy — nothing was interrupted.
    expect(h.container.querySelector(".chat")?.textContent).toContain("文件面板根 → /w/proj-b");
  });

  it("an unsent draft survives a pick (no navigate anymore); the label follows the receipt", async () => {
    const h = await connectedApp([{ path: "/w/proj-c", lastUsed: "t" }]);
    const input = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(input, "没发出去的话");
    });
    click(h.container.querySelector(".ws-switcher"));
    await drain(h, [{ path: "/w/proj-c", lastUsed: "t" }]);
    click(h.container.querySelector(".ws-menu .ws-item"));
    await drain(h);
    expect(h.container.querySelector(".modal-card")).toBeNull();
    expect(hasOp(h, (o) => o.op === "panelRootSet" && o.path === "/w/proj-c")).toBe(true);
    // The draft is still in the composer — the pick navigates nothing now.
    const after = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    expect(after.value).toBe("没发出去的话");
    expect(h.container.querySelector(".ws-switcher .tree-root")?.textContent).toContain("proj-c");
  });
});

// ---------------------------------------------------------------------------
// I5 — Esc and the scrim close what says "(Esc)".
// ---------------------------------------------------------------------------
describe("ui-review-r2 I5 — honest cancel affordances", () => {
  it("ResumePicker: Escape and the scrim click close; 1-9 still picks", async () => {
    const h = await connectedApp();
    const input = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(input, "/resume");
    });
    key(input, "Enter");
    await reply(h, "sessions", [
      { id: "wudao-old-1", mtime: "2026-08-16T10:00:00.000Z", messages: 4, firstUser: "fix bug", model: "deepseek" },
    ]);
    expect(h.container.textContent).toContain("选择要恢复的会话");
    key(h.container.querySelector(".modal-card"), "Escape");
    expect(h.container.querySelector(".modal-card")).toBeNull();
    // Reopen — the scrim click closes too.
    await act(async () => {
      type(h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement, "/resume");
    });
    key(h.container.querySelector("textarea.wudao-input"), "Enter");
    await reply(h, "sessions", [
      { id: "wudao-old-1", mtime: "2026-08-16T10:00:00.000Z", messages: 4, firstUser: "fix bug", model: "deepseek" },
    ]);
    click(h.container.querySelector(".scrim"));
    expect(h.container.querySelector(".modal-card")).toBeNull();
  });

  it("AskUserCards: Escape (from the cards AND the free-text input) and the scrim dismiss", async () => {
    let dismissed = 0;
    const c = mount(
      <AskUserCards
        question="Which DB?"
        options={[{ label: "postgres" }, { label: "sqlite" }]}
        onAnswer={() => {}}
        onDismiss={() => { dismissed += 1; }}
      />,
    );
    key(c.querySelector(".modal-card"), "Escape");
    expect(dismissed).toBe(1);
    click(c.querySelector(".scrim"));
    expect(dismissed).toBe(2);
    // The free-text variant: Escape on the INPUT bubbles to the modal.
    const c2 = mount(<AskUserCards question="Name?" onAnswer={() => {}} onDismiss={() => { dismissed += 1; }} />);
    key(c2.querySelector("input.wudao-input"), "Escape");
    expect(dismissed).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// I6 — reduced motion.
// ---------------------------------------------------------------------------
describe("ui-review-r2 I6 — prefers-reduced-motion", () => {
  it("styles.css carries EXACTLY ONE reduced-motion block, neutralizing transitions and animation loops", () => {
    const media = [...document.styleSheets].flatMap((s) => {
      try {
        return [...s.cssRules];
      } catch {
        return [];
      }
    }).filter((r) => r instanceof CSSMediaRule);
    const reduced = media.filter(
      (r) => (r as CSSMediaRule).conditionText.includes("prefers-reduced-motion"),
    ) as CSSMediaRule[];
    expect(reduced).toHaveLength(1);
    const body = reduced[0]!.cssRules[0] as CSSStyleRule;
    // inkline 2026-08-22 §1.4: the source now writes .01ms (no leading
    // zero) and adds animation-duration — jsdom returns the declared text
    // verbatim, so the pin follows the new source form.
    expect(body.style.getPropertyValue("transition-duration")).toBe(".01ms");
    expect(body.style.getPropertyValue("animation-duration")).toBe(".01ms");
    expect(body.style.getPropertyValue("animation-iteration-count")).toBe("1");
  });

  it("the jump-bottom scroll respects the query: reduce → behavior auto, default → smooth", async () => {
    const h = await connectedApp();
    const chat = h.container.querySelector<HTMLElement>(".ide-cell.ide-right .chat") as HTMLElement;
    const scrollChatTo = (scrollTop: number): void => {
      Object.defineProperty(chat, "scrollHeight", { configurable: true, value: 2000 });
      Object.defineProperty(chat, "clientHeight", { configurable: true, value: 600 });
      act(() => {
        Object.defineProperty(chat, "scrollTop", { configurable: true, writable: true, value: scrollTop });
        chat.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
    };
    scrollChatTo(0); // float the button
    const btn = h.container.querySelector<HTMLButtonElement>(".jump-bottom");
    expect(btn).not.toBeNull();
    // Reduced motion (mocked): the jump lands instantly.
    const real = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes("prefers-reduced-motion"), media: q })) as typeof window.matchMedia;
    try {
      const reduced = vi.fn();
      chat.scrollTo = reduced;
      click(btn);
      expect(reduced).toHaveBeenCalledWith({ top: 2000, behavior: "auto" });
    } finally {
      window.matchMedia = real;
    }
    // Default: the smooth scroll the scroll-bottom suite pins.
    scrollChatTo(0);
    const smooth = vi.fn();
    chat.scrollTo = smooth;
    click(h.container.querySelector(".jump-bottom"));
    expect(smooth).toHaveBeenCalledWith({ top: 2000, behavior: "smooth" });
  });
});

// ---------------------------------------------------------------------------
// I7 — clearView bumps the epoch.
// ---------------------------------------------------------------------------
describe("ui-review-r2 I7 — clearView is a history replacement", () => {
  it("the client bumps historyEpoch; the App's write-watcher counts write tools from zero after a view clear", async () => {
    const h = await connectedApp();
    // Two agent writes already seen (the watcher seeds on the reset frame).
    await act(async () => {
      h.server.socket.serverSend({
        t: "history",
        entries: [{ kind: "tool", name: "write_file", summary: "a.ts" }, { kind: "tool", name: "write_file", summary: "b.ts" }],
        reset: false,
      });
    });
    await drain(h); // the watcher's treeRefresh bump → the tree refetches
    const treeFetches = (): number => opFrames(h).filter((o) => o.op.op === "fileTree").length;
    const before = treeFetches();
    // The view-only clear (the offline fallback arm) — epoch-bumped now.
    act(() => {
      h.client.clearView();
    });
    expect(h.client.getSnapshot().historyEpoch).toBeGreaterThan(1); // reset(1) + clearView(2)
    // ONE new write tool after the clear counts as fresh news → a refetch.
    await act(async () => {
      h.server.socket.serverSend({ t: "history", entries: [{ kind: "tool", name: "write_file", summary: "c.ts" }], reset: false });
    });
    await drain(h);
    expect(treeFetches()).toBeGreaterThan(before); // pre-fix: the count stayed 2 → no bump
  });
});

// ---------------------------------------------------------------------------
// I8 — the live mode flip + the sidebar refresh.
// ---------------------------------------------------------------------------
describe("ui-review-r2 I8 — live mode flip + sidebar refresh", () => {
  it("a 简洁模式 chip write flips the shell LIVE (no reload) and lands the 已切换 notice", async () => {
    const h = await connectedApp();
    click(h.container.querySelector(".topbar button[aria-label='设置']"));
    await reply(h, "settingsStatus", {
      providers: [],
      credentials: { path: "/c", keyCount: 0 },
      settings: { memoryEnabled: true, uiDefaultMode: null, wizardCompletedVersion: 1, uiTheme: null, uiAccent: null },
      current: { provider: "deepseek", model: "m" },
      envKey: false,
      readiness: true,
      efforts: [],
    });
    // settings-split: the 默认界面 chips ride the 偏好 tab — route through it.
    click(h.container.querySelector("button[data-settings-tab='preferences']"));
    const chip = [...h.container.querySelectorAll("button[data-default-mode]")].find(
      (b) => b.getAttribute("data-default-mode") === "simple",
    ) as HTMLButtonElement;
    click(chip);
    await reply(h, "settingsSet", { key: "ui.defaultMode", saved: true });
    // The shell flipped while the settings page is still up...
    expect(h.container.querySelector(".settings-page")).not.toBeNull();
    expect(h.container.textContent).toContain("已切换"); // the settings receipt
    // ...and the flip is real: closing the page lands on the SIMPLE shell
    // (its own composer placeholder) with the App-level notice in history.
    click(h.container.querySelector(".settings-head button"));
    expect(h.container.querySelector(".settings-page")).toBeNull();
    expect(h.container.querySelector(".simple")).not.toBeNull();
    expect(h.container.textContent).toContain("已切换到简洁模式 — 重载后完全生效");
  });

  it("the sidebar refetches when the active session changes", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await reply(h, "settingsStatus", {
      providers: [],
      credentials: { path: "/c", keyCount: 0 },
      settings: { memoryEnabled: true, uiDefaultMode: "buddy", wizardCompletedVersion: 1, uiTheme: null, uiAccent: null },
      current: { provider: "deepseek", model: "m" },
      envKey: false,
      readiness: true,
      efforts: [],
    });
    await reply(h, "sessions", []);
    const fetches = (): number => opFrames(h).filter((o) => o.op.op === "sessions").length;
    // ω99-156: two mount fetches now — the sidebar's + App's activeName boot
    // read (App 自拉 + 侧栏零动 is the arc's pinned design).
    expect(fetches()).toBe(2); // the mount fetches
    // A resume elsewhere rotates the driver's session id → the panel refreshes.
    sendState(h, { sessionId: "wudao-new-9999" });
    await act(async () => {});
    // ω99-156: the rotation refires BOTH readers (+1 each): 2 → 4.
    expect(fetches()).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// P6 — overlay-first Esc.
// ---------------------------------------------------------------------------
describe("ui-review-r2 P6 — Esc closes the overlay, never interrupts", () => {
  it("with the ctx menu open, Esc in the composer closes the menu and fires NO interrupt op", async () => {
    const h = await connectedApp();
    await act(async () => {
      h.server.socket.serverSend({ t: "history", entries: [{ kind: "user", text: "复制我" }], reset: false });
    });
    sendState(h, { busy: true });
    const entry = h.container.querySelector(".chat .entry") as HTMLElement;
    act(() => {
      entry.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    expect(h.container.querySelector(".menu")).not.toBeNull(); // the menu is open
    key(h.container.querySelector("textarea.wudao-input"), "Escape");
    expect(h.container.querySelector(".menu")).toBeNull(); // the menu ate the Esc
    expect(hasOp(h, (o) => o.op === "interrupt")).toBe(false); // the run lives
  });
});

// ---------------------------------------------------------------------------
// The desktop invoke bridge — dialog through the shared tauriInvoke seam
// (workspace-ux A2: __TAURI_INTERNALS__.invoke, the tier Tauri v2 always
// injects; the old __TAURI__.core pin was tier 2 of the same resolver).
// ---------------------------------------------------------------------------
describe("ui-review-r2 — the desktop invoke bridge", () => {
  it("打开其他目录… calls plugin:dialog|open through __TAURI_INTERNALS__.invoke and routes the pick into panelRootSet", async () => {
    const calls: { cmd: string; args: unknown }[] = [];
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args: unknown) => { calls.push({ cmd, args }); return Promise.resolve("/w/picked"); },
    };
    const h = await connectedApp();
    click(h.container.querySelector(".ws-switcher"));
    await drain(h);
    click(h.container.querySelector(".ws-menu .ws-open-other"));
    await act(async () => {}); // the invoke promise resolves
    // ω99-280: #1 — 钉演进（m81 先例）：原钉「invoke 流恰为 [dialog]」写于
    // ω99-275 主题广播之前的年代——275 起 applyTheme 单一缝（boot stamp 与
    // settingsStatus 落地都过它，275 test ③ 钉死「都过它且必 emit」）在挂载
    // 期向宠物窗广播 wudao-pet-theme（同值两发：boot + settings 重应用，消费
    // 者幂等）。dialog 的意图不变且不弱化：恰一次、directory 参数；环境广播
    // 从「缺席」改钉「已知形状」——把 275 的意外变成本件的覆盖（桥上不许
    // 出现第三类命令）。
    const dialogCalls = calls.filter((c) => c.cmd === "plugin:dialog|open");
    expect(dialogCalls).toHaveLength(1);
    expect(JSON.stringify(dialogCalls[0]?.args)).toContain("directory");
    for (const c of calls) {
      if (c.cmd === "plugin:dialog|open") continue;
      // 环境发射只许是宠物主题广播（事件名+载荷形状都钉）。
      expect(c.cmd).toBe("plugin:event|emit");
      expect((c.args as { event?: unknown })?.event).toBe("wudao-pet-theme");
      expect((c.args as { payload?: unknown })?.payload).toEqual({ theme: "dark" });
    }
    // The picked path re-roots the panel (workspace-ux B1: view root only —
    // no switchWorkspace, no navigate, nothing killed).
    expect(hasOp(h, (o) => o.op === "panelRootSet" && o.path === "/w/picked")).toBe(true);
    expect(hasOp(h, (o) => o.op === "switchWorkspace")).toBe(false);
  });

  it("a null/cancelled dialog picks nothing; a defensive string[] shape still resolves [0]", async () => {
    let result: unknown = null;
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: () => Promise.resolve(result),
    };
    const h = await connectedApp();
    click(h.container.querySelector(".ws-switcher"));
    await drain(h);
    click(h.container.querySelector(".ws-menu .ws-open-other"));
    await act(async () => {});
    expect(hasOp(h, (o) => o.op === "panelRootSet")).toBe(false); // cancel = no switch, and NO browser notice (the bridge exists)
    expect(h.container.textContent).not.toContain("浏览器模式无法选择目录");
    // The belt-and-suspenders array shape.
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: () => Promise.resolve(["/w/first", "/w/second"]),
    };
    click(h.container.querySelector(".ws-switcher"));
    await drain(h);
    click(h.container.querySelector(".ws-menu .ws-open-other"));
    await act(async () => {});
    expect(hasOp(h, (o) => o.op === "panelRootSet" && o.path === "/w/first")).toBe(true);
  });

  it("no invoke (plain browser) keeps the CLI-fallback notice", async () => {
    const h = await connectedApp();
    click(h.container.querySelector(".ws-switcher"));
    await drain(h);
    click(h.container.querySelector(".ws-menu .ws-open-other"));
    await act(async () => {});
    expect(h.container.textContent).toContain("浏览器模式无法选择目录");
  });
});

// ---------------------------------------------------------------------------
// r2 task-review follow-ups — pins for the three review findings.
// ---------------------------------------------------------------------------
describe("ui-review-r2 review — follow-up pins", () => {
  it("the topbar + refuses while a run is in flight (same notice as typed /clear)", async () => {
    const h = await connectedApp();
    sendState(h, { busy: true });
    click(h.container.querySelector(".topbar .new-chat"));
    expect(h.container.querySelector(".modal-card")).toBeNull(); // no confirm opened
    expect(hasOp(h, (o) => o.op === "submit" && o.text === "/clear")).toBe(false);
    expect(h.container.textContent).toContain("⚠️ 运行中无法 /clear（任务进行中）"); // the refusal notice (r4 P2 tone, r7 P1 unified suffix)
  });

  it("a parked draft is DROPPED when the unhide crosses a session switch", async () => {
    const h = await connectedApp();
    const input = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(input, "A 会话的草稿");
    });
    // The ask hides the composer; the draft parks.
    sendState(h, { pendingPermission: { toolName: "write_file", summary: "src/a.ts", input: {} } });
    expect(h.container.querySelector("textarea.wudao-input")).toBeNull();
    // The ask resolves AND the session changed while hidden (a resume landed
    // behind the takeover) — the parked draft must not seed session B.
    sendState(h, { pendingPermission: null, sessionId: "wudao-test-0002" });
    const after = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    expect(after.value).toBe("");
  });

  it("a parked draft SURVIVES an unhide on the SAME session (the /clear TUI-parity case)", async () => {
    const h = await connectedApp();
    const input = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    await act(async () => {
      type(input, "同会话的草稿");
    });
    sendState(h, { pendingPermission: { toolName: "write_file", summary: "src/a.ts", input: {} } });
    sendState(h, { pendingPermission: null }); // same sessionId stands
    const back = h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    expect(back.value).toBe("同会话的草稿");
  });
});
