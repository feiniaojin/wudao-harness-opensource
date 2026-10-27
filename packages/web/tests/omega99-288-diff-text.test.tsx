// @vitest-environment jsdom
// ω99-288: #8 — diff 分色渲染 receipts。先红后绿（红=DiffText 模块缺位，
// 如实分类留痕）。四层：①分类纯函数 classifyDiffLines（全方言前缀各就其
// 位；非 diff 文本零特判——无方言前缀行全 context，截断标记行原样）；
// ②DiffText 渲染（add/del/hunk/文件头类名锚 + 等宽原文保真——textContent
// 逐行等于输入 + 文件头带 ledger 路径锚）；③ChangesPanel 集成（detail 分
// 色在场 + 徽标 +M/−K present 形 + absent 降级「修改 ×N」不显示行数 + 文件
// 行点按跳到该文件头）；④HistoryList notice 展开双形（changes 在场走 diff
// 形；非 diff detail（meta_note 形）零视觉变化——类名缺席锚）。渲染纯展示：
// 分类结果只在 DiffText 内，任何其他组件不得 import 当数据（216 裁定延续）。
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChangesPanel, aggregateSessionChanges } from "../src/components/ChangesPanel.js";
import { DiffText, classifyDiffLines, detailFileAnchors } from "../src/components/DiffText.js";
import { HistoryList } from "../src/components/HistoryList.js";
import type { HistoryChange, HistoryEntry } from "../src/protocol.js";

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
});

// —— 播种词汇：与 driver settle seam 落的字段同形（plus/minus 数据层补齐，
// optional append-only）。 ——
const change = (path: string, op: "created" | "modified", writes: number, plus?: number, minus?: number): HistoryChange =>
  ({ path, op, writes, ...(plus !== undefined ? { plus } : {}), ...(minus !== undefined ? { minus } : {}) });

const TRUNCATION_MARKER = "…（净变更 diff 已按 8KB 截断——/rewind 可见完整历史）";

// jsdom has no scrollIntoView — the jump test's spy seam.
const scrolled: HTMLElement[] = [];
beforeAll(() => {
  Element.prototype.scrollIntoView = function (this: HTMLElement): void {
    scrolled.push(this);
  };
});

describe("classifyDiffLines 纯函数 (ω99-288)", () => {
  it("方言前缀各就其位：file-header（diff --git / new file / --- / +++）、hunk（@@）、add（+）、del（-）", () => {
    const kinds = classifyDiffLines([
      "diff --git a/x.ts b/x.ts",
      "new file",
      "--- /dev/null",
      "+++ b/x.ts",
      "@@ -0,0 +1 @@",
      "+hello",
      "-world",
      " ctx",
    ].join("\n")).map((l) => l.kind);
    expect(kinds).toEqual(["file-header", "file-header", "file-header", "file-header", "hunk", "add", "del", "context"]);
  });

  it("非 diff 文本零特判：无方言前缀的行全 context（meta_note 全文/截断标记/空行）", () => {
    const prose = ["# 会话纪要", "", "some plain prose", TRUNCATION_MARKER].join("\n");
    expect(classifyDiffLines(prose).every((l) => l.kind === "context")).toBe(true);
  });

  it("空串 = 单条空 context 行（不炸、不丢）", () => {
    expect(classifyDiffLines("")).toEqual([{ kind: "context", text: "" }]);
  });

  it("detailFileAnchors：只有 diff --git 行成锚（--- /+++ /new file 文件头族其余零贡献）；非 diff / 空串 → 空集", () => {
    const detail = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
      "diff --git a/b.ts b/b.ts",
      "new file",
      "--- /dev/null",
      "+++ b/b.ts",
      "@@ -0,0 +1 @@",
      "+hi",
      TRUNCATION_MARKER,
    ].join("\n");
    expect(detailFileAnchors(detail)).toEqual(new Set(["a.ts", "b.ts"]));
    expect(detailFileAnchors("plain prose")).toEqual(new Set());
    expect(detailFileAnchors("")).toEqual(new Set());
  });
});

describe("DiffText 渲染 (ω99-288)", () => {
  const DETAIL = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n ctx";

  it("分类渲染：add/del/hunk/文件头类名锚 + 等宽原文保真（textContent 逐行等于输入）", () => {
    const c = mount(createElement(DiffText, { detail: DETAIL, className: "chg-detail", as: "pre" }));
    const el = c.querySelector(".chg-detail");
    expect(el?.className).toContain("dtx");
    expect(el?.querySelectorAll(".dtx-file")).toHaveLength(3); // diff --git + --- + +++
    expect(el?.querySelectorAll(".dtx-hunk")).toHaveLength(1);
    expect(el?.querySelectorAll(".dtx-add")).toHaveLength(1);
    expect(el?.querySelectorAll(".dtx-del")).toHaveLength(1);
    expect(el?.querySelectorAll(".dtx-context")).toHaveLength(1);
    expect(el?.textContent).toBe(DETAIL); // 可复制原文结构不变
  });

  it("文件头行带 ledger 路径锚（data-dtx-file——面板定位跳转的靶点，仅 diff --git 行）", () => {
    const c = mount(createElement(DiffText, { detail: "diff --git a/src/x.ts b/src/x.ts\n@@ -1 +1 @@\n-a\n+b", className: "chg-detail" }));
    const anchors = [...c.querySelectorAll("[data-dtx-file]")];
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.getAttribute("data-dtx-file")).toBe("src/x.ts");
  });

  it("镜像切分：路径含 b/ 子串不误咬（a/P b/P 两路径恒镜像，首个镜像切点即真分隔）", () => {
    // 旧 lastIndexOf 在 P=`docs/a b/readme.md` 上咬到第二个 P 内部的 " b/"（27），
    // 错切成 `docs/a b/readme.md b/docs/a`——真切点 18。
    const p = "docs/a b/readme.md";
    const c = mount(createElement(DiffText, { detail: `diff --git a/${p} b/${p}\n@@ -1 +1 @@\n-a\n+b`, className: "chg-detail" }));
    const anchors = [...c.querySelectorAll("[data-dtx-file]")];
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.getAttribute("data-dtx-file")).toBe(p);
    // 同 it 再钉 P=`x b/x`：idx=1 的候选前缀 "x" ≠ 后缀，跳过；真切点 5。
    const c2 = mount(createElement(DiffText, { detail: "diff --git a/x b/x b/x b/x\n@@ -1 +1 @@\n-a\n+b", className: "chg-detail" }));
    const anchors2 = [...c2.querySelectorAll("[data-dtx-file]")];
    expect(anchors2).toHaveLength(1);
    expect(anchors2[0]?.getAttribute("data-dtx-file")).toBe("x b/x");
  });

  it("外来方言回退钉：a/old b/new 两路径不同无镜像切点 → lastIndexOf 既有行为（锚 = 前路径）", () => {
    const c = mount(createElement(DiffText, { detail: "diff --git a/old.md b/new.md\n@@ -1 +1 @@\n-a\n+b", className: "chg-detail" }));
    const anchors = [...c.querySelectorAll("[data-dtx-file]")];
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.getAttribute("data-dtx-file")).toBe("old.md");
  });

  it("纯非 diff 文本零分色（全 context 行——经分色器天然降级，视觉与原文块等价）", () => {
    const c = mount(createElement(DiffText, { detail: `plain\nprose\n${TRUNCATION_MARKER}`, className: "notice-detail" }));
    const el = c.querySelector(".notice-detail");
    expect(el?.querySelectorAll(".dtx-line")).toHaveLength(3);
    expect(el?.querySelectorAll(".dtx-line.dtx-context")).toHaveLength(3);
    expect(el?.querySelector(".dtx-add")).toBeNull();
    expect(el?.querySelector(".dtx-del")).toBeNull();
    expect(el?.querySelector(".dtx-file")).toBeNull();
    expect(el?.querySelector(".dtx-hunk")).toBeNull();
    expect(el?.textContent).toBe(`plain\nprose\n${TRUNCATION_MARKER}`);
  });
});

describe("会话改动面板集成分色 (ω99-288)", () => {
  const DETAIL = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-old",
    " keep2",
    "+new",
    "",
    "diff --git a/b.ts b/b.ts",
    "new file",
    "--- /dev/null",
    "+++ b/b.ts",
    "@@ -0,0 +1 @@",
    "+hi",
  ].join("\n");

  const aggWithCounts = aggregateSessionChanges([
    { kind: "notice", text: "回合净变更 2 文件：a.ts(×2) · b.ts(新建)", detail: DETAIL, changes: [change("a.ts", "modified", 2, 2, 1), change("b.ts", "created", 1, 1, 0)] },
  ]);

  it("徽标 +M/−K present 形：「修改 ×N +M −K」与「新建 +M」（计数着色 span 在场）；absent 降级不显示行数", () => {
    const agg = aggregateSessionChanges([
      { kind: "notice", text: "回合净变更 2 文件：a.ts(×2) · b.ts(新建)", detail: DETAIL, changes: [change("a.ts", "modified", 2, 2, 1), change("b.ts", "created", 1, 1, 0)] },
      { kind: "notice", text: "老收据", changes: [change("c.md", "modified", 3)] },
    ]);
    const c = mount(createElement(ChangesPanel, { agg, onClose: () => {} }));
    const runs = [...c.querySelectorAll(".chg-run")] as HTMLElement[];
    const badges = runs.map((r) => [...r.querySelectorAll(".chg-badge")].map((b) => b.textContent));
    expect(badges[0]).toEqual(["修改 ×2 +2 −1", "新建 +1"]);
    expect(badges[1]).toEqual(["修改 ×3"]); // absent 降级：不显示行数
    // 计数是着色 span（--ok/--danger 语槽），不是裸文本
    const plus = runs[0]?.querySelector(".chg-cnt-plus");
    const minus = runs[0]?.querySelector(".chg-cnt-minus");
    expect(plus?.textContent).toBe(" +2");
    expect(minus?.textContent).toBe(" −1");
  });

  it("展开明细分色在场（.chg-detail 内 dtx-add/del/file/hunk），原文保真含截断标记", () => {
    const c = mount(createElement(ChangesPanel, { agg: aggWithCounts, onClose: () => {} }));
    const run = c.querySelector(".chg-run") as HTMLElement;
    act(() => {
      (run.querySelector<HTMLButtonElement>(".chg-exp"))!.click();
    });
    const detail = run.querySelector(".chg-detail");
    expect(detail).not.toBeNull();
    expect(detail?.querySelector(".dtx-add")).not.toBeNull();
    expect(detail?.querySelector(".dtx-del")).not.toBeNull();
    expect(detail?.querySelector(".dtx-hunk")).not.toBeNull();
    expect(detail?.querySelector(".dtx-file")).not.toBeNull();
    expect(detail?.textContent).toBe(DETAIL);
  });

  it("文件行点按 → 展开明细并跳到该文件头（scrollIntoView 靶 = 该文件的 data-dtx-file 元素）", () => {
    const c = mount(createElement(ChangesPanel, { agg: aggWithCounts, onClose: () => {} }));
    const run = c.querySelector(".chg-run") as HTMLElement;
    expect(run.querySelector(".chg-detail")).toBeNull(); // 收起态
    const rows = [...run.querySelectorAll<HTMLButtonElement>("button.chg-file")];
    expect(rows).toHaveLength(2); // 有明细的 run 文件行是可点钮
    act(() => {
      rows[1]!.click(); // b.ts —— 第二个文件的头部
    });
    expect(run.querySelector(".chg-detail")).not.toBeNull(); // 点按即展开
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]?.getAttribute("data-dtx-file")).toBe("b.ts");
    // 再点第一个文件：跳到 a.ts 的头
    act(() => {
      rows[0]!.click();
    });
    expect(scrolled).toHaveLength(2);
    expect(scrolled[1]?.getAttribute("data-dtx-file")).toBe("a.ts");
  });

  it("无锚文件行降级：净零/截断族是 DIV + 收益语 title（有锚行跳转零漂移）", () => {
    const agg = aggregateSessionChanges([
      {
        kind: "notice",
        text: "回合净变更 3 文件：a.ts · c.md · d.md",
        detail: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b",
        changes: [change("a.ts", "modified", 1, 1, 1), change("c.md", "modified", 2, 0, 0), change("d.md", "modified", 1, 5, 3)],
      },
    ]);
    const c = mount(createElement(ChangesPanel, { agg, onClose: () => {} }));
    const run = c.querySelector(".chg-run") as HTMLElement;
    const rows = [...run.querySelectorAll(".chg-file")];
    expect(rows).toHaveLength(3); // 明细里只有 a.ts 的锚，但三行都列
    const buttons = [...run.querySelectorAll<HTMLButtonElement>("button.chg-file")];
    expect(buttons).toHaveLength(1); // 只有有锚的 a.ts 是可点钮
    const rowFor = (path: string): HTMLElement => rows.find((r) => r.querySelector(".chg-path")?.textContent === path) as HTMLElement;
    const cRow = rowFor("c.md"); // 净零族：counts 双零，无块无锚
    const dRow = rowFor("d.md"); // 截断族：块被整块丢弃，有计数无锚
    expect(cRow.tagName).toBe("DIV");
    expect(cRow.getAttribute("title")).toBe("这一轮结束时，这个文件的内容没有变化");
    expect(dRow.tagName).toBe("DIV");
    expect(dRow.getAttribute("title")).toContain("/rewind");
    // 既有跳转零漂移：点 a.ts 钮 → 精确一次 scrollIntoView 且靶点 a.ts
    scrolled.length = 0;
    act(() => {
      buttons[0]!.click();
    });
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]?.getAttribute("data-dtx-file")).toBe("a.ts");
  });
});

describe("HistoryList notice 展开双形 (ω99-288)", () => {
  it("changes 在场的收据走 diff 形（.notice-detail 内 dtx 分色在场）", () => {
    const history: HistoryEntry[] = [
      { kind: "notice", text: "回合净变更 1 文件：a.ts(×1)", detail: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b", changes: [change("a.ts", "modified", 1, 1, 1)] },
    ];
    const c = mount(createElement(HistoryList, { history }));
    act(() => {
      (c.querySelector<HTMLButtonElement>(".notice-exp"))!.click();
    });
    const d = c.querySelector(".notice-detail");
    expect(d?.className).toContain("dtx");
    expect(d?.querySelector(".dtx-add")).not.toBeNull();
    expect(d?.querySelector(".dtx-del")).not.toBeNull();
    expect(d?.querySelector(".dtx-file")).not.toBeNull();
  });

  it("非 diff detail 零视觉变化：meta_note 卡（card:true）与普通胶囊都不走分色（类名缺席锚）", () => {
    const history: HistoryEntry[] = [
      { kind: "notice", text: "预览行", detail: "注入全文\n第二行", card: true, source: "记忆召回" },
      { kind: "notice", text: "普通通知", detail: "plain detail text" },
    ];
    const c = mount(createElement(HistoryList, { history }));
    // meta_note 注入卡
    act(() => {
      (c.querySelector<HTMLButtonElement>(".inject-head"))!.click();
    });
    const inject = c.querySelector(".reply-card .notice-detail");
    expect(inject).not.toBeNull();
    expect(inject?.className).not.toContain("dtx"); // 类名缺席锚
    expect(inject?.querySelector(".dtx-line")).toBeNull();
    expect(inject?.textContent).toBe("注入全文\n第二行");
    // 普通胶囊（无 changes 的 notice detail）
    act(() => {
      (c.querySelector(".entry-notice .notice-exp") as HTMLButtonElement).click();
    });
    const plain = c.querySelector(".entry-notice .notice-detail");
    expect(plain?.className).not.toContain("dtx");
    expect(plain?.querySelector(".dtx-line")).toBeNull();
    expect(plain?.textContent).toBe("plain detail text");
  });
});
