// @vitest-environment jsdom
// 墨线 T11 (spec §2 任务板): the task board's ink-line shell — .todo >
// .todo-bar (a 2px accent progress line whose inline width = done/total)
// + .todo-item rows (.todo-box 16px square checkbox [.done → ok 弱染
// fill + IconCheck] + a label span). The ☑/◐/☐ text marks retire into the
// checkbox; board.ts's classification stays the single source. Colors read
// off the mounted sheet through decl() (jsdom never resolves var()).
import { afterEach, describe, expect, it } from "vitest";
import { stylesCss } from "./styles-source.js";
import "../src/styles.css";
import { TodoBoard } from "../src/components/TodoBoard.js";
import { decl, mount, unmount } from "./css-test-utils.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(unmount);

/** The raw sheet text — the width-transition pin reads the source (cssstyle
 *  drops var()-bearing transition shorthands, the .act precedent). */
const STYLES_CSS = stylesCss;

const LINES = ["☑ done thing", "◐ wip thing", "☐ pending thing"];

describe("墨线 T11 — 任务板 (.todo)", () => {
  it("todo: 2px accent progress bar on top + 16px square checkbox", () => {
    const c = mount(<TodoBoard done={2} total={4} lines={LINES} />);
    expect(c.querySelector(".todo > .todo-bar")).toBeTruthy();
    expect(c.querySelector(".todo-box")).toBeTruthy();
    // The bar's inline width is the done/total ratio (2/4 → 50%).
    expect((c.querySelector(".todo-bar") as HTMLElement).style.width).toBe("50%");
  });

  it("the checkbox replaces the text mark: .done boxes carry IconCheck, labels are mark-stripped", () => {
    const c = mount(<TodoBoard done={1} total={3} lines={LINES} />);
    const boxes = [...c.querySelectorAll(".todo-item > .todo-box")] as HTMLElement[];
    expect(boxes).toHaveLength(3);
    // Exactly the ☑ line's box is .done — and only it renders the check.
    expect(boxes.filter((b) => b.classList.contains("done"))).toHaveLength(1);
    expect(c.querySelector(".todo-box.done svg")).not.toBeNull();
    expect(c.querySelectorAll(".todo-box svg")).toHaveLength(1);
    // The ☐/◐ lines keep empty boxes (the interface has no third state).
    expect(boxes[1]?.querySelector("svg")).toBeNull();
    expect(boxes[2]?.querySelector("svg")).toBeNull();
    // Labels: the glyph + its space are stripped, the text itself intact.
    const labels = [...c.querySelectorAll(".todo-item > span:not(.todo-box)")].map((s) => s.textContent);
    expect(labels).toEqual(["done thing", "wip thing", "pending thing"]);
  });

  it("the bar rides the tokens: 2px ok-semantic line, width transition on --dur-med; the box is 16px on hair-2", () => {
    mount(<TodoBoard done={1} total={2} lines={LINES} />);
    expect(decl(".todo-bar", "height")).toBe("2px");
    // 116 弧 A: 完成度进度走 ok 语义族（.board .done/.diff .add 同语）。
    expect(decl(".todo-bar", "background")).toBe("var(--ok)");
    // cssstyle drops the var()-bearing transition shorthand — pin the sheet.
    expect(STYLES_CSS).toMatch(/\.todo-bar\s*\{[^}]*transition:\s*width var\(--dur-med\) var\(--ease\);/s);
    expect(decl(".todo-box", "width")).toBe("16px");
    expect(decl(".todo-box", "height")).toBe("16px");
    // tokfinish radius 归档: the ruled 4px optical yields to --radius-sm —
    // the sheet-wide radius gate retires bare px radii (equivalent re-pin).
    expect(decl(".todo-box", "border-radius")).toBe("var(--radius-sm)");
    expect(decl(".todo-box", "border-color")).toBe("var(--hair-2)");
    expect(decl(".todo-box", "color")).toBe("var(--ok)");
  });

  it(".todo-box.done fills the ok tint with the ok channel border mix (116 弧 A)", () => {
    mount(<TodoBoard done={1} total={3} lines={LINES} />);
    expect(decl(".todo-box.done", "background")).toBe("rgb(var(--ok-rgb) / .12)");
    expect(decl(".todo-box.done", "border-color")).toBe("rgb(var(--ok-rgb) / .3)");
  });

  // 墨线 T15 终门 — the checkbox speaks EXACTLY two classes: bare `todo-box`
  // for pending/wip and `todo-box done` for the finished one (the interface
  // has no third state — wip renders as a bare box).
  it("T15 gate — .todo-box class names: bare box vs `todo-box done` (exact)", () => {
    const c = mount(<TodoBoard done={1} total={3} lines={LINES} />);
    const boxes = [...c.querySelectorAll(".todo-item > .todo-box")] as HTMLElement[];
    expect(boxes[0]?.className).toBe("todo-box done"); // the ☑ line
    expect(boxes[1]?.className).toBe("todo-box"); // the ◐ line — wip is NOT a class
    expect(boxes[2]?.className).toBe("todo-box"); // the ☐ line
  });

  it("an unmarked line classifies pending: empty box, raw label kept whole", () => {
    const c = mount(<TodoBoard done={0} total={1} lines={["plain item"]} />);
    expect(c.querySelector(".todo-box.done")).toBeNull();
    expect(c.querySelector(".todo-box svg")).toBeNull();
    expect(c.querySelector(".todo-item > span:not(.todo-box)")?.textContent).toBe("plain item");
  });
});
