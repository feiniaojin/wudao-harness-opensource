// @vitest-environment jsdom
// M64-visual §4 — the shell: the 34px topbar (T9 墨线: the session's name +
// mono run badge in the flexible drag surface, ◐ theme + ⚙ settings at the
// right edge; the window mark rides document.title), the
// ui.theme/ui.accent channel (App applies the settingsStatus tri-state —
// null resolves dark/green; ◐ toggles optimistically and persists through
// settingsSet, reverting on a failed write), the SettingsPage 外观 section
// (theme two-chip + accent three-chip pickers), the tokenized statusline
// (28px, mono 11.5px, cache% ok, board checks ok), and the prose/mono
// typography split (body = var(--font); every code/tool surface pins
// var(--mono) explicitly — the Task-3 ledger item).
//
// CSS assertions read the MOUNTED stylesheet through the CSSOM (same decl()
// seam as flow-visual.test.tsx — jsdom does not resolve var()).
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { stylesCss } from "./styles-source.js";
import tokensCss from "../src/tokens.css?raw";
import "../src/styles.css";
import "../src/tokens.css";
import { WudaoClient } from "../src/protocol.js";
import type { SettingsStatus } from "../src/protocol.js";
import { App } from "../src/components/App.js";
import { SettingsPage } from "../src/components/SettingsPage.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";
// F9: the shared visual-suite seams (mount/unmount/decl).
import { decl, mount, unmount } from "./css-test-utils.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  unmount();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.accent;
  window.localStorage.removeItem("wudao.ui.v1"); // ui-review-r3 P2: reset the persisted layout between tests
});

const STYLES_CSS = stylesCss;
const TOKENS_CSS = tokensCss;

function opsOf(server: FakeServer): { id: number; op: Record<string, unknown> }[] {
  return server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } =>
    typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>),
  ) as { id: number; op: Record<string, unknown> }[];
}

const card = (provider: string): SettingsStatus["providers"][number] => ({
  provider,
  label: provider,
  status: "ready",
  keySource: "env",
  endpoint: "https://e.example",
  defaultModel: "m-1",
  custom: false,
  models: [],
});

/** A settingsStatus fixture with overridable settings (readiness = true so
 *  the first-run wizard never mounts over the shell). */
const status = (settings: Partial<SettingsStatus["settings"]> = {}): SettingsStatus => ({
  providers: [card("deepseek")],
  credentials: { path: "/home/u/.wudao/.credentials.yaml", keyCount: 0 },
  settings: { memoryEnabled: true, uiDefaultMode: null, wizardCompletedVersion: 1, uiTheme: null, uiAccent: null, ...settings },
  current: { provider: "deepseek", model: "m-1" },
  envKey: false,
  readiness: true,
  efforts: ["high"],
});

interface Harness {
  container: HTMLElement;
  client: WudaoClient;
  server: FakeServer;
}

/** Mount the App connected, with both boot ops answered. */
async function mountedApp(s: SettingsStatus = status()): Promise<Harness> {
  const server = fakeServer();
  const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
  const container = mount(<App client={client} />);
  act(() => {
    client.connect();
    server.socket.serverOpen();
    authOk(server.socket);
  });
  await act(async () => {
    for (const name of ["listSlashCommands", "settingsStatus"]) {
      const op = [...opsOf(server)].reverse().find((o) => o.op.op === name);
      if (op !== undefined) {
        server.socket.serverSend({ t: "result", id: op.id, ok: name === "settingsStatus" ? s : [] });
      }
    }
  });
  return { container, client, server };
}

const settingsSetOps = (server: FakeServer): { id: number; key: string; value: unknown }[] =>
  opsOf(server)
    .filter((o) => o.op.op === "settingsSet")
    .map((o) => ({ id: o.id, key: String(o.op.key), value: o.op.value }));

const themeBtn = (c: HTMLElement): HTMLButtonElement => c.querySelector(".topbar button[aria-label='切换主题']") as HTMLButtonElement;

// ---------------------------------------------------------------------------
// §4.1 + M65-space §1 — the 34px topbar (T9 墨线: the flexible left carries
// the session's name + run badge), ◐ theme + ⚙ settings at the right edge.
// The fake dots and the 简洁/高级 pill are gone — the WINDOW mark rides
// document.title (native bar / browser tab) and the mode switch lives only
// on the settings page.
// ---------------------------------------------------------------------------
describe("M64-visual §4 — topbar (34px shell)", () => {
  it("M65-space §1: flexible left + ◐ + ⚙ right — no dots, no .title, no mode pill, no .header chrome", async () => {
    const h = await mountedApp();
    const bar = h.container.querySelector(".topbar") as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.querySelector(".tdots")).toBeNull(); // the fake traffic lights are gone
    expect(bar.querySelectorAll(".tdot").length).toBe(0);
    expect(bar.querySelector(".title")).toBeNull(); // the RETIRED .title class (T9 uses .tb-name)
    expect(bar.querySelector(".mode-toggle")).toBeNull(); // settings-page-only now
    expect(themeBtn(h.container)?.querySelector("svg")).not.toBeNull(); // P3: the ◐ glyph is IconTheme now
    expect(bar.querySelector("button[aria-label='设置']")?.querySelector("svg")).not.toBeNull();
    // The bar's button set is EXACTLY the right-edge icon buttons — the
    // M65 pair ◐/⚙, the M75-ux3 §10 + new-chat, the 2026-08-26 §3.3 审查专注
    // toggle, and the M76-ux2 §3 📋 session picker in between (P3: named by
    // aria-label, the glyphs are SVG).
    expect([...bar.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual([
      "新对话",
      "会话列表",
      "审查专注",
      "切换主题",
      "监控", // 139：探针仪表盘入口（IconChart 细线折线）
      "设置",
    ]);
    expect(h.container.querySelector(".header")).toBeNull();
    expect(h.container.querySelector(".header-btn")).toBeNull();
  });

  it("M65-space §1: the window mark rides document.title (悟道)", async () => {
    await mountedApp();
    expect(document.title).toContain("悟道Harness");
  });

  it("the topbar rides the tokens: 34px, transparent canvas (116 弧 B 去实底), hairline bottom; icobtn hover = surface (119 画布律 +1 档)", async () => {
    await mountedApp();
    expect(decl(".topbar", "height")).toBe("34px");
    // 116 弧 B：实底 surface 带退役——条带透在窗口画布上，分隔只剩 hair-1
    // 底缘（.statusline 的「surface band is GONE」同律），为第三弧玻璃化铺路。
    expect(decl(".topbar", "background")).toBe("none");
    expect(decl(".topbar", "border-bottom")).toContain("var(--hair-1)");
    // 119 画布律：大区同色（--bg）后，画布上的 hover 一律 +1 档（surface）；
    // surface-2 只留给卡内嵌面（composer 芯片/菜单行等）。
    expect(decl(".icobtn:hover", "background")).toBe("var(--surface)");
  });

  it("M65-space §1: the 84px traffic-light inset is desktop-shell-gated; browsers keep --sp-3", async () => {
    await mountedApp();
    expect(decl(".topbar", "padding-left")).toBe("var(--sp-3)");
    expect(decl('[data-shell="desktop"] .topbar', "padding-left")).toBe("84px");
  });

  it("M65-space §1: the bar is the window drag region; the icon buttons opt back out", async () => {
    await mountedApp();
    // The raw-sheet check: jsdom's CSSOM may not model the -webkit- property,
    // so the drag region is pinned as-declared off the sheet text.
    expect(STYLES_CSS).toMatch(/\.topbar\s*\{[^}]*-webkit-app-region:\s*drag/s);
    expect(STYLES_CSS).toMatch(/\.icobtn\s*\{[^}]*-webkit-app-region:\s*no-drag/s);
  });

  it("M65-space §1: the traffic tokens are gone — the native lights own the desktop shell", async () => {
    await mountedApp();
    expect(TOKENS_CSS).not.toContain("--traffic-r");
    expect(TOKENS_CSS).not.toContain("--traffic-y");
    expect(TOKENS_CSS).not.toContain("--traffic-g");
    expect(STYLES_CSS).not.toContain("--traffic-");
    expect(STYLES_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("⚙ opens the settings page (the same swap the old 设置 button owned)", async () => {
    const h = await mountedApp();
    await act(async () => {
      (h.container.querySelector(".topbar button[aria-label='设置']") as HTMLButtonElement).click();
    });
    expect(h.container.querySelector(".settings-page")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T9 墨线 — the topbar's CONTENT: the session names itself (the first user
// move's first line — the mockup's crumb; the 悟道 mark before any move
// exists), and the mono run badge beside it (✓ distinct tools used · ctx
// watermark, the same DriverStatus snapshot StatusBar reads — no new fetch).
// The badge omits ENTIRELY when the signal is absent (StatusBar's convention:
// no dangling empty span).
// ---------------------------------------------------------------------------
describe("T9 墨线 — topbar session name + run badge", () => {
  // 12400 → formatTokensK → "12.4k"; three DISTINCT tool names → "3 tools".
  const ctxState = { ctxTokens: { used: 12400, window: 65536, nearLimit: false } };
  const toolHistory = [
    { kind: "user", text: "修复窗口拖动的两层根因" },
    { kind: "tool", name: "read_file", summary: "" },
    { kind: "tool", name: "edit_file", summary: "" },
    { kind: "tool", name: "shell", summary: "" },
    { kind: "tool", name: "read_file", summary: "" }, // a repeat call: still 3 DISTINCT tools
    { kind: "assistant", text: "done" },
  ];

  it("topbar shows session name + mono run badge (tools/ctx) when status present", async () => {
    const h = await mountedApp();
    await act(async () => {
      authOk(h.server.socket, ctxState, toolHistory);
    });
    expect(h.container.querySelector(".tb-name")?.textContent).toBe("修复窗口拖动的两层根因");
    expect(h.container.querySelector(".tb-run")).toBeTruthy();
    // ω99-298 (I7): the ctx tail is gone — the statusline's seg-ctx is the
    // single home; the badge reports tools only (ctx still gates presence).
    expect(h.container.querySelector(".tb-run")?.textContent).toBe("✓ 3 tools");
  });

  it("run badge omits entirely when no status (StatusBar 惯例)", async () => {
    const server = fakeServer();
    const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
    const container = mount(<App client={client} />);
    act(() => {
      client.connect();
      server.socket.serverOpen();
      // Connected WITHOUT a state frame (a history-only reply also flips the
      // connection) — the shell renders, status stays null.
      server.socket.serverSend({ t: "history", entries: [], reset: true });
    });
    expect(container.querySelector(".topbar")).not.toBeNull();
    expect(container.querySelector(".tb-name")?.textContent).toBe("悟道Harness"); // the pre-session mark
    expect(container.querySelector(".tb-run")).toBeNull(); // not an empty span — gone
  });

  it("the name/badge live INSIDE the drag surface — the icobtn slots stay direct children (9d80c91 intact)", async () => {
    const h = await mountedApp();
    await act(async () => {
      authOk(h.server.socket, ctxState, toolHistory);
    });
    const bar = h.container.querySelector(".topbar") as HTMLElement;
    // The frozen child order the new-chat/session-picker/workspace-switcher
    // suites pin: [sp, +, sessions, theme, settings] — the T9 content nests
    // INSIDE .sp, never a new direct child.
    expect(
      [...bar.children].map((c) => (c instanceof HTMLButtonElement ? c.getAttribute("aria-label") : c.className)),
    ).toEqual(["sp", "新对话", "会话列表", "审查专注", "切换主题", "监控", "设置"]);
    expect(bar.querySelector(".sp > .tb-name")).not.toBeNull();
    expect(bar.querySelector(".sp > .tb-run")).not.toBeNull();
    // The name/badge ARE the drag surface now (Tauri v2 checks the mousedown
    // TARGET) — they carry the attribute like the spacer they fill.
    expect(bar.querySelector(".tb-name")?.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(bar.querySelector(".tb-run")?.hasAttribute("data-tauri-drag-region")).toBe(true);
  });

  it("the simple shell's strip carries no telemetry (ui-sweep 顶栏经济) — the ctx ring is its readout", async () => {
    const h = await mountedApp(status({ uiDefaultMode: "simple" }));
    await act(async () => {
      authOk(h.server.socket, ctxState, toolHistory);
    });
    expect(h.container.querySelector(".simple")).not.toBeNull();
    expect(h.container.querySelector(".statusline")).toBeNull(); // simple mode drops the bottom bar
    // ui-sweep A (mockup-space-v3 顶栏经济): the run badge was advanced-speak
    // telemetry; the simple window carries none of it. The ctx signal stays
    // reachable through the composer's context ring (ContextMeter rides the
    // simple composer's controlsSuffix).
    expect(h.container.querySelector(".tb-run")).toBeNull();
    expect(h.container.querySelector(".composer-right .ctx")).not.toBeNull();
    expect(h.container.querySelector(".composer-right .ctx-num")?.textContent).toContain("▲");
  });

  it("the name/badge/icobtn shells ride the inkline tokens", async () => {
    await mountedApp();
    expect(decl(".tb-name", "font-size")).toBe("var(--fs-ui)");
    expect(decl(".tb-name", "color")).toBe("var(--text-1)");
    expect(decl(".tb-name", "font-weight")).toBe("var(--fw-medium)"); // P2 §2.5 字重令牌化
    expect(decl(".tb-name", "text-overflow")).toBe("ellipsis");
    expect(decl(".tb-run", "font-family")).toBe("var(--mono)");
    expect(decl(".tb-run", "font-size")).toBe("var(--fs-caption)");
    expect(decl(".tb-run", "color")).toBe("var(--text-3)");
    // Controller r1/r2: the sketch's 5px/2px micro-offsets yield to the
    // established --sp-1 ruling (the gate owns density choices).
    expect(decl(".tb-run", "gap")).toBe("var(--sp-1)");
    expect(decl(".topbar", "gap")).toBe("var(--sp-1)");
    expect(decl(".tb-run .ok", "color")).toBe("var(--ok)"); // the mockup's green ✓
    expect(decl(".icobtn", "border-radius")).toBe("var(--radius-sm)");
  });
});

// ---------------------------------------------------------------------------
// §4.2 — the ui.theme channel: factory dark, payload tri-state applied, ◐
// toggles optimistically + persists, reverts when the write fails.
// ---------------------------------------------------------------------------
describe("M64-visual §4 — ui.theme channel", () => {
  it("mount applies the factory dark default", async () => {
    await mountedApp(status());
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("a persisted ui.theme=\"light\" applies on the settingsStatus reply", async () => {
    await mountedApp(status({ uiTheme: "light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("◐ flips to the opposite theme and persists via settingsSet(\"ui.theme\")", async () => {
    const h = await mountedApp(status()); // dark
    await act(async () => {
      themeBtn(h.container).click();
    });
    expect(document.documentElement.dataset.theme).toBe("light");
    const ops = settingsSetOps(h.server);
    expect(ops.find((o) => o.key === "ui.theme")).toMatchObject({ value: "light" });
    await act(async () => {
      const op = ops.find((o) => o.key === "ui.theme");
      if (op !== undefined) h.server.socket.serverSend({ t: "result", id: op.id, ok: { key: "ui.theme", saved: true } });
    });
    expect(document.documentElement.dataset.theme).toBe("light"); // persisted — stays
  });

  it("a failed ◐ write reverts the flip (the ui.defaultMode toggle's pattern)", async () => {
    const h = await mountedApp(status()); // dark
    await act(async () => {
      themeBtn(h.container).click();
    });
    expect(document.documentElement.dataset.theme).toBe("light");
    await act(async () => {
      const op = settingsSetOps(h.server).find((o) => o.key === "ui.theme");
      if (op !== undefined) h.server.socket.serverSend({ t: "result", id: op.id, err: "disk full" });
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  // Final-review F5: the uiModeTouched guard's theme twin — a ◐ flip inside
  // the first-fetch window survives the STALE settingsStatus reply that was
  // already on the wire (it would re-apply the persisted dark).
  it("a ◐ flip before the first settingsStatus reply lands is not stomped by the stale reply", async () => {
    const server = fakeServer();
    const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
    const container = mount(<App client={client} />);
    act(() => {
      client.connect();
      server.socket.serverOpen();
      authOk(server.socket);
    });
    // Answer ONLY the commands fetch — settingsStatus stays in flight.
    await act(async () => {
      const op = opsOf(server).find((o) => o.op.op === "listSlashCommands");
      if (op !== undefined) server.socket.serverSend({ t: "result", id: op.id, ok: [] });
    });
    await act(async () => {
      themeBtn(container).click(); // ◐ inside the first-fetch window
    });
    expect(document.documentElement.dataset.theme).toBe("light");
    // The stale reply (persisted dark) lands now — the flip must survive it.
    await act(async () => {
      const op = opsOf(server).find((o) => o.op.op === "settingsStatus");
      if (op !== undefined) server.socket.serverSend({ t: "result", id: op.id, ok: status({ uiTheme: "dark" }) });
    });
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

// ---------------------------------------------------------------------------
// §4.3 — the ui.accent channel (wired symmetrically with ui.theme): null
// resolves the factory green; a persisted accent applies on the same reply.
// ---------------------------------------------------------------------------
describe("M64-visual §4 — ui.accent channel", () => {
  it("absent (null) resolves the factory green default", async () => {
    await mountedApp(status());
    expect(document.documentElement.dataset.accent).toBe("green");
  });

  it("a persisted ui.accent=\"blue\" applies on the settingsStatus reply", async () => {
    await mountedApp(status({ uiAccent: "blue" }));
    expect(document.documentElement.dataset.accent).toBe("blue");
  });
});

// ---------------------------------------------------------------------------
// §4.4 — the SettingsPage 外观 section: theme two-chip + accent three-chip
// pickers writing through settingsSet and applying live.
// ---------------------------------------------------------------------------
describe("M64-visual §4 — SettingsPage 外观", () => {
  it("0.3.26 ②: .set-body reserves a stable scrollbar gutter — the settings columns do not shift width when the detail content crosses the scroll threshold (provider switch)", () => {
    // The root cause of the width drift: .set-body is the ONLY scroll column
    // since round-5 F; per-provider detail heights differ → the scrollbar's
    // appearance changes the content-box width → the two-column grid jumps.
    expect(STYLES_CSS).toMatch(/\.set-body\s*\{[^}]*scrollbar-gutter:\s*stable/s);
  });
  it("0.3.38 ①: the provider detail is a MODAL — the master list is the only column; the pvd card is wide and its body scrolls", () => {
    // 用户:供应商太多,拉到最下面点编辑,详情却渲染在页面最上方,要往回翻 ——
    // 点开就该看到。 The 0.3.28 fixed-track two-column grid retired WITH the
    // detail column: the list is now the tab's only column (still a 30rem
    // internal scroll box), and a card click opens the centered pvd dialog.
    expect(STYLES_CSS).toMatch(/\.provider-master\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
    // The pvd card: modal-card family viewport fit + a width that fits the
    // model table; the body is the scroll region; the hosted .provider-detail
    // drops its card chrome (the modal IS the card — no border-in-border).
    expect(STYLES_CSS).toMatch(/\.modal-card\.pvd\s*\{[^}]*max-width:\s*min\(46rem,\s*calc\(100vw - var\(--sp-8\)\)\)/s);
    expect(STYLES_CSS).toMatch(/\.pvd-body\s*\{[^}]*overflow-y:\s*auto/s);
    expect(STYLES_CSS).toMatch(/\.pvd-body \.provider-detail\s*\{[^}]*border:\s*0/s);
    // The modal dropdown's toggle is a labeled button, not the bare 1.9rem ▾
    // glyph (④: it was also disabled on a failed auto-pull — dead button).
    expect(STYLES_CSS).toMatch(/\.mcm-drop-toggle\s*\{[^}]*white-space:\s*nowrap/s);
  });
  it("0.3.31 ③: .set GROWS to fill .settings-page — the settings column is never content-width (glm's short URL stranded a right-side band)", () => {
    // 用户:glm 的模型配置卡片宽度没占满容器,url 太短撑不起来。 The grid fix
    // above pinned the DETAIL track, but .set — a flex item of .settings-page
    // with no grow — still sized the whole column by the detail's max-content:
    // 1fr of a shrink-to-fit parent stays content width. flex:1 + min-width:0
    // hands the width back to the container (verified in a real-browser dump:
    // detail 306px → 988px at a 1440px viewport).
    expect(STYLES_CSS).toMatch(/\.set\s*\{[^}]*flex:\s*1[^}]*min-width:\s*0/s);
  });
  async function mountedPage(): Promise<Harness> {
    const server = fakeServer();
    const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
    act(() => {
      client.connect();
      server.socket.serverOpen();
      authOk(server.socket);
    });
    const container = mount(<SettingsPage client={client} status={null} onClose={() => {}} />);
    await act(async () => {
      const op = opsOf(server).find((o) => o.op.op === "settingsStatus");
      server.socket.serverSend({ t: "result", id: op?.id, ok: status() });
    });
    // settings-split: the pickers ride the 外观 tab now (lazy mount).
    await act(async () => {
      (container.querySelector("button[data-settings-tab='appearance']") as HTMLButtonElement).click();
    });
    return { container, client, server };
  }

  it("renders 主题 (two chips) + 主色 (three chips) with the live selection marked", async () => {
    const h = await mountedPage();
    const section = [...h.container.querySelectorAll(".settings-section")].find((n) => n.querySelector(".section-title")?.textContent === "外观");
    expect(section).not.toBeUndefined();
    const themes = [...(section?.querySelectorAll("[data-appearance-theme]") ?? [])] as HTMLButtonElement[];
    const accents = [...(section?.querySelectorAll("[data-appearance-accent]") ?? [])] as HTMLButtonElement[];
    expect(themes.map((b) => b.dataset.appearanceTheme).sort()).toEqual(["dark", "light"]);
    expect(accents.map((b) => b.dataset.appearanceAccent).sort()).toEqual(["black", "blue", "green"]);
    // Live defaults (nothing persisted): dark + green carry the selected
    // segment (120: .segctl-opt.on — the raised pill).
    expect(themes.find((b) => b.dataset.appearanceTheme === "dark")?.classList.contains("on")).toBe(true);
    expect(accents.find((b) => b.dataset.appearanceAccent === "green")?.classList.contains("on")).toBe(true);
  });

  it("an accent chip writes ui.accent AND applies dataset.accent live", async () => {
    const h = await mountedPage();
    await act(async () => {
      (h.container.querySelector("[data-appearance-accent='blue']") as HTMLButtonElement).click();
    });
    expect(document.documentElement.dataset.accent).toBe("blue");
    expect(settingsSetOps(h.server).find((o) => o.key === "ui.accent")).toMatchObject({ value: "blue" });
  });

  it("a theme chip writes ui.theme AND applies the theme live", async () => {
    const h = await mountedPage();
    await act(async () => {
      (h.container.querySelector("[data-appearance-theme='light']") as HTMLButtonElement).click();
    });
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(settingsSetOps(h.server).find((o) => o.key === "ui.theme")).toMatchObject({ value: "light" });
  });

  // The Task-4 review ledger: the chip highlight is DERIVED at render from
  // the live documentElement (SettingsPage §5), so a ◐ flip while the page
  // is open moves the highlight — a mount-time useState stayed stale.
  it("a ◐ flip while the page is open moves the highlighted theme chip (ledger)", async () => {
    const h = await mountedApp(); // dark
    await act(async () => {
      (h.container.querySelector(".topbar button[aria-label='设置']") as HTMLButtonElement).click();
    });
    // settings-split: the theme chips ride the 外观 tab — open it first.
    await act(async () => {
      (h.container.querySelector("button[data-settings-tab='appearance']") as HTMLButtonElement).click();
    });
    const chip = (t: string): HTMLButtonElement =>
      h.container.querySelector(`[data-appearance-theme='${t}']`) as HTMLButtonElement;
    expect(chip("dark").classList.contains("on")).toBe(true); // 120: .segctl-opt.on
    await act(async () => {
      themeBtn(h.container).click(); // ◐ flips the live DOM to light
    });
    // The ◐ write's reply carries App's notify — the re-render that lets the
    // page re-derive its selection from the flipped DOM.
    await act(async () => {
      const op = settingsSetOps(h.server).find((o) => o.key === "ui.theme");
      if (op !== undefined) h.server.socket.serverSend({ t: "result", id: op.id, ok: { key: "ui.theme", saved: true } });
    });
    expect(chip("light").classList.contains("on")).toBe(true); // 120: .segctl-opt.on
    expect(chip("dark").classList.contains("on")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §4.5 — the statusline: 28px bottom-edge row (墨线 T10 收编: NO surface
// band), mono caption, text-3, cache% on --ok, board checks on --ok.
// ---------------------------------------------------------------------------
describe("M64-visual §4 — statusline", () => {
  it("the .statusline strip rides the tokens per the mockup", async () => {
    await mountedApp(status());
    expect(decl(".statusline", "height")).toBe("28px");
    // 墨线 T10: the surface band is gone — the row IS the panel's bottom edge
    // (pinned off the raw sheet; decl() cannot express absence).
    expect(STYLES_CSS).not.toMatch(/\.statusline\s*\{[^}]*background/s);
    expect(decl(".statusline", "border-top")).toContain("var(--hair-1)");
    expect(decl(".statusline", "font-size")).toBe("var(--fs-caption)"); // 墨线五档 caption 档
    expect(decl(".statusline", "font-family")).toBe("var(--mono)");
    expect(decl(".statusline", "color")).toBe("var(--text-3)");
  });

  it("cache% and the board segment read on --ok", () => {
    expect(decl(".statusline .cache", "color")).toBe("var(--ok)");
    expect(decl(".statusline .board", "color")).toBe("var(--ok)");
  });

  it("StatusBar wraps the cache segment in .cache (markup seam)", async () => {
    const h = await mountedApp();
    await act(async () => {
      authOk(h.server.socket, { cachePercent: 91, boardProgress: { done: 2, total: 3 } });
    });
    expect(h.container.querySelector(".statusline .cache")?.textContent).toContain("91%");
    expect(h.container.querySelector(".statusline .board")?.textContent).toContain("2/3");
  });
});

// ---------------------------------------------------------------------------
// §4.6 — the prose/mono typography split (the Task-3 ledger item): body =
// var(--font) (the -apple-system/PingFang stack), EVERY code/tool surface
// pinned var(--mono) explicitly, interactive chips/labels on --font.
// ---------------------------------------------------------------------------
describe("M64-visual §4 — prose stack + the mono-pinning audit", () => {
  it("tokens.css declares --font (the mockup's proportional prose stack)", () => {
    expect(TOKENS_CSS).toMatch(/--font:\s*-apple-system/);
    expect(TOKENS_CSS).toContain("PingFang SC");
  });

  it("the body prose stack is var(--font)", () => {
    expect(decl("body", "font-family")).toBe("var(--font)");
  });

  it("code/tool surfaces pin var(--mono) explicitly (no inheritance reliance)", () => {
    const mono = "var(--mono)";
    // The Task-3 ledger pair (the carried item):
    expect(decl(".act-file", "font-family")).toBe(mono);
    expect(decl(".act-body", "font-family")).toBe(mono);
    // The rest of the audit:
    expect(decl(".pre code", "font-family")).toBe(mono); // 墨线 §2/task-6: pre.codeblock → .pre 卡 + .pre code
    expect(decl(".md code.inline", "font-family")).toBe(mono);
    expect(decl(".toolcard", "font-family")).toBe(mono);
    expect(decl(".diff", "font-family")).toBe(mono);
    // 墨线 T10: the live busy-tool line joined the timeline — its mono
    // surfaces are the row parts (.act-verb/.act-file, already pinned) and
    // the panel head's counter.
    expect(decl(".panel-count", "font-family")).toBe(mono);
    expect(decl(".slashmenu .row", "font-family")).toBe(mono);
    expect(decl(".approval .cmd", "font-family")).toBe(mono);
    expect(decl(".pickrow", "font-family")).toBe(mono);
    expect(decl(".model-chip", "font-family")).toBe(mono);
    expect(decl("input.wudao-input.key-input", "font-family")).toBe(mono);
    expect(decl(".provider-card .card-endpoint", "font-family")).toBe(mono);
    // The Task-4 review ledger: the wizard's provider-card meta rides mono
    // too (the one surface the audit missed).
    expect(decl(".wizard-provider-card .meta", "font-family")).toBe(mono);
    expect(decl(".ctxmeter-legend", "font-family")).toBe(mono);
  });

  it("prose/control surfaces ride the proportional stack (mockup: chips, composer, approval labels)", () => {
    expect(decl(".chip", "font-family")).toBe("var(--font)");
    expect(decl(".composer-ta", "font-family")).toBe("var(--font)");
    expect(decl(".pop .mi", "font-family")).toBe("var(--font)");
    expect(decl(".approval .strip", "font-family")).toBe("var(--font)");
    expect(decl(".approval .btns button", "font-family")).toBe("var(--font)");
  });

  it("the .pop.down modifier flips the menu BELOW the chip (2026-08-31 设置页权限 chip 弹层向上不可见)", () => {
    // .pop.down 解除 .pop .menu 的 bottom: 40px 锚(它把菜单顶到 chip 上方)
    // 改成 top: calc(100% + 4px),让菜单挂在 chip 下方 —— 中间视口向上弹是
    // 反向的。composer 处的 chip(model/effort/language/mode)继续用默认的
    // .pop(底部视口,向上弹正合适),所以这是 chip 级的修饰而非全替换。
    expect(decl(".pop.down .menu", "bottom")).toBe("auto");
    expect(decl(".pop.down .menu", "top")).toBe("calc(100% + 4px)");
  });
});
