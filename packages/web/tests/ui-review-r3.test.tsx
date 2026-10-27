// @vitest-environment jsdom
// ui-review-r3 — the round's fix suite. One test per brief finding:
//   I1  the wizard's missing-endpoint dead end — ② badges 需 BASE_URL, ③
//       saves the paste directly (no test op) and proceeds on the warning
//   I2  上一步 at steps ③-⑤ (a wrong pick is correctable)
//   I3  the panel separators: focusable, Arrow/Home/End resize through the
//       drag's own clamp, aria-valuenow/min/max maintained
//   I5  both API-key inputs carry aria-label
//   I6  SessionPicker Esc works while the rows still load
//   I7  notify() folds consecutive duplicates (×N) and caps at 50
//   P1  the sidebar's relative times re-render on a 60s tick
//   P2  panel widths + collapse flags + open tabs persist (wudao.ui.v1),
//       corrupt JSON falls back, a stale tab drops on its failed read
//   P3  palette scoring — "app" ranks app.ts above web/happy/mapper.ts
//   P4  the palette guard swallows only Ctrl+P; Ctrl+B reaches the global
//   P5  a VISIBLE-but-unfocused window still notifies on busy→idle
//   P6  astral-plane filenames highlight the match, unshifted
//   P7  settings/wizard own focus; Esc closes settings, confirms in the
//       wizard (the skip write only on an explicit 确认)
//   P8  two concurrent wizard completion failures both stay visible
//   (I4 — session rename/delete — is deferred by the brief, documented in
//   the round's report, not implemented here.)
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  App,
  FileSearch,
  SessionPicker,
  appendNotice,
  MAX_LOCAL_NOTICES,
  mergeLocalNotes,
  pathCharsWithHits,
} from "../src/components/App.js";
import { Wizard } from "../src/components/Wizard.js";
import { SettingsPage } from "../src/components/SettingsPage.js";
import { SessionSidebar } from "../src/components/SessionSidebar.js";
import { WudaoClient } from "../src/protocol.js";
import type { SettingsStatus } from "../src/protocol.js";
import { WIZARD_COPY_VERSION } from "../src/wizard.js";
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
/** A GLOBAL chord — the App's window-level listener. */
const press = (k: string, mods: { ctrlKey?: boolean; metaKey?: boolean } = {}): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
  });
};
/** Type into a controlled input the way a real browser does. */
function type(el: HTMLTextAreaElement | HTMLInputElement, text: string): void {
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  unmount();
  document.body.innerHTML = "";
  document.title = "";
  window.localStorage.removeItem("wudao.ui.v1");
  delete (document as { hasFocus?: () => boolean }).hasFocus; // P5's own-property mock
  delete (window as { __TAURI__?: unknown }).__TAURI__;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  vi.useRealTimers();
});

// --- the App-level harness (ui-review-r2's, plus the ide listing table). ---

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
  return { container, client, server, answered: new Set<number>(), listing: {} };
}

type OpFrame = { id: number; op: Record<string, unknown> };

const opFrames = (h: Harness): OpFrame[] =>
  h.server
    .clientFrames()
    .filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f && "id" in f);

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

/** Answer pending ops: settingsStatus (advanced default), fileTree/fileRead
 *  from the listing table (or `failing` — paths whose read REJECTS),
 *  everything else a bare ok. */
async function drain(h: Harness, opts: { listing?: Record<string, readonly Entry[]>; failing?: readonly string[] } = {}): Promise<void> {
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
          settings: { memoryEnabled: false, uiDefaultMode: null, wizardCompletedVersion: 1, uiTheme: null, uiAccent: null },
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

const hasOp = (h: Harness, pred: (op: Record<string, unknown>) => boolean): boolean =>
  opFrames(h).some((o) => pred(o.op));

const tabPaths = (h: Harness): string[] =>
  [...h.container.querySelectorAll(".tab")].map((t) => t.getAttribute("data-path") ?? "");

// --- the wizard harness (wizard.test.tsx's, trimmed). ---

const card = (provider: string, status: SettingsStatus["providers"][number]["status"]): SettingsStatus["providers"][number] => ({
  provider,
  label: provider,
  status,
  keySource: status === "ready" ? "credentials" : null,
  endpoint: provider === "wudao" ? null : `https://${provider}.example/v1`,
  defaultModel: provider === "glm" ? "glm-4.6" : "wudao-preview",
  custom: false,
  models: [],
});

const NOT_READY: SettingsStatus = {
  providers: [card("deepseek", "missing-key"), card("glm", "missing-key"), card("wudao", "missing-endpoint")],
  credentials: { path: "/home/u/.wudao/.credentials.yaml", keyCount: 0 },
  settings: { memoryEnabled: true, uiDefaultMode: "simple", wizardCompletedVersion: 0, uiTheme: null, uiAccent: null },
  current: { provider: "deepseek", model: "deepseek-v4-flash" },
  envKey: false,
  readiness: false,
  efforts: [],
};

interface WizardHarness {
  container: HTMLElement;
  client: WudaoClient;
  server: FakeServer;
  answered: Set<number>;
}

function connectedClient(server: FakeServer): WudaoClient {
  const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
  act(() => {
    client.connect();
    server.socket.serverOpen();
  });
  act(() => {
    authOk(server.socket);
  });
  return client;
}

function mountedWizard(onDone: () => void = () => {}): WizardHarness {
  const server = fakeServer();
  const client = connectedClient(server);
  const container = mount(<Wizard client={client} status={null} settings={NOT_READY} onDone={onDone} />);
  return { container, client, server, answered: new Set<number>() };
}

const wizardOps = (h: WizardHarness): { id: number; op: Record<string, unknown> }[] =>
  h.server
    .clientFrames()
    .filter((f): f is { id: number; op: Record<string, unknown> } =>
      typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>),
    ) as { id: number; op: Record<string, unknown> }[];

/** Reply to every still-unanswered wizard op (per-op ok shapes, or `fail`),
 *  looping to a fixpoint — the wizard chains ops (a passing test fires the
 *  auto-save inside its .then), so one pass leaves the chained op pending. */
async function answerWizard(h: WizardHarness, fail?: (op: Record<string, unknown>) => string | undefined): Promise<void> {
  const okOf = (op: Record<string, unknown>): unknown => {
    if (op.op === "settingsTestConnection") return { ok: true, state: "ok", message: "连接成功" };
    if (op.op === "settingsSaveKey") return { provider: op.provider, saved: true, keyCount: 1 };
    if (op.op === "submit") return "ok";
    return [];
  };
  for (let round = 0; round < 5; round++) {
    const pending = wizardOps(h).filter((o) => !h.answered.has(o.id));
    if (pending.length === 0) return;
    await act(async () => {
      for (const o of pending) {
        h.answered.add(o.id);
        const err = fail?.(o.op);
        h.server.socket.serverSend(err !== undefined ? { t: "result", id: o.id, err } : { t: "result", id: o.id, ok: okOf(o.op) });
      }
    });
  }
}

const btnByText = (scope: HTMLElement, text: string): HTMLButtonElement => {
  const b = [...scope.querySelectorAll("button")].find((x) => x.textContent === text);
  if (b === undefined) throw new Error(`button "${text}" missing`);
  return b as HTMLButtonElement;
};

/** Walk ①→② picking `provider`, landing on the key step. */
async function wizardAtKeyStep(h: WizardHarness, provider = "glm"): Promise<void> {
  await act(async () => {
    btnByText(h.container, "开始配置").click();
  });
  await act(async () => {
    const el = [...h.container.querySelectorAll(".wizard-provider-card")].find(
      (n) => n.querySelector(".card-name")?.textContent?.includes(provider) === true,
    );
    if (el === undefined) throw new Error(`provider card ${provider} missing`);
    (el as HTMLElement).click();
  });
  await act(async () => {
    btnByText(h.container, "下一步").click();
  });
}

// ---------------------------------------------------------------------------
// I1 — the missing-endpoint dead end.
// ---------------------------------------------------------------------------
describe("ui-review-r3 I1 — missing-endpoint providers are not a dead end", () => {
  it("② badges the wudao card 需 BASE_URL; ③ saves the paste DIRECTLY (no test op) and proceeds on the warning", async () => {
    const h = mountedWizard();
    await act(async () => {
      btnByText(h.container, "开始配置").click();
    });
    const wudaoCard = [...h.container.querySelectorAll(".wizard-provider-card")].find(
      (n) => n.querySelector(".card-name")?.textContent?.includes("wudao") === true,
    ) as HTMLElement;
    expect(wudaoCard.querySelector(".wizard-badge")?.textContent).toBe("需 BASE_URL");
    await act(async () => {
      wudaoCard.click();
    });
    await act(async () => {
      btnByText(h.container, "下一步").click();
    });
    // ③: the warning is up BEFORE any interaction — the user knows the test
    // is skipped, and the button says what it really does.
    expect(h.container.querySelector("[data-endpoint-warning]")?.textContent).toContain("未配置 BASE_URL");
    expect(h.container.textContent).toContain("连接测试跳过");
    const input = h.container.querySelector("input.key-input") as HTMLInputElement;
    await act(async () => {
      type(input, "sk-compat");
    });
    await act(async () => {
      btnByText(h.container, "保存 Key").click();
    });
    await answerWizard(h); // the settingsSaveKey reply
    expect(wizardOps(h).some((o) => o.op.op === "settingsTestConnection")).toBe(false); // never fired
    expect(btnByText(h.container, "下一步").disabled).toBe(false); // the saved key is enough — no dead end
    await act(async () => {
      btnByText(h.container, "下一步").click();
    });
    expect(h.container.querySelector('[data-step="model"]')).not.toBeNull();
  });

  it("the complete flow through a missing-endpoint provider finishes — no hang, the completion writes all land", async () => {
    let done = 0;
    const h = mountedWizard(() => {
      done += 1;
    });
    await wizardAtKeyStep(h, "wudao");
    const input = h.container.querySelector("input.key-input") as HTMLInputElement;
    await act(async () => {
      type(input, "sk-compat");
    });
    await act(async () => {
      btnByText(h.container, "保存 Key").click();
    });
    await answerWizard(h);
    await act(async () => {
      btnByText(h.container, "下一步").click();
    });
    await act(async () => {
      btnByText(h.container, "下一步").click();
    });
    await act(async () => {
      btnByText(h.container, "完成").click();
    });
    expect(h.container.querySelector('[data-step="done"]')).not.toBeNull(); // landed synchronously
    await answerWizard(h); // every completion write resolves
    expect(h.container.textContent).toContain("供应商 → wudao"); // ω99-310: 称谓随设置面统一
    await act(async () => {
      btnByText(h.container, "开始使用").click();
    });
    expect(done).toBe(1); // onDone handed back — the flow ends, never hangs
  });
});

// ---------------------------------------------------------------------------
// I2 — back navigation.
// ---------------------------------------------------------------------------
describe("ui-review-r3 I2 — the wizard has 上一步", () => {
  it("back from ③ returns to ② with the prior pick intact; forward re-lands on ③", async () => {
    const h = mountedWizard();
    await wizardAtKeyStep(h); // ③, glm picked
    await act(async () => {
      btnByText(h.container, "上一步").click();
    });
    expect(h.container.querySelector('[data-step="provider"]')).not.toBeNull();
    expect(h.container.querySelector(".wizard-provider-card[data-selected='true']")?.textContent).toContain("glm");
    await act(async () => {
      btnByText(h.container, "下一步").click();
    });
    expect(h.container.querySelector('[data-step="key"]')).not.toBeNull();
  });

  it("steps ④⑤ both carry 上一步 (①② do not); the back walk lands on the right step", async () => {
    const h = mountedWizard();
    expect(btnByText(h.container, "开始配置").disabled).toBe(false);
    expect(h.container.textContent).not.toContain("上一步"); // ①
    await wizardAtKeyStep(h); // ③
    expect(btnByText(h.container, "上一步")).toBeDefined();
    const input = h.container.querySelector("input.key-input") as HTMLInputElement;
    await act(async () => {
      type(input, "sk-good");
    });
    await act(async () => {
      btnByText(h.container, "测试连接").click();
    });
    await answerWizard(h); // test pass + save
    await act(async () => {
      btnByText(h.container, "下一步").click();
    }); // ④
    await act(async () => {
      btnByText(h.container, "上一步").click();
    }); // → ③
    expect(h.container.querySelector('[data-step="key"]')).not.toBeNull();
    await act(async () => {
      btnByText(h.container, "下一步").click();
    }); // ④
    await act(async () => {
      btnByText(h.container, "下一步").click();
    }); // ⑤
    await act(async () => {
      btnByText(h.container, "上一步").click();
    }); // → ④
    expect(h.container.querySelector('[data-step="model"]')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// I3 — keyboard-resizable separators.
// ---------------------------------------------------------------------------
describe("ui-review-r3 I3 — the panel separators are keyboard-operable", () => {
  it("focusable; ArrowRight = the same +16px a 16px drag applies, through the shared clamp; aria-valuenow tracks; Home/End hit the bounds", async () => {
    const h = await connectedApp({ "": [{ name: "a.ts", type: "file" }] });
    const ide = () => h.container.querySelector<HTMLElement>(".ide");
    const left = h.container.querySelector<HTMLElement>('.ide-drag[data-side="left"]');
    expect(left).not.toBeNull();
    expect(left?.tabIndex).toBe(0); // the :focus-visible ring finally has a target
    expect(left?.getAttribute("role")).toBe("separator");
    expect(left?.getAttribute("aria-valuemin")).toBe("180");
    expect(left?.getAttribute("aria-valuemax")).toBe("409"); // 40% of 1024
    expect(left?.getAttribute("aria-valuenow")).toBe("220");
    key(left, "ArrowRight");
    expect(ide()?.style.getPropertyValue("--tree-w")).toBe("236px");
    expect(left?.getAttribute("aria-valuenow")).toBe("236");
    key(left, "End");
    expect(ide()?.style.getPropertyValue("--tree-w")).toBe("409px"); // the drag's ceiling
    expect(left?.getAttribute("aria-valuenow")).toBe("409");
    key(left, "Home");
    expect(ide()?.style.getPropertyValue("--tree-w")).toBe("180px"); // the drag's floor
    // The right handle MIRRORS (the drag's own facing): → narrows.
    const right = h.container.querySelector<HTMLElement>('.ide-drag[data-side="right"]');
    key(right, "ArrowRight");
    expect(ide()?.style.getPropertyValue("--chat-w")).toBe("344px");
    key(right, "ArrowLeft");
    expect(ide()?.style.getPropertyValue("--chat-w")).toBe("360px");
  });
});

// ---------------------------------------------------------------------------
// I5 — labeled key inputs.
// ---------------------------------------------------------------------------
describe("ui-review-r3 I5 — the API-key inputs are labeled", () => {
  it("the wizard's key input carries aria-label", async () => {
    const h = mountedWizard();
    await wizardAtKeyStep(h);
    expect(h.container.querySelector("input.key-input")?.getAttribute("aria-label")).toBe("API Key");
  });

  it("the settings detail's key input carries the per-provider aria-label", async () => {
    const server = fakeServer();
    const client = connectedClient(server);
    const c = mount(<SettingsPage client={client} status={null} onClose={() => {}} />);
    await act(async () => {
      const op = [...wizardOps({ server } as WizardHarness)].reverse().find((o) => o.op.op === "settingsStatus");
      server.socket.serverSend({
        t: "result",
        id: op?.id,
        ok: { ...NOT_READY, providers: [card("glm", "missing-key"), card("wudao", "missing-endpoint")] },
      });
    });
    // iter3 (strict master-detail): ONE key input lives anywhere — the OPEN
    // provider's detail. 0.3.38: the detail is the pvd MODAL and nothing
    // auto-selects on load — glm is OPENED (its card head) first.
    // round 5 契约反转: read mode carries zero inputs — the box lives behind
    // the detail's 编辑 door, and re-selecting a card re-enters read mode.
    const openDetail = async (provider: string): Promise<void> => {
      await act(async () => {
        ([...c.querySelectorAll(".provider-card")].find((n) =>
          n.querySelector(".card-name")?.textContent?.includes(provider) === true,
        ) as HTMLElement).querySelector(".card-name")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    };
    const enterDetailEdit = async (): Promise<void> => {
      await act(async () => {
        const b = [...c.querySelectorAll(".provider-detail button")].find((x) => x.textContent === "编辑");
        if (b === undefined) throw new Error("detail 编辑 button missing");
        (b as HTMLButtonElement).click();
      });
    };
    const input = () => c.querySelector("input.key-input") as HTMLInputElement;
    await openDetail("glm");
    await enterDetailEdit();
    expect([...c.querySelectorAll("input.key-input")].length).toBe(1);
    // ui-review-r4 P5: the label names the provider (a screen reader announces
    // WHICH key field has focused), not one shared "API Key".
    expect(input().getAttribute("aria-label")).toBe("glm API Key");
    // …and it follows the selection.
    await act(async () => {
      ([...c.querySelectorAll(".provider-card")].find((n) =>
        n.querySelector(".card-name")?.textContent?.includes("wudao") === true,
      ) as HTMLElement).querySelector(".card-name")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await enterDetailEdit();
    expect([...c.querySelectorAll("input.key-input")].length).toBe(1);
    expect(input().getAttribute("aria-label")).toBe("wudao API Key");
  });
});

// ---------------------------------------------------------------------------
// I6 — the picker's Esc while rows load.
// ---------------------------------------------------------------------------
describe("ui-review-r3 I6 — SessionPicker Esc while the rows load", () => {
  it("Escape closes even with rows === null (the loading state)", () => {
    const onClose = vi.fn();
    // ω99-277: #16 — SessionPicker 增 onSearch prop（全文搜索车道）；空命中 stub（本套件钉 Esc 车道）。
    const c = mount(<SessionPicker rows={null} onPick={vi.fn()} onClose={onClose} onSearch={vi.fn(async () => [])} />);
    key(c.querySelector(".search-pop"), "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// I7 — notify() folding + cap.
// ---------------------------------------------------------------------------
describe("ui-review-r3 I7 — notices fold and cap", () => {
  it("appendNotice: consecutive duplicates fold to 「text ×N」; non-consecutive stack; the cap drops the oldest", () => {
    let notes = appendNotice([], "x", 0);
    notes = appendNotice(notes, "x", 0);
    notes = appendNotice(notes, "x", 0);
    expect(notes).toHaveLength(1);
    expect((notes[0] as { text: string }).text).toBe("x ×3");
    notes = appendNotice(notes, "y", 1); // a different text breaks the run
    notes = appendNotice(notes, "x", 1);
    expect(notes).toHaveLength(3);
    for (let i = 0; i < MAX_LOCAL_NOTICES + 10; i++) notes = appendNotice(notes, `n${i}`, 2);
    expect(notes).toHaveLength(MAX_LOCAL_NOTICES); // capped
    expect((notes[notes.length - 1] as { text: string }).text).toBe(`n${MAX_LOCAL_NOTICES + 9}`); // newest kept
  });

  it("App-level: three identical refusals in a row render as ONE ×3 notice row", async () => {
    const h = await connectedApp();
    sendState(h, { busy: true });
    for (let i = 0; i < 3; i++) {
      click(h.container.querySelector(".topbar .new-chat"));
    }
    const rows = [...h.container.querySelectorAll(".entry-notice")];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("×3");
  });
});

// 0.3.4 反馈（切模式通知钉底）— the notice rides its cursor: it renders at
// its occurrence position in the flow, so a message that arrives AFTER it
// lands BELOW it. The old end-concat pinned every notice below ALL later
// messages forever (three mode switches stacked three permanent rows at the
// conversation's bottom, "不在消息流中").
describe("notice in-flow placement (0.3.4 反馈)", () => {
  const hist = (n: number): readonly { kind: "user"; text: string }[] =>
    Array.from({ length: n }, (_, i) => ({ kind: "user" as const, text: `m${i}` }));
  const flat = (merged: readonly { kind: string; text?: string }[]): readonly string[] =>
    merged.map((e) => (e.kind === "notice" ? `[${e.text ?? ""}]` : e.kind === "user" ? (e.text ?? "user") : e.kind));

  it("mergeLocalNotes: a note interleaves at its cursor; same-cursor notes keep order; a shrunken replay clamps to the end", () => {
    // cursor 2 in a 5-entry history — renders between m1 and m2.
    expect(flat(mergeLocalNotes(hist(5), [{ text: "n1", after: 2 }]))).toEqual(["m0", "m1", "[n1]", "m2", "m3", "m4"]);
    // two notes at the same cursor keep append order.
    expect(flat(mergeLocalNotes(hist(5), [{ text: "a", after: 2 }, { text: "b", after: 2 }]))).toEqual(["m0", "m1", "[a]", "[b]", "m2", "m3", "m4"]);
    // a reset replay shrank the history to 1 — the overflow parks at the end, order intact.
    expect(flat(mergeLocalNotes(hist(1), [{ text: "n1", after: 2 }, { text: "n2", after: 4 }]))).toEqual(["m0", "[n1]", "[n2]"]);
    // cursor 0 renders before everything.
    expect(flat(mergeLocalNotes(hist(2), [{ text: "z", after: 0 }]))).toEqual(["[z]", "m0", "m1"]);
    // no notes is identity — the SAME array reference (streaming frames' ONE-identity rule).
    const h2 = hist(2);
    expect(mergeLocalNotes(h2, [])).toBe(h2);
  });

  it("App-level: a notice renders where it happened — a message arriving after it lands BELOW it in the flow", async () => {
    const h = await connectedApp();
    sendState(h, { busy: true });
    click(h.container.querySelector(".topbar .new-chat")); // the ⚠️ 运行中 notice lands at the current tail
    // A user message arrives AFTER the notice → renders below it, not above.
    await act(async () => {
      h.server.socket.serverSend({ t: "history", entries: [{ kind: "user", text: "后来者" }], reset: false });
    });
    const notice = h.container.querySelector(".entry-notice");
    expect(notice).not.toBeNull();
    const later = [...h.container.querySelectorAll(".chat *")].find((el) => el.textContent === "后来者");
    expect(later).toBeDefined();
    // DOM order: the later message FOLLOWS the notice (the pinned-bottom bug inverted this).
    expect(notice !== null && later != null ? notice.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING : 0).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// P1 — the sidebar's relative-time tick.
// ---------------------------------------------------------------------------
describe("ui-review-r3 P1 — stale relative times", () => {
  it("a 61s fake-timer advance re-renders 2分钟前 → 3分钟前 (one interval, no refetch)", async () => {
    vi.useFakeTimers();
    const sessions = vi.fn(() =>
      Promise.resolve([
        { id: "s1", mtime: new Date(Date.now() - 2 * 60_000).toISOString(), messages: 1, firstUser: "hi", model: "m" },
      ]),
    );
    const c = mount(
      <SessionSidebar
        client={{ sessions }}
        activeSessionId={null}
        onResume={() => {}}
        onNewChat={() => {}}
        onOpenSettings={() => {}}
        onOpenSearch={() => {}}
      />
      // ω99-147: modelLabel prop retired with the footer's ModelSelector
    );
    await act(async () => {}); // the mount load resolves
    expect(c.querySelector(".sb-when")?.textContent).toBe("2分钟前");
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(c.querySelector(".sb-when")?.textContent).toBe("3分钟前");
    expect(sessions).toHaveBeenCalledTimes(1); // a re-render, not a refetch
  });
});

// ---------------------------------------------------------------------------
// P2 — persisted layout.
// ---------------------------------------------------------------------------
describe("ui-review-r3 P2 — the layout survives a reload (wudao.ui.v1)", () => {
  it("widths + collapse flags + open tabs hydrate on the next mount; corrupt JSON falls back to defaults", async () => {
    const listing: Record<string, readonly Entry[]> = { "": [{ name: "a.ts", type: "file", size: 3 }] };
    const h1 = await connectedApp(listing);
    // Resize the left panel (a 240→320 x-move: 220+80 = 300) and collapse
    // the right.
    const ide1 = h1.container.querySelector<HTMLElement>(".ide");
    act(() => {
      h1.container.querySelector('.ide-drag[data-side="left"]')?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 240 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 320 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup", { clientX: 320 }));
    });
    click(h1.container.querySelector(".ide-toggle[data-side='right']"));
    // Open a tab.
    click(h1.container.querySelector('.tree-node[data-path="a.ts"] > .ft-row'));
    await drain(h1);
    expect(ide1?.style.getPropertyValue("--tree-w")).toBe("300px");
    expect(tabPaths(h1)).toEqual(["a.ts"]);

    // Reload: a fresh App (new client, new server — localStorage is the carrier).
    unmount();
    const h2 = await connectedApp(listing);
    const ide2 = h2.container.querySelector<HTMLElement>(".ide");
    expect(ide2?.style.getPropertyValue("--tree-w")).toBe("300px");
    expect(ide2?.style.getPropertyValue("--chat-w")).toBe("0px"); // the collapsed flag
    expect(tabPaths(h2)).toEqual(["a.ts"]); // the strip, paths only

    // Corrupt JSON → the defaults stand, nothing crashes.
    window.localStorage.setItem("wudao.ui.v1", "{not json");
    unmount();
    const h3 = await connectedApp(listing);
    const ide3 = h3.container.querySelector<HTMLElement>(".ide");
    expect(ide3?.style.getPropertyValue("--tree-w")).toBe("220px");
    expect(ide3?.style.getPropertyValue("--chat-w")).toBe("360px");
    expect(tabPaths(h3)).toEqual([]);
  });

  it("a persisted tab whose fileRead rejects drops from the strip when it activates (a healthy one stays)", async () => {
    const listing: Record<string, readonly Entry[]> = { "": [{ name: "a.ts", type: "file", size: 3 }] };
    // The stale tab is ACTIVE on mount — its read fires, rejects, and drops
    // it (v1 validates lazily: an inactive tab drops when activated).
    window.localStorage.setItem(
      "wudao.ui.v1",
      JSON.stringify({ tabs: [{ path: "a.ts", isDir: false }, { path: "gone.ts", isDir: false }], activeTabIndex: 1 }),
    );
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket);
    });
    await drain(h, { listing, failing: ["gone.ts"] });
    await drain(h, { listing, failing: ["gone.ts"] }); // the viewer's fetch lands behind the gate
    expect(tabPaths(h)).toEqual(["a.ts"]); // the stale tab dropped; the live one kept
    expect(h.container.querySelector(".tab.active")?.getAttribute("data-path")).toBe("a.ts");
  });
});

// ---------------------------------------------------------------------------
// P3 — palette scoring.
// ---------------------------------------------------------------------------
describe("ui-review-r3 P3 — palette scoring", () => {
  it("\"app\" ranks app.ts above web/happy/mapper.ts regardless of index order; matched results cap at 20", () => {
    const paths = ["web/happy/mapper.ts", "app.ts"]; // the loose deep hit comes FIRST in the index
    const c = mount(<FileSearch getAllKnownPaths={() => paths} onOpenPath={vi.fn()} onClose={vi.fn()} />);
    type(c.querySelector<HTMLInputElement>(".search-input")!, "app");
    const rows = [...c.querySelectorAll(".search-item")].map((r) => r.getAttribute("data-path") ?? "");
    expect(rows).toEqual(["app.ts", "web/happy/mapper.ts"]); // basename + compactness win
    unmount();

    const many = Array.from({ length: 30 }, (_, i) => `f${i}.ts`);
    const c2 = mount(<FileSearch getAllKnownPaths={() => many} onOpenPath={vi.fn()} onClose={vi.fn()} />);
    type(c2.querySelector<HTMLInputElement>(".search-input")!, "f");
    expect(c2.querySelectorAll(".search-item")).toHaveLength(20); // the ranked cap
  });
});

// ---------------------------------------------------------------------------
// P4 — the palette's chord guard.
// ---------------------------------------------------------------------------
describe("ui-review-r3 P4 — the palette guard swallows only its own chord", () => {
  it("palette open + Ctrl+B (from the palette's own input) toggles the left panel; Ctrl+P there still never self-closes", async () => {
    const h = await connectedApp({ "": [{ name: "a.ts", type: "file" }] });
    press("p", { ctrlKey: true });
    const input = h.container.querySelector<HTMLInputElement>(".search-input");
    expect(input).not.toBeNull();
    const ide = () => h.container.querySelector<HTMLElement>(".ide");
    // From the INPUT (bubbles to the window handler): the old blanket guard ate this.
    act(() => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(ide()?.style.getPropertyValue("--tree-w")).toBe("0px");
    act(() => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(ide()?.style.getPropertyValue("--tree-w")).toBe("220px");
    // The palette-owning chord stays swallowed while its input holds focus.
    act(() => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "p", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(h.container.querySelector(".search-pop")).not.toBeNull();
    // From anywhere else it still toggles.
    press("p", { ctrlKey: true });
    expect(h.container.querySelector(".search-pop")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P5 — the unfocused-visible notify arm.
// ---------------------------------------------------------------------------
describe("ui-review-r3 P5 — visible-but-unfocused notifies", () => {
  it("hasFocus() false + hidden false → the flash path fires on busy→idle", async () => {
    vi.useFakeTimers();
    const h = await connectedApp();
    document.hasFocus = () => false; // the own-property mock (jsdom's native one is false already — pinned)
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    sendState(h, { busy: true });
    await act(async () => {});
    sendState(h, { busy: false });
    await act(async () => {});
    expect(document.title).toBe("悟道Harness"); // nothing synchronous
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(document.title).toBe("✅ 悟道Harness — 任务完成"); // the flash started
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(document.title).toBe("悟道Harness"); // 3 alternations, then restored
  });
});

// ---------------------------------------------------------------------------
// P6 — astral-plane highlight alignment.
// ---------------------------------------------------------------------------
describe("ui-review-r3 P6 — astral-plane highlights", () => {
  it("a filename with an astral char (𝟘.ts) highlights the matched \"ts\", unshifted", () => {
    // The unit contract: UTF-16 hits mapped onto code points.
    const chars = pathCharsWithHits("𝟘.ts", new Set([3, 4])); // "t"/"s" sit at UTF-16 3-4, code points 2-3
    expect(chars.map((c) => (c.hit ? `[${c.ch}]` : c.ch)).join("")).toBe("𝟘.[t][s]");
    // The component contract.
    const c = mount(<FileSearch getAllKnownPaths={() => ["𝟘.ts"]} onOpenPath={vi.fn()} onClose={vi.fn()} />);
    type(c.querySelector<HTMLInputElement>(".search-input")!, "ts");
    const hits = [...c.querySelectorAll(".search-item .hit")].map((s) => s.textContent ?? "");
    expect(hits.join("")).toBe("ts");
  });
});

// ---------------------------------------------------------------------------
// P7 — settings/wizard focus + Esc.
// ---------------------------------------------------------------------------
describe("ui-review-r3 P7 — settings Esc + focus", () => {
  it("the page owns focus while open; Esc closes; focus lands in the remounted composer (never stranded on body)", async () => {
    const h = await connectedApp();
    const gear = h.container.querySelector<HTMLButtonElement>(".topbar button[aria-label='设置']");
    expect(gear).not.toBeNull();
    gear?.focus(); // a real click focuses its trigger first
    click(gear);
    const page = h.container.querySelector<HTMLElement>(".settings-page");
    expect(page).not.toBeNull();
    expect(document.activeElement).toBe(page); // focus owned on open
    key(page, "Escape");
    expect(h.container.querySelector(".settings-page")).toBeNull();
    // The brief's ⚙-trigger return is superseded by the better target: the
    // composer remounts with the input area and autofocuses its textarea —
    // the user closes settings to type. The pin that matters: focus is
    // SOMEWHERE useful, not stranded on <body>.
    expect(document.activeElement?.tagName).toBe("TEXTAREA");
  });
});

describe("ui-review-r3 P7 — wizard Esc confirm", () => {
  it("the overlay owns focus; Esc asks a confirm — 继续配置 keeps everything, 跳过并退出 rides the SAME skip write", async () => {
    let done = 0;
    const h = mountedWizard(() => {
      done += 1;
    });
    expect(document.activeElement?.classList.contains("wizard-overlay")).toBe(true);
    await wizardAtKeyStep(h); // real progress to protect
    key(h.container.querySelector(".wizard-overlay"), "Escape");
    const confirm = h.container.querySelector(".wizard-confirm");
    expect(confirm).not.toBeNull();
    // Cancel: nothing written, the wizard stays.
    await act(async () => {
      btnByText(h.container, "继续配置").click();
    });
    expect(h.container.querySelector(".wizard-confirm")).toBeNull();
    expect(h.container.querySelector('[data-step="key"]')).not.toBeNull();
    expect(wizardOps(h).some((o) => o.op.op === "settingsSet")).toBe(false);
    // The confirm's own Esc cancels (never re-arms).
    key(h.container.querySelector(".wizard-overlay"), "Escape");
    key(h.container.querySelector(".wizard-confirm .modal-card"), "Escape");
    expect(h.container.querySelector(".wizard-confirm")).toBeNull();
    expect(h.container.querySelector(".wizard-overlay")).not.toBeNull();
    // Confirm: the skip semantics — completedVersion written, onDone fired.
    key(h.container.querySelector(".wizard-overlay"), "Escape");
    await act(async () => {
      btnByText(h.container, "跳过并退出").click();
    });
    expect(done).toBe(1);
    const skipWrite = wizardOps(h).find((o) => o.op.op === "settingsSet")?.op;
    expect(skipWrite).toMatchObject({ key: "wizard.completedVersion", value: WIZARD_COPY_VERSION });
  });

  it("Esc at ⑥ hands back directly (nothing left to lose)", async () => {
    let done = 0;
    const h = mountedWizard(() => {
      done += 1;
    });
    // Walk to ⑥ the fast way: every step's gate satisfied by the missing-
    // endpoint arm (save without a test) then the default walk.
    await wizardAtKeyStep(h, "wudao");
    const input = h.container.querySelector("input.key-input") as HTMLInputElement;
    await act(async () => {
      type(input, "sk-c");
    });
    await act(async () => {
      btnByText(h.container, "保存 Key").click();
    });
    await answerWizard(h);
    await act(async () => {
      btnByText(h.container, "下一步").click();
    });
    await act(async () => {
      btnByText(h.container, "下一步").click();
    });
    await act(async () => {
      btnByText(h.container, "完成").click();
    });
    await answerWizard(h);
    expect(h.container.querySelector('[data-step="done"]')).not.toBeNull();
    key(h.container.querySelector(".wizard-overlay"), "Escape");
    expect(done).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P8 — wizard writeError collection.
// ---------------------------------------------------------------------------
describe("ui-review-r3 P8 — concurrent completion failures all show", () => {
  it("two failing writes both render at ⑥ (the old single slot kept only the last)", async () => {
    const h = mountedWizard();
    await wizardAtKeyStep(h);
    const input = h.container.querySelector("input.key-input") as HTMLInputElement;
    await act(async () => {
      type(input, "sk-good");
    });
    await act(async () => {
      btnByText(h.container, "测试连接").click();
    });
    await answerWizard(h); // the pass + the auto-save
    await act(async () => {
      btnByText(h.container, "下一步").click();
    });
    await act(async () => {
      btnByText(h.container, "下一步").click();
    });
    await act(async () => {
      btnByText(h.container, "完成").click();
    });
    // Fail TWO of the concurrent writes; the rest succeed.
    await answerWizard(h, (op) =>
      op.op === "setMode"
        ? "setMode broke"
        : op.op === "settingsSet" && op.key === "ui.defaultMode"
          ? "settingsSet broke"
          : undefined,
    );
    const errors = [...h.container.querySelectorAll(".entry-error > div")].map((d) => d.textContent ?? "");
    expect(errors.some((e) => e.includes("权限档设置失败"))).toBe(true);
    expect(errors.some((e) => e.includes("默认界面写入失败"))).toBe(true); // BOTH visible
  });
});

// I4 (session rename/delete) is deferred by the brief — a feature (protocol
// op + driver + UI menu), documented in report-r3-fixes.md, not patched here.
