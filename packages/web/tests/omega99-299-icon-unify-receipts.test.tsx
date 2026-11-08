// @vitest-environment jsdom
// ω99-299 — 图标统一收据（v5 弧5，M4）。家族线：chrome=SVG、content=文字。
// 交互控件上的 emoji 面孔退役——🗑（弹框删除钮）/✎（侧栏重命名钮）/▸▾
// （归档折叠 caret）三处换装 icons.tsx 家族（IconTrash 新增、IconPencil
// 新增、Chevron 对复用）。钉：按钮内是 svg 且无裸字形、可访问名仍在按钮
// 上（家族 aria-hidden 契约）、家族缩放律（0.9× 显式尺寸）在挂载点成立。
// ⚠️/▣/⏳/✓ 等文字流内字形不在此弧（它们随文色随字号，是内容不是 chrome）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WudaoClient } from "../src/protocol.js";
import type { SessionRow } from "../src/protocol.js";
import { App } from "../src/components/App.js";
import { SessionSidebar } from "../src/components/SessionSidebar.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";
import "../src/styles.css";

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
  window.localStorage.removeItem("wudao.archive.v1");
});

// ---- Part A harness（279 同形：buddy 车道开弹框）----
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

async function openPicker(): Promise<AppHarness> {
  const h = mountedApp();
  await act(async () => {
    const op = opFrames(h).find((o) => o.op.op === "settingsStatus");
    h.server.socket.serverSend({
      t: "result",
      id: op?.id,
      ok: { settings: { memoryEnabled: true, uiDefaultMode: "buddy" } },
    });
  });
  await act(async () => {
    (h.container.querySelector(".sb-search") as HTMLElement).click();
  });
  const row: SessionRow = {
    id: "list-row-0001",
    mtime: new Date(Date.now() - 5 * 60_000).toISOString(),
    messages: 2,
    firstUser: "",
    model: "deepseek-v4-flash",
    name: "图标收据行",
  };
  await act(async () => {
    const op = opFrames(h).filter((o) => o.op.op === "sessions").at(-1);
    h.server.socket.serverSend({ t: "result", id: op?.id, ok: [row] });
  });
  expect(h.container.querySelector(".search-pop")).not.toBeNull();
  return h;
}

// ---- Part B harness（297 同形：侧栏直挂）----
const sidebarClient = (rows: readonly SessionRow[]): { sessions: () => Promise<readonly SessionRow[]> } => ({
  sessions: () => Promise.resolve(rows),
});
const srow = (over: Partial<SessionRow> & { id: string }): SessionRow => ({
  mtime: new Date(Date.now() - 5 * 60_000).toISOString(),
  messages: 2,
  firstUser: "",
  model: "deepseek-v4-flash",
  ...over,
});
function mountSidebar(rows: readonly SessionRow[]): HTMLElement {
  return mount(
    <SessionSidebar
      client={sidebarClient(rows)}
      activeSessionId={null}
      onResume={vi.fn()}
      onNewChat={() => {}}
      onOpenSearch={() => {}}
      onRenameSession={vi.fn()}
    />,
  );
}

describe("ω99-299 图标统一收据", () => {
  it("M4 (🗑): 弹框删除钮持家族 svg——裸字形归零、可访问名仍在钮上", async () => {
    const h = await openPicker();
    const del = h.container.querySelector(".search-pop .session-item .session-del") as HTMLButtonElement;
    expect(del).not.toBeNull();
    expect(del.querySelector("svg")).not.toBeNull();
    expect(del.textContent).not.toContain("🗑");
    // 家族契约：glyph 装饰（aria-hidden），可访问名在按钮（aria-label 不动）。
    expect(del.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(del.getAttribute("aria-label")).toBe("删除这个会话");
  });

  it("M4 (✎): 侧栏重命名钮持 svg——无裸 ✎ 字形；家族缩放律 0.9×12=10.8 在场", async () => {
    const c = mountSidebar([srow({ id: "row-a-0001", name: "甲" })]);
    await act(async () => {});
    const rename = c.querySelector(".sb-i .sb-rename") as HTMLButtonElement;
    expect(rename).not.toBeNull();
    const svg = rename.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(rename.textContent).not.toContain("✎");
    expect(svg?.getAttribute("width")).toBe("10.8");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });

  it("M4 (▸▾): 归档折叠 caret 换 Chevron 对——无裸字形、展开态翻转方向", async () => {
    const c = mountSidebar([srow({ id: "row-a-0001", name: "甲" })]);
    await act(async () => {});
    // 归档一行 → 折叠组出现（214 车道：非活跃行 .sb-act）。
    await act(async () => {
      (c.querySelector(".sb-i .sb-act") as HTMLButtonElement).click();
    });
    const head = c.querySelector(".sb-arch-h") as HTMLButtonElement;
    expect(head).not.toBeNull();
    const caret = head.querySelector(".sb-arch-caret") as HTMLElement;
    expect(caret.querySelector("svg")).not.toBeNull();
    expect(head.textContent).not.toContain("▸");
    expect(head.textContent).not.toContain("▾");
    // 展开 → 方向翻转（chevron-down），折叠态回 chevron-right。
    await act(async () => {
      head.click();
    });
    expect(head.getAttribute("aria-expanded")).toBe("true");
    const openCaret = head.querySelector(".sb-arch-caret svg");
    expect(openCaret?.innerHTML).toContain("M6 9l6 6 6-6"); // IconChevronDown 的 path
    await act(async () => {
      head.click();
    });
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect((head.querySelector(".sb-arch-caret svg") as HTMLElement)?.innerHTML).toContain("M9 6l6 6-6 6");
  });
});
