// ω99-284: #2 — 回收站键盘导航（283 延后项收口：弹框键盘契约三面一致）：
// ↑↓ 行走（clamp 无环绕，同主列表范式）· Enter 恢复（sessionRestore op，
// 与恢复钮同一调用形）· Esc 返回列表；aria-activedescendant 三态化跟随
// trashSel（= 选中行 id 锚）；空回收站 ↑↓/Enter no-op；指针车道（恢复钮
// 直点，不经键盘）283 语义零回归；再进回收站 trashSel 复位 0。
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
  messages: 2,
  firstUser: "",
  model: "deepseek-v4-flash",
  ...over,
});

/** The buddy lane to an OPEN picker（283 openPicker 同形；sessions+trash 都应答）。 */
async function openPicker(
  status: Record<string, unknown> = {},
  trashRows: readonly SessionRow[],
): Promise<AppHarness> {
  const h = mountedApp(status);
  await replySettings(h, "buddy");
  await act(async () => {
    (h.container.querySelector(".sb-search") as HTMLElement).click();
  });
  await replyOps(h, "sessions", [
    row({ id: "list-row-0001", name: "留下的会话" }),
  ]);
  await replyOps(h, "sessionTrashList", trashRows);
  expect(h.container.querySelector(".search-pop")).not.toBeNull();
  return h;
}

const noticeText = (h: AppHarness): string =>
  [...h.container.querySelectorAll(".notice-bub")].map((el) => el.textContent ?? "").join("\n");

const key = (el: Element, k: string): void => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
};

const pop = (h: AppHarness): HTMLElement => h.container.querySelector(".search-pop") as HTMLElement;

/** 点「回收站 (N)」入口进回收站视图（283 指针车道）。 */
async function enterTrash(h: AppHarness): Promise<void> {
  await act(async () => {
    (h.container.querySelector(".session-trash-link") as HTMLElement).click();
  });
  expect(h.container.querySelector(".session-restore")).not.toBeNull(); // 已在回收站视图
}

/** 回收站第 i 行（trashRows 渲染保序，data-id 寻址稳定）。 */
const trashRow = (h: AppHarness, id: string): HTMLElement =>
  h.container.querySelector(`.search-results [role='option'][data-id='${id}']`) as HTMLElement;

describe("ω99-284 — 回收站键盘导航", () => {
  it("↑↓ 行走：进面首行 sel/aria-selected → ↓ 第二行 → 底部 clamp → ↑ 回首行", async () => {
    const h = await openPicker({}, [
      row({ id: "trash-00000001", firstUser: "删错的第一条" }),
      row({ id: "trash-00000002", firstUser: "删错的第二条" }),
    ]);
    await enterTrash(h);
    const r0 = trashRow(h, "trash-00000001");
    const r1 = trashRow(h, "trash-00000002");
    // 进面即首行选中（同主列表进面范式）。
    expect(r0.classList.contains("sel")).toBe(true);
    expect(r0.getAttribute("aria-selected")).toBe("true");
    expect(r1.classList.contains("sel")).toBe(false);
    expect(r1.getAttribute("aria-selected")).toBe("false");
    // ↓ → 第二行。
    await act(async () => { key(pop(h), "ArrowDown"); });
    expect(r1.classList.contains("sel")).toBe(true);
    expect(r1.getAttribute("aria-selected")).toBe("true");
    expect(r0.classList.contains("sel")).toBe(false);
    // ↓ 已在底 → clamp 仍在第二行（无环绕）。
    await act(async () => { key(pop(h), "ArrowDown"); });
    expect(r1.classList.contains("sel")).toBe(true);
    // ↑ → 回首行。
    await act(async () => { key(pop(h), "ArrowUp"); });
    expect(r0.classList.contains("sel")).toBe(true);
  });

  it("Enter 恢复：行走至第二行 → Enter → sessionRestore(id=第二行) → 成功回执 → toast + 视图回主列表", async () => {
    const h = await openPicker({}, [
      row({ id: "trash-00000001", firstUser: "删错的第一条" }),
      row({ id: "trash-00000002", firstUser: "删错的第二条" }),
    ]);
    await enterTrash(h);
    await act(async () => { key(pop(h), "ArrowDown"); }); // 行走至第二行
    await act(async () => { key(pop(h), "Enter"); });
    // op 上线，id verbatim（与恢复钮同一调用形）。
    expect(opsOf(h, "sessionRestore").at(-1)?.op).toMatchObject({ op: "sessionRestore", id: "trash-00000002" });
    // 成功回执。
    await replyOps(h, "sessionRestore", { restored: true });
    expect(noticeText(h)).toContain("已恢复");
    // 视图回主列表：恢复钮没了。入口在 trash 重取中先隐（trashRows 置
    // null——283 打开时快照语义），应答双重取后回来（283 件同款收尾）。
    expect(h.container.querySelector(".session-restore")).toBeNull();
    await replyOps(h, "sessions", [
      row({ id: "list-row-0001", name: "留下的会话" }),
      row({ id: "trash-00000002", firstUser: "删错的第二条" }), // 恢复后回到列表
    ]);
    await replyOps(h, "sessionTrashList", []);
    expect(h.container.querySelector(".session-trash-link")).not.toBeNull();
  });

  it("aria-activedescendant 跟随：listbox 的锚 = 当前选中行的 id（${listId}-opt-${sel} 形）", async () => {
    const h = await openPicker({}, [
      row({ id: "trash-00000001", firstUser: "删错的第一条" }),
      row({ id: "trash-00000002", firstUser: "删错的第二条" }),
    ]);
    await enterTrash(h);
    const listbox = h.container.querySelector("[role='listbox']") as HTMLElement;
    const r0 = trashRow(h, "trash-00000001");
    const r1 = trashRow(h, "trash-00000002");
    // 行带 id 锚（-opt-i 形），listbox 指向选中行。
    expect(r0.id).toMatch(/-opt-0$/);
    expect(r1.id).toMatch(/-opt-1$/);
    expect(listbox.getAttribute("aria-activedescendant")).toBe(r0.id);
    await act(async () => { key(pop(h), "ArrowDown"); });
    expect(listbox.getAttribute("aria-activedescendant")).toBe(r1.id);
  });

  it("Esc 仍返回列表（283 语义零回归）；再进回收站 trashSel 复位 0（首行 sel）", async () => {
    const h = await openPicker({}, [
      row({ id: "trash-00000001", firstUser: "删错的第一条" }),
      row({ id: "trash-00000002", firstUser: "删错的第二条" }),
    ]);
    await enterTrash(h);
    await act(async () => { key(pop(h), "ArrowDown"); }); // 走到第二行
    await act(async () => { key(pop(h), "Escape"); });
    expect(h.container.querySelector(".search-pop")).not.toBeNull(); // 弹框在
    expect(h.container.querySelector(".session-restore")).toBeNull(); // 回主列表视图
    expect(h.container.querySelector(".session-trash-link")).not.toBeNull();
    // 再进回收站 → 光标复位顶行。
    await enterTrash(h);
    expect(trashRow(h, "trash-00000001").classList.contains("sel")).toBe(true);
    expect(trashRow(h, "trash-00000002").classList.contains("sel")).toBe(false);
  });

  it("空回收站 no-op：↓/↑/Enter 均不抛、视图不变、无 op 发出", async () => {
    const h = await openPicker({}, []);
    await act(async () => {
      (h.container.querySelector(".session-trash-link") as HTMLElement).click();
    });
    expect(h.container.querySelector(".search-empty")?.textContent).toContain("回收站是空的");
    const opsBefore = opFrames(h).length;
    await act(async () => { key(pop(h), "ArrowDown"); });
    await act(async () => { key(pop(h), "ArrowUp"); });
    await act(async () => { key(pop(h), "Enter"); });
    expect(h.container.querySelector(".search-empty")?.textContent).toContain("回收站是空的"); // 视图不变
    expect(h.container.querySelector(".session-trash-link")).toBeNull(); // 仍在回收站视图
    expect(opFrames(h).length).toBe(opsBefore); // 无任何新 op
    expect(opsOf(h, "sessionRestore")).toHaveLength(0);
  });

  it("指针车道不回归：直点「恢复」钮（不经键盘）→ 恢复照常（283 语义）", async () => {
    const h = await openPicker({}, [row({ id: "trash-00000001", firstUser: "删错的会话" })]);
    await enterTrash(h);
    await act(async () => {
      (h.container.querySelector(".session-restore") as HTMLElement).click();
    });
    expect(opsOf(h, "sessionRestore").at(-1)?.op).toMatchObject({ op: "sessionRestore", id: "trash-00000001" });
    await replyOps(h, "sessionRestore", { restored: true });
    expect(noticeText(h)).toContain("已恢复");
    expect(h.container.querySelector(".session-restore")).toBeNull(); // 视图回主列表
  });
});
