// ω99-287: #5 — L2 后台运行 MVP 的 web 面（brief §2 web 件；283/286 件范式）：
//  ① hide 决策纯函数：设置开 → "hide"；false / 缺席（老 server）→ "close"；
//  ② 决策流（注入边）：开+hide 成 → hidden 且不 destroy；关 → destroy；读失败 →
//     destroy（fail-open 到旧行为）；hide 失败 → 仍 destroy（不可关死窗不变量）；
//  ③ 挂载门：__TAURI_INTERNALS__.metadata.currentWindow.label==="main" 才注
//     册 close-requested 监听（target 必 {"kind":"Window","label":"main"}——
//     tauri 2.11.5 manager/window.rs 的 has_js_listener 只认窗名 target）；非
//     main 窗（workspace-*）/无桥（浏览器）→ 不注册；
//  ④ 设置页开关（?shell=desktop 才渲染）：默认关；切换走既有 settingsSet 车道
//     op 形（key desktop.backgroundOnClose）；文案含合盖例外锚词「合盖」；
//     浏览器壳（无 shell=desktop）→ 开关不渲染。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsPage } from "../src/components/SettingsPage.js";
import type { SettingsStatus } from "../src/protocol.js";
import {
  backgroundCloseDecision,
  currentTauriWindowLabel,
  mountBackgroundOnClose,
  resolveBackgroundClose,
} from "../src/background-close.js";
import { fakeServer, authOk } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Flush the async listen/hide/destroy chain (fake invokes resolve on microtasks). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("ω99-287 — hide 决策纯函数", () => {
  it("开 → hide；false / 缺席 → close", () => {
    expect(backgroundCloseDecision(true)).toBe("hide");
    expect(backgroundCloseDecision(false)).toBe("close");
    expect(backgroundCloseDecision(undefined)).toBe("close");
  });
});

describe("ω99-287 — 决策流（注入边）", () => {
  it("开 + hide 成 → hidden，destroy 不被调", async () => {
    const calls: string[] = [];
    const out = await resolveBackgroundClose({
      readSetting: async () => true,
      hide: async () => { calls.push("hide"); return true; },
      destroy: async () => { calls.push("destroy"); return true; },
    });
    expect(out).toBe("hidden");
    expect(calls).toEqual(["hide"]);
  });

  it("关 / 缺席（老 server）→ destroy", async () => {
    for (const setting of [false, undefined]) {
      const calls: string[] = [];
      const out = await resolveBackgroundClose({
        readSetting: async () => setting,
        hide: async () => { calls.push("hide"); return true; },
        destroy: async () => { calls.push("destroy"); return true; },
      });
      expect(out).toBe("closed");
      expect(calls).toEqual(["destroy"]);
    }
  });

  it("读失败（server 不可达）→ destroy（fail-open 到旧行为）", async () => {
    const calls: string[] = [];
    const out = await resolveBackgroundClose({
      readSetting: () => Promise.reject(new Error("ws down")),
      hide: async () => { calls.push("hide"); return true; },
      destroy: async () => { calls.push("destroy"); return true; },
    });
    expect(out).toBe("closed");
    expect(calls).toEqual(["destroy"]);
  });

  it("hide 失败 → 仍 destroy（不可关死窗不变量）", async () => {
    const calls: string[] = [];
    const out = await resolveBackgroundClose({
      readSetting: async () => true,
      hide: async () => { calls.push("hide"); return false; },
      destroy: async () => { calls.push("destroy"); return true; },
    });
    expect(out).toBe("closed");
    expect(calls).toEqual(["hide", "destroy"]);
  });
});

// ---- 挂载门（stub __TAURI_INTERNALS__，帧级断言） ------------------------------

type InvokeFrame = { cmd: string; args?: unknown };

interface InternalsStub {
  frames: InvokeFrame[];
  /** Fire the registered event callback (the transformCallback seam). */
  fire: (payload: unknown) => void;
  restore: () => void;
}

/** Install a fake bridge; label controls the gating branch under test. */
function stubInternals(label: string): InternalsStub {
  const frames: InvokeFrame[] = [];
  let handler: ((raw: unknown) => void) | null = null;
  const w = window as unknown as Record<string, unknown>;
  const prev = w.__TAURI_INTERNALS__;
  w.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: unknown): Promise<unknown> => {
      frames.push({ cmd, args });
      return cmd === "plugin:event|listen" ? 7 : null;
    },
    transformCallback: (cb: (raw: unknown) => void): number => {
      handler = cb;
      return 1;
    },
    metadata: { currentWindow: { label }, currentWebview: { label } },
  };
  return {
    frames,
    fire: (payload: unknown) => { handler?.(payload); },
    restore: () => { if (prev === undefined) delete w.__TAURI_INTERNALS__; else w.__TAURI_INTERNALS__ = prev; },
  };
}

describe("ω99-287 — 挂载门（main 窗才注册；workspace 窗/浏览器不注册）", () => {
  afterEach(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.__TAURI_INTERNALS__;
  });

  it("main：listen 以 {kind:Window,label:main} target 注册；close 事件 → 设置开 → hide 帧落地", async () => {
    const stub = stubInternals("main");
    mountBackgroundOnClose({ settingsStatus: async () => ({ settings: { desktopBackgroundOnClose: true } }) });
    await flush();
    const listen = stub.frames.find((f) => f.cmd === "plugin:event|listen");
    expect(listen).toBeDefined();
    expect(listen?.args).toMatchObject({ event: "tauri://close-requested", target: { kind: "Window", label: "main" } });
    // Fire the close event (the unwrap seam tolerates the raw Event wrapper).
    stub.fire({ event: "tauri://close-requested", payload: null, id: 1 });
    await flush();
    expect(stub.frames.some((f) => f.cmd === "plugin:window|hide")).toBe(true);
    expect(stub.frames.some((f) => f.cmd === "plugin:window|destroy")).toBe(false);
  });

  it("main：设置关 → destroy 帧落地（不走 hide）", async () => {
    const stub = stubInternals("main");
    mountBackgroundOnClose({ settingsStatus: async () => ({ settings: { desktopBackgroundOnClose: false } }) });
    await flush();
    stub.fire({ event: "tauri://close-requested", payload: null, id: 1 });
    await flush();
    expect(stub.frames.some((f) => f.cmd === "plugin:window|destroy")).toBe(true);
    expect(stub.frames.some((f) => f.cmd === "plugin:window|hide")).toBe(false);
  });

  it("workspace-1 窗：不注册（保留原生关闭）；无桥（浏览器）：no-op", async () => {
    const stub = stubInternals("workspace-1");
    mountBackgroundOnClose({ settingsStatus: async () => ({ settings: { desktopBackgroundOnClose: true } }) });
    await flush();
    expect(stub.frames.some((f) => f.cmd === "plugin:event|listen")).toBe(false);
    stub.restore();
    // 浏览器：无 __TAURI_INTERNALS__ → 不抛、不注册。
    expect(currentTauriWindowLabel()).toBeNull();
    expect(() => mountBackgroundOnClose({ settingsStatus: async () => ({ settings: {} }) })).not.toThrow();
    await flush();
  });
});

// ---- 设置页开关（?shell=desktop 门） ------------------------------------------

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
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

interface Harness {
  container: HTMLElement;
  server: FakeServer;
}

const STATUS = (settingsOver: Record<string, unknown>): SettingsStatus => ({
  providers: [{ provider: "deepseek", label: "deepseek", status: "ready", keySource: "env", endpoint: "https://api.deepseek.com", defaultModel: "deepseek-v4-flash", custom: false, models: [{ name: "deepseek-v4-flash" }] }],
  credentials: { path: "/home/u/.wudao/.credentials.yaml", keyCount: 1 },
  settings: { memoryEnabled: true, uiDefaultMode: "advanced", wizardCompletedVersion: 1, uiTheme: null, uiAccent: null, ...settingsOver },
  current: { provider: "deepseek", model: "deepseek-v4-flash", effort: "high" },
  envKey: false,
  readiness: true,
  efforts: ["low", "medium", "high", "max", "none"],
});

const opFrames = (h: Harness) =>
  h.server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } =>
    typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>),
  );

async function mountedPrefs(statusOk: SettingsStatus): Promise<Harness> {
  const server = fakeServer();
  // The desktop-shell mark: the toggle renders only under ?shell=desktop.
  window.history.replaceState(null, "", "/?shell=desktop#t");
  const { WudaoClient } = await import("../src/protocol.js");
  const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
  act(() => {
    client.connect();
    server.socket.serverOpen();
  });
  act(() => {
    authOk(server.socket);
  });
  const container = mount(<SettingsPage client={client} status={null} onClose={() => {}} pendingAsk={false} />);
  await act(async () => {
    const statusOp = opFrames({ container, server }).find((o) => o.op.op === "settingsStatus");
    server.socket.serverSend({ t: "result", id: statusOp?.id, ok: statusOk });
  });
  await act(async () => {
    (container.querySelector("button[data-settings-tab='preferences']") as HTMLButtonElement).click();
  });
  return { container, server };
}

const toggleInput = (c: HTMLElement): HTMLInputElement | null =>
  c.querySelector("input[data-background-on-close]");

describe("ω99-287 — 设置页「关闭窗口时保持后台运行」开关", () => {
  it("desktop 壳：默认关；文案含合盖例外锚词；点击走既有 settingsSet 车道", async () => {
    const h = await mountedPrefs(STATUS({}));
    const input = toggleInput(h.container);
    expect(input).not.toBeNull();
    expect(input?.checked).toBe(false); // 默认关（Q1 裁定）
    const row = input?.closest("label")?.textContent ?? "";
    expect(row).toContain("关闭窗口时保持后台运行");
    expect(row).toContain("合盖"); // Q4 裁定：例外诚实文案
    expect(row).toContain("继续"); // 收益语（关窗不杀活）
    await act(async () => {
      input?.click();
    });
    const op = opFrames(h).find((o) => o.op.op === "settingsSet" && o.op.key === "desktop.backgroundOnClose");
    expect(op?.op).toMatchObject({ op: "settingsSet", key: "desktop.backgroundOnClose", value: true });
    await act(async () => {
      server_send(h, "settingsSet", { key: "desktop.backgroundOnClose", saved: true });
    });
    expect(h.container.textContent).toContain("关窗后台运行已开启");
  });

  it("desktop 壳：server 回读 true → 开关初始勾上", async () => {
    const h = await mountedPrefs(STATUS({ desktopBackgroundOnClose: true }));
    expect(toggleInput(h.container)?.checked).toBe(true);
  });

  it("浏览器壳（无 shell=desktop）：开关不渲染", async () => {
    const server = fakeServer();
    const { WudaoClient } = await import("../src/protocol.js");
    const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
    act(() => {
      client.connect();
      server.socket.serverOpen();
    });
    act(() => {
      authOk(server.socket);
    });
    const container = mount(<SettingsPage client={client} status={null} onClose={() => {}} pendingAsk={false} />);
    await act(async () => {
      const statusOp = opFrames({ container, server }).find((o) => o.op.op === "settingsStatus");
      server.socket.serverSend({ t: "result", id: statusOp?.id, ok: STATUS({ desktopBackgroundOnClose: true }) });
    });
    await act(async () => {
      (container.querySelector("button[data-settings-tab='preferences']") as HTMLButtonElement).click();
    });
    expect(toggleInput(container)).toBeNull();
  });
});

/** Reply to the latest settingsSet op (the settings-page family's replyTo). */
async function server_send(h: Harness, opName: string, ok: unknown): Promise<void> {
  const op = [...opFrames(h)].reverse().find((o) => o.op.op === opName);
  h.server.socket.serverSend({ t: "result", id: op?.id, ok });
}
