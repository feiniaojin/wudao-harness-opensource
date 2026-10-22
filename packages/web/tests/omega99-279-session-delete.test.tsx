// ω99-279: #15 — 切换会话弹框的回收站式删除（buddy 链）：列表行/搜索命中行
// 悬停删除钮 → 行内确认（删除这个会话？+ 删除/取消）→ sessionDelete op →
// 应答后 sessions 纪元重发 + 行消失 / 搜索态当前查询重跑；取消/Esc 复原
// （Esc 分层：确认态先 consumed 不关弹框）；activeId 行无删除钮；Del 键进
// 确认 + Enter 确认；回归钉：不交互零 sessionDelete op。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WudaoClient } from "../src/protocol.js";
import type { SessionRow, SessionSearchHit } from "../src/protocol.js";
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

/** ω99-279: 纪元 bump 触发的不止一个 sessions 读（弹框行集 + activeName
 * 重读各一发）——对 given 之后出现的每一个 sessions op 都应答，行集车道
 * 必然吃到。 */
async function replySessionsAfter(h: AppHarness, answered: number, rows: readonly SessionRow[]): Promise<number> {
  const ops = opFrames(h).filter((o) => o.op.op === "sessions");
  await act(async () => {
    for (const op of ops.slice(answered)) {
      h.server.socket.serverSend({ t: "result", id: op.id, ok: rows });
    }
  });
  return ops.length;
}

async function replySearch(h: AppHarness, hits: readonly SessionSearchHit[]): Promise<void> {
  await act(async () => {
    const op = opFrames(h).filter((o) => o.op.op === "sessionSearch").at(-1);
    h.server.socket.serverSend({ t: "result", id: op?.id, ok: hits });
  });
}

async function replyDelete(h: AppHarness, ok: unknown): Promise<void> {
  await act(async () => {
    const op = opFrames(h).filter((o) => o.op.op === "sessionDelete").at(-1);
    h.server.socket.serverSend({ t: "result", id: op?.id, ok });
  });
}

function type(el: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const key = (el: Element, k: string): void => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
};

const row = (over: Partial<SessionRow> & { id: string }): SessionRow => ({
  mtime: new Date(Date.now() - 5 * 60_000).toISOString(),
  messages: 2,
  firstUser: "",
  model: "deepseek-v4-flash",
  ...over,
});

const hit = (over: Partial<SessionSearchHit> & { sessionId: string }): SessionSearchHit => ({
  name: "",
  firstUser: "帮我修复登录页面的 Bug",
  mtime: new Date(Date.now() - 5 * 60_000).toISOString(),
  kind: "user",
  snippet: "…已修复 Bug：问题出在 auth.ts 的空指针…",
  ...over,
});

/** The buddy lane to an OPEN picker over answered rows (277 openPicker 同形). */
async function openPicker(status: Record<string, unknown> = {}): Promise<AppHarness> {
  const h = mountedApp(status);
  await replySettings(h, "buddy");
  await act(async () => {
    (h.container.querySelector(".sb-search") as HTMLElement).click();
  });
  await replySessions(h, [
    row({ id: "list-row-0001", name: "要删的会话" }),
    row({ id: "list-row-0002", name: "留下的会话" }),
  ]);
  expect(h.container.querySelector(".search-pop")).not.toBeNull();
  return h;
}

const item = (h: AppHarness, id: string): HTMLElement =>
  [...h.container.querySelectorAll(".search-item.session-item")].find(
    (el) => el.getAttribute("data-id") === id,
  ) as HTMLElement;

describe("ω99-279 — SessionPicker 回收站式删除（列表态）", () => {
  it("🗑 → 行内确认（删除这个会话？/删除/取消）→ 删除 → sessionDelete op → 应答 → sessions 重发 + 行消失", async () => {
    const h = await openPicker();
    // 回归钉：没交互前零 sessionDelete。
    expect(opFrames(h).filter((o) => o.op.op === "sessionDelete")).toHaveLength(0);
    // 删除钮在场（jsdom 用 class 断言；真机 hover 显形）。
    const del = item(h, "list-row-0001")?.querySelector(".session-del") as HTMLButtonElement;
    expect(del).not.toBeNull();
    await act(async () => {
      del.click();
    });
    // 行 morph 成确认行：文案 + 两钮。
    const confirmRow = h.container.querySelector(".session-item.session-confirm") as HTMLElement;
    expect(confirmRow?.textContent).toContain("删除这个会话？");
    expect(confirmRow?.querySelector(".session-del-ok")?.textContent).toBe("删除");
    expect(confirmRow?.querySelector(".session-del-cancel")?.textContent).toBe("取消");
    // 同一时刻至多一行确认。
    expect(h.container.querySelectorAll(".session-item.session-confirm")).toHaveLength(1);
    await act(async () => {
      (confirmRow.querySelector(".session-del-ok") as HTMLElement).click();
    });
    const op = opFrames(h).find((o) => o.op.op === "sessionDelete");
    expect(op?.op).toMatchObject({ op: "sessionDelete", id: "list-row-0001" });
    const answered = opFrames(h).filter((o) => o.op.op === "sessions").length; // openPicker 的那一发
    // 应答 deleted:true → sessions op 重发（纪元）。
    await replyDelete(h, { deleted: true });
    const sessionsOps = opFrames(h).filter((o) => o.op.op === "sessions");
    expect(sessionsOps.length).toBeGreaterThan(answered);
    await replySessionsAfter(h, answered, [row({ id: "list-row-0002", name: "留下的会话" })]);
    expect(item(h, "list-row-0001")).toBeUndefined();
    expect(item(h, "list-row-0002")).not.toBeUndefined();
  });

  it("取消复原：零 op、行回原形；点他行删除钮切换确认行（仍至多一行）", async () => {
    const h = await openPicker();
    await act(async () => {
      (item(h, "list-row-0001")?.querySelector(".session-del") as HTMLElement).click();
    });
    await act(async () => {
      (h.container.querySelector(".session-del-cancel") as HTMLElement).click();
    });
    expect(opFrames(h).filter((o) => o.op.op === "sessionDelete")).toHaveLength(0);
    expect(h.container.querySelector(".session-confirm")).toBeNull();
    expect(item(h, "list-row-0001")?.querySelector(".session-title")?.textContent).toBe("要删的会话");
    // 点另一行的删除钮 → 确认行切到那行。
    await act(async () => {
      (item(h, "list-row-0002")?.querySelector(".session-del") as HTMLElement).click();
    });
    const confirmRow = h.container.querySelector(".session-confirm") as HTMLElement;
    expect(confirmRow?.getAttribute("data-id")).toBe("list-row-0002");
  });

  it("失败应答诚实分叉：active 拒 → 不重发 sessions、行还在", async () => {
    const h = await openPicker();
    await act(async () => {
      (item(h, "list-row-0001")?.querySelector(".session-del") as HTMLElement).click();
    });
    await act(async () => {
      (h.container.querySelector(".session-del-ok") as HTMLElement).click();
    });
    const before = opFrames(h).filter((o) => o.op.op === "sessions").length;
    await replyDelete(h, { deleted: false, reason: "active" });
    expect(opFrames(h).filter((o) => o.op.op === "sessions")).toHaveLength(before); // 无重发
    expect(item(h, "list-row-0001")).not.toBeUndefined(); // 行还在
  });

  it("activeId 行（当前打开的会话）不渲染删除钮", async () => {
    const h = await openPicker({ sessionId: "list-row-0001" });
    expect(item(h, "list-row-0001")?.querySelector(".session-del")).toBeNull();
    expect(item(h, "list-row-0002")?.querySelector(".session-del")).not.toBeNull();
  });
});

describe("ω99-279 — SessionPicker 回收站式删除（搜索态 + 键盘）", () => {
  it("搜索命中行删除 → 应答后当前查询重跑（同 q 的第二个 sessionSearch op）", async () => {
    const h = await openPicker();
    const input = h.container.querySelector(".session-q") as HTMLInputElement;
    await act(async () => {
      type(input, "登录页面");
    });
    await replySearch(h, [
      hit({ sessionId: "hit-del-00001" }),
      hit({ sessionId: "hit-stay-0001", kind: "assistant" }),
    ]);
    await act(async () => {
      (item(h, "hit-del-00001")?.querySelector(".session-del") as HTMLElement).click();
    });
    await act(async () => {
      (h.container.querySelector(".session-del-ok") as HTMLElement).click();
    });
    expect(opFrames(h).find((o) => o.op.op === "sessionDelete")?.op).toMatchObject({ id: "hit-del-00001" });
    await replyDelete(h, { deleted: true });
    // 当前查询重跑：第二个 sessionSearch op 且 q 同字。
    const searches = opFrames(h).filter((o) => o.op.op === "sessionSearch");
    expect(searches.length).toBeGreaterThanOrEqual(2);
    expect(searches.at(-1)?.op).toMatchObject({ q: "登录页面" });
    await replySearch(h, [hit({ sessionId: "hit-stay-0001", kind: "assistant" })]);
    expect(item(h, "hit-del-00001")).toBeUndefined();
    expect(item(h, "hit-stay-0001")).not.toBeUndefined();
  });

  it("搜索命中 activeId 的行同样无删除钮", async () => {
    const h = await openPicker({ sessionId: "hit-live-00001" });
    const input = h.container.querySelector(".session-q") as HTMLInputElement;
    await act(async () => {
      type(input, "登录页面");
    });
    await replySearch(h, [hit({ sessionId: "hit-live-00001" }), hit({ sessionId: "hit-idle-00001" })]);
    expect(item(h, "hit-live-00001")?.querySelector(".session-del")).toBeNull();
    expect(item(h, "hit-idle-00001")?.querySelector(".session-del")).not.toBeNull();
  });

  it("Del 进确认态；Enter 确认（不是 resume）；Esc 先 consumed 不关弹框，第二次才关", async () => {
    const h = await openPicker();
    const pop = h.container.querySelector(".search-pop") as HTMLElement;
    // Del：选中行（首行）进确认态。
    await act(async () => {
      key(pop, "Delete");
    });
    const confirmRow = h.container.querySelector(".session-confirm") as HTMLElement;
    expect(confirmRow?.getAttribute("data-id")).toBe("list-row-0001");
    // Esc：先 consumed——确认行复原，弹框不关。
    await act(async () => {
      key(pop, "Escape");
    });
    expect(h.container.querySelector(".search-pop")).not.toBeNull();
    expect(h.container.querySelector(".session-confirm")).toBeNull();
    // 再 Del + Enter：Enter = 确认删除（发 sessionDelete，不发 resume）。
    await act(async () => {
      key(pop, "Delete");
    });
    await act(async () => {
      key(pop, "Enter");
    });
    expect(opFrames(h).find((o) => o.op.op === "sessionDelete")?.op).toMatchObject({ id: "list-row-0001" });
    expect(opFrames(h).filter((o) => o.op.op === "resume")).toHaveLength(0);
    const answered2 = opFrames(h).filter((o) => o.op.op === "sessions").length;
    await replyDelete(h, { deleted: true });
    await replySessionsAfter(h, answered2, [row({ id: "list-row-0002", name: "留下的会话" })]);
    // 非确认态的 Esc 照旧关弹框（277 回归）。
    await act(async () => {
      key(h.container.querySelector(".search-pop") as HTMLElement, "Escape");
    });
    expect(h.container.querySelector(".search-pop")).toBeNull();
  });
});
