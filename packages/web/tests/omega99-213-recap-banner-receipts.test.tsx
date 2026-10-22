// @vitest-environment jsdom
// ω99-213: #R — 回来摘要（auto-recap）web receipts。先红后绿：红=新模块缺位
// （module not found，如实分类）。全 App harness（照 finish-notify 式样）：
// 播种 per-session lastSeen 记录 → 挂载/可见 → recap op 发出 → 应答 →
// 横幅卡三段+数字行+关闭；降级卡；双阈不满足零调用零渲染；畸形载荷零渲染。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { WudaoClient } from "../src/protocol.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";
import { formatAwayDuration } from "../src/components/RecapBanner.js";

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

const setHidden = (hidden: boolean): void => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
};

interface Harness {
  container: HTMLElement;
  client: WudaoClient;
  server: FakeServer;
}

function mountedApp(): Harness {
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

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

type OpFrame = { id: number; op: { op: string; [k: string]: unknown } };
const opFrames = (h: Harness): OpFrame[] =>
  h.server
    .clientFrames()
    .filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f && "id" in f);
const recapOps = (h: Harness): OpFrame[] => opFrames(h).filter((f) => f.op.op === "recap");

/** Seed the per-session away record (the "left at mark M, at time T" state a
 * previous page session persisted before hiding). */
const seedAway = (sessionId: string, mark: number, at: number): void => {
  window.localStorage.setItem("wudao.recap.v1", JSON.stringify({ sessions: { [sessionId]: { mark, at } } }));
};

/** Four history entries: 3 conversational (user + 2 assistant) + 1 tool. */
const awayHistory = (): unknown[] => [
  { kind: "user", text: "夜间任务" },
  { kind: "assistant", text: "开工" },
  { kind: "tool", name: "read_file", summary: "ok" },
  { kind: "assistant", text: "结论" },
];

/** Mount + auth + drain the settings ops. The recap op (when the mount-check
 * fires it) is left PENDING for the test to script. */
async function connectedApp(history: readonly unknown[] = []): Promise<Harness> {
  const h = mountedApp();
  const answered = new Set<number>();
  await act(async () => {
    authOk(h.server.socket, {}, history);
  });
  await act(async () => {
    for (const f of opFrames(h)) {
      if (answered.has(f.id)) continue;
      answered.add(f.id);
      if (f.op.op === "settingsStatus") {
        h.server.socket.serverSend({
          t: "result",
          id: f.id,
          ok: {
            providers: [],
            credentials: { path: "/root/.wudao/credentials.json", keyCount: 0 },
            settings: {
              memoryEnabled: false,
              uiDefaultMode: null,
              wizardCompletedVersion: 1,
              uiTheme: null,
              uiAccent: null,
            },
            current: { provider: "deepseek", model: "deepseek-chat" },
            envKey: false,
            readiness: false,
            efforts: [],
          },
        });
      } else if (f.op.op !== "recap") {
        // The recap op stays PENDING — each test scripts its own reply.
        h.server.socket.serverSend({ t: "result", id: f.id, ok: [] });
      }
    }
  });
  return h;
}

const GOOD_NARRATIVE = "完成了：跑通全部测试\n还在进行：补文档\n等你决定：是否发版";

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  window.localStorage.removeItem("wudao.ui.v1");
  window.localStorage.removeItem("wudao.recap.v1"); // ω99-213: reset the away record between tests
  document.title = "";
  vi.useRealTimers();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  delete (window as { __TAURI__?: unknown }).__TAURI__;
  delete (document as { hasFocus?: () => boolean }).hasFocus;
});

describe("RecapBanner + wiring (ω99-213)", () => {
  it("away record qualifies → recap op carries sessionId/mark/sinceTs; the card renders three segments, the numbers line, and closes", async () => {
    const awayAt = Date.now() - 30 * 60_000;
    seedAway("wudao-test-0001", 0, awayAt);
    const h = await connectedApp(awayHistory());
    await until(() => recapOps(h).length === 1, "recap op");
    const op = recapOps(h)[0]!.op;
    expect(op.sessionId).toBe("wudao-test-0001");
    expect(op.sinceMark).toBe(0);
    expect(op.sinceTs).toBe(awayAt);
    await act(async () => {
      h.server.socket.serverSend({
        t: "result",
        id: recapOps(h)[0]!.id,
        ok: { stats: { turns: 2, toolCalls: 5, filesTouched: 3, sinceTs: awayAt }, narrative: GOOD_NARRATIVE },
      });
    });
    await until(() => h.container.textContent?.includes("你离开了 30 分钟") === true, "banner title");
    const text = h.container.textContent ?? "";
    expect(text).toContain("完成了：跑通全部测试");
    expect(text).toContain("还在进行：补文档");
    expect(text).toContain("等你决定：是否发版");
    expect(text).toContain("2 轮 · 5 次工具调用 · 3 个文件");
    const close = [...h.container.querySelectorAll("button")].find((b) => b.textContent === "知道了");
    expect(close).toBeDefined();
    act(() => {
      close!.click();
    });
    expect(h.container.textContent).not.toContain("你离开了 30 分钟");
  });

  it("narrative absent → degraded card (stats only, zero fabricated segments)", async () => {
    const awayAt = Date.now() - 30 * 60_000;
    seedAway("wudao-test-0001", 0, awayAt);
    const h = await connectedApp(awayHistory());
    await until(() => recapOps(h).length === 1, "recap op");
    await act(async () => {
      h.server.socket.serverSend({
        t: "result",
        id: recapOps(h)[0]!.id,
        ok: { stats: { turns: 2, toolCalls: 5, filesTouched: 3, sinceTs: awayAt } },
      });
    });
    await until(() => (h.container.textContent ?? "").includes("2 轮 · 5 次工具调用 · 3 个文件"), "degraded numbers");
    const text = h.container.textContent ?? "";
    expect(text).toContain("你离开了");
    expect(text).not.toContain("等你决定：");
  });

  it("op resolves undefined / malformed → zero render (fail-closed, no fabricated card)", async () => {
    seedAway("wudao-test-0001", 0, Date.now() - 30 * 60_000);
    const h = await connectedApp(awayHistory());
    await until(() => recapOps(h).length === 1, "recap op");
    await act(async () => {
      h.server.socket.serverSend({ t: "result", id: recapOps(h)[0]!.id, ok: undefined });
    });
    await wait(120);
    expect(h.container.textContent ?? "").not.toContain("你离开了");
  });

  it("below either threshold → ZERO recap op, zero render (10min / 3-message dual gate)", async () => {
    // away < 10 minutes.
    seedAway("wudao-test-0001", 0, Date.now() - 2 * 60_000);
    const h1 = await connectedApp(awayHistory());
    await wait(150);
    expect(recapOps(h1).length).toBe(0);
    expect(h1.container.textContent ?? "").not.toContain("你离开了");
    act(() => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = "";
    window.localStorage.removeItem("wudao.recap.v1");
    // away ≥ 10 minutes but only 1 new conversational message since the mark.
    seedAway("wudao-test-0001", 3, Date.now() - 30 * 60_000);
    const h2 = await connectedApp(awayHistory());
    await wait(150);
    expect(recapOps(h2).length).toBe(0);
    expect(h2.container.textContent ?? "").not.toContain("你离开了");
  });

  it("the same absence never burns a second call — returning again without new messages stays silent", async () => {
    const awayAt = Date.now() - 30 * 60_000;
    seedAway("wudao-test-0001", 0, awayAt);
    const h = await connectedApp(awayHistory());
    await until(() => recapOps(h).length === 1, "recap op");
    await act(async () => {
      h.server.socket.serverSend({
        t: "result",
        id: recapOps(h)[0]!.id,
        ok: { stats: { turns: 2, toolCalls: 5, filesTouched: 3, sinceTs: awayAt }, narrative: GOOD_NARRATIVE },
      });
    });
    await until(() => h.container.textContent?.includes("你离开了 30 分钟") === true, "banner");
    // A quick hide → return cycle (sub-threshold away) must not re-ask.
    act(() => {
      setHidden(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => {
      setHidden(false);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await wait(120);
    expect(recapOps(h).length).toBe(1);
  });
});

describe("formatAwayDuration (ω99-213 pure)", () => {
  it("minutes under the hour, floor hours beyond, days beyond 24h, null-safe", () => {
    const now = 1_700_000_000_000;
    expect(formatAwayDuration(now - 25 * 60_000, now)).toBe("25 分钟");
    expect(formatAwayDuration(now - 90 * 60_000, now)).toBe("1 小时");
    expect(formatAwayDuration(now - 26 * 60 * 60_000, now)).toBe("1 天");
    expect(formatAwayDuration(null, now)).toBeNull();
  });
});
