// @vitest-environment jsdom
// ω99-236: #R3 — 设置页插件 tab「内置」段：文档三件套开关（身份可见——内
// 置能力也有开关与身份，不与核心熔死）。三面：(i) 内置段在场（标题/行名/
// 说明逐字——brief §二钉）；(j) 开关初值=设置回载、toggle → settingsSet
// 调用断言 + 既有开关回执范式的 toast；(k) 旧服务端无键 → 缺省开（沿
// memoryEnabled `?? true` 的缺省门语义，段不隐藏）。
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WudaoClient } from "../src/protocol.js";
import type { SettingsStatus } from "../src/protocol.js";
import { SettingsPage } from "../src/components/SettingsPage.js";
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

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
});

// The settingsStatus fixture (plugin-tab.test.ts 的同款底座 + docSuiteEnabled)。
const statusWith = (docSuiteEnabled?: boolean): SettingsStatus => ({
  providers: [
    { provider: "deepseek", label: "deepseek", status: "ready", keySource: "env", endpoint: "https://api.deepseek.com", defaultModel: "deepseek-v4-flash", custom: false, models: [] },
  ],
  credentials: { path: "/home/u/.wudao/.credentials.yaml", keyCount: 1 },
  settings: {
    memoryEnabled: true,
    uiDefaultMode: "advanced",
    wizardCompletedVersion: 1,
    uiTheme: null,
    uiAccent: null,
    ...(docSuiteEnabled === undefined ? {} : { docSuiteEnabled }),
  },
  current: { provider: "deepseek", model: "deepseek-v4-flash", effort: "high" },
  envKey: false,
  readiness: true,
  efforts: ["low", "medium", "high", "max", "none"],
});

const MARKETS = { marketplaces: [] };
const INSTALLED = { installed: [] };

interface Harness {
  container: HTMLElement;
  server: FakeServer;
}

async function pluginsTabWith(status: SettingsStatus): Promise<Harness> {
  const server = fakeServer();
  const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
  act(() => {
    client.connect();
    server.socket.serverOpen();
  });
  act(() => {
    authOk(server.socket);
  });
  const container = mount(<SettingsPage client={client} status={null} onClose={() => {}} />);
  const ops = (): { id: number; op: Record<string, unknown> }[] =>
    server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } =>
      typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>),
    ) as { id: number; op: Record<string, unknown> }[];
  await act(async () => {
    const statusOp = ops().find((o) => o.op.op === "settingsStatus");
    server.socket.serverSend({ t: "result", id: statusOp?.id, ok: status });
  });
  const tabBtn = container.querySelector("button[data-settings-tab='plugins']") as HTMLButtonElement;
  await act(async () => {
    tabBtn.click();
  });
  // The tab's lazy plugin fetches (the 内置段 is settings-prop-fed, no extra op).
  await act(async () => {
    for (const name of ["pluginList", "pluginMarketList"]) {
      const op = [...ops()].reverse().find((o) => o.op.op === name);
      server.socket.serverSend({ t: "result", id: op?.id, ok: name === "pluginList" ? INSTALLED : MARKETS });
    }
  });
  return { container, server };
}

/** Answer the LATEST op of a name. */
const replyLatest = async (h: Harness, opName: string, ok: unknown): Promise<void> => {
  await act(async () => {
    const ops = h.server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } =>
      typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>),
    ) as { id: number; op: Record<string, unknown> }[];
    const op = [...ops].reverse().find((o) => o.op.op === opName);
    h.server.socket.serverSend({ t: "result", id: op?.id, ok });
  });
};

const docToggle = (c: HTMLElement): HTMLInputElement => {
  const el = c.querySelector("input[data-doc-suite-toggle]") as HTMLInputElement | null;
  if (el === null) throw new Error("doc-suite toggle missing");
  return el;
};

describe("ω99-236 R3(i) — 插件 tab 内置段在场（文案逐字）", () => {
  it("标题「内置」/ 行名「文档三件套」/ 行说明逐字", async () => {
    const h = await pluginsTabWith(statusWith(true));
    const panel = h.container.querySelector("[data-plugin-tab]") as HTMLElement | null;
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain("内置");
    expect(panel?.textContent).toContain("文档三件套");
    expect(panel?.textContent).toContain("用自然语言创建和编辑 Excel、Word、PPT 文件（关闭后新会话生效）");
  });
});

describe("ω99-236 R3(j) — 开关初值=设置回载；toggle → settingsSet + toast", () => {
  it("回载 false → 初值未勾；勾上 → settingsSet(docSuite.enabled,true) + 既有回执范式 toast", async () => {
    const h = await pluginsTabWith(statusWith(false));
    expect(docToggle(h.container).checked).toBe(false);
    await act(async () => {
      docToggle(h.container).click();
    });
    const ops = h.server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } =>
      typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>),
    ) as { id: number; op: Record<string, unknown> }[];
    const setOp = [...ops].reverse().find((o) => o.op.op === "settingsSet");
    expect(setOp?.op).toMatchObject({ op: "settingsSet", key: "docSuite.enabled", value: true });
    await replyLatest(h, "settingsSet", { key: "docSuite.enabled", saved: true });
    expect(h.container.querySelector(".settings-toasts")?.textContent).toContain("文档三件套已开启 —— 下会话生效");
    // The landed write re-reads settingsStatus (the page's refresh seam).
    await replyLatest(h, "settingsStatus", statusWith(true));
    expect(docToggle(h.container).checked).toBe(true);
  });

  it("回载 true → 勾着；关 → settingsSet(docSuite.enabled,false)；pending 期间开关禁用", async () => {
    const h = await pluginsTabWith(statusWith(true));
    expect(docToggle(h.container).checked).toBe(true);
    await act(async () => {
      docToggle(h.container).click();
    });
    const ops = h.server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } =>
      typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>),
    ) as { id: number; op: Record<string, unknown> }[];
    const setOp = [...ops].reverse().find((o) => o.op.op === "settingsSet");
    expect(setOp?.op).toMatchObject({ op: "settingsSet", key: "docSuite.enabled", value: false });
    // Pending: the op is unanswered — the toggle disables (no silent double-fire).
    expect(docToggle(h.container).disabled).toBe(true);
    await replyLatest(h, "settingsSet", { key: "docSuite.enabled", saved: false });
    expect(h.container.querySelector(".settings-toasts")?.textContent).toContain("文档三件套已关闭 —— 下会话生效");
    await replyLatest(h, "settingsStatus", statusWith(false));
    expect(docToggle(h.container).disabled).toBe(false);
    expect(docToggle(h.container).checked).toBe(false);
  });
});

describe("ω99-236 R3(k) — 旧服务端无键 → 缺省开（段不隐藏）", () => {
  it("settings.docSuiteEnabled 缺席 → 勾着（memoryEnabled `?? true` 同款缺省门）", async () => {
    const h = await pluginsTabWith(statusWith(undefined));
    const panel = h.container.querySelector("[data-plugin-tab]") as HTMLElement | null;
    expect(panel?.textContent).toContain("内置"); // 段在场，不降级隐藏
    expect(docToggle(h.container).checked).toBe(true);
  });
});
