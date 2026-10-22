// @vitest-environment jsdom
// ω99-219: #R2 — 电脑操作回望面板 receipts。先红后绿：红=面板模块缺位
// （module not found，如实分类留痕）。两层：①聚合纯函数
// aggregateComputerActions（tool 条目六工具计入/他工具不计/user 边界分
// run/连续同 (name,summary) 折叠计数/totalSteps=条目数）；②全 App harness
// （mock-ws fakeServer + authOk 播种含电脑操作 tool 条目的 history——夹具
// 全内存 jsdom，零文件系统、零键鼠、零截屏：212 既立红线）。chip
// 「电脑操作 N 步」计数=总步数、点击开 overlay 面板（run 分组/动作行
// 用户词短语/错误样式/老会话空 summary 兜底行+resultPreview 单行/Esc/
// 关闭钮）。数据源=消息面 tool 条目（resume 重建即回——与 216 收据的
// 寿命差异是本弧选型依据，末钉钉重建形状的等价性）。
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { aggregateComputerActions } from "../src/components/ComputerActionsPanel.js";
import { WudaoClient } from "../src/protocol.js";
import type { HistoryEntry } from "../src/protocol.js";
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

/** The bare connected App（无 settings/sessions 回复——本面零依赖：authOk 的
 *  history 重置帧就是面板的全部数据源，挂起 op 不影响渲染）。 */
function mountedApp(history: readonly HistoryEntry[]): Harness {
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
  return { container, client, server };
}

// —— 播种词汇：与 driver 落的 tool 条目同形（name/summary/isError/
// resultPreview/durationMs；pre-219 会话 summary 为空串）。 ——
const tool = (name: string, summary: string, extra: Partial<{ isError: boolean; resultPreview: string; durationMs: number }> = {}): HistoryEntry => ({
  kind: "tool",
  name,
  summary,
  ...extra,
});

/** 一轮典型托付（在备忘录记一条）：截屏看屏 → 打开备忘录 → 点进输入框 →
 *  输入 → 按回车；穿插一次 app.list（与下一次连续同词折叠）。 */
const oneErrand = (): HistoryEntry[] => [
  { kind: "user", text: "帮我在备忘录记一条：明天买咖啡豆" },
  tool("screen.capture", "全屏"),
  tool("app.list", "列表"),
  tool("app.list", "列表"),
  tool("app.activate", "备忘录"),
  tool("computer.click", "(512, 384)"),
  tool("computer.type", "明天买咖啡豆"),
  tool("computer.key", "return"),
  { kind: "assistant", text: "记好了。" },
];

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  document.title = "";
});

describe("aggregateComputerActions 纯函数 (ω99-219)", () => {
  it("空切片 → 零 run 零步；非电脑操作工具零贡献（read/write/shell 是另一条回望线）", () => {
    expect(aggregateComputerActions([])).toEqual({ runs: [], totalSteps: 0 });
    const notComputer: HistoryEntry[] = [
      { kind: "user", text: "hi" },
      tool("write_file", "a.ts"),
      tool("shell", "ls"),
      tool("read_file", "a.ts"),
      { kind: "notice", text: "回合净变更 1 文件：a.ts" },
      { kind: "assistant", text: "ok" },
    ];
    expect(aggregateComputerActions(notComputer)).toEqual({ runs: [], totalSteps: 0 });
  });

  it("六工具全计入；totalSteps=条目数（不是折叠后的行数）", () => {
    const agg = aggregateComputerActions(oneErrand());
    expect(agg.totalSteps).toBe(7);
    expect(agg.runs).toHaveLength(1);
    expect(agg.runs[0]?.actions.map((a) => a.name)).toEqual([
      "screen.capture", "app.list", "app.activate", "computer.click", "computer.type", "computer.key",
    ]);
  });

  it("连续同 (name, summary) 折叠计数；不同输入文本的连续 computer.type 不折叠（各有各的回望行）", () => {
    const agg = aggregateComputerActions([
      tool("app.list", "列表"),
      tool("app.list", "列表"),
      tool("app.list", "列表"),
      tool("computer.type", "标题"),
      tool("computer.type", "正文内容"),
    ]);
    expect(agg.runs[0]?.actions.map((a) => [a.name, a.count])).toEqual([
      ["app.list", 3],
      ["computer.type", 1],
      ["computer.type", 1],
    ]);
    expect(agg.totalSteps).toBe(5); // 3+1+1：条目数
  });

  it("user 消息边界分 run；首个 user 前的条目自成一 run（历史序）", () => {
    const agg = aggregateComputerActions([
      tool("screen.capture", "全屏"), // 引导期条目（无前置 user）→ 第 1 组
      { kind: "user", text: "记一条" },
      tool("computer.type", "内容"),
      { kind: "user", text: "再记一条" },
      tool("computer.type", "内容2"),
      tool("computer.key", "return"),
    ]);
    expect(agg.runs).toHaveLength(3);
    expect(agg.runs.map((r) => r.actions.length)).toEqual([1, 1, 2]);
    expect(agg.totalSteps).toBe(4);
  });

  it("折叠行的 isError=任一次失败；durationMs=全部携带时求和、有缺省则不显示（不编造）", () => {
    const allTimed = aggregateComputerActions([
      tool("app.list", "列表", { durationMs: 800 }),
      tool("app.list", "列表", { durationMs: 700 }),
    ]);
    expect(allTimed.runs[0]?.actions[0]).toMatchObject({ count: 2, durationMs: 1500, isError: false });
    const mixed = aggregateComputerActions([
      tool("app.list", "列表", { durationMs: 800 }),
      tool("app.list", "列表"),
    ]);
    expect(mixed.runs[0]?.actions[0]?.durationMs).toBeUndefined();
    const oneErr = aggregateComputerActions([
      tool("app.list", "列表"),
      tool("app.list", "列表", { isError: true }),
    ]);
    expect(oneErr.runs[0]?.actions[0]?.isError).toBe(true);
  });

  it("老会话（pre-219）空串 summary 条目照常计入——兜底行在面板侧不猜内容", () => {
    const agg = aggregateComputerActions([
      { kind: "user", text: "老会话" },
      { kind: "tool", name: "computer.type", summary: "", resultPreview: "已在焦点处输入 12 个字符。" },
    ]);
    expect(agg.totalSteps).toBe(1);
    expect(agg.runs[0]?.actions[0]).toMatchObject({ name: "computer.type", summary: "", preview: "已在焦点处输入 12 个字符。" });
  });

  it("resume 重建形状等价：折叠轮的单 tool 条目（首工具名+「N 个工具」summary）聚合照常在——跨重启持久钉（web 侧无真 resume，钉对重建后 history 形状的等价性）", () => {
    const rebuilt: HistoryEntry[] = [
      { kind: "divider", text: "已恢复 abc12345 · 8 条消息" },
      { kind: "user", text: "帮我在备忘录记一条" },
      // resumeEntries 对多工具轮的折叠形状（resume.ts 同款）：一条 tool 携「N 个工具：names」
      tool("computer.type", "2 个工具：computer.type,computer.click", { resultPreview: "已在焦点处输入 8 个字符。" }),
      { kind: "user", text: "谢谢" },
      tool("app.activate", "备忘录"),
    ];
    const agg = aggregateComputerActions(rebuilt);
    expect(agg.totalSteps).toBe(2);
    expect(agg.runs).toHaveLength(2);
  });
});

describe("电脑操作回望面板面 (ω99-219)", () => {
  it("chip「电脑操作 N 步」=总步数；点击开面板：会话头+run 分组+动作行用户词短语", async () => {
    const h = mountedApp(oneErrand());
    await until(() => h.container.querySelector(".topbar .tb-computer") !== null, "computer chip");
    const chip = h.container.querySelector<HTMLButtonElement>(".topbar .tb-computer");
    expect(chip?.textContent).toBe("电脑操作 7 步"); // 条目数，不是折叠行数
    expect(chip?.getAttribute("aria-label")).toBe("查看电脑操作");
    // 打开前面板不在
    expect(h.container.querySelector(".computer-panel")).toBeNull();
    await act(async () => {
      chip!.click();
    });
    const panel = h.container.querySelector(".computer-panel");
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("role")).toBe("dialog");
    expect(panel?.getAttribute("aria-label")).toBe("电脑操作");
    // 会话头：总步数 + 轮数
    expect(panel?.querySelector(".cap-head")?.textContent).toBe("共电脑操作 7 步 · 1 轮");
    // run 分组头
    const runs = [...panel?.querySelectorAll(".cap-run") ?? []] as HTMLElement[];
    expect(runs).toHaveLength(1);
    expect(runs[0]?.querySelector(".cap-run-h")?.textContent).toBe("第 1 轮 · 7 步");
    // 动作行=用户词短语（打开了/输入了/点击/按键/截图），零实现术语
    // （动词与对象间的间隔是 .cap-act 的 flex gap，非文本空格）
    const rows = [...runs[0]?.querySelectorAll(".cap-act") ?? []].map((r) => r.textContent);
    expect(rows).toEqual([
      "截了一张全屏图",
      "看了当前打开的应用×2", // 连续同词折叠计数
      "打开了备忘录",
      "点击(512, 384)",
      "输入了明天买咖啡豆",
      "按键return",
    ]);
  });

  it("错误步红色样式；耗时行（formatDur 同规则）", async () => {
    const h = mountedApp([
      { kind: "user", text: "点一下" },
      tool("computer.click", "(10, 20)", { isError: true, durationMs: 1200 }),
    ]);
    await until(() => h.container.querySelector(".topbar .tb-computer") !== null, "computer chip");
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>(".topbar .tb-computer"))!.click();
    });
    const row = h.container.querySelector(".cap-act") as HTMLElement;
    expect(row.getAttribute("data-err")).toBe("true");
    expect(row.textContent).toContain("点击(10, 20)");
    expect(row.querySelector(".cap-dur")?.textContent).toBe("· 1.2s");
  });

  it("老会话空 summary 兜底：工具名行 + resultPreview 单行（诚实降级，不猜动作内容）", async () => {
    const h = mountedApp([
      { kind: "user", text: "老会话" },
      { kind: "tool", name: "computer.type", summary: "", resultPreview: "已在焦点处输入 12 个字符。" },
    ]);
    await until(() => h.container.querySelector(".topbar .tb-computer") !== null, "computer chip");
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>(".topbar .tb-computer"))!.click();
    });
    const row = h.container.querySelector(".cap-act") as HTMLElement;
    expect(row.textContent).toContain("computer.type"); // 工具名兜底——唯一可诚实的标识
    expect(row.querySelector(".cap-preview")?.textContent).toBe("已在焦点处输入 12 个字符。");
  });

  it("零电脑操作历史零 chip（读写会话顶栏字节不变）", async () => {
    const h = mountedApp([
      { kind: "user", text: "hi" },
      tool("write_file", "a.ts"),
      { kind: "notice", text: "回合净变更 1 文件：a.ts" },
    ]);
    await until(() => h.container.querySelector(".topbar") !== null, "topbar");
    expect(h.container.querySelector(".topbar .tb-computer")).toBeNull();
  });

  it("Esc 与关闭钮都能收起面板", async () => {
    const h = mountedApp(oneErrand());
    await until(() => h.container.querySelector(".topbar .tb-computer") !== null, "computer chip");
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>(".topbar .tb-computer"))!.click();
    });
    expect(h.container.querySelector(".computer-panel")).not.toBeNull();
    const panel = h.container.querySelector<HTMLElement>(".computer-panel") /* ω99-301: re-shelled onto .modal-card — the panel IS the card */;
    await act(async () => {
      panel!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(h.container.querySelector(".computer-panel")).toBeNull();
    // 重开 → 关闭钮收起
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>(".topbar .tb-computer"))!.click();
    });
    const closeBtn = [...h.container.querySelectorAll(".computer-panel button")].find(
      (b) => b.textContent === "关闭",
    ) as HTMLButtonElement;
    await act(async () => {
      closeBtn.click();
    });
    expect(h.container.querySelector(".computer-panel")).toBeNull();
  });
});
