// ω99-283: #6 — 切换会话弹框的回收站面（buddy 链）：列表底部「回收站 (N)」
// 入口（N 来自打开时 sessionTrashList）→ 回收站视图（行复用会话行形态）→
// 点「恢复」→ sessionRestore op（id 正确）→ 成功回执：toast「已恢复」+
// sessions 与 sessionTrashList 双重取 + 视图回主列表；target-exists 拒 →
// 人话 toast 且留在回收站视图；Esc 在回收站视图=返回列表（不关弹框）；
// 回归钉：旧 server 不应答 sessionTrashList → 入口隐藏（车道缺席）。
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

/** The buddy lane to an OPEN picker（279 openPicker 同形；sessions+trash 都应答）。 */
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

describe("ω99-283 — SessionPicker 回收站入口与恢复", () => {
  it("打开弹框发 sessionTrashList；回执 N=1 → 列表底部「回收站 (1)」入口；未应答入口隐藏（车道缺席回归钉）", async () => {
    const h = await openPicker({}, [row({ id: "trash-00000001", firstUser: "删错的会话" })]);
    // 打开即发（App 挂载/打开时取数）。
    expect(opsOf(h, "sessionTrashList").length).toBeGreaterThanOrEqual(1);
    const entry = h.container.querySelector(".session-trash-link") as HTMLElement;
    expect(entry).not.toBeNull();
    expect(entry.textContent).toContain("回收站 (1)");
  });

  it("无 sessionTrashList 应答（旧 server）→ 入口隐藏；弹框照常用", async () => {
    const h = await openPicker({}, []);
    // 重新打开一次并只应答 sessions——trash 不应答（车道缺席）。
    await act(async () => {
      key(h.container.querySelector(".search-pop") as HTMLElement, "Escape");
    });
    expect(h.container.querySelector(".search-pop")).toBeNull();
    await act(async () => {
      (h.container.querySelector(".sb-search") as HTMLElement).click();
    });
    await replyOps(h, "sessions", [row({ id: "list-row-0001" })]);
    expect(opsOf(h, "sessionTrashList").length).toBeGreaterThanOrEqual(2); // 重开又发了一发
    expect(h.container.querySelector(".session-trash-link")).toBeNull(); // 未应答 → 入口隐藏
  });

  it("进回收站视图：行复用会话行形态（firstUser 摘要）+ 每行「恢复」钮；Esc=返回列表不关弹框", async () => {
    const h = await openPicker({}, [row({ id: "trash-00000001", firstUser: "删错的会话（首问摘要）" })]);
    await act(async () => {
      (h.container.querySelector(".session-trash-link") as HTMLElement).click();
    });
    const restoreBtn = h.container.querySelector(".session-restore") as HTMLButtonElement;
    expect(restoreBtn).not.toBeNull();
    expect(restoreBtn.textContent).toContain("恢复");
    // 行形态复用：title 梯（name 缺席 → firstUser）+ 相对时间。
    const item = h.container.querySelector(".search-item.session-item[data-id='trash-00000001']") as HTMLElement;
    expect(item?.querySelector(".session-title")?.textContent).toContain("删错的会话");
    expect(item?.querySelector(".session-time")?.textContent).toContain("分钟前");
    // Esc：回主列表（弹框不关）。
    await act(async () => {
      key(h.container.querySelector(".search-pop") as HTMLElement, "Escape");
    });
    expect(h.container.querySelector(".search-pop")).not.toBeNull();
    expect(h.container.querySelector(".session-restore")).toBeNull();
    expect(h.container.querySelector(".session-trash-link")).not.toBeNull(); // 回到列表视图
  });

  it("点恢复 → sessionRestore op（id 正确）→ 成功回执：toast + sessions/trash 双重取 + 视图回主列表", async () => {
    const h = await openPicker({}, [row({ id: "trash-00000001", firstUser: "删错的会话" })]);
    await act(async () => {
      (h.container.querySelector(".session-trash-link") as HTMLElement).click();
    });
    const sessionsBefore = opsOf(h, "sessions").length;
    const trashBefore = opsOf(h, "sessionTrashList").length;
    await act(async () => {
      (h.container.querySelector(".session-restore") as HTMLElement).click();
    });
    // op 上线，id verbatim。
    expect(opsOf(h, "sessionRestore").at(-1)?.op).toMatchObject({ op: "sessionRestore", id: "trash-00000001" });
    // 成功回执。
    await replyOps(h, "sessionRestore", { restored: true });
    // toast（人话回执）。
    expect(noticeText(h)).toContain("已恢复");
    // 双重取：sessions 与 sessionTrashList 都重发。
    expect(opsOf(h, "sessions").length).toBeGreaterThan(sessionsBefore);
    expect(opsOf(h, "sessionTrashList").length).toBeGreaterThan(trashBefore);
    // 视图回主列表：恢复钮没了，列表入口回来了（应答后 N=0）。
    expect(h.container.querySelector(".session-restore")).toBeNull();
    await replyOps(h, "sessions", [
      row({ id: "list-row-0001", name: "留下的会话" }),
      row({ id: "trash-00000001", firstUser: "删错的会话" }), // 恢复后回到列表
    ]);
    await replyOps(h, "sessionTrashList", []);
    const entry = h.container.querySelector(".session-trash-link") as HTMLElement;
    expect(entry?.textContent).toContain("回收站 (0)");
  });

  it("target-exists 拒 → 人话 toast「已存在同名会话」且留在回收站视图（无 sessions 重发）", async () => {
    const h = await openPicker({}, [row({ id: "trash-00000001", firstUser: "删错的会话" })]);
    await act(async () => {
      (h.container.querySelector(".session-trash-link") as HTMLElement).click();
    });
    const sessionsBefore = opsOf(h, "sessions").length;
    await act(async () => {
      (h.container.querySelector(".session-restore") as HTMLElement).click();
    });
    await replyOps(h, "sessionRestore", { restored: false, reason: "target-exists" });
    expect(noticeText(h)).toContain("已存在同名会话");
    expect(h.container.querySelector(".session-restore")).not.toBeNull(); // 留在回收站视图
    expect(opsOf(h, "sessions")).toHaveLength(sessionsBefore); // 无重发
  });

  it("回收站空（N=0）→ 视图显示「回收站是空的」空态", async () => {
    const h = await openPicker({}, []);
    await act(async () => {
      (h.container.querySelector(".session-trash-link") as HTMLElement).click();
    });
    expect(h.container.querySelector(".search-empty")?.textContent).toContain("回收站是空的");
  });
});
