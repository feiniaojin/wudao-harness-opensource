// @vitest-environment jsdom
// ω99-125 — 交付物文件卡, RED-first, arc B. A tool entry carrying `file`
// (the driver's name-gated receipt extraction, arc A) renders a FILE CARD
// ROW between the activity head and the body: type icon (derived from the
// name's extension in the RENDER layer — never on the wire), the file name,
// an honest KB size, and one 「在访达中显示」 button that invokes the Rust
// reveal_path command through the null-safe tauri seam. Entries WITHOUT the
// field render byte-identically to before (the pinned baselines below were
// captured from the pre-change DOM); error entries never show a card.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SimpleActivityCard, fileIconOf } from "../src/components/SimpleActivityCard.js";
import { tauriInvokeCommand } from "../src/tauri-invoke.js";

// The seam stays real except the one command the card fires (jsdom has no
// bridge; the real seam would read null and swallow — here we SPY the call).
vi.mock("../src/tauri-invoke.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tauri-invoke.js")>();
  return {
    ...actual,
    tauriInvokeCommand: vi.fn(async (): Promise<unknown | null> => null),
  };
});

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
  vi.clearAllMocks();
});

// The driver-landed receipt (arc A pins the same triple on the wire).
const XLSX_FILE = { path: "/tmp/ws/报表.xlsx", name: "报表.xlsx", bytes: 1536 } as const;

describe("ω99-125 B — the deliverable file card row", () => {
  it("renders under the head: icon + name + honest KB + reveal button", () => {
    const c = mount(
      <SimpleActivityCard entry={{ kind: "tool", name: "make_xlsx", summary: "", resultPreview: "已生成 Excel：报表.xlsx", file: { ...XLSX_FILE } }} />,
    );
    const card = c.querySelector(".act .act-file-card") as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("报表.xlsx");
    expect(card.textContent).toContain("1.5 KB");
    // ω99-129 added the primary 「打开」 action before this one — the reveal
    // assertion now targets the LAST button instead of "the" button.
    const btns = card.querySelectorAll("button");
    expect(btns[btns.length - 1]?.textContent).toBe("在访达中显示");
    // 116 弧 C：类型标从 emoji 位图（📊）换 Icon 细线字形——textContent 不再
    // 承载它，svg 在位 + 派生映射在下一个用例钉。
    expect(card.querySelector(".act-file-icon svg")).not.toBeNull();
  });

  it("derives the icon per extension: pptx → film; others → file-text (116 弧 C 细线集)", () => {
    expect(fileIconOf("报表.xlsx")).toBe("chart-column");
    expect(fileIconOf("汇报.pptx")).toBe("film");
    expect(fileIconOf("交付.bin")).toBe("file-text");
    const c = mount(
      <SimpleActivityCard entry={{ kind: "tool", name: "make_pptx", summary: "", resultPreview: "x", file: { path: "/w/汇报.pptx", name: "汇报.pptx", bytes: 9 } }} />,
    );
    expect((c.querySelector(".act .act-file-card .act-file-icon") as HTMLElement)?.querySelector("svg")).not.toBeNull();
  });

  it("sits between the head and the body (ActHead 之下一行)", async () => {
    const c = mount(
      <SimpleActivityCard entry={{ kind: "tool", name: "make_xlsx", summary: "", resultPreview: "line1\nline2", file: { ...XLSX_FILE } }} />,
    );
    act(() => {
      (c.querySelector(".act .act-row") as HTMLButtonElement).click();
    });
    const head = c.querySelector(".act > .act-row") as HTMLElement;
    const card = c.querySelector(".act > .act-file-card") as HTMLElement;
    const body = c.querySelector(".act > .act-body") as HTMLElement;
    expect(card.previousElementSibling).toBe(head);
    expect(card.nextElementSibling).toBe(body);
  });

  it("clicking the button invokes reveal_path with the absolute path", async () => {
    const c = mount(
      <SimpleActivityCard entry={{ kind: "tool", name: "make_xlsx", summary: "", resultPreview: "x", file: { ...XLSX_FILE } }} />,
    );
    await act(async () => {
      // ω99-129 added 打开 (open_path) as the FIRST button — target reveal
      // by its label, not by "the" button, so both actions stay pinned.
      const reveal = Array.from(c.querySelectorAll(".act-file-card button")).find(
        (b) => b.textContent === "在访达中显示",
      ) as HTMLButtonElement;
      reveal.click();
    });
    expect(vi.mocked(tauriInvokeCommand)).toHaveBeenCalledWith("reveal_path", { path: "/tmp/ws/报表.xlsx" });
  });

  it("an error entry never shows the file card (red line: 错误卡不带卡)", () => {
    const c = mount(
      <SimpleActivityCard entry={{ kind: "tool", name: "make_xlsx", summary: "", isError: true, resultPreview: "make_xlsx: 写入失败", file: { ...XLSX_FILE } }} />,
    );
    expect(c.querySelector(".act .act-file-card")).toBeNull();
  });
});

// --- 老条目零回归: the no-file DOM is BYTE-identical to the pre-change render.
// The two literals below were captured from the worktree at 98e84cb9 (arc B
// untouched) — svg geometry, attribute order, the expanded body's embedded
// newline and all. Any DOM drift the file-card branch introduces into the
// fieldless path breaks these pins.

const BASELINE_COLLAPSED =
  '<div class="act" data-kind="read" data-status="ok" data-err="false" data-open="false"><button type="button" class="act-row" data-status="ok" aria-expanded="false"><span class="act-st st-ok" aria-hidden="true"><svg width="11.700000000000001" height="11.700000000000001" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12.5 9.5 17.5 19.5 7"></path></svg></span><span class="sr-only">完成</span><span class="act-verb">读取</span><span class="act-file">src/a.ts</span><span class="act-tail">· 1.5s</span><svg width="10.8" height="10.8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="act-chev"><path d="M6 9l6 6 6-6"></path></svg></button></div>';

const BASELINE_EXPANDED =
  '<div class="act" data-kind="read" data-status="ok" data-err="false" data-open="true"><button type="button" class="act-row" data-status="ok" aria-expanded="true"><span class="act-st st-ok" aria-hidden="true"><svg width="11.700000000000001" height="11.700000000000001" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12.5 9.5 17.5 19.5 7"></path></svg></span><span class="sr-only">完成</span><span class="act-verb">读取</span><span class="act-file">src/a.ts</span><span class="act-tail"></span><svg width="10.8" height="10.8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="act-chev"><path d="M6 9l6 6 6-6"></path></svg></button><div class="act-body read" data-truncated="false" style="max-height: 132px;"><span class="blocktext">line1\nline2</span></div></div>';

describe("ω99-125 B — no `file` field ⇒ zero DOM change (byte pins)", () => {
  it("collapsed no-file card renders the exact pre-change bytes", () => {
    const c = mount(
      <SimpleActivityCard entry={{ kind: "tool", name: "read_file", summary: "src/a.ts", resultPreview: "line1\nline2", durationMs: 1500 }} />,
    );
    expect(c.innerHTML).toBe(BASELINE_COLLAPSED);
  });
  it("expanded no-file card renders the exact pre-change bytes", () => {
    const c = mount(
      <SimpleActivityCard entry={{ kind: "tool", name: "read_file", summary: "src/a.ts", resultPreview: "line1\nline2" }} />,
    );
    act(() => {
      (c.querySelector(".act .act-row") as HTMLButtonElement).click();
    });
    expect(c.innerHTML).toBe(BASELINE_EXPANDED);
  });
});

