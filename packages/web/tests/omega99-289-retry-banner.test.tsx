// ω99-289 — 失败尾一键重试 web 面：多 driver 并发（09-17 用户令）横幅退役
// 后的契约钉（0.4.1 收口）。原面（live 错误卡/重启 errored 行 →「重试上次
// 失败的任务」横幅 → sessionContinue op）按用户令整体退役——任务在车道里
// 继续跑，切回来就是实时状态；真停了的会话用户发消息继续即可。App 死件
// （retryLiveFace/continueArm/fireContinue 族）已清，本钉件反转为退役契约：
//   ① live 面：history 末条 error 且 idle → 无重试横幅、op 从未上线；
//   ② busy 面：run 进行中 → 同样无横幅（与 ① 同退役，不再分语）；
//   ③ 重启面：行 errored:true / unfinished:true → 都不武装（无横幅无 op）；
//   ④ 旧 server：行无字段 → 同退役形（等价面，防回爬钉）。
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
function mountedApp(status: Record<string, unknown> = {}, history: readonly unknown[] = []): AppHarness {
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
    authOk(server.socket, status, history);
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

/** 应答所有挂起的 sessions op（activeName 合并读 + 弹框自己的读）。 */
async function replySessions(h: AppHarness, rows: readonly SessionRow[]): Promise<void> {
  await replyOps(h, "sessions", rows);
}

const retryButton = (h: AppHarness): HTMLButtonElement | null =>
  [...h.container.querySelectorAll("button")].find((b) => b.textContent?.includes("重试上次失败的任务")) ?? null;

const continueButton = (h: AppHarness): HTMLButtonElement | null =>
  [...h.container.querySelectorAll("button")].find((b) => b.textContent?.includes("继续跑上次没完成的任务")) ?? null;

const ERROR_TAIL_HISTORY = [
  { kind: "user", text: "把测试修绿" },
  { kind: "assistant", text: "跑到一半" },
  { kind: "error", text: "连接中断" },
];

describe("ω99-289 — 重试横幅退役契约（09-17 用户令；0.4.1 收口钉）", () => {
  const liveSession = { sessionId: "o289-live-0001" };

  it("① live 面：history 末条 error 且 idle → 无重试横幅，sessionContinue op 从未上线", async () => {
    const h = mountedApp(liveSession, ERROR_TAIL_HISTORY);
    await replySettings(h, "advanced");
    await replySessions(h, [row({ id: "o289-live-0001", firstUser: "失败的活" })]);
    expect(retryButton(h)).toBeNull();
    expect(opsOf(h, "sessionContinue")).toHaveLength(0);
  });

  it("② busy 面：run 进行中 → 无横幅（与 ① 同退役形）", async () => {
    const h = mountedApp(liveSession, ERROR_TAIL_HISTORY);
    await replySettings(h, "advanced");
    await replySessions(h, [row({ id: "o289-live-0001" })]);
    await act(async () => {
      h.server.socket.serverSend({
        t: "state",
        state: {
          live: { reasoning: "", answer: "", busyTools: [] },
          busy: true,
          queued: [],
          boardProgress: null,
          ctxTokens: null,
          mode: "workspace",
          cachePercent: null,
          bg: { active: 0, spawned: 0 },
          pendingPermission: null,
          planBoard: null,
          sessionId: "o289-live-0001",
          sidecar: null,
        },
      });
    });
    expect(retryButton(h)).toBeNull();
    expect(opsOf(h, "sessionContinue")).toHaveLength(0);
  });

  it("③ 重启面：行 errored:true / unfinished:true → 都不武装（无横幅无 op）", async () => {
    const erroredSession = { sessionId: "o289-err-0001" };
    const h = mountedApp(erroredSession);
    await replySettings(h, "advanced");
    await replySessions(h, [row({ id: "o289-err-0001", firstUser: "重启看到的失败", errored: true })]);
    expect(retryButton(h)).toBeNull();
    expect(continueButton(h)).toBeNull();
    expect(opsOf(h, "sessionContinue")).toHaveLength(0);
  });

  it("④ 旧 server：行无 errored/unfinished 字段 → 同退役形（等价面，防回爬）", async () => {
    const h = mountedApp(liveSession, ERROR_TAIL_HISTORY);
    await replySettings(h, "advanced");
    await replySessions(h, [row({ id: "o289-live-0001" })]);
    expect(retryButton(h)).toBeNull();
    expect(continueButton(h)).toBeNull();
    expect(opsOf(h, "sessionContinue")).toHaveLength(0);
  });
});
