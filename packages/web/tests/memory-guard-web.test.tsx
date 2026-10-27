// 永续迭代 v6 · reef 借鉴弧 A（digest-reef C3）——「已拦 N 条可疑学习输入」
// 的 web 可见面 RED 件：管理记忆面板（PreferencesTab 直接挂载，preferences-
// tab.test.tsx 的 harness 家族）在 blocked>0 时渲染提示行（含去向）；blocked
// 缺场 = 零渲染（老 server 静默降级，零噪音门不破）。全 mock 零真网络。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WudaoClient } from "../src/protocol.js";
import type { SettingsStatus } from "../src/protocol.js";
import { PreferencesTab } from "../src/components/PreferencesTab.js";
import { authOk, fakeServer } from "./mock-ws.js";

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

const STATUS: SettingsStatus = {
  providers: [],
  credentials: { path: "/home/u/.wudao/.credentials.yaml", keyCount: 1 },
  settings: { memoryEnabled: true, uiDefaultMode: null, wizardCompletedVersion: 1, uiTheme: null, uiAccent: null },
  current: { provider: "deepseek", model: "deepseek-v4-flash", effort: "high" },
  envKey: false,
  readiness: true,
  efforts: [],
};

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

interface Harness {
  container: HTMLElement;
  server: ReturnType<typeof fakeServer>;
  replyTo: (opName: string, ok: unknown) => Promise<void>;
  opSeen: (opName: string) => boolean;
}
async function mountedTab(): Promise<Harness> {
  const server = fakeServer();
  const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
  // Connect FIRST, then mount: the tab's memory fetch rides sendOp (a read —
  // it rejects while offline rather than queueing), so the socket must be
  // open before the effect fires.
  act(() => {
    client.connect();
    server.socket.serverOpen();
  });
  act(() => {
    authOk(server.socket);
  });
  const container = mount(
    <PreferencesTab client={client} settings={STATUS} notify={vi.fn()} refresh={vi.fn()} onModeApplied={vi.fn()} />,
  );
  const ops = () =>
    server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } =>
      typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>));
  const opSeen = (opName: string): boolean => ops().some((o) => o.op.op === opName);
  const replyTo = async (opName: string, ok: unknown): Promise<void> => {
    await act(async () => {
      const op = [...ops()].reverse().find((o) => o.op.op === opName);
      server.socket.serverSend({ t: "result", id: op?.id, ok });
    });
  };
  return { container, server, replyTo, opSeen };
}

describe("永续 v6 弧 A — 被拦学习输入的 web 可见面（管理记忆面）", () => {
  it("blocked > 0 → renders the「已拦 N 条」hint naming the ledger", async () => {
    const h = await mountedTab();
    await until(() => h.opSeen("memoryList"), "the lazy memoryList fetch");
    await h.replyTo("memoryList", { entries: [], blocked: 3 });
    await until(() => h.container.querySelector(".mem-blocked") !== null, "the blocked hint");
    const line = h.container.querySelector(".mem-blocked") as HTMLElement;
    expect(line.textContent).toContain("已拦 3 条可疑学习输入");
    expect(line.textContent).toContain("memory-blocked.jsonl");
  });

  it("blocked absent (old server) → 零渲染（静默降级，零噪音门不破）", async () => {
    const h = await mountedTab();
    await until(() => h.opSeen("memoryList"), "the lazy memoryList fetch");
    await h.replyTo("memoryList", { entries: [] }); // no blocked field at all
    await until(() => h.container.querySelector(".mem-empty") !== null, "the empty memory state (section painted)");
    expect(h.container.querySelector(".mem-blocked")).toBeNull();
  });
});
