// ω99-286 — 断点续跑 web 面：多 driver 并发（09-17 用户令）横幅退役后的
// 契约钉。原面（聊天区「继续跑上次没完成的任务」横幅 + sessionContinue
// op 发射）按用户令「鸡肋且易误触，全部让用户自己决定」整体退役——任务
// 在车道里继续跑，切回来就是实时状态；真停了的会话用户发消息继续即可。
// 0.4.1 收口：App 死件（continueArm/fireContinue 族）已清，本钉件从「横幅
// 在场」反转为「退役契约」：
//   存活面 弹框行 unfinished:true → 「未完成」chip（读行字段自渲染，
//          与横幅无关——退役不改弹框信息面）；false/缺席无标（旧 server
//          行容忍）。
//   退役面 unfinished 行（当前会话）→ 聊天区无「继续跑」按钮、
//          sessionContinue op 从未上线（发射口已删，防回爬钉）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
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

interface AppHarness {
  container: HTMLElement;
  client: WudaoClient;
  server: FakeServer;
}
function mountedApp(status: Record<string, unknown> = {}): AppHarness {
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
  act(() => {
    authOk(server.socket, status);
  });
  return { container, client, server };
}

type OpFrame = { id: number; op: Record<string, unknown> };
const opFrames = (h: AppHarness): OpFrame[] =>
  h.server.clientFrames().filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f);
const opsOf = (h: AppHarness, name: string): OpFrame[] => opFrames(h).filter((o) => o.op.op === name);

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

async function replyOps(h: AppHarness, name: string, ok: unknown): Promise<void> {
  await act(async () => {
    for (const op of opsOf(h, name)) {
      h.server.socket.serverSend({ t: "result", id: op.id, ok });
    }
  });
}

const row = (over: Partial<SessionRow> & { id: string }): SessionRow => ({
  mtime: new Date(Date.now() - 5 * 60_000).toISOString(),
  messages: 3,
  firstUser: "",
  model: "deepseek-v4-flash",
  ...over,
});

const continueButton = (h: AppHarness): HTMLButtonElement | null =>
  [...h.container.querySelectorAll("button")].find((b) => b.textContent?.includes("继续跑上次没完成的任务")) ?? null;

/** 应答所有挂起的 sessions op（activeName 合并读 + 弹框自己的读）。 */
async function replySessions(h: AppHarness, rows: readonly SessionRow[]): Promise<void> {
  await replyOps(h, "sessions", rows);
}

describe("ω99-286 — 弹框行「未完成」小标（存活面）", () => {
  it("unfinished:true → title 梯前「未完成」chip；false/缺席（旧 server）无标", async () => {
    const h = mountedApp();
    await replySettings(h, "advanced");
    // 顶栏 📋 入口（advanced 壳的 .icobtn.sessions）。
    await act(async () => {
      (h.container.querySelector("button.icobtn.sessions") as HTMLElement).click();
    });
    await replySessions(h, [
      row({ id: "o286-unfin-01", firstUser: "昨晚没跑完的活", unfinished: true }),
      row({ id: "o286-settled", firstUser: "已经完成的活", unfinished: false }),
      row({ id: "o286-legacy", firstUser: "旧 server 的行（字段缺席）" }),
    ]);
    expect(h.container.querySelector(".search-pop")).not.toBeNull();
    const chips = [...h.container.querySelectorAll(".session-item .session-kind")].map((el) => el.textContent);
    expect(chips).toEqual(["未完成"]); // 恰一枚——false 与缺席都无标
    const badgeRow = h.container.querySelector('.session-item[data-id="o286-unfin-01"]');
    expect(badgeRow?.querySelector(".session-kind")?.textContent).toBe("未完成");
  });
});

describe("ω99-286 — 断点续跑横幅退役契约（09-17 用户令；0.4.1 收口钉）", () => {
  const liveSession = { sessionId: "o286-live-0001" };

  it("当前会话 unfinished → 无「继续跑」按钮，sessionContinue op 从未上线", async () => {
    const h = mountedApp(liveSession);
    await replySettings(h, "advanced");
    // boot 的 sessions 读（activeName 同一趟）应答当前行未完成——退役后
    // 不再武装任何横幅；op 零上线（发射口已删）。
    await replySessions(h, [row({ id: "o286-live-0001", firstUser: "没跑完", unfinished: true })]);
    expect(continueButton(h)).toBeNull();
    expect(opsOf(h, "sessionContinue")).toHaveLength(0);
  });

  it("旧 server：行无 unfinished 字段 → 同样无按钮、无 op（两面同退役）", async () => {
    const h = mountedApp(liveSession);
    await replySettings(h, "advanced");
    await replySessions(h, [row({ id: "o286-live-0001", firstUser: "旧 server 行" })]);
    expect(continueButton(h)).toBeNull();
    expect(opsOf(h, "sessionContinue")).toHaveLength(0);
  });
});
