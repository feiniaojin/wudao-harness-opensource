// @vitest-environment jsdom
// M85-final I-1（终审修复波）— 归档行主窗刷新缺口的 App 侧接线钉。终审事实：
// sessionsEpoch 只由 rename/delete/trash/主车道 sessionName 变化 bump——pet
// 轮换归档后主车道不动，已打开的 Buddy 侧栏不重取，「精灵 · …」归档行要等
// 某次无关操作才出现。修复=relay 广播 WUDAO_PET_SESSIONS_REFRESH_EVENT（relay
// 侧行为在 m85-final-relay.test.ts (a)），App 监听 bump sessionsEpoch。本文件
// 钉 App 半边：信号到 → SessionSidebar 重发 sessions op（列表重取被触发）。
// 装配照 omega99-116 的 tauriListenEvent 捕获范式（jsdom 无桥，真缝读 null，
// mock 保持缝的其它出口真实）+ omega99-307 的 mock-ws 挂载/landMode 范式。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { WudaoClient } from "../src/protocol.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";
import { WUDAO_PET_SESSIONS_REFRESH_EVENT } from "../src/pet/pet-frame.js";
import { tauriListenEvent } from "../src/tauri-invoke.js";

// App's effect consumes tauriListenEvent; the mock keeps the seam's other
// exports real and captures handler registrations per event name so the test
// can FIRE the relay's refresh signal verbatim (ω99-116 discipline).
vi.mock("../src/tauri-invoke.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tauri-invoke.js")>();
  return {
    ...actual,
    tauriListenEvent: vi.fn(async (event: string, handler: (payload: unknown) => void): Promise<(() => void) | null> => {
      listeners.set(event, handler);
      return () => {};
    }),
  };
});

const listenMock = vi.mocked(tauriListenEvent);
const listeners = new Map<string, (payload: unknown) => void>();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const mount = (el: ReactElement): HTMLElement => {
  const container = document.body.appendChild(document.createElement("div"));
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
  window.localStorage.removeItem("wudao.ui.v1");
});

beforeEach(() => {
  listeners.clear();
  listenMock.mockClear();
});

interface AppHarness {
  container: HTMLElement;
  client: WudaoClient;
  server: FakeServer;
}

function mountedApp(): AppHarness {
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
  return { container, client, server };
}

type OpFrame = { id: number; op: Record<string, unknown> };
const opFrames = (h: AppHarness): OpFrame[] =>
  h.server.clientFrames().filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in (f as object));

const sessionsOps = (h: AppHarness): number => opFrames(h).filter((o) => o.op.op === "sessions").length;

/** The connect-time agentRootStatus resolve + the settings pick that lands the
 *  shell in buddy mode（omega99-307 landMode 逐字——buddy 才挂 SessionSidebar）。
 *  authOk 的状态帧也在此落定（view.sessionId 稳定后侧栏的取数效应跑完）。 */
async function landBuddy(h: AppHarness): Promise<void> {
  await act(async () => {
    authOk(h.server.socket);
  });
  await act(async () => {
    const op = opFrames(h).find((o) => o.op.op === "agentRootStatus");
    h.server.socket.serverSend({
      t: "result",
      id: op?.id,
      ok: { panelRoot: "/Users/u/work/proj-x", agentRoot: "/Users/u/work/proj-x", aligned: true },
    });
  });
  await act(async () => {
    const op = opFrames(h).find((o) => o.op.op === "settingsStatus");
    h.server.socket.serverSend({
      t: "result",
      id: op?.id,
      ok: { settings: { memoryEnabled: true, uiDefaultMode: "buddy" } },
    });
  });
}

describe("M85-final I-1 归档刷新信号 → 主窗会话列表重取", () => {
  it("buddy 侧栏在场：WUDAO_PET_SESSIONS_REFRESH_EVENT 到 → sessionsEpoch bump → sessions op 重发（列表重取被触发）", async () => {
    const h = mountedApp();
    await landBuddy(h);
    // 侧栏挂载完成（buddy 模式非折叠）——监听已注册（App 挂载即订）。
    expect(listeners.has(WUDAO_PET_SESSIONS_REFRESH_EVENT)).toBe(true);
    const sidebar = h.container.querySelector(".buddy .buddy-left");
    expect(sidebar).not.toBeNull();
    const before = sessionsOps(h);
    expect(before).toBeGreaterThan(0); // 侧栏挂载即取过（基线非零）
    await act(async () => {
      listeners.get(WUDAO_PET_SESSIONS_REFRESH_EVENT)!(null);
    });
    // 一次信号 = 两条既有重取车道各一发（ω99-255 的设计：sessionsEpoch 的
    // 消费者本就两族——侧栏列表（SessionSidebar 的 mount/change/epoch 读）
    // 与顶栏名车道（App 的 activeName/schedSessions/heroRows 同节拍读，deps
    // 同含 sessionsEpoch））。本弧零新 fetch 逻辑——bump 的是既有纪元。
    expect(sessionsOps(h)).toBe(before + 2);
  });

  it("信号幂等于次数：两次信号 → 两条车道各两次（不是一次布尔翻转）", async () => {
    const h = mountedApp();
    await landBuddy(h);
    const before = sessionsOps(h);
    await act(async () => {
      listeners.get(WUDAO_PET_SESSIONS_REFRESH_EVENT)!(null);
    });
    await act(async () => {
      listeners.get(WUDAO_PET_SESSIONS_REFRESH_EVENT)!(null);
    });
    expect(sessionsOps(h)).toBe(before + 4);
  });
});
