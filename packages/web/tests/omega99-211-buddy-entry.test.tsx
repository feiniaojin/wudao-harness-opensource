// @vitest-environment jsdom
// ω99-211 receipts（web 半，canonical #R 头在 cli 侧
// packages/cli/tests/omega99-211-empty-session-receipts.test.ts）——Buddy 进门
// 欢迎态钉面（用户令 09-09）：进门时 boot 会话未物化（不出现在 sessions 行），
// 中栏=欢迎界面（EmptyHero 经共享 chatColumn），左侧零行激活。web 代码零改
// （§零 实证：欢迎面与「无自动选中」已在位——激活本是 boot id 物化行自匹配，
// cli 半修掉物化后激活自然消失）；此件钉住 UI 契约防回归。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WudaoClient } from "../src/protocol.js";
import type { SessionRow } from "../src/protocol.js";
import { App } from "../src/components/App.js";
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
  window.localStorage.removeItem("wudao.ui.v1");
});

const row = (over: Partial<SessionRow> & { id: string }): SessionRow => ({
  mtime: new Date(Date.now() - 5 * 60_000).toISOString(),
  messages: 2,
  firstUser: "既有会话首句",
  model: "deepseek-v4-flash",
  ...over,
});

interface AppHarness {
  container: HTMLElement;
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
  return { container, server };
}

type OpFrame = { id: number; op: Record<string, unknown> };
const opFrames = (h: AppHarness): OpFrame[] =>
  h.server.clientFrames().filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f);

async function replySettings(h: AppHarness, uiDefaultMode: "simple" | "buddy" | "advanced" | null): Promise<void> {
  await act(async () => {
    const op = opFrames(h).find((o) => o.op.op === "settingsStatus");
    h.server.socket.serverSend({
      t: "result",
      id: op?.id,
      ok: { settings: { memoryEnabled: true, uiDefaultMode } },
    });
  });
}

async function replySessions(h: AppHarness, rows: readonly SessionRow[]): Promise<void> {
  await act(async () => {
    const op = opFrames(h).filter((o) => o.op.op === "sessions").at(-1);
    h.server.socket.serverSend({ t: "result", id: op?.id, ok: rows });
  });
}

describe("ω99-211 — Buddy 进门欢迎态（零空会话的 web 契约）", () => {
  it("进门：boot 会话未物化（不在 sessions 行）→ 中栏欢迎界面在场、左侧零行激活", async () => {
    const h = mountedApp();
    // status.sessionId = boot id（未物化，不在 sessions 行里）；history 空。
    await act(async () => {
      authOk(h.server.socket, { sessionId: "wudao-boot-9999" }, []);
    });
    await replySettings(h, "buddy");
    await replySessions(h, [row({ id: "wudao-real-0001", name: "既有会话" })]);

    // 欢迎界面：buddy 右栏（共享 chatColumn）里的 EmptyHero。
    expect(h.container.querySelector(".buddy-main .hero")).not.toBeNull();
    expect(h.container.querySelector(".buddy-main .hero h1")?.textContent).toContain("你好呀，我是悟道Harness");
    // 左侧：既有会话照旧渲染，但零行激活（无「启动即选中」——boot id 无行可匹配）。
    const items = [...h.container.querySelectorAll(".sb-i")];
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain("既有会话");
    expect(h.container.querySelectorAll(".sb-i.on")).toHaveLength(0);
  });

  it("对照（钉非空断言）：活动会话在 sessions 行内 → 该行激活（.on 恰一）", async () => {
    const h = mountedApp();
    await act(async () => {
      authOk(h.server.socket, { sessionId: "wudao-real-0001" }, []);
    });
    await replySettings(h, "buddy");
    await replySessions(h, [row({ id: "wudao-real-0001", name: "既有会话" })]);
    expect(h.container.querySelectorAll(".sb-i.on")).toHaveLength(1);
    // 活动会话非空（history 有轮次）→ 欢迎界面让位。
    await act(async () => {
      h.server.socket.serverSend({ t: "history", entries: [{ kind: "user", text: "hi" }], reset: false });
    });
    expect(h.container.querySelector(".buddy-main .hero")).toBeNull();
  });
});
