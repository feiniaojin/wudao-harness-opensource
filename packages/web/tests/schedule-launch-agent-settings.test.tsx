// 122 项 2 — 定时任务离线唤起的 web 设置面（287 关窗后台测试的姊妹形）：
//  ① desktop 壳渲染开关：默认关（fail-closed 家族）；文案=收益语（「应用
//     没开着，到点也会自动打开应用执行」）+ 合盖例外锚词（诚实边界）；
//  ② 点击走既有 settingsSet 车道（key schedules.launchAgent），回执收益语；
//  ③ server 回读 true → 初始勾上；supported=false（非 macOS）→ 不渲染；
//     浏览器壳（无 shell=desktop）→ 不渲染。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsPage } from "../src/components/SettingsPage.js";
import type { SettingsStatus } from "../src/protocol.js";
import { fakeServer, authOk } from "./mock-ws.js";
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

const opFrames = (h: { container: HTMLElement; server: FakeServer }) =>
  h.server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } =>
    typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>),
  );

async function mountedPrefs(statusOk: SettingsStatus, shell = "desktop"): Promise<Harness> {
  const server = fakeServer();
  if (shell === "desktop") window.history.replaceState(null, "", "/?shell=desktop#t");
  else window.history.replaceState(null, "", "/#t");
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
  c.querySelector("input[data-schedule-launch-agent]");

async function serverSend(h: Harness, opName: string, ok: unknown): Promise<void> {
  const op = [...opFrames(h)].reverse().find((o) => o.op.op === opName);
  h.server.socket.serverSend({ t: "result", id: op?.id, ok });
}

describe("122 项 2 — 设置页「定时任务离线唤起」开关", () => {
  it("desktop 壳：默认关；文案=收益语+合盖例外锚词；点击走既有 settingsSet 车道，回执收益语", async () => {
    const h = await mountedPrefs(STATUS({ schedulesLaunchAgentSupported: true }));
    const input = toggleInput(h.container);
    expect(input).not.toBeNull();
    expect(input?.checked).toBe(false); // 默认关（fail-closed）
    const row = input?.closest("label")?.textContent ?? "";
    expect(row).toContain("定时任务离线唤起");
    expect(row).toContain("应用没开着"); // 收益语（对外文案律：用户收益，不是 LaunchAgent/plist 术语）
    expect(row).not.toContain("LaunchAgent");
    expect(row).not.toContain("plist");
    expect(row).toContain("合盖"); // 例外诚实文案（设计 §6 边界）
    await act(async () => {
      input?.click();
    });
    const op = opFrames(h).find((o) => o.op.op === "settingsSet" && o.op.key === "schedules.launchAgent");
    expect(op?.op).toMatchObject({ op: "settingsSet", key: "schedules.launchAgent", value: true });
    await act(async () => {
      await serverSend(h, "settingsSet", { key: "schedules.launchAgent", saved: true });
    });
    expect(h.container.textContent).toContain("定时任务离线唤起已开启");
  });

  it("desktop 壳：server 回读 true → 初始勾上；关闭回执如实", async () => {
    const h = await mountedPrefs(STATUS({ schedulesLaunchAgentSupported: true, schedulesLaunchAgent: true }));
    expect(toggleInput(h.container)?.checked).toBe(true);
    const input = toggleInput(h.container);
    await act(async () => {
      input?.click();
    });
    const op = opFrames(h).find((o) => o.op.op === "settingsSet" && o.op.key === "schedules.launchAgent");
    expect(op?.op).toMatchObject({ value: false });
    await act(async () => {
      await serverSend(h, "settingsSet", { key: "schedules.launchAgent", saved: true });
    });
    expect(h.container.textContent).toContain("定时任务离线唤起已关闭");
  });

  it("desktop 壳 + 非 macOS（supported=false）：开关不渲染（不承诺系统给不了的唤起）", async () => {
    const h = await mountedPrefs(STATUS({ schedulesLaunchAgentSupported: false, schedulesLaunchAgent: false }));
    expect(toggleInput(h.container)).toBeNull();
  });

  it("浏览器壳（无 shell=desktop）：开关不渲染", async () => {
    const h = await mountedPrefs(STATUS({ schedulesLaunchAgentSupported: true, schedulesLaunchAgent: true }), "browser");
    expect(toggleInput(h.container)).toBeNull();
  });
});
