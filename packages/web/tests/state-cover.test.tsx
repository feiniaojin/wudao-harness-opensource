// @vitest-environment jsdom
// statecover 批 — the discriminators for the state-coverage batch (audit
// §4 batch 1). This file: A4 (the redesigned pre-app connection screen —
// three honest states in the token language), A2 (the disconnected
// statusline's stale marker), C5 (the provider tab's load-failure honesty).
// Later sections (B1/C7/C8/C9) land with their commits in the same batch.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { stylesCss } from "./styles-source.js";
import "../src/styles.css";
import { WudaoClient } from "../src/protocol.js";
import type { SettingsStatus } from "../src/protocol.js";
import { App } from "../src/components/App.js";
import { StatusBar } from "../src/components/StatusBar.js";
import { HistoryList } from "../src/components/HistoryList.js";
import { ProviderTab } from "../src/components/ProviderTab.js";
import { SettingsPage } from "../src/components/SettingsPage.js";
import { Wizard } from "../src/components/Wizard.js";
import { ModelSelector } from "../src/components/ModelSelector.js";
import { FileTree } from "../src/components/FileTree.js";
import { ResumePicker } from "../src/components/ResumePicker.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";
import { decl, mount, unmount } from "./css-test-utils.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  unmount();
  window.localStorage.removeItem("wudao.ui.v1");
});

/** The raw sheet text — shorthand/attribute-selector pins read the source
 * (the CSSOM drops var()-bearing shorthands; cssstyle keeps attribute
 * selectors but the raw text is the sturdier pin). */
const STYLES_CSS = stylesCss;

/** A mounted App over a fresh fake server — the socket is open (the caller
 *  scripts auth/frames from there). */
function mountedApp(server: FakeServer): HTMLElement {
  const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
  const c = mount(<App client={client} />);
  act(() => {
    client.connect();
    server.socket.serverOpen();
  });
  return c;
}

// ---------------------------------------------------------------------------
// A4 — the connection screen: three honest states, one token-language card.
// ---------------------------------------------------------------------------
describe("statecover A4 — connection screen", () => {
  it("connecting: the card renders the Chinese copy, the spinner, and the mono meta token", () => {
    const server = fakeServer();
    const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
    const c = mount(<App client={client} />);
    const card = c.querySelector(".connect-card") as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(card?.getAttribute("role")).toBe("status");
    expect(card?.textContent).toContain("正在连接 wudao 服务…");
    expect(card?.textContent).toContain("请重新打开 wudao 桌面应用"); // ω99-232: #4 — 旧句「检查 wudao 服务（sidecar）是否已启动」退役（去实现术语），同形 re-pin
    // The spinner: IconSpinner is a static arc; the .spin class rotates it.
    const spinner = card?.querySelector("svg.spin");
    expect(spinner).not.toBeNull();
    // The mono detail line keeps the state token reachable.
    expect(card?.querySelector(".connect-meta")?.textContent).toBe("wudao ui · connecting");
    // No stale English remains on the old strip.
    expect(c.querySelector(".connect")).toBeNull();
    expect(card?.textContent).not.toContain("connecting…");
  });

  it("authenticating shares the spinner card (only the meta token differs)", () => {
    const server = fakeServer();
    const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
    const c = mount(<App client={client} />);
    act(() => {
      client.connect();
      server.socket.serverOpen();
    });
    const card = c.querySelector(".connect-card") as HTMLElement;
    expect(card.textContent).toContain("正在连接 wudao 服务…");
    expect(card.querySelector("svg.spin")).not.toBeNull();
    expect(card.querySelector(".connect-meta")?.textContent).toBe("wudao ui · authenticating");
  });

  it("auth-failed: error copy with the actionable URL guidance; role=alert; close code reachable", () => {
    const server = fakeServer();
    const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
    const c = mount(<App client={client} />);
    act(() => {
      client.connect();
      server.socket.serverOpen();
    });
    act(() => {
      server.socket.serverClose(4401, "bad token");
    });
    const card = c.querySelector(".connect-card") as HTMLElement;
    expect(card.getAttribute("role")).toBe("alert");
    expect(card.textContent).toContain("认证失败");
    expect(card.textContent).toContain("Token 无效或已过期 —— 请重新打开启动时打印的 URL 完成认证");
    expect(card.querySelector("svg.spin")).toBeNull(); // a settled failure does not spin
    // The mono detail line keeps the close code.
    expect(card.querySelector(".connect-meta")?.textContent).toBe("wudao ui · auth-failed · close 4401");
  });

  it("closed: the reload escape button exists and clicking it reloads the page", () => {
    const server = fakeServer();
    const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
    const c = mount(<App client={client} />);
    act(() => {
      client.connect();
      server.socket.serverOpen();
    });
    act(() => {
      server.socket.serverClose(1006, "");
    });
    const card = c.querySelector(".connect-card") as HTMLElement;
    expect(card.textContent).toContain("连接已断开");
    // jsdom's location is LegacyUnforgeable (reload cannot be stubbed), so the
    // click is proven through jsdom's own not-implemented report: reaching
    // window.location.reload is exactly what emits it.
    const notImplemented = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const btn = [...card.querySelectorAll("button")].find((b) => b.textContent === "刷新页面重连");
      if (btn === undefined) throw new Error("reload button missing");
      act(() => {
        btn.click();
      });
      expect(notImplemented.mock.calls.some((args) => String(args[0]).includes("Not implemented: navigation"))).toBe(true);
    } finally {
      notImplemented.mockRestore();
    }
  });

  it("the card rides the token language (surface / radius-lg / elevation 中档; logo at a token radius)", () => {
    expect(decl(".connect-card", "background")).toBe("var(--surface)");
    expect(decl(".connect-card", "border-radius")).toBe("var(--radius-lg)");
    // 116 弧 A: the floating card rides the elevation trio — hairline stroke
    // drawn INTO the shadow; the border retired (no double outline).
    expect(decl(".connect-card", "box-shadow")).toBe("var(--elev-2)");
    expect(decl(".connect-card", "border")).toBe("0");
    // 品牌弧（09-15）：logo=透明底精灵帧（同 .hero .logo 家族）——radius/accent 断言随悟字退役。
    expect(decl(".connect-card .logo", "background-image")).toContain("skin-default.png");
    expect(decl(".connect-card .logo", "background-size")).toBe("200% auto");
  });
});

// ---------------------------------------------------------------------------
// A2 — the stale marker: the disconnected statusline says so, presentation
// only (the refetch semantics are ui-review-r4 I3's, untouched).
// ---------------------------------------------------------------------------
describe("statecover A2 — statusline stale marker", () => {
  it("standalone: stale={true} marks the row; the default does not", () => {
    const status = {
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
      model: null,
    } as Parameters<typeof StatusBar>[0]["status"];
    const stale = mount(<StatusBar status={status} stale={true} />);
    expect(stale.querySelector(".statusline[data-stale]")).not.toBeNull();
    const fresh = mount(<StatusBar status={status} />);
    expect(fresh.querySelector(".statusline[data-stale]")).toBeNull();
  });

  it("in-app: a drop marks the live strip; the reconnect's replay clears it", async () => {
    const server = fakeServer();
    const timers: (() => void)[] = [];
    const client = new WudaoClient({
      url: "ws://127.0.0.1:1",
      token: "t",
      wsFactory: () => server.spawn(),
      setTimeout: (fn) => {
        timers.push(fn);
        return timers.length - 1;
      },
      clearTimeout: () => {},
    });
    const c = mount(<App client={client} />);
    act(() => {
      client.connect();
      server.socket.serverOpen();
    });
    await act(async () => {
      authOk(server.socket);
    });
    const strip = () => c.querySelector(".statusline") as HTMLElement;
    expect(strip().hasAttribute("data-stale")).toBe(false); // connected: fresh
    act(() => {
      server.socket.serverClose(1006, "");
    });
    expect(c.textContent).toContain("正在重连"); // the quiet banner is up
    expect(strip().hasAttribute("data-stale")).toBe(true); // the row is marked
    await act(async () => {
      timers[0]?.();
      server.socket.serverOpen();
      authOk(server.socket);
    });
    expect(strip().hasAttribute("data-stale")).toBe(false); // replay restored it
  });

  it("CSS: the marker weakens the row (opacity), on the container only", () => {
    expect(STYLES_CSS).toMatch(/\.statusline\[data-stale\]\s*\{[^}]*opacity:\s*\.55/s);
  });
});

// ---------------------------------------------------------------------------
// C5 — the provider tab's load failure is honest: no 读取中 lie, an in-place
// 重试 on the page's refresh() seam, and exactly ONE error presentation per
// tab (the page-level banner skips the provider tab, keeps the other five).
// ---------------------------------------------------------------------------
const C5_STATUS: SettingsStatus = {
  providers: [
    { provider: "deepseek", label: "deepseek", status: "ready", keySource: "env", endpoint: "https://api.deepseek.com", defaultModel: "deepseek-v4-flash", custom: false, models: [] },
  ],
  credentials: { path: "/home/u/.wudao/.credentials.yaml", keyCount: 1 },
  settings: { memoryEnabled: true, uiDefaultMode: "advanced", wizardCompletedVersion: 1, uiTheme: null, uiAccent: null },
  current: { provider: "deepseek", model: "deepseek-v4-flash", effort: "high" },
  envKey: false,
  readiness: true,
  efforts: ["low", "high"],
};

describe("statecover C5 — ProviderTab load-failure honesty", () => {
  it("standalone: loadError suppresses 读取中, renders the error, and 重试 rides the refresh seam", async () => {
    const refresh = vi.fn();
    const c = mount(<ProviderTab client={{} as never} settings={null} status={null} notify={vi.fn()} refresh={refresh} loadError="boom" />);
    expect(c.textContent).not.toContain("读取中");
    expect(c.textContent).toContain("无法读取设置:boom");
    const retry = [...c.querySelectorAll("button")].find((b) => b.textContent === "重试");
    if (retry === undefined) throw new Error("retry button missing");
    await act(async () => {
      retry.click();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    // The settings branch stays closed (settings is still null) — the error
    // row is the tab's content until the retry succeeds.
    expect(c.querySelector(".provider-toolbar")).toBeNull();
  });

  it("standalone: without loadError the 读取中 stand-in keeps its old contract", () => {
    const c = mount(<ProviderTab client={{} as never} settings={null} status={null} notify={vi.fn()} refresh={vi.fn()} />);
    expect(c.textContent).toContain("读取中…");
    expect(c.textContent).not.toContain("无法读取设置");
  });

  it("in-page: a failing settingsStatus shows ONE error row on the provider tab; 重试 refetches and recovers", async () => {
    const server = fakeServer();
    const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
    act(() => {
      client.connect();
      server.socket.serverOpen();
    });
    await act(async () => {
      authOk(server.socket);
    });
    const opsOf = (): { id: number; op: Record<string, unknown> }[] =>
      server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } => typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>));
    const c = mount(<SettingsPage client={client} status={null} onClose={vi.fn()} />);
    // The page's mount fetch — answer it with a failure.
    await act(async () => {
      const op = opsOf().find((o) => o.op.op === "settingsStatus");
      if (op === undefined) throw new Error("settingsStatus op missing");
      server.socket.serverSend({ t: "result", id: op.id, err: "socket hiccup" });
    });
    expect(c.textContent).not.toContain("读取中"); // the lie is gone
    expect(c.textContent).toContain("无法读取设置:socket hiccup");
    // One presentation only — the page-level banner skipped this tab.
    expect([...c.querySelectorAll(".entry-error")]).toHaveLength(1);
    // The retry fires the SAME op again; a good reply lands the cards.
    await act(async () => {
      ([...c.querySelectorAll("button")].find((b) => b.textContent === "重试") as HTMLButtonElement).click();
    });
    const retryOps = opsOf().filter((o) => o.op.op === "settingsStatus");
    expect(retryOps.length).toBe(2);
    await act(async () => {
      server.socket.serverSend({ t: "result", id: retryOps[1]?.id, ok: C5_STATUS });
    });
    expect(c.textContent).not.toContain("无法读取设置");
    expect(c.textContent).toContain("deepseek"); // the card matrix landed
  });

  it("in-page: the OTHER tabs keep the page-level banner", async () => {
    const server = fakeServer();
    const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
    act(() => {
      client.connect();
      server.socket.serverOpen();
    });
    await act(async () => {
      authOk(server.socket);
    });
    const opsOf = (): { id: number; op: Record<string, unknown> }[] =>
      server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } => typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>));
    const c = mount(<SettingsPage client={client} status={null} onClose={vi.fn()} />);
    await act(async () => {
      const op = opsOf().find((o) => o.op.op === "settingsStatus");
      server.socket.serverSend({ t: "result", id: op?.id, err: "down" });
    });
    await act(async () => {
      ([...c.querySelectorAll("[data-settings-tab]")].find((b) => b.getAttribute("data-settings-tab") === "preferences") as HTMLButtonElement).click();
    });
    expect(c.textContent).toContain("无法读取设置:down"); // the banner still covers this tab
  });
});

// ---------------------------------------------------------------------------
// B1 — the advanced/buddy faces' run-level errors gain the simple face's
// recovery classification: the RAW text stays whole in the red line, the
// hint is appended (muted), and the actionable 继续 rides the App's submit
// seam (wired: a stable latest-ref wrapper — no new channel).
// ---------------------------------------------------------------------------
describe("statecover B1 — advanced error entries carry recovery hints", () => {
  it("a 429 error: the original text stays whole + the rate-limit hint is appended; no button (429 has no action)", async () => {
    const server = fakeServer();
    const c = mountedApp(server);
    await act(async () => {
      authOk(server.socket, {}, [
        { kind: "user", text: "hi" },
        { kind: "error", text: "HTTP 429 too many requests: rate limit exceeded (retry after 30s)" },
      ]);
    });
    const red = c.querySelector(".entry-error") as HTMLElement;
    expect(red.textContent).toBe("HTTP 429 too many requests: rate limit exceeded (retry after 30s)"); // nothing swallowed
    const hint = c.querySelector(".entry-error-hint") as HTMLElement;
    expect(hint).not.toBeNull();
    expect(hint.textContent).toContain("稍等"); // the rate-limit wording
    expect(hint.querySelector("button")).toBeNull(); // 429's recovery is patience, not a button
  });

  it("a truncation error: the 继续 button submits through the App's existing input path", async () => {
    const server = fakeServer();
    const c = mountedApp(server);
    await act(async () => {
      authOk(server.socket, {}, [
        { kind: "user", text: "hi" },
        { kind: "error", text: "stream aborted: finish_reason length, output truncated" },
      ]);
    });
    const hint = c.querySelector(".entry-error-hint") as HTMLElement;
    expect(hint.textContent).toContain("截断"); // the truncation wording
    const btn = [...c.querySelectorAll(".entry-error-hint button")].find((b) => b.textContent === "发送「继续」让模型接着写") as HTMLButtonElement | undefined;
    if (btn === undefined) throw new Error("recovery button missing");
    await act(async () => {
      btn.click();
    });
    const submits = server
      .clientFrames()
      .filter((f): f is { id: number; op: { op: string; text: string } } => typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>))
      .filter((f) => (f.op as { op?: string }).op === "submit" && (f.op as { text?: string }).text === "继续");
    expect(submits).toHaveLength(1); // the normal input path, nothing bespoke
  });

  it("standalone HistoryList without onAction: the hint renders, the button does not (hint-only wiring)", async () => {
    await act(async () => {});
    const c = mount(
      <HistoryList history={[{ kind: "error", text: "stream aborted: finish_reason length, output truncated" }]} />,
    );
    expect(c.querySelector(".entry-error")?.textContent).toContain("output truncated");
    expect(c.querySelector(".entry-error-hint")).not.toBeNull();
    expect(c.querySelector(".entry-error-hint button")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C7 — the wizard's two empty states (② no providers / ④ no models).
// C8 — ModelPicker's state copy is Chinese. C9 — the recents menu's loading
// row says 加载中… instead of a bare "…".
// ---------------------------------------------------------------------------
const EMPTY_PROVIDERS: SettingsStatus = {
  providers: [],
  credentials: { path: "/home/u/.wudao/.credentials.yaml", keyCount: 0 },
  settings: { memoryEnabled: true, uiDefaultMode: "simple", wizardCompletedVersion: 0, uiTheme: null, uiAccent: null },
  current: { provider: "", model: "", effort: undefined },
  envKey: false,
  readiness: false,
  efforts: ["low", "high"],
};

describe("statecover C7 — wizard empty states", () => {
  const blankDefault = (provider: string): SettingsStatus["providers"][number] => ({
    provider,
    label: provider,
    status: "missing-key",
    keySource: null,
    endpoint: `https://${provider}.example/v1`,
    defaultModel: "", // a registry stub that resolves no real model
    custom: false,
    models: [],
  });

  it("step ② with an empty registry renders the empty state with its guidance", async () => {
    const server = fakeServer();
    const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
    const c = mount(<Wizard client={client} status={null} settings={EMPTY_PROVIDERS} onDone={vi.fn()} />);
    await act(async () => {
      ([...c.querySelectorAll("button")].find((b) => b.textContent === "开始配置") as HTMLButtonElement).click();
    });
    const empty = c.querySelector(".wizard-empty") as HTMLElement;
    expect(empty).not.toBeNull();
    expect(empty.textContent).toContain("暂无可用供应商");
    expect(empty.textContent).toContain("稍后在设置的「供应商」中添加");
    // 下一步 stays disabled — the empty state names the way out, it is not one.
    expect(([...c.querySelectorAll("button")].find((b) => b.textContent === "下一步") as HTMLButtonElement).disabled).toBe(true);
  });

  it("step ④ with a provider that resolves no models renders the empty state", async () => {
    const server = fakeServer();
    const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
    const settings: SettingsStatus = { ...EMPTY_PROVIDERS, providers: [blankDefault("deepseek")] };
    const c = mount(<Wizard client={client} status={null} settings={settings} onDone={vi.fn()} />);
    act(() => {
      client.connect();
      server.socket.serverOpen();
    });
    await act(async () => {
      ([...c.querySelectorAll("button")].find((b) => b.textContent === "开始配置") as HTMLButtonElement).click();
    });
    await act(async () => {
      (c.querySelector(".wizard-provider-card") as HTMLButtonElement).click();
    });
    await act(async () => {
      ([...c.querySelectorAll("button")].find((b) => b.textContent === "下一步") as HTMLButtonElement).click();
    });
    // Step ③: paste a key, test, pass, auto-save — the two op replies.
    const keyInput = c.querySelector("input.key-input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(keyInput, "sk-test");
      keyInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      ([...c.querySelectorAll("button")].find((b) => b.textContent === "测试连接") as HTMLButtonElement).click();
    });
    const opsOf = (): { id: number; op: Record<string, unknown> }[] =>
      server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } => typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>));
    const testOp = opsOf().find((o) => o.op.op === "settingsTestConnection");
    await act(async () => {
      server.socket.serverSend({ t: "result", id: testOp?.id, ok: { ok: true, state: "ok", message: "连接成功" } });
    });
    const saveOp = opsOf().find((o) => o.op.op === "settingsSaveKey");
    await act(async () => {
      server.socket.serverSend({ t: "result", id: saveOp?.id, ok: { ok: true } });
    });
    await act(async () => {
      ([...c.querySelectorAll("button")].filter((b) => b.textContent === "下一步").pop() as HTMLButtonElement).click();
    });
    const empty = c.querySelector(".wizard-empty") as HTMLElement;
    expect(empty).not.toBeNull();
    expect(empty.textContent).toContain("该供应商暂无可用模型");
    expect(empty.textContent).toContain("返回上一步重选");
    expect(c.querySelector(".model-chip")).toBeNull(); // no blank chips either
  });
});

describe("statecover C8 — ModelSelector state copy (the retired ModelPicker modal's cover, re-targeted)", () => {
  const CHOICES = [{ provider: "deepseek", model: "deepseek-v4", source: "profile" }];

  it("no switchable models: the Chinese empty line replaces the English one", () => {
    const c = mount(<ModelSelector label="x" provider="deepseek" choices={[]} onPick={vi.fn()} />);
    // The menu only exists while open — the chip click is part of the cover.
    act(() => {
      (c.querySelector("button.chip") as HTMLButtonElement).click();
    });
    expect(c.textContent).toContain("暂无可切换的模型");
    expect(c.textContent).not.toContain("no switchable models");
  });

  it("the footer state copy is Chinese (key name kept)", () => {
    const c = mount(
      <ModelSelector label="deepseek-v4" provider="deepseek" choices={CHOICES} onPick={vi.fn()} onPersistDefault={() => {}} />,
    );
    act(() => {
      (c.querySelector("button.chip") as HTMLButtonElement).click();
    });
    expect(c.textContent).toContain("设为默认(下次启动)");
    expect(c.textContent).not.toContain("cancel"); // tokfinish §7: 强化负断言——旧英文按钮任意大小写都不在
  });
});

describe("statecover C9 — the recents menu's loading row", () => {
  it("while recents load, the row says 加载中… (not a bare ellipsis)", async () => {
    const never = new Promise(() => {});
    const client = {
      fileTree: () => never,
      recentWorkspaces: () => never,
    } as unknown as Parameters<typeof FileTree>[0]["client"];
    const c = mount(
      <FileTree client={client} workspaceRoot="/w" selectedPath={null} onSelect={vi.fn()} onAtMention={vi.fn()} refreshKey={0} />,
    );
    await act(async () => {
      (c.querySelector(".ws-switcher") as HTMLButtonElement).click();
    });
    expect(c.querySelector(".ws-loading")?.textContent).toBe("加载中…");
  });
});

// ---------------------------------------------------------------------------
// E — the language-policy settlement: receipts/empty states/hints are
// Chinese; slash commands, key names, and mono technical details stay
// English by policy (not debt). The two REQUIRED re-pins (ResumePicker
// title, InputBox offline hint) live in components/composer-visual; this
// section pins the row copy that would otherwise be unpinned.
// ---------------------------------------------------------------------------
describe("statecover E — ResumePicker row copy", () => {
  it("rows say N 条消息; an empty row says 暂无会话; the cancel button is 取消 (Esc)", () => {
    const c = mount(
      <ResumePicker
        rows={[
          { id: "wudao-a-1", mtime: "2026-08-16T10:00:00.000Z", messages: 4, firstUser: "fix bug", model: "deepseek" },
          { id: "wudao-b-2", mtime: "2026-08-15T10:00:00.000Z", messages: 0, firstUser: "", model: "" },
        ]}
        onPick={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(c.querySelector("h3")?.textContent).toBe("选择要恢复的会话");
    const rows = [...c.querySelectorAll(".pickrow")] as HTMLElement[];
    expect(rows[0]?.textContent).toContain("4 条消息");
    expect(rows[0]?.textContent).not.toContain("4 msg");
    expect(rows[1]?.textContent).toContain("暂无会话");
    expect([...c.querySelectorAll(".btnrow button")].some((b) => b.textContent === "取消 (Esc)")).toBe(true);
  });
});
