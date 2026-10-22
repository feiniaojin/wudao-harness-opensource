// @vitest-environment jsdom
// ω99-255: #7 — W1–W4 — 自动命名到达桌面侧栏（面二 receipts）。触发器即状态
// 面：protocol 增可选 sessionName 镜像（249 goal?/253 gitBranch? 先例形），
// App 一个 effect 盯 status?.sessionName 的跨帧变化 → bump 既有 sessionsEpoch
// ——侧栏走 ω99-150 的既有重读缝自然上脸，零新组件零新 fetch 逻辑零新 op。
// 老协议（无字段）undefined 恒静默；首帧只记录不 bump（boot/resume 的名字不
// 产生多余重读）；值不变不 bump。W3 手动 ✎ 车道照旧（无循环 bump——收敛钉）。
// W4 StatusBar/253 分支 chip 面零触碰直证。全 mock-ws 零真网络。
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { StatusBar } from "../src/components/StatusBar.js";
import { WudaoClient } from "../src/protocol.js";
import type { DriverStatus, SessionRow } from "../src/protocol.js";
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

type OpFrame = { id: number; op: { op: string; [k: string]: unknown } };
const opFrames = (h: Harness): OpFrame[] =>
  h.server
    .clientFrames()
    .filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f && "id" in f);

/** sessions op 的累计计数（侧栏重读 + ω99-156 activeName 同缝——两者都吃
 *  epoch，计数按 op 类型聚合，与具体哪一缝发出无关）。 */
const sessionsOpCount = (h: Harness): number => opFrames(h).filter((o) => o.op.op === "sessions").length;

/** 回答所有尚未回答的 sessions op（bump 会同时触发侧栏 + activeName 两缝的
 *  重读——逐 id 全答，不猜顺序）。 */
async function replyAllSessions(h: Harness, rows: readonly SessionRow[], answered: Set<number>): Promise<void> {
  await act(async () => {
    for (const op of opFrames(h).filter((o) => o.op.op === "sessions" && !answered.has(o.id))) {
      answered.add(op.id);
      h.server.socket.serverSend({ t: "result", id: op.id, ok: rows });
    }
  });
}

async function replySettings(h: Harness): Promise<void> {
  await act(async () => {
    const op = opFrames(h).find((o) => o.op.op === "settingsStatus");
    h.server.socket.serverSend({
      t: "result",
      id: op?.id,
      ok: { settings: { memoryEnabled: true, uiDefaultMode: "buddy" } },
    });
  });
}

/** 推一帧全量 state（authOk 同形；over 覆盖字段——本弧的关键字 sessionName）。 */
async function pushState(h: Harness, over: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    h.server.socket.serverSend({
      t: "state",
      state: {
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
        ...over,
      },
    });
  });
}

const row = (over: Partial<SessionRow> & { id: string }): SessionRow => ({
  mtime: new Date(Date.now() - 5 * 60_000).toISOString(),
  messages: 2,
  firstUser: "",
  model: "deepseek-chat",
  ...over,
});

/** 侧栏挂到行可见为止（authOk → buddy 壳 → sessions 播种）。 */
async function buddyApp(rows: readonly SessionRow[]): Promise<{ h: Harness; answered: Set<number> }> {
  const h = mountedApp();
  const answered = new Set<number>();
  await act(async () => {
    authOk(h.server.socket);
  });
  await replySettings(h);
  await replyAllSessions(h, rows, answered);
  await until(() => h.container.querySelector(".sb-list .sb-i") !== null, "sidebar rows");
  return { h, answered };
}

/** The active-list row (.sb-list 内) whose title cell reads `title`. */
const rowByTitle = (h: Harness, title: string): HTMLElement | undefined =>
  ([...h.container.querySelectorAll(".sb-list .sb-i")] as HTMLElement[])
    .find((r) => r.querySelector(".sb-t")?.textContent === title);

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  window.localStorage.removeItem("wudao.ui.v1");
  window.localStorage.removeItem("wudao.recap.v1");
  window.localStorage.removeItem("wudao.archive.v1");
  document.title = "";
});

describe("ω99-255 W1 — 推帧 sessionName null→X → sessionsEpoch bump → 侧栏行上脸", () => {
  it("自动命名落定（状态帧带名）→ 侧栏重读 → 「会话 3」变「修复登录超时」", async () => {
    const { h, answered } = await buddyApp([row({ id: "wudao-test-0001", name: "会话 3" })]);
    expect(rowByTitle(h, "会话 3")).toBeDefined();
    const fetchesBefore = sessionsOpCount(h);
    // 首帧不带名（armed 只记录）：安静。
    await pushState(h);
    await wait(80);
    expect(sessionsOpCount(h)).toBe(fetchesBefore);
    // 标题落定帧：null→「修复登录超时」→ bump → 重读 → store 侧已是新名。
    await pushState(h, { sessionName: "修复登录超时" });
    await until(() => sessionsOpCount(h) > fetchesBefore, "epoch bump refetch");
    await replyAllSessions(h, [row({ id: "wudao-test-0001", name: "修复登录超时" })], answered);
    await until(() => rowByTitle(h, "修复登录超时") !== undefined, "sidebar shows the titled row");
    expect(rowByTitle(h, "会话 3")).toBeUndefined(); // 派生名行消失——同一事实一处真相
    act(() => {
      h.client.close();
    });
  });
});

describe("ω99-255 W2 — 零多余重读（老 server 缺场 / 值不变）", () => {
  it("老 server（无字段）：多帧推送零 bump 零多余重读", async () => {
    const { h } = await buddyApp([row({ id: "wudao-test-0001", name: "会话 3" })]);
    const fetchesBefore = sessionsOpCount(h);
    await pushState(h);
    await pushState(h, { busy: true });
    await pushState(h);
    await wait(120);
    expect(sessionsOpCount(h)).toBe(fetchesBefore); // undefined 恒静默
    act(() => {
      h.client.close();
    });
  });

  it("值不变：同名的重复帧只 bump 一次（null→X 一 bump；X→X 静默）", async () => {
    const { h, answered } = await buddyApp([row({ id: "wudao-test-0001", name: "会话 3" })]);
    const fetchesBefore = sessionsOpCount(h);
    await pushState(h, { sessionName: "X 标题" });
    await until(() => sessionsOpCount(h) > fetchesBefore, "first change bumps once");
    const afterFirst = sessionsOpCount(h);
    await pushState(h, { sessionName: "X 标题" });
    await pushState(h, { sessionName: "X 标题", busy: true });
    await wait(120);
    expect(sessionsOpCount(h)).toBe(afterFirst); // 值不变零 bump
    await replyAllSessions(h, [row({ id: "wudao-test-0001", name: "X 标题" })], answered);
    act(() => {
      h.client.close();
    });
  });
});

describe("ω99-255 W3 — 手动 ✎ 车道照旧（既有 bump 不受 effect 干扰，无循环）", () => {
  it("✎ 改名：submit 落定 bump + 驱动状态帧 bump 双双收敛，终态稳定无循环", async () => {
    const { h, answered } = await buddyApp([row({ id: "wudao-test-0001", name: "会话 3" })]);
    expect(rowByTitle(h, "会话 3")).toBeDefined();
    // ✎ 进入行内编辑（当前会话行——150 的守卫要求 id === status.sessionId）。
    await act(async () => {
      (rowByTitle(h, "会话 3")?.querySelector(".sb-rename") as HTMLElement).click();
    });
    const input = h.container.querySelector("input.sb-rename-in") as HTMLInputElement;
    expect(input).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, "手改的名");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    // 既有车道：App 发 /rename op → server 应答 → submit.then bump。
    await until(() => opFrames(h).some((o) => o.op.op === "submit"), "/rename submit op");
    const fetchesBefore = sessionsOpCount(h);
    const submitOp = opFrames(h).filter((o) => o.op.op === "submit").at(-1);
    await act(async () => {
      h.server.socket.serverSend({ t: "result", id: submitOp?.id, ok: "notice" });
    });
    await until(() => sessionsOpCount(h) > fetchesBefore, "manual-lane epoch bump");
    // 新车道：driver 落定后的状态帧同带名 → effect 再 bump 一次 → 收敛（非循环）。
    const afterManual = sessionsOpCount(h);
    await pushState(h, { sessionName: "手改的名" });
    await until(() => sessionsOpCount(h) > afterManual, "status-face bump");
    const settled = sessionsOpCount(h);
    await replyAllSessions(h, [row({ id: "wudao-test-0001", name: "手改的名" })], answered);
    await until(() => rowByTitle(h, "手改的名") !== undefined, "sidebar converges to the manual name");
    // 无循环：终态后静默窗内计数稳定。
    await wait(150);
    expect(sessionsOpCount(h)).toBe(settled);
    expect(rowByTitle(h, "会话 3")).toBeUndefined();
    act(() => {
      h.client.close();
    });
  });
});

describe("ω99-255 W4 — StatusBar 零触碰直证（253 分支 chip 面零演进）", () => {
  it("状态带 sessionName 与否，分支 chip 渲染逐字相同——状态条不消费本字段", () => {
    const base = {
      live: { reasoning: "", answer: "", busyTools: [] },
      busy: false,
      queued: [],
      boardProgress: null,
      ctxTokens: null,
      mode: "workspace" as const,
      cachePercent: null,
      bg: { active: 0, spawned: 0 },
      pendingPermission: null,
      planBoard: null,
      sessionId: "wudao-test-0001",
      sidecar: null,
      model: null,
      gitBranch: "omega99-255",
    };
    const without = mount(<StatusBar status={base as DriverStatus} />);
    const chipA = without.querySelector(".statusline .seg-branch") as HTMLElement;
    expect(chipA).not.toBeNull();
    expect(chipA.textContent).toBe("omega99-255");
    const withName = mount(<StatusBar status={{ ...base, sessionName: "某个会话名" } as DriverStatus} />);
    const chipB = withName.querySelector(".statusline .seg-branch") as HTMLElement;
    expect(chipB?.textContent).toBe("omega99-255"); // 同一枚、同文案——零演进
    expect(withName.querySelector(".statusline")?.textContent).toBe(without.querySelector(".statusline")?.textContent);
  });
});
