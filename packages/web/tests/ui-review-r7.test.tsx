// @vitest-environment jsdom
// ui-review-r7 I3 — the hook-warn notice fold. agent-driver's hookWarnSink
// (agent-driver.ts R6-I1) appends ONE notice per fire, so a hook that warns
// on every tool call spammed a `.entry-notice` row each — groupToolRuns
// folded only COLLAPSIBLE_TOOLS. The fold now extends to runs (≥2) of
// CONSECUTIVE IDENTICAL notice texts: `text ×N`, the same expand/collapse
// contract the tool runs render. View-side only (the history entries stay
// immutable); a differing text breaks the run — interleaved distinct
// warnings each keep their own row.
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

const WARN = "⚠️ hook guard: shell blocked by policy";
const warn = (): HistoryEntry => ({ kind: "notice", text: WARN });
const warnText = (text: string): HistoryEntry => ({ kind: "notice", text });
const read = (path: string): HistoryEntry => ({ kind: "tool", name: "read_file", summary: path });

describe("r7 I3 — groupToolRuns folds repeated identical notices", () => {
  it("3 identical notices become ONE noticegroup row carrying all three", () => {
    const rows = groupToolRuns([warn(), warn(), warn()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("noticegroup");
    if (rows[0]?.kind === "noticegroup") {
      expect(rows[0].text).toBe(WARN);
      expect(rows[0].entries).toHaveLength(3);
    }
  });

  it("interleaved different texts never fold", () => {
    const rows = groupToolRuns([warnText("a"), warnText("b"), warnText("a")]);
    expect(rows.map((r) => r.kind)).toEqual(["entry", "entry", "entry"]);
  });

  it("a lone notice stays a plain row; a 2-run folds (the tool runs' ≥2 rule)", () => {
    expect(groupToolRuns([warnText("a")]).map((r) => r.kind)).toEqual(["entry"]);
    const rows = groupToolRuns([warnText("a"), warnText("a")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("noticegroup");
    if (rows[0]?.kind === "noticegroup") expect(rows[0].entries).toHaveLength(2);
  });

  it("a non-notice entry between identical notices breaks the run", () => {
    const rows = groupToolRuns([warn(), { kind: "user", text: "hi" }, warn()]);
    expect(rows.map((r) => r.kind)).toEqual(["entry", "entry", "entry"]);
  });

  it("notice runs and tool runs fold independently, in order", () => {
    const rows = groupToolRuns([warn(), warn(), read("a"), read("b"), warnText("other")]);
    expect(rows.map((r) => r.kind)).toEqual(["noticegroup", "toolgroup", "entry"]);
  });
});

describe("r7 I3 — HistoryList renders the folded notice run", () => {
  it("3 identical hook warns render ONE 「… ×3」 row, collapsed by default", () => {
    const c = mount(<HistoryList history={[warn(), warn(), warn()]} />);
    const head = c.querySelector(".noticegroup .grp-head");
    // P2 §6.4 通知变体制：⚠️ 前缀渲染面剥离——正文不带位图 emoji，头行带 warn 变体。
    expect(head?.textContent).toContain("hook guard: shell blocked by policy ×3");
    expect(head?.textContent).not.toContain("⚠️");
    expect(head?.getAttribute("data-variant")).toBe("warn");
    expect(c.querySelectorAll(".entry-notice")).toHaveLength(0); // collapsed: no rows
    expect(head?.getAttribute("aria-expanded")).toBe("false");
  });

  it("expanding reveals every fire's own row; collapsing hides them again", () => {
    const c = mount(<HistoryList history={[warn(), warn(), warn()]} />);
    const head = c.querySelector<HTMLButtonElement>(".noticegroup .grp-head");
    act(() => {
      head?.dispatchEvent(new Event("click", { bubbles: true }));
    });
    expect(head?.getAttribute("aria-expanded")).toBe("true");
    const rows = c.querySelectorAll(".entry-notice");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toBe("hook guard: shell blocked by policy"); // P2：前缀已剥
    expect(rows[2]?.textContent).toBe("hook guard: shell blocked by policy");
    act(() => {
      head?.dispatchEvent(new Event("click", { bubbles: true }));
    });
    expect(c.querySelectorAll(".entry-notice")).toHaveLength(0);
    expect(c.querySelector(".noticegroup")?.getAttribute("data-open")).toBe("false");
  });

  it("interleaved different warn texts render one row each — no fold", () => {
    const c = mount(
      <HistoryList history={[warnText("⚠️ warn A"), warnText("⚠️ warn B"), warnText("⚠️ warn A")]} />,
    );
    expect(c.querySelector(".noticegroup")).toBeNull();
    const rows = c.querySelectorAll(".entry-notice");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toBe("warn A"); // P2：前缀已剥
    expect(rows[1]?.textContent).toBe("warn B");
  });

  it("the spam scene end-to-end: the notice run and the tool run both fold between ordinary entries", () => {
    const c = mount(
      <HistoryList
        history={[
          { kind: "user", text: "run it" },
          read("a"),
          read("b"),
          read("c"),
          warn(),
          warn(),
          warn(),
          { kind: "assistant", text: "# done" },
        ]}
      />,
    );
    const text = c.textContent ?? "";
    expect(text).toContain("read_file ×3"); // the observation run still folds
    expect(text).toContain("hook guard: shell blocked by policy ×3"); // the hook-warn spam folds too（P2：前缀已剥）
    expect(text).toContain("run it"); // the user echo renders
    // 0.3.3 (mockup-v2): headings drop the literal # — the assistant reply's
    // first line renders as a tiered heading "done", not "# done".
    expect(text).toContain("done"); // the assistant markdown renders
    expect(c.querySelectorAll(".entry-notice")).toHaveLength(0); // both groups collapsed
  });
});
