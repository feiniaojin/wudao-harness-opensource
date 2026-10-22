// @vitest-environment jsdom
// ω99-216: #R — 会话改动面板 receipts。先红后绿：红=面板模块缺位（module
// not found，如实分类留痕）。两层：①聚合纯函数 aggregateSessionChanges
// （切片→run 分组/路径去重计数/空与无字段切片零贡献——数据源=结构化
// changes 字段，绝不解析 detail 文本）；②全 App harness（mock-ws fakeServer
// + authOk 播种携带 changes 的 notice 条目——夹具零文件系统，红线：绝不
// 触碰用户文件）——chip「改动 N 文件」计数=去重文件数、点击开面板、run
// 分组、文件徽标（新建/修改 ×N）、展开见 detail 原文（含截断标记如实）、
// 无 changes 老历史零 chip、空数组零 chip、Esc/关闭钮收起。
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { aggregateSessionChanges } from "../src/components/ChangesPanel.js";
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

// —— 播种词汇：与 driver settle seam 落的字段同形（轻摘要；before/after
// 全内容快照绝不入历史——收据红线）。 ——
const change = (path: string, op: "created" | "modified", writes: number) => ({ path, op, writes });

const TRUNCATION_MARKER = "…（净变更 diff 已按 8KB 截断——/rewind 可见完整历史）";

/** One driver-landed turn-diff receipt（text/detail 与 0.3.7 通道同款；本弧
 *  只新增可选 changes——append-only）。 */
const receipt = (
  files: readonly ReturnType<typeof change>[],
  detail = "",
): HistoryEntry => ({
  kind: "notice",
  text: `回合净变更 ${files.length} 文件：${files.map((f) => f.path).join(" · ")}`,
  ...(detail !== "" ? { detail } : {}),
  changes: files,
});

/** 两轮收据 + 干扰条目：run1 改 a.ts(新建)+b.md(修改×2)；run2 再改
 *  a.ts(修改×1)+c.ts(新建)——a 跨轮去重，会话头=3 文件。 */
const twoRuns = (): HistoryEntry[] => [
  { kind: "user", text: "做点东西" },
  { kind: "assistant", text: "好了" },
  receipt([change("a.ts", "created", 1), change("b.md", "modified", 2)], "diff --git a/a.ts b/a.ts\nnew file\n+b1"),
  { kind: "notice", text: "总耗时 3.2s · 模型 2.1s · 工具 4 (5)" },
  { kind: "user", text: "再改一轮" },
  receipt([change("a.ts", "modified", 1), change("c.ts", "created", 1)], "diff --git a/a.ts b/a.ts\n--- a/a.ts\n-b1\n+b2"),
];

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  document.title = "";
});

describe("aggregateSessionChanges 纯函数 (ω99-216)", () => {
  it("空切片 → 零 run 零文件；无 changes 的历史（老收据/普通条目）零贡献", () => {
    expect(aggregateSessionChanges([])).toEqual({ runs: [], fileCount: 0 });
    const legacy: HistoryEntry[] = [
      { kind: "user", text: "hi" },
      // 老收据：0.3.7 起就有 text+detail，无 changes 字段——面板不回填（诚实边界）
      { kind: "notice", text: "回合净变更 2 文件：x.ts(新建) · y.md(×1)", detail: "diff --git a/x.ts b/x.ts" },
      { kind: "tool", name: "write_file", summary: "x.ts" },
    ];
    expect(aggregateSessionChanges(legacy)).toEqual({ runs: [], fileCount: 0 });
  });

  it("changes 空数组条目不贡献（netFiles 空整条不落的现状在面板侧同形）", () => {
    const withEmpty: HistoryEntry[] = [
      { kind: "notice", text: "回合净变更 0 文件：", changes: [] },
      receipt([change("a.ts", "created", 1)]),
    ];
    expect(aggregateSessionChanges(withEmpty)).toEqual({
      runs: [{ files: [change("a.ts", "created", 1)], detail: undefined }],
      fileCount: 1,
    });
  });

  it("run 分组按历史序；文件序保持落账序；detail 透传（原文即展示，不解析）", () => {
    const agg = aggregateSessionChanges(twoRuns());
    expect(agg.runs).toHaveLength(2);
    expect(agg.runs[0]?.files.map((f) => f.path)).toEqual(["a.ts", "b.md"]);
    expect(agg.runs[1]?.files.map((f) => f.path)).toEqual(["a.ts", "c.ts"]);
    expect(agg.runs[0]?.detail).toContain("new file");
    expect(agg.runs[1]?.detail).toContain("-b1");
  });

  it("会话头计数 = 路径去重（同文件跨轮计 1）", () => {
    expect(aggregateSessionChanges(twoRuns()).fileCount).toBe(3); // a/b/c，a 两轮计 1
  });
});

describe("会话改动面板面 (ω99-216)", () => {
  it("chip「改动 N 文件」=去重文件数；点击开面板：会话头+run 分组+文件徽标", async () => {
    const h = mountedApp(twoRuns());
    await until(() => h.container.querySelector(".topbar .tb-changes") !== null, "changes chip");
    const chip = h.container.querySelector<HTMLButtonElement>(".topbar .tb-changes");
    expect(chip?.textContent).toBe("改动 3 文件"); // a/b/c 去重，不是 4
    expect(chip?.getAttribute("aria-label")).toBe("查看会话改动");
    // 打开前面板不在
    expect(h.container.querySelector(".changes-panel")).toBeNull();
    await act(async () => {
      chip!.click();
    });
    const panel = h.container.querySelector(".changes-panel");
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("role")).toBe("dialog");
    expect(panel?.getAttribute("aria-label")).toBe("会话改动");
    // 会话头：去重文件数 + run 数
    expect(panel?.querySelector(".chg-head")?.textContent).toBe("共改动 3 个文件 · 2 轮");
    // run 分组（历史序）与文件行徽标
    const runs = [...panel?.querySelectorAll(".chg-run") ?? []] as HTMLElement[];
    expect(runs).toHaveLength(2);
    expect(runs[0]?.querySelector(".chg-run-h")?.textContent).toBe("第 1 轮 · 2 文件");
    const badges = runs.map((r) =>
      [...r.querySelectorAll(".chg-badge")].map((b) => b.textContent),
    );
    expect(badges[0]).toEqual(["新建", "修改 ×2"]);
    expect(badges[1]).toEqual(["修改 ×1", "新建"]);
    // 文件行带相对路径
    expect(runs[0]?.querySelector(".chg-path")?.textContent).toBe("a.ts");
  });

  it("per-run 展开见 detail 原文（截断标记如实照搬，不假装完整）", async () => {
    const h = mountedApp([
      receipt([change("big.ts", "modified", 1)], `diff --git a/big.ts b/big.ts\n--- a/big.ts\n-long\n+short\n\n${TRUNCATION_MARKER}`),
    ]);
    await until(() => h.container.querySelector(".topbar .tb-changes") !== null, "changes chip");
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>(".topbar .tb-changes"))!.click();
    });
    const run = h.container.querySelector(".chg-run") as HTMLElement;
    // 收起态无明细块
    expect(run.querySelector(".chg-detail")).toBeNull();
    await act(async () => {
      (run.querySelector<HTMLButtonElement>(".chg-exp"))!.click();
    });
    const detail = run.querySelector(".chg-detail");
    expect(detail?.textContent).toContain("diff --git a/big.ts b/big.ts");
    expect(detail?.textContent).toContain(TRUNCATION_MARKER); // 超长截断照实显示
    // 再点收起
    await act(async () => {
      (run.querySelector<HTMLButtonElement>(".chg-exp"))!.click();
    });
    expect(run.querySelector(".chg-detail")).toBeNull();
  });

  it("无 changes 老历史零 chip；changes 空数组零 chip", async () => {
    const legacy = mountedApp([
      { kind: "user", text: "hi" },
      { kind: "notice", text: "回合净变更 2 文件：x.ts(新建)", detail: "diff --git a/x.ts b/x.ts" },
      { kind: "notice", text: "总耗时 1s" },
    ]);
    await until(() => legacy.container.querySelector(".topbar") !== null, "topbar");
    expect(legacy.container.querySelector(".topbar .tb-changes")).toBeNull();
    const emptyArr = mountedApp([{ kind: "notice", text: "回合净变更 0 文件：", changes: [] }]);
    await until(() => emptyArr.container.querySelector(".topbar") !== null, "topbar");
    expect(emptyArr.container.querySelector(".topbar .tb-changes")).toBeNull();
  });

  it("Esc 与关闭钮都能收起面板", async () => {
    const h = mountedApp(twoRuns());
    await until(() => h.container.querySelector(".topbar .tb-changes") !== null, "changes chip");
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>(".topbar .tb-changes"))!.click();
    });
    expect(h.container.querySelector(".changes-panel")).not.toBeNull();
    const panel = h.container.querySelector<HTMLElement>(".changes-panel") /* ω99-301: re-shelled onto .modal-card — the panel IS the card */;
    await act(async () => {
      panel!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(h.container.querySelector(".changes-panel")).toBeNull();
    // 重开 → 关闭钮收起
    await act(async () => {
      (h.container.querySelector<HTMLButtonElement>(".topbar .tb-changes"))!.click();
    });
    const closeBtn = [...h.container.querySelectorAll(".changes-panel button")].find(
      (b) => b.textContent === "关闭",
    ) as HTMLButtonElement;
    await act(async () => {
      closeBtn.click();
    });
    expect(h.container.querySelector(".changes-panel")).toBeNull();
  });
});
