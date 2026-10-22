// @vitest-environment jsdom
// ω99-129 — the deliverable file card's SECOND action, RED-first. The card
// (ω99-125) grows a primary 「打开」 button that fires the Rust open_path
// command (the system default application — docx/xlsx/pptx open in Word/
// Numbers/Keynote, and ⌘P 存 PDF rides the OS pipeline: the make_pdf
// ruling's alternative, not a self-built PDF engine). Order is pinned:
// 打开 FIRST (primary), 在访达中显示 second (the ω99-125 action keeps its
// own invocation pin in omega99-125-file-card.test.tsx). The browser
// degradation is reveal's precedent verbatim: no bridge → the seam
// resolves null → silent no-op, the button stays.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SimpleActivityCard } from "../src/components/SimpleActivityCard.js";
import { tauriInvokeCommand } from "../src/tauri-invoke.js";

// The seam stays real except the one command under test (jsdom has no
// bridge; the real seam would read null and swallow — here we SPY it).
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

// The driver-landed receipt (arc A of ω99-125 pins this triple on the wire).
const XLSX_FILE = { path: "/tmp/ws/报表.xlsx", name: "报表.xlsx", bytes: 1536 } as const;

const cardButtons = (c: HTMLElement): HTMLButtonElement[] =>
  Array.from(c.querySelectorAll(".act .act-file-card button")) as HTMLButtonElement[];

// noUncheckedIndexedAccess: index access is `T | undefined` — find by label
// instead (the same cast pattern the ω99-125 reveal click uses).
const buttonByText = (c: HTMLElement, label: string): HTMLButtonElement =>
  cardButtons(c).find((b) => b.textContent === label) as HTMLButtonElement;

describe("ω99-129 — the deliverable file card's 打开 action", () => {
  it("renders TWO actions in order: 打开 (primary) then 在访达中显示", () => {
    const c = mount(
      <SimpleActivityCard entry={{ kind: "tool", name: "make_xlsx", summary: "", resultPreview: "已生成 Excel：报表.xlsx", file: { ...XLSX_FILE } }} />,
    );
    const btns = cardButtons(c);
    expect(btns).toHaveLength(2);
    expect(btns.map((b) => b.textContent)).toEqual(["打开", "在访达中显示"]);
  });

  it("clicking 打开 invokes open_path with the absolute path", async () => {
    const c = mount(
      <SimpleActivityCard entry={{ kind: "tool", name: "make_xlsx", summary: "", resultPreview: "x", file: { ...XLSX_FILE } }} />,
    );
    await act(async () => {
      buttonByText(c, "打开").click();
    });
    expect(vi.mocked(tauriInvokeCommand)).toHaveBeenCalledWith("open_path", { path: "/tmp/ws/报表.xlsx" });
  });

  it("the two actions fire their own command — 打开≠reveal, no cross-wiring", async () => {
    const c = mount(
      <SimpleActivityCard entry={{ kind: "tool", name: "make_pptx", summary: "", resultPreview: "x", file: { ...XLSX_FILE } }} />,
    );
    await act(async () => {
      buttonByText(c, "打开").click();
      buttonByText(c, "在访达中显示").click();
    });
    expect(vi.mocked(tauriInvokeCommand)).toHaveBeenNthCalledWith(1, "open_path", { path: "/tmp/ws/报表.xlsx" });
    expect(vi.mocked(tauriInvokeCommand)).toHaveBeenNthCalledWith(2, "reveal_path", { path: "/tmp/ws/报表.xlsx" });
  });

  it("browser degradation = reveal's precedent: a null-resolving seam is a silent no-op (no throw, button stays)", async () => {
    const c = mount(
      <SimpleActivityCard entry={{ kind: "tool", name: "make_xlsx", summary: "", resultPreview: "x", file: { ...XLSX_FILE } }} />,
    );
    await expect(
      act(async () => {
        buttonByText(c, "打开").click(); // the mocked seam resolves null — swallowed
      }),
    ).resolves.not.toThrow();
    expect(buttonByText(c, "打开").textContent).toBe("打开"); // the button STAYS
  });
});
