// @vitest-environment jsdom
// M72 §3 — semantic collapse in the ADVANCED column's tool stream (research
// 38 §1, the upstream's collapseReadSearch): consecutive OBSERVATION-tool runs (reads,
// greps, globs, web lookups) collapse into a `name ×N` group header — one
// line instead of N cards — each group expandable in place. Pure CSS/class
// + local state only: the history array itself is never rewritten (the
// grouping is a view-side transform over the same immutable entries), and
// errored tools never collapse (failures stay loud).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { groupToolRuns, HistoryList } from "../src/components/HistoryList.js";
import type { HistoryEntry } from "../src/protocol.js";
import { resetMarkdownCache } from "../src/markdown.js";

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

beforeEach(() => {
  resetMarkdownCache();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
});

const read = (path: string): HistoryEntry => ({ kind: "tool", name: "read_file", summary: path, resultPreview: `${path}:1` });

describe("M72 §3 groupToolRuns (the pure transform)", () => {
  it("consecutive same-name observation tools become one group row", () => {
    const rows = groupToolRuns([read("a"), read("b"), read("c")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("toolgroup");
    if (rows[0]?.kind === "toolgroup") {
      expect(rows[0].name).toBe("read_file");
      expect(rows[0].entries).toHaveLength(3);
    }
  });

  it("greps/globs/web lookups group too; singletons stay plain entries", () => {
    const grep = (p: string): HistoryEntry => ({ kind: "tool", name: "grep", summary: p });
    const rows = groupToolRuns([grep("x"), grep("y"), read("a")]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.kind).toBe("toolgroup");
    expect(rows[1]?.kind).toBe("entry");
  });

  it("write-class tools and errors never collapse", () => {
    const edit = (p: string): HistoryEntry => ({ kind: "tool", name: "edit", summary: p });
    const bash = (c: string): HistoryEntry => ({ kind: "tool", name: "shell", summary: c });
    expect(groupToolRuns([edit("a"), edit("b"), edit("c")]).every((r) => r.kind === "entry")).toBe(true);
    expect(groupToolRuns([bash("a"), bash("b")]).every((r) => r.kind === "entry")).toBe(true);
    // An errored read breaks the run and stays loud.
    const err = { kind: "tool", name: "read_file", summary: "x", isError: true } as const;
    const rows = groupToolRuns([read("a"), err, read("b")]);
    expect(rows.every((r) => r.kind === "entry")).toBe(true);
  });

  it("different names or kinds break the run", () => {
    const rows = groupToolRuns([
      read("a"),
      { kind: "tool", name: "grep", summary: "p" },
      read("b"),
      { kind: "notice", text: "n" },
      read("c"),
      read("d"),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["entry", "entry", "entry", "entry", "toolgroup"]);
  });

  it("non-tool kinds pass through untouched", () => {
    const history: HistoryEntry[] = [
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "done" },
    ];
    expect(groupToolRuns(history)).toEqual(history.map((entry) => ({ kind: "entry", entry })));
  });
});

describe("M72 §3 HistoryList collapse (advanced tool stream)", () => {
  it("a read ×3 run renders ONE group header, collapsed by default", () => {
    const c = mount(<HistoryList history={[read("a"), read("b"), read("c")]} />);
    const head = c.querySelector(".toolgroup .grp-head");
    expect(head?.textContent).toContain("read_file ×3");
    expect(c.querySelectorAll(".toolcard")).toHaveLength(0); // collapsed: no cards
    expect(head?.getAttribute("aria-expanded")).toBe("false");
  });

  it("expanding reveals every card intact; collapsing hides them again", () => {
    const c = mount(<HistoryList history={[read("a"), read("b"), read("c")]} />);
    const head = c.querySelector<HTMLButtonElement>(".toolgroup .grp-head");
    act(() => {
      head?.dispatchEvent(new Event("click", { bubbles: true }));
    });
    expect(head?.getAttribute("aria-expanded")).toBe("true");
    const cards = c.querySelectorAll(".toolcard");
    expect(cards).toHaveLength(3);
    expect(cards[0]?.textContent).toContain("✓ read_file(a)"); // fix round 1: mockup-v2 glyphs
    expect(cards[2]?.textContent).toContain("↳ c:1");
    act(() => {
      head?.dispatchEvent(new Event("click", { bubbles: true }));
    });
    expect(c.querySelectorAll(".toolcard")).toHaveLength(0);
    expect(c.querySelector(".toolgroup")?.getAttribute("data-open")).toBe("false");
  });

  it("mixed history: groups sit between the ordinary entries, unchanged", () => {
    const c = mount(
      <HistoryList
        history={[
          { kind: "user", text: "look" },
          read("a"),
          read("b"),
          { kind: "assistant", text: "# found it" },
          { kind: "tool", name: "edit", summary: "src/a.ts", resultPreview: "ok" },
        ]}
      />,
    );
    const text = c.textContent ?? "";
    expect(text).toContain("look");
    expect(text).toContain("read_file ×2");
    // 0.3.3 标题去 # 前缀后的正确 pin：标题文本渲染、无字面 #（旧断言
    // "# found it" 红了一个版本周期——0.3.5 ui-review-r7 同款漏扫）。
    expect(text).toContain("found it"); // assistant markdown still rendered
    expect(text).toContain("✓ edit(src/a.ts)"); // write-class card NOT grouped
    expect(c.querySelector(".msg-user .bub")?.textContent).toBe("look");
  });

  it("the whole history renders stable across a parent re-render (rows memoized)", () => {
    const history = [read("a"), read("b")];
    const c = mount(<HistoryList history={history} />);
    const before = c.innerHTML;
    act(() => {
      root?.render(<HistoryList history={history} />);
    });
    expect(c.innerHTML).toBe(before);
  });

  it("M76-ux2 §2: a long tool result caps at 8 lines; 展开 shows up to 50; 收起 returns to 8", () => {
    const preview = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join("\n");
    const c = mount(
      <HistoryList history={[{ kind: "tool", name: "shell", summary: "npm t", resultPreview: preview }]} />,
    );
    const result = (): HTMLElement => c.querySelector(".toolcard .result") as HTMLElement;
    const toggle = (): HTMLButtonElement | null => c.querySelector(".toolcard .result .activity-toggle");
    // Truncated: 8 lines + the honest-total toggle.
    expect(result().textContent).toContain("L8");
    expect(result().textContent).not.toContain("L9");
    expect(result().getAttribute("data-truncated")).toBe("true");
    expect(toggle()?.textContent).toBe("展开 ▾ (20 行)");
    act(() => {
      toggle()?.click();
    });
    // Expanded: all 20 lines.
    expect(result().textContent).toContain("L20");
    expect(toggle()?.textContent).toBe("收起 ▴");
    act(() => {
      toggle()?.click();
    });
    // Collapsed again.
    expect(result().textContent).not.toContain("L9");
    expect(toggle()?.textContent).toBe("展开 ▾ (20 行)");
  });

  it("M76-ux2 §2: a short result renders whole — no toggle, no truncation flag", () => {
    const c = mount(
      <HistoryList
        history={[{ kind: "tool", name: "shell", summary: "npm t", resultPreview: "one\nline done" }]}
      />,
    );
    const result = c.querySelector(".toolcard .result") as HTMLElement;
    expect(result.textContent).toContain("one");
    expect(result.textContent).toContain("line done");
    expect(result.getAttribute("data-truncated")).toBe("false");
    expect(c.querySelector(".activity-toggle")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 0.3.9 — 注入上下文卡（card:true 的 notice）：模型可见的会话内容退出
// 通知折叠（胶囊专属 harness 内部状态），各自独立成行。
// ---------------------------------------------------------------------------
describe("0.3.9 — injected-context cards never fold into noticegroups", () => {
  it("two identical card notices stay separate entry rows; non-card notices still fold", () => {
    const card = { kind: "notice", text: "injected ctx", card: true } as const;
    const rows = groupToolRuns([card, card]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === "entry")).toBe(true);
    const plain = { kind: "notice", text: "warn once" } as const;
    const folded = groupToolRuns([plain, plain]);
    expect(folded).toHaveLength(1);
    expect(folded[0]?.kind).toBe("noticegroup");
  });
});
