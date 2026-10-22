// @vitest-environment jsdom
// ω99-220: #R2 — 回望面板演进 receipts：computer.scroll / computer.drag
// 进聚合集与动作短语（219 面板「免费扩展」的钉——driver 零改动，新工具
// 靠名集+summarize 单源自动入面板）。夹具全内存 jsdom——零文件系统、零
// 键鼠、零截屏（212 既立红线：本面根本不触执行层）。播种的 tool 条目与
// driver 落的形状同构（name/summary——summary 即 log.ts summarizeToolCall
// 的新例输出）。
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { aggregateComputerActions } from "../src/components/ComputerActionsPanel.js";
import type { HistoryEntry } from "../src/protocol.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";
import { WudaoClient } from "../src/protocol.js";

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

function mountedApp(history: readonly HistoryEntry[]): { container: HTMLElement } {
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
    authOk(server.socket, {}, history);
  });
  return { container };
}

const tool = (name: string, summary: string, extra: Partial<{ isError: boolean; resultPreview: string; durationMs: number }> = {}): HistoryEntry => ({
  kind: "tool",
  name,
  summary,
  ...extra,
});

/** 一轮「读长文 + 挪文件」托付：截屏看屏 → 点进正文 → 连滚两屏读完 →
 *  拖一个文件进文件夹。scroll/drag 与既有六工具混排在同一 run。 */
const scrollDragErrand = (): HistoryEntry[] => [
  { kind: "user", text: "帮我把这篇长文读完，再把桌面那个文件拖进整理文件夹" },
  tool("screen.capture", "全屏"),
  tool("computer.click", "(512, 384)"),
  tool("computer.scroll", "向下 300 像素"),
  tool("computer.scroll", "向下 300 像素"),
  tool("computer.drag", "(100, 200)→(400, 500)"),
  { kind: "assistant", text: "读完了，文件也挪好了。" },
];

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  document.title = "";
});

describe("aggregateComputerActions 演进 (ω99-220)", () => {
  it("scroll/drag 条目计入 totalSteps 与动作行（与既有六工具同一条回望线）", () => {
    const agg = aggregateComputerActions(scrollDragErrand());
    expect(agg.totalSteps).toBe(5);
    expect(agg.runs).toHaveLength(1);
    expect(agg.runs[0]?.actions.map((a) => a.name)).toEqual([
      "screen.capture", "computer.click", "computer.scroll", "computer.drag",
    ]);
  });

  it("连续同词条目照常折叠计数（scroll×2 → ×2 徽标）", () => {
    const agg = aggregateComputerActions(scrollDragErrand());
    expect(agg.runs[0]?.actions[2]).toMatchObject({ name: "computer.scroll", count: 2 });
  });

  it("user 边界分 run 对新工具同构：两轮托付各自成组", () => {
    const agg = aggregateComputerActions([
      { kind: "user", text: "先读这篇" },
      tool("computer.scroll", "向下 300 像素"),
      { kind: "user", text: "再挪文件" },
      tool("computer.drag", "(1, 2)→(3, 4)"),
    ]);
    expect(agg.runs).toHaveLength(2);
    expect(agg.totalSteps).toBe(2);
  });

  it("他工具零贡献不回归：read/write/shell/notice 仍不计入", () => {
    const agg = aggregateComputerActions([
      { kind: "user", text: "hi" },
      tool("write_file", "a.ts"),
      tool("shell", "ls"),
      tool("read_file", "a.ts"),
      { kind: "notice", text: "回合净变更 1 文件：a.ts" },
    ]);
    expect(agg).toEqual({ runs: [], totalSteps: 0 });
  });

  it("pre-219 老形状零漂移：空串 summary 的 scroll 条目照常计入（兜底行语义不变）", () => {
    const agg = aggregateComputerActions([
      { kind: "user", text: "老会话" },
      { kind: "tool", name: "computer.drag", summary: "", resultPreview: "已从 (1, 2) 拖到 (3, 4)。" },
    ]);
    expect(agg.totalSteps).toBe(1);
    expect(agg.runs[0]?.actions[0]).toMatchObject({ name: "computer.drag", summary: "" });
  });
});

describe("回望面板面 演进 (ω99-220)", () => {
  it("chip 计数含 scroll/drag；面板动作行=「滚动了/拖动了」+ 对象（run 分组内新行就位）", async () => {
    const h = mountedApp(scrollDragErrand());
    await until(() => h.container.querySelector(".topbar .tb-computer") !== null, "computer chip");
    const chip = h.container.querySelector<HTMLButtonElement>(".topbar .tb-computer");
    expect(chip?.textContent).toBe("电脑操作 5 步");
    await act(async () => {
      chip!.click();
    });
    const panel = h.container.querySelector(".computer-panel");
    expect(panel).not.toBeNull();
    expect(panel?.querySelector(".cap-head")?.textContent).toBe("共电脑操作 5 步 · 1 轮");
    const rows = [...panel?.querySelectorAll(".cap-act") ?? []].map((r) => r.textContent);
    // 动词与对象间的间隔是 .cap-act 的 flex gap，非文本空格（219 同款钉法）
    expect(rows).toEqual([
      "截了一张全屏图",
      "点击(512, 384)",
      "滚动了向下 300 像素×2",
      "拖动了(100, 200)→(400, 500)",
    ]);
  });

  it("scroll 错误步红色样式不回归（data-err 语义对新工具同构）", async () => {
    const h = mountedApp([
      { kind: "user", text: "滚一下" },
      tool("computer.scroll", "向下 300 像素", { isError: true }),
    ]);
    await until(() => h.container.querySelector(".topbar .tb-computer") !== null, "computer chip");
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>(".topbar .tb-computer"))!.click();
    });
    const row = h.container.querySelector(".cap-act") as HTMLElement;
    expect(row.getAttribute("data-err")).toBe("true");
    expect(row.textContent).toContain("滚动了向下 300 像素");
  });

  it("零电脑操作历史零 chip（读写会话顶栏字节不变——零回归）", async () => {
    const h = mountedApp([
      { kind: "user", text: "hi" },
      tool("write_file", "a.ts"),
    ]);
    await until(() => h.container.querySelector(".topbar") !== null, "topbar");
    expect(h.container.querySelector(".topbar .tb-computer")).toBeNull();
  });
});
