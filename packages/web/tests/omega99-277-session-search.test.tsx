// ω99-277: #13 — 切换会话弹框的全文搜索（buddy 链）：查询框输入即发
// sessionSearch op（IME 组合期不发、组合完补发）；命中渲染（标题 + 问/答
// 徽标 + 时间 + 摘要 + 命中词高亮）；Enter 骑 resume（sessionId 断言）；
// stale 守卫（慢应答迟到丢弃）；空查询零 op 且原列表逐字节回归；Esc 照旧。
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

/** Reply to the LATEST sessionSearch op with hits. */
async function replySearch(h: AppHarness, hits: readonly SessionSearchHit[]): Promise<void> {
  await act(async () => {
    const op = opFrames(h).filter((o) => o.op.op === "sessionSearch").at(-1);
    h.server.socket.serverSend({ t: "result", id: op?.id, ok: hits });
  });
}

/** Type into a controlled input the way a real browser does. */
function type(el: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

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

/** The buddy lane to an OPEN picker over answered rows. */
async function openPicker(): Promise<AppHarness> {
  const h = mountedApp();
  await act(async () => {
    authOk(h.server.socket);
  });
  await replySettings(h, "buddy");
  await act(async () => {
    (h.container.querySelector(".sb-search") as HTMLElement).click();
  });
  await replySessions(h, [row({ id: "list-row-0001", name: "列表会话" })]);
  expect(h.container.querySelector(".search-pop")).not.toBeNull();
  return h;
}

describe("ω99-277 — SessionPicker 全文搜索", () => {
  it("typing rides the sessionSearch op verbatim; hits render title + 问/答 chip + snippet + highlighted mark", async () => {
    const h = await openPicker();
    const input = h.container.querySelector(".session-q") as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      type(input, "登录页面");
    });
    const op = opFrames(h).find((o) => o.op.op === "sessionSearch");
    expect(op?.op).toMatchObject({ op: "sessionSearch", q: "登录页面" });
    // 未回应答 → 搜索中…
    expect(h.container.querySelector(".search-empty")?.textContent).toContain("搜索中");
    await replySearch(h, [
      hit({ sessionId: "hit-sess-0001", name: "修复登录页", kind: "user", snippet: "…帮我修复登录页面的 Bug…" }),
      hit({ sessionId: "hit-sess-0001", kind: "assistant", snippet: "…已修复 Bug：问题出在 auth.ts 的空指针…" }),
    ]);
    const items = [...h.container.querySelectorAll(".search-item.session-item")] as HTMLElement[];
    expect(items).toHaveLength(2);
    // 标题（name 命中三级回退第一级）+ 摘要在场。
    expect(items[0]?.querySelector(".session-title")?.textContent).toBe("修复登录页");
    expect(items[0]?.querySelector(".session-preview")?.textContent).toContain("帮我修复登录页面");
    // 问/答徽标。
    expect(items[0]?.querySelector(".session-kind")?.textContent).toBe("问");
    expect(items[1]?.querySelector(".session-kind")?.textContent).toBe("答");
    // 命中词高亮 span（大小写不敏感原文保真）。
    expect(items[0]?.querySelector(".session-hit-mark")?.textContent?.toLowerCase()).toBe("登录页面");
    // 头行换查询态文案。
    expect(h.container.querySelector(".session-head")?.textContent).toContain("全文搜索");
  });

  it("Enter on a hit rides resume with the hit's sessionId; the picker closes", async () => {
    const h = await openPicker();
    const input = h.container.querySelector(".session-q") as HTMLInputElement;
    await act(async () => {
      type(input, "空指针");
    });
    await replySearch(h, [hit({ sessionId: "enter-target-01", kind: "assistant" })]);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    const op = opFrames(h).find((o) => o.op.op === "resume");
    expect(op?.op).toMatchObject({ id: "enter-target-01" });
    expect(h.container.querySelector(".search-pop")).toBeNull();
  });

  it("stale guard: a slow earlier reply is dropped; only the latest query renders", async () => {
    const h = await openPicker();
    const input = h.container.querySelector(".session-q") as HTMLInputElement;
    await act(async () => {
      type(input, "第一个");
    });
    const first = opFrames(h).filter((o) => o.op.op === "sessionSearch").at(-1);
    await act(async () => {
      type(input, "第二个");
    });
    // 第二个查询先回。
    await replySearch(h, [hit({ sessionId: "fresh-00000001" })]);
    expect(h.container.querySelector(".search-item.session-item")?.getAttribute("data-id")).toBe("fresh-00000001"); // 新应答已渲染
    // 第一个查询的慢应答迟到——丢弃（不覆盖新结果）。
    await act(async () => {
      h.server.socket.serverSend({ t: "result", id: first?.id, ok: [hit({ sessionId: "stale-00000001", snippet: "…陈旧应答绝不上屏…" })] });
    });
    expect(h.container.querySelector(".session-preview")?.textContent).not.toContain("陈旧应答绝不上屏");
    expect(h.container.querySelector(".search-item.session-item")?.getAttribute("data-id")).toBe("fresh-00000001");
  });

  it("IME composition period sends nothing; compositionend fires once", async () => {
    const h = await openPicker();
    const input = h.container.querySelector(".session-q") as HTMLInputElement;
    await act(async () => {
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    await act(async () => {
      type(input, "pinyin中间态");
    });
    expect(opFrames(h).filter((o) => o.op.op === "sessionSearch")).toHaveLength(0); // 组合期不发
    await act(async () => {
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    const ops = opFrames(h).filter((o) => o.op.op === "sessionSearch");
    expect(ops).toHaveLength(1); // 组合完一次补发
    expect(ops[0]?.op).toMatchObject({ q: "pinyin中间态" });
  });

  it("empty query: zero sessionSearch ops, the list/grouping/header stay byte-identical to today; Esc closes", async () => {
    const h = await openPicker();
    // 头行原文（回归钉）。
    expect(h.container.querySelector(".session-head")?.textContent).toBe("切换会话 — ↑↓ 选择 · Enter 恢复 · Esc 关闭");
    // 列表照旧（标题/时间/预览行的类名与数据源不变）。
    const item = h.container.querySelector(".search-item.session-item") as HTMLElement;
    expect(item?.getAttribute("data-id")).toBe("list-row-0001");
    expect(item?.querySelector(".session-title")?.textContent).toBe("列表会话");
    expect(h.container.querySelector(".session-q")).not.toBeNull(); // 查询框在场但未发 op
    expect(opFrames(h).filter((o) => o.op.op === "sessionSearch")).toHaveLength(0);
    // 清空查询也回到原列表（输入又删光）。
    const input = h.container.querySelector(".session-q") as HTMLInputElement;
    await act(async () => {
      type(input, "临时");
    });
    await replySearch(h, [hit({ sessionId: "temp-000000001" })]);
    await act(async () => {
      type(input, "");
    });
    expect(h.container.querySelector(".search-item.session-item")?.getAttribute("data-id")).toBe("list-row-0001");
    // Esc 关弹框照旧。
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(h.container.querySelector(".search-pop")).toBeNull();
  });

  it("an empty reply renders 没有找到相关内容; an error degrades to the same honest empty", async () => {
    const h = await openPicker();
    const input = h.container.querySelector(".session-q") as HTMLInputElement;
    await act(async () => {
      type(input, "不存在的词");
    });
    await replySearch(h, []);
    expect(h.container.querySelector(".search-empty")?.textContent).toContain("没有找到相关内容");
    await act(async () => {
      type(input, "出错词");
    });
    const op = opFrames(h).filter((o) => o.op.op === "sessionSearch").at(-1);
    await act(async () => {
      h.server.socket.serverSend({ t: "result", id: op?.id, err: "sessionSearch not supported by this driver" });
    });
    expect(h.container.querySelector(".search-empty")?.textContent).toContain("没有找到相关内容");
  });
});
