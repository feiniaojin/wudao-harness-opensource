// @vitest-environment jsdom
// ui-review-r4 — the round's fix suite. One block per brief finding:
//   I1  a failed submit re-arms the text (reject / notice-noop re-arm;
//       started stays cleared) — the composer's synchronous clear no longer
//       destroys the draft on a dead socket
//   I2  the accent twin of themeTouched — a LOCAL accent pick survives a
//       stale settingsStatus reply
//   I3  tree + viewer refetch after a reconnect (the epoch bump keys both)
//   I4  /help carries the App-level chord line; FileSearch carries the
//       SessionPicker header hint
//   P1  the /clear-flow copy is Chinese (ClearConfirm buttons); the
//       reconnecting banner joins the gave-up banner's language
//   P2  the busy-refusal notices' error tone is Chinese; the paren style
//       standard (half-width, no surrounding spaces) holds on touched copy
//   P3  panel widths re-clamp on window resize
//   P4  the pointer:coarse block bumps the three 16px glyph buttons
//   FU2 the driver's real /clear ("cleared") gets the fresh-session receipt
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App, FileSearch } from "../src/components/App.js";
import { ClearConfirm } from "../src/components/ClearConfirm.js";
import { WudaoClient } from "../src/protocol.js";
import type { SettingsStatus } from "../src/protocol.js";
import { formatSlashHelp } from "../src/slash.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";
import { stylesCss } from "./styles-source.js";

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
const unmount = (): void => {
  act(() => {
    root?.unmount();
  });
  root = null;
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
/** Type into a controlled input the way a real browser does. */
function type(el: HTMLTextAreaElement | HTMLInputElement, text: string): void {
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
const innerWidthOf = (w: number): void => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
};

afterEach(() => {
  unmount();
  document.body.innerHTML = "";
  document.title = "";
  window.localStorage.removeItem("wudao.ui.v1");
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.accent;
  innerWidthOf(1024);
});

// --- the App-level harness (ui-review-r3's). ---

interface Entry {
  name: string;
  type: "file" | "dir";
  size?: number;
}

interface Harness {
  container: HTMLElement;
  client: WudaoClient;
  server: FakeServer;
  answered: Set<number>;
  listing: Record<string, readonly Entry[]>;
  /** The scripted reconnect timers (empty when the client cannot reconnect). */
  timers: ((() => void) | undefined)[];
}

function mountedApp(opts: { reconnect?: boolean } = {}): Harness {
  const server = fakeServer();
  const timers: ((() => void) | undefined)[] = [];
  const client = new WudaoClient({
    url: "ws://127.0.0.1:1",
    token: "t",
    wsFactory: () => server.spawn(),
    reconnect: opts.reconnect ?? false,
    ...(opts.reconnect === true
      ? {
          setTimeout: (fn: () => void) => {
            timers.push(fn);
            return timers.length - 1;
          },
          clearTimeout: (h: unknown) => {
            if (typeof h === "number") timers[h] = undefined;
          },
        }
      : {}),
  });
  const container = mount(<App client={client} />);
  act(() => {
    client.connect();
    server.socket.serverOpen();
  });
  return { container, client, server, answered: new Set<number>(), listing: {}, timers };
}

type OpFrame = { id: number; op: Record<string, unknown> };

const opFrames = (h: Harness): OpFrame[] =>
  h.server
    .clientFrames()
    .filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f && "id" in f);

/** The still-unanswered op frames (submit / settingsSet / … — one reply each). */
const pendingOps = (h: Harness, op: string): OpFrame[] =>
  opFrames(h).filter((f) => !h.answered.has(f.id) && f.op.op === op);

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

/** Answer pending ops: settingsStatus (advanced default, `settings` overridable),
 *  fileTree/fileRead from the listing table (or `failing` — paths whose read
 *  REJECTS), everything else a bare ok. */
async function drain(
  h: Harness,
  opts: { listing?: Record<string, readonly Entry[]>; failing?: readonly string[]; settings?: Partial<SettingsStatus["settings"]> } = {},
): Promise<void> {
  if (opts.listing !== undefined) h.listing = opts.listing;
  await act(async () => {
    for (const f of opFrames(h)) {
      if (h.answered.has(f.id)) continue;
      h.answered.add(f.id);
      let ok: unknown = [];
      let err: string | undefined;
      const path = typeof f.op.path === "string" ? f.op.path : "";
      if (f.op.op === "settingsStatus") {
        ok = {
          providers: [],
          credentials: { path: "/root/.wudao/credentials.json", keyCount: 0 },
          settings: { memoryEnabled: false, uiDefaultMode: null, wizardCompletedVersion: 1, uiTheme: null, uiAccent: null, ...opts.settings },
          current: { provider: "deepseek", model: "deepseek-chat" },
          envKey: false,
          readiness: false,
          efforts: [],
        };
      } else if (f.op.op === "fileTree") {
        ok = { entries: h.listing[path] ?? [] };
      } else if (f.op.op === "fileRead") {
        if ((opts.failing ?? []).includes(path)) err = "no such file";
        else ok = { content: `// ${path}\n`, truncated: false, totalBytes: 8, lines: 1, language: "ts" };
      }
      h.server.socket.serverSend(err !== undefined ? { t: "result", id: f.id, err } : { t: "result", id: f.id, ok });
    }
  });
}

async function connectedApp(listing: Record<string, readonly Entry[]> = {}): Promise<Harness> {
  const h = mountedApp();
  await act(async () => {
    authOk(h.server.socket);
  });
  await drain(h, { listing });
  await drain(h); // the tree mounts behind the settingsStatus reply
  return h;
}

const textarea = (h: Harness): HTMLTextAreaElement => h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;

/** Type `text` and press Enter — the composer's synchronous submit path. */
async function submitLine(h: Harness, text: string): Promise<void> {
  const input = textarea(h);
  await act(async () => {
    type(input, text);
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
}

/** Reply every pending `op` frame with `ok`/`err` (a fake server's result). */
async function replyOps(h: Harness, op: string, payload: { ok?: unknown; err?: string }): Promise<void> {
  await act(async () => {
    for (const f of pendingOps(h, op)) {
      h.answered.add(f.id);
      h.server.socket.serverSend(payload.err !== undefined ? { t: "result", id: f.id, err: payload.err } : { t: "result", id: f.id, ok: payload.ok });
    }
  });
}

// ---------------------------------------------------------------------------
// I1 — a failed submit re-arms the composed text.
// ---------------------------------------------------------------------------
describe("ui-review-r4 I1 — the failed submit re-arms the draft", () => {
  it("a REJECTED submit (socket error) returns the text to the composer + the failure notice", async () => {
    const h = await connectedApp();
    await submitLine(h, "keep me");
    expect(textarea(h).value).toBe(""); // the synchronous clear already ran
    await replyOps(h, "submit", { err: "connection closed (1006)" });
    expect(textarea(h).value).toBe("keep me"); // re-armed through the seed seam
    expect(h.container.textContent).toContain("submit 失败："); // ω99-202 消费者钉随行（App #4 error 尾中文化）
  });

  it("a notice/noop outcome also re-arms (the driver refused it); started keeps the buffer cleared", async () => {
    const h = await connectedApp();
    await submitLine(h, "first try");
    await replyOps(h, "submit", { ok: "noop" });
    expect(textarea(h).value).toBe("first try"); // the driver took nothing — the text comes back
    await submitLine(h, "second try");
    await replyOps(h, "submit", { ok: "started" });
    expect(textarea(h).value).toBe(""); // the turn was taken — cleared stays cleared
  });
});

// ---------------------------------------------------------------------------
// I2 — the accent's stale-reply guard.
// ---------------------------------------------------------------------------
describe("ui-review-r4 I2 — a local accent pick survives a stale settingsStatus reply", () => {
  it("blue picked on the settings page is not stomped by a uiAccent=black reply still on the wire", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await act(async () => {
      for (const f of opFrames(h)) {
        if (f.op.op !== "listSlashCommands" || h.answered.has(f.id)) continue;
        h.answered.add(f.id);
        h.server.socket.serverSend({ t: "result", id: f.id, ok: [] });
      }
    });
    // settingsStatus stays IN FLIGHT — open the page, route to the 外观 tab
    // (settings-split: the pickers are lazy behind it), and pick blue locally.
    click(h.container.querySelector(".topbar button[aria-label='设置']"));
    click(h.container.querySelector("button[data-settings-tab='appearance']"));
    await act(async () => {
      (h.container.querySelector("[data-appearance-accent='blue']") as HTMLButtonElement).click();
    });
    expect(document.documentElement.dataset.accent).toBe("blue");
    await replyOps(h, "settingsSet", { ok: { key: "ui.accent", saved: true } });
    // The stale reply lands NOW (a different accent) — the pick must survive.
    await replyOps(h, "settingsStatus", { ok: { providers: [], credentials: { path: "/c", keyCount: 0 }, settings: { memoryEnabled: false, uiDefaultMode: null, wizardCompletedVersion: 1, uiTheme: null, uiAccent: "black" }, current: { provider: "deepseek", model: "m" }, envKey: false, readiness: false, efforts: [] } });
    expect(document.documentElement.dataset.accent).toBe("blue");
  });
});

// ---------------------------------------------------------------------------
// I3 — the panels refetch after a reconnect.
// ---------------------------------------------------------------------------
describe("ui-review-r4 I3 — tree + viewer refetch on reconnect", () => {
  it("connection ok→dropped→ok: the reconnect replay bumps the epoch and BOTH panels re-fetch on the new socket", async () => {
    const h = mountedApp({ reconnect: true });
    const listing: Record<string, readonly Entry[]> = { "": [{ name: "a.ts", type: "file", size: 3 }] };
    await act(async () => {
      authOk(h.server.socket);
    });
    await drain(h, { listing });
    await drain(h); // the tree mounts + the root fetch answers
    click(h.container.querySelector('.tree-node[data-path="a.ts"] > .ft-row')); // open the tab
    await drain(h); // the viewer's read answers
    const socket1 = h.server.socket;
    expect(opFrames(h).some((o) => o.op.op === "fileTree" && o.op.path === "")).toBe(true);
    // Drop and reconnect: banner in Chinese, then a full replay (reset → epoch).
    act(() => {
      socket1.serverClose(1006, "");
    });
    expect(h.container.textContent).toContain("连接断开(close 1006) — 正在重连");
    await act(async () => {
      h.timers[0]?.();
      h.server.socket.serverOpen();
      authOk(h.server.socket, {}, [{ kind: "user", text: "after" }]);
    });
    expect(h.server.socket).not.toBe(socket1); // a genuinely new connection
    await drain(h, { listing });
    // The tree's root listing and the viewer's open tab BOTH re-fetched on
    // the new socket — no stale pre-drop content behind a recovery banner.
    expect(opFrames(h).some((o) => o.op.op === "fileTree" && o.op.path === "")).toBe(true);
    expect(opFrames(h).some((o) => o.op.op === "fileRead" && o.op.path === "a.ts")).toBe(true);
    expect(h.container.textContent).toContain("after"); // the replay restored
  });
});

// ---------------------------------------------------------------------------
// I4 — the chords are discoverable.
// ---------------------------------------------------------------------------
describe("ui-review-r4 I4 — App-level chords are discoverable", () => {
  it("formatSlashHelp carries the chord line (Ctrl+P, Ctrl+B, Cmd/Ctrl+,, Ctrl+W, Ctrl+Tab, Ctrl+1-9)", () => {
    const help = formatSlashHelp([], { mode: "ask" });
    expect(help).toContain("Ctrl+P");
    expect(help).toContain("Ctrl+B");
    expect(help).toContain("Cmd/Ctrl+,");
    expect(help).toContain("Ctrl+W");
    expect(help).toContain("Ctrl+Tab");
    expect(help).toContain("Ctrl+1-9");
  });

  it("/help through the composer renders the chord mentions into the transcript", async () => {
    const h = await connectedApp();
    await submitLine(h, "/help");
    expect(h.container.textContent).toContain("Ctrl+P");
    expect(h.container.textContent).toContain("Ctrl+B");
  });

  it("FileSearch carries the SessionPicker header hint (↑↓ 选择 · Enter 打开 · Esc 关闭)", () => {
    const c = mount(<FileSearch getAllKnownPaths={() => []} onOpenPath={() => {}} onClose={() => {}} />);
    const head = c.querySelector(".search-pop .session-head");
    expect(head?.textContent).toBe("文件搜索 — ↑↓ 选择 · Enter 打开 · Esc 关闭");
  });
});

// ---------------------------------------------------------------------------
// P1 — the /clear-flow copy.
// ---------------------------------------------------------------------------
describe("ui-review-r4 P1 — unified /clear-flow language", () => {
  it("ClearConfirm's buttons are Chinese (heading stays); y/n/Enter/Esc keep the single-shot contract", () => {
    const onChoose = vi.fn();
    const c = mount(<ClearConfirm onChoose={onChoose} />);
    const buttons = [...c.querySelectorAll(".modal-card .btnrow button")].map((b) => b.textContent);
    expect(buttons).toEqual(["清空", "保留 (Esc)"]); // tokfinish §7: 键名提示统一 (Esc) 大写
    expect(c.querySelector(".modal-card h3")?.textContent).toContain("清空历史"); // statecover E: the heading joined the Chinese family
    key(c.querySelector(".modal-card"), "y"); // clears
    key(c.querySelector(".modal-card"), "Escape"); // single-shot — resolved already
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith(true);
  });
});

// ---------------------------------------------------------------------------
// P2 — error tone + paren style on the touched copy.
// ---------------------------------------------------------------------------
describe("ui-review-r4 P2 — error tone + paren standard", () => {
  it("the busy /clear refusal is the Chinese error tone", async () => {
    const h = await connectedApp();
    sendState(h, { busy: true });
    await submitLine(h, "/clear");
    expect(h.container.textContent).toContain("⚠️ 运行中无法 /clear（任务进行中）");
    expect(h.container.textContent).not.toContain("cannot /clear");
  });

  it("the busy session-switch refusal is the Chinese error tone", async () => {
    const h = await connectedApp();
    sendState(h, { busy: true });
    click(h.container.querySelector(".topbar button[aria-label='会话列表']"));
    expect(h.container.textContent).toContain("⚠️ 运行中无法 切换会话（任务进行中）");
  });

  it("touched CJK-adjacent parens carry no surrounding spaces (the dominant standard)", async () => {
    const h = await connectedApp();
    expect(h.container.querySelector(".topbar .new-chat")?.getAttribute("title")).toBe("新对话(清空当前会话)");
  });
});

// ---------------------------------------------------------------------------
// P3 — panel widths re-clamp on resize.
// ---------------------------------------------------------------------------
describe("ui-review-r4 P3 — widths re-clamp on resize", () => {
  it("a 720px tree on a 1800px window re-clamps to 40% when the window shrinks to 900px", async () => {
    const listing: Record<string, readonly Entry[]> = { "": [{ name: "a.ts", type: "file" }] };
    const h = await connectedApp(listing);
    const ide = () => h.container.querySelector<HTMLElement>(".ide");
    innerWidthOf(1800);
    act(() => {
      h.container.querySelector('.ide-drag[data-side="left"]')?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 240 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 760 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup", { clientX: 760 }));
    });
    // Dragged to 740 (default 220 + delta 520); 720 = 40% of 1800 — the
    // clamp's ceiling engages (the 7d87d1a geometry rebalance moved the
    // default 240→220, so the drag overshoots and the max clamp proves out).
    expect(ide()?.style.getPropertyValue("--tree-w")).toBe("720px");
    innerWidthOf(900);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(ide()?.style.getPropertyValue("--tree-w")).toBe("360px"); // 40% of 900 — re-clamped
    expect(ide()?.style.getPropertyValue("--chat-w")).toBe("360px"); // the right panel rides the same clamp (400 > 360)
  });
});

// ---------------------------------------------------------------------------
// P4 — coarse-pointer hit areas.
// ---------------------------------------------------------------------------
describe("ui-review-r4 P4 — pointer:coarse touch targets", () => {
  it("one media block bumps .ide-toggle / .at-btn / .tclose to 24px hit areas", () => {
    const at = stylesCss.indexOf("@media (pointer: coarse)");
    expect(at).toBeGreaterThanOrEqual(0);
    const block = stylesCss.slice(at, stylesCss.indexOf("@media (prefers-reduced-motion"));
    for (const sel of [".ide-toggle", ".filetree .at-btn", ".tabbar .tab .tclose"]) {
      expect(block).toContain(sel);
    }
    expect(block).toContain("width: 24px");
    expect(block).toContain("height: 24px");
    // ONE block only — the consolidated rule.
    expect(stylesCss.split("@media (pointer: coarse)").length - 1).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Follow-up 2 — the driver's real /clear receipt.
// ---------------------------------------------------------------------------
describe("ui-review-r4 follow-up 2 — the \"cleared\" outcome receipt", () => {
  it("reply \"cleared\" → the fresh-session receipt (and the reset frame owns the view)", async () => {
    const h = await connectedApp();
    await act(async () => {
      h.server.socket.serverSend({ t: "history", entries: [{ kind: "user", text: "旧消息" }], reset: false });
    });
    await submitLine(h, "/clear"); // the ClearConfirm path (Chinese buttons, P1)
    expect(h.container.textContent).toContain("旧消息"); // nothing wiped pre-confirm
    click(h.container.querySelector(".modal-card button.danger")); // 清空
    await act(async () => {
      h.server.socket.serverSend({ t: "history", entries: [], reset: true }); // the driver's reset frame
    });
    await replyOps(h, "submit", { ok: "cleared" });
    expect(h.container.textContent).not.toContain("旧消息");
    expect(h.container.textContent).toContain("历史已清空 —— 全新会话");
    // The view-reset wording stays the OLDER server's ("frontend") arm.
    expect(h.container.textContent).not.toContain("仅重置视图");
  });
});
