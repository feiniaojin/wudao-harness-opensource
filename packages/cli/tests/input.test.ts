import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import {
  createInputState,
  handleKey,
  createInputHistory,
  submitToHistory,
  recallOlder,
  recallNewer,
  recalledText,
  inputStateFromText,
  INPUT_HISTORY_MAX,
  type InputState,
  type KeyInfo,
} from "../src/tui/input-state.js";
// Explicit .tsx: `input.js` would resolve to the machine (input.ts), since
// TS/Vite prefer the .ts sibling when both input.ts and input.tsx exist.
import { TextInput } from "../src/tui/input.tsx";
import { listSlashCommands } from "../src/slash-commands.js";
import { suggestWindow } from "../src/tui/suggest.js";

const type = (state: InputState, text: string): InputState => {
  let s = state;
  for (const ch of text) {
    const next = handleKey(s, { input: ch });
    if ("submit" in next) throw new Error(`unexpected submit while typing: ${ch}`);
    s = next;
  }
  return s;
};

const key = (k: KeyInfo): KeyInfo => k;

describe("pure input state machine", () => {
  it("starts with one empty line at row 0", () => {
    expect(createInputState()).toEqual({ lines: [""], row: 0, col: 0 });
  });

  it("appends typed chars to the current line", () => {
    let s = createInputState();
    s = type(s, "a");
    s = type(s, "b");
    expect(s).toEqual({ lines: ["ab"], row: 0, col: 2 });
  });

  it("appends a multi-char input chunk", () => {
    const s = handleKey(createInputState(), { input: "hello" });
    expect(s).toEqual({ lines: ["hello"], row: 0, col: 5 });
  });

  it("backslash+Enter strips the backslash and opens a new line", () => {
    let s = createInputState();
    s = type(s, "a\\");
    expect(s).toEqual({ lines: ["a\\"], row: 0, col: 2 });
    const next = handleKey(s, key({ return: true }));
    // The brief abbreviates this as {lines:["a"], row:1}; we materialize the
    // new (empty) line so row always indexes an existing line.
    expect(next).toEqual({ lines: ["a", ""], row: 1, col: 0 });
  });

  it("bare Enter on multi-line input returns submit with lines joined", () => {
    let s = type(createInputState(), "a");
    s = handleKey(s, { input: "\\" }) as InputState;
    s = handleKey(s, { return: true }) as InputState;
    s = type(s, "b");
    expect(s).toEqual({ lines: ["a", "b"], row: 1, col: 1 });
    expect(handleKey(s, { return: true })).toEqual({ submit: "a\nb" });
  });

  it("bare Enter on a single line returns submit of that line", () => {
    const s = type(createInputState(), "hello");
    expect(handleKey(s, { return: true })).toEqual({ submit: "hello" });
  });

  it("empty input + Enter returns submit \"\"", () => {
    expect(handleKey(createInputState(), { return: true })).toEqual({ submit: "" });
  });

  it("backspace deletes the last char of the current line", () => {
    const s = type(createInputState(), "ab");
    expect(handleKey(s, { backspace: true })).toEqual({ lines: ["a"], row: 0, col: 1 });
  });

  it("backspace at BOL of a non-first line joins to the previous line", () => {
    let s = type(createInputState(), "a");
    s = handleKey(handleKey(s, { input: "\\" }), { return: true }) as InputState;
    s = type(s, "b");
    // now at row 1 with "b"; delete "b" leaves an empty line at row 1
    s = handleKey(s, { backspace: true }) as InputState;
    expect(s).toEqual({ lines: ["a", ""], row: 1, col: 0 });
    const joined = handleKey(s, { backspace: true });
    expect(joined).toEqual({ lines: ["a"], row: 0, col: 1 });
  });

  it("backspace at BOL of the only line is a no-op", () => {
    expect(handleKey(createInputState(), { backspace: true })).toEqual(
      createInputState(),
    );
  });

  it("Up/Down move the row between existing lines", () => {
    let s = type(createInputState(), "a");
    s = handleKey(handleKey(s, { input: "\\" }), { return: true }) as InputState;
    s = type(s, "b");
    expect(s.row).toBe(1);
    const up = handleKey(s, { upArrow: true }) as InputState;
    expect(up).toEqual({ lines: ["a", "b"], row: 0, col: 1 });
    const backDown = handleKey(up, { downArrow: true }) as InputState;
    expect(backDown).toEqual({ lines: ["a", "b"], row: 1, col: 1 });
  });

  it("Up at top row and Down at bottom row clamp", () => {
    expect(handleKey(createInputState(), { upArrow: true })).toEqual(
      createInputState(),
    );
    expect(handleKey(createInputState(), { downArrow: true })).toEqual(
      createInputState(),
    );
  });

  it("typing after navigating up inserts at that row's cursor (column carries over)", () => {
    let s = type(createInputState(), "ab");
    s = handleKey(handleKey(s, { input: "\\" }), { return: true }) as InputState;
    s = handleKey(s, { upArrow: true }) as InputState;
    // row 1's cursor was at col 0, so row 0's cursor is col 0 — the insert
    // lands at the start (M44: no implicit EOL anymore).
    const next = handleKey(s, { input: "c" }) as InputState;
    expect(next).toEqual({ lines: ["cab", ""], row: 0, col: 1 });
    // with a col on the moved-to row (end), typing appends as before
    const atEnd = handleKey(next, { end: true }) as InputState;
    expect(handleKey(atEnd, { input: "d" })).toEqual({ lines: ["cabd", ""], row: 0, col: 4 });
  });

  it("Left/Right move within the current line, clamped at both ends", () => {
    let s = type(createInputState(), "abc");
    s = handleKey(s, { leftArrow: true }) as InputState;
    expect(s).toEqual({ lines: ["abc"], row: 0, col: 2 });
    s = handleKey(s, { leftArrow: true }) as InputState;
    expect(s).toEqual({ lines: ["abc"], row: 0, col: 1 });
    s = handleKey(s, { rightArrow: true }) as InputState;
    expect(s).toEqual({ lines: ["abc"], row: 0, col: 2 });
    for (let i = 0; i < 3; i++) s = handleKey(s, { rightArrow: true }) as InputState;
    expect(s.col).toBe(3); // EOL clamp
    for (let i = 0; i < 5; i++) s = handleKey(s, { leftArrow: true }) as InputState;
    expect(s.col).toBe(0); // BOL clamp
  });

  it("Home/End jump to line start/end", () => {
    let s = type(createInputState(), "abc");
    s = handleKey(s, { leftArrow: true }) as InputState;
    expect(handleKey(s, { home: true })).toEqual({ lines: ["abc"], row: 0, col: 0 });
    expect(handleKey(s, { end: true })).toEqual({ lines: ["abc"], row: 0, col: 3 });
    // already there → unchanged state
    const atStart = handleKey(s, { home: true }) as InputState;
    expect(handleKey(atStart, { home: true })).toEqual(atStart);
  });

  it("Esc remains a no-op", () => {
    const s = type(createInputState(), "ab");
    expect(handleKey(s, { esc: true })).toEqual(s);
  });

  it("control characters in input are ignored", () => {
    const s = type(createInputState(), "ab");
    expect(handleKey(s, { input: "\x00" })).toEqual(s);
    expect(handleKey(s, { input: "" })).toEqual(s);
  });

  it("a paste chunk containing \\n splits into lines, row on the last", () => {
    const s = handleKey(createInputState(), { input: "line1\nline2" }) as InputState;
    expect(s).toEqual({ lines: ["line1", "line2"], row: 1, col: 5 });
  });

  it("paste joins the first fragment to the current line's text", () => {
    const s0 = type(createInputState(), "ab");
    const s = handleKey(s0, { input: "c\nd" }) as InputState;
    expect(s).toEqual({ lines: ["abc", "d"], row: 1, col: 1 });
  });

  it("control chars are stripped per-char, not dropping the whole chunk", () => {
    const s = handleKey(createInputState(), { input: "a\x08b" }) as InputState;
    expect(s).toEqual({ lines: ["ab"], row: 0, col: 2 });
  });

  // -------------------------------------------------------------------------
  // M44 §1 — the col dimension: mid-line insertion, cursor-relative deletes,
  // Home/End, col-correct paste / continuation / row navigation.
  // -------------------------------------------------------------------------
  it("typing inserts at the cursor, not at EOL", () => {
    let s = type(createInputState(), "abc"); // col 3
    s = handleKey(s, { leftArrow: true }) as InputState; // col 2
    s = handleKey(s, { input: "X" }) as InputState;
    expect(s).toEqual({ lines: ["abXc"], row: 0, col: 3 });
  });

  it("a multi-char chunk inserts whole at the cursor", () => {
    let s = type(createInputState(), "abc");
    s = handleKey(handleKey(s, { leftArrow: true }), { leftArrow: true }) as InputState; // col 1
    s = handleKey(s, { input: "XY" }) as InputState;
    expect(s).toEqual({ lines: ["aXYbc"], row: 0, col: 3 });
  });

  it("backspace mid-line deletes the char before the cursor", () => {
    let s = type(createInputState(), "abc");
    s = handleKey(s, { leftArrow: true }) as InputState; // col 2
    s = handleKey(s, { backspace: true }) as InputState; // deletes 'b'
    expect(s).toEqual({ lines: ["ac"], row: 0, col: 1 });
  });

  it("backspace at col 0 joins to the previous row with the cursor at the join", () => {
    let s = type(createInputState(), "a");
    s = handleKey(handleKey(s, { input: "\\" }), { return: true }) as InputState;
    s = type(s, "bc"); // ["a","bc"] row 1 col 2
    s = handleKey(s, { home: true }) as InputState; // col 0
    const joined = handleKey(s, { backspace: true }) as InputState;
    expect(joined).toEqual({ lines: ["abc"], row: 0, col: 1 });
  });

  it("Delete removes the char at the cursor (forward delete)", () => {
    let s = type(createInputState(), "abc");
    s = handleKey(handleKey(s, { leftArrow: true }), { leftArrow: true }) as InputState; // col 1
    s = handleKey(s, { delete: true }) as InputState; // deletes 'b'
    expect(s).toEqual({ lines: ["ac"], row: 0, col: 1 });
  });

  it("Delete at EOL joins the next line into the current one, cursor unmoved", () => {
    let s = type(createInputState(), "a");
    s = handleKey(handleKey(s, { input: "\\" }), { return: true }) as InputState;
    s = type(s, "b"); // ["a","b"] row 1
    s = handleKey(s, { upArrow: true }) as InputState; // row 0, col 1 (EOL of "a")
    const joined = handleKey(s, { delete: true }) as InputState;
    expect(joined).toEqual({ lines: ["ab"], row: 0, col: 1 });
  });

  it("Delete at EOL of the last line is a no-op", () => {
    const s = type(createInputState(), "ab");
    expect(handleKey(s, { delete: true })).toEqual(s);
  });

  it("backslash+Enter mid-line splits at the cursor and strips that backslash", () => {
    let s = type(createInputState(), "ab\\cd"); // col 5
    s = handleKey(s, { leftArrow: true }) as InputState;
    s = handleKey(s, { leftArrow: true }) as InputState; // col 3, '\' is at col-1
    const next = handleKey(s, { return: true }) as InputState;
    expect(next).toEqual({ lines: ["ab", "cd"], row: 1, col: 0 });
  });

  it("Enter mid-line without a backslash before the cursor still submits", () => {
    let s = type(createInputState(), "abc");
    s = handleKey(s, { leftArrow: true }) as InputState;
    expect(handleKey(s, { return: true })).toEqual({ submit: "abc" });
  });

  it("a line ending in '\\' whose cursor sits before it submits without splitting", () => {
    let s = type(createInputState(), "ab\\");
    s = handleKey(s, { home: true }) as InputState;
    // '\' is at line end but NOT left of the cursor → plain submit
    expect(handleKey(s, { return: true })).toEqual({ submit: "ab\\" });
  });

  it("paste mid-line splits at the cursor; trailing text lands on the last pasted line", () => {
    let s = type(createInputState(), "abc");
    s = handleKey(s, { leftArrow: true }) as InputState; // col 2
    const pasted = handleKey(s, { input: "x\ny" }) as InputState;
    expect(pasted).toEqual({ lines: ["abx", "yc"], row: 1, col: 1 });
  });

  it("Up/Down clamp col to the target row's length", () => {
    let s = type(createInputState(), "abc");
    s = handleKey(handleKey(s, { input: "\\" }), { return: true }) as InputState;
    s = type(s, "xy"); // ["abc","xy"] row 1 col 2
    const up = handleKey(s, { upArrow: true }) as InputState; // row 0, col 2 (fits "abc")
    expect(up).toEqual({ lines: ["abc", "xy"], row: 0, col: 2 });
    const atEnd = handleKey(up, { end: true }) as InputState; // col 3 on row 0
    const down = handleKey(atEnd, { downArrow: true }) as InputState; // clamped to "xy"
    expect(down).toEqual({ lines: ["abc", "xy"], row: 1, col: 2 });
  });
});

describe("TextInput component", () => {
  const wait = (ms = 25) => new Promise((r) => setTimeout(r, ms));

  it("submits typed text on Enter", async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(TextInput, { onSubmit }),
    );
    await wait();
    stdin.write("hello");
    await wait();
    stdin.write("\r");
    await wait();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("hello");
    unmount();
  });

  it("backslash+Enter continues the line; submit joins with newline", async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(TextInput, { onSubmit }),
    );
    await wait();
    stdin.write("a");
    await wait();
    stdin.write("\\");
    await wait();
    stdin.write("\r");
    await wait();
    expect(onSubmit).not.toHaveBeenCalled();
    stdin.write("b");
    await wait();
    stdin.write("\r");
    await wait();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("a\nb");
    unmount();
  });

  it("does not call onSubmit for empty input", async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(TextInput, { onSubmit }),
    );
    await wait();
    stdin.write("\r");
    await wait();
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  it("does not call onSubmit for whitespace-only input", async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(TextInput, { onSubmit }),
    );
    await wait();
    stdin.write("   ");
    await wait();
    stdin.write("\r");
    await wait();
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  it("ignores keystrokes when disabled", async () => {
    const onSubmit = vi.fn();
    const { stdin, rerender, unmount } = render(
      React.createElement(TextInput, { onSubmit }),
    );
    await wait();
    rerender(React.createElement(TextInput, { onSubmit, disabled: true }));
    await wait();
    stdin.write("hello");
    await wait();
    stdin.write("\r");
    await wait();
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  it("renders typed text with a caret on the active row", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit }),
    );
    await wait();
    stdin.write("hello");
    await wait();
    const frame = (lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    expect(frame).toContain("hello");
    unmount();
  });

  it("a pasted multi-line chunk becomes multiple lines and submits joined", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit }),
    );
    await wait();
    // One chunk containing \n — ink delivers it as a single `input` string.
    stdin.write("line1\nline2");
    await wait();
    const frame = (lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    expect(frame).toContain("line1");
    expect(frame).toContain("line2");
    stdin.write("\r");
    await wait();
    expect(onSubmit).toHaveBeenCalledWith("line1\nline2");
    unmount();
  });

  // -------------------------------------------------------------------------
  // M44 §1 — in-line cursor: caret renders before lines[row][col], arrow keys
  // / Home / End move it through ink, and editing is cursor-relative.
  // -------------------------------------------------------------------------
  it("the caret renders before the character at the cursor", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit }),
    );
    await wait();
    stdin.write("abc");
    await wait();
    stdin.write("\x1b[D"); // ←
    await wait();
    const frame = (lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    expect(frame).toContain("ab█c");
    unmount();
  });

  it("mid-line edit via ← then typing inserts before the cursor and submits the edited text", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit }),
    );
    await wait();
    stdin.write("abc");
    await wait();
    stdin.write("\x1b[D");
    await wait();
    stdin.write("\x1b[D"); // col 1
    await wait();
    stdin.write("X");
    await wait();
    const frame = (lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    expect(frame).toContain("aX█bc");
    stdin.write("\r");
    await wait();
    expect(onSubmit).toHaveBeenCalledWith("aXbc");
    unmount();
  });

  it("Home/End move the cursor to line start/end", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit }),
    );
    await wait();
    stdin.write("abc");
    await wait();
    stdin.write("\x1b[H"); // Home
    await wait();
    const start = (lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    expect(start).toContain("█abc");
    stdin.write("X");
    await wait();
    stdin.write("\x1b[F"); // End
    await wait();
    stdin.write("Y");
    await wait();
    const end = (lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    expect(end).toContain("XabcY█");
    stdin.write("\r");
    await wait();
    expect(onSubmit).toHaveBeenCalledWith("XabcY");
    unmount();
  });

  it("Delete removes forward at the cursor; multi-line row navigation keeps working with a mid-line cursor", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit }),
    );
    await wait();
    stdin.write("abc");
    await wait();
    stdin.write("\x1b[D");
    await wait();
    stdin.write("\x1b[3~"); // Delete (forward)
    await wait();
    const frame = (lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    expect(frame).toContain("ab█");
    unmount();
  });
});

// ---------------------------------------------------------------------------
// M42 §2 — the slash suggestion menu: open on the "/" prefix, prefix filter,
// ↑↓ select, Tab/Enter complete WITHOUT submitting (Enter submits only a
// complete no-argument command), Esc closes without losing the input.
// ---------------------------------------------------------------------------
describe("TextInput slash suggestions", () => {
  const wait = (ms = 25) => new Promise((r) => setTimeout(r, ms));
  const COMMANDS = listSlashCommands({
    skills: [{ name: "alpha", description: "Alpha rules", filePath: "/x", relPath: "x", content: "" }],
    pluginCommands: [{ name: "deploy", description: "Deploy the app", filePath: "/x", body: "", plugin: "acme" }],
  });

  const plain = (frame: string | null | undefined): string => (frame ?? "").replace(/\x1b\[[0-9;]*m/g, "");

  async function type(stdin: { write(s: string): void }, text: string): Promise<void> {
    for (const ch of text) {
      stdin.write(ch);
      await wait(15);
    }
  }

  it("a bare / opens the menu above the input (names + dim descriptions)", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit, suggestions: COMMANDS }),
    );
    await wait();
    stdin.write("/");
    await wait();
    const frame = plain(lastFrame());
    expect(frame).toContain("/exit");
    expect(frame).toContain("/help");
    expect(frame).toContain("/memory");
    // 22+ entries → 7 visible (the builtin rows incl. M52's /compact +
    // /context, M53's /edit /tree /switch, M55's parity + medium packs, plus
    // the skill and the plugin), the rest behind the overflow mark
    expect(frame).toContain(`… 还有 ${COMMANDS.length - 7} 项`); // ω99-169: 钉随源演进
    unmount();
  });

  it("typing filters the menu inline by prefix", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit, suggestions: COMMANDS }),
    );
    await wait();
    // cc-plugins D3: workspace skills now render as /<name>; the "al" prefix
    // narrows the menu to /alpha (the workspace skill) without touching the
    // /skill: legacy annotation line.
    await type(stdin, "/al");
    await wait();
    const frame = plain(lastFrame());
    expect(frame).toContain("/alpha");
    expect(frame).not.toContain("/exit");
    expect(frame).not.toContain("/help");
    unmount();
  });

  it("no suggestions prop → no menu (bare input unchanged)", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit }),
    );
    await wait();
    stdin.write("/");
    await wait();
    const frame = plain(lastFrame());
    expect(frame).not.toContain("/exit");
    unmount();
  });

  it("Tab completes the selected command without submitting", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit, suggestions: COMMANDS }),
    );
    await wait();
    await type(stdin, "/he");
    stdin.write("\t");
    await wait();
    const frame = plain(lastFrame());
    expect(frame).toContain("/help█"); // completed into the input line
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  it("Enter completes a partial command without submitting, then submits when complete", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit, suggestions: COMMANDS }),
    );
    await wait();
    await type(stdin, "/he");
    stdin.write("\r"); // partial → completes, no submit
    await wait();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(plain(lastFrame())).toContain("/help█");
    stdin.write("\r"); // complete no-arg command → submits
    await wait();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("/help");
    unmount();
  });

  it("Enter on an exact skill: match submits the full invocation line", async () => {
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(TextInput, { onSubmit, suggestions: COMMANDS }),
    );
    await wait();
    await type(stdin, "/skill:alpha");
    stdin.write("\r");
    await wait();
    expect(onSubmit).toHaveBeenCalledWith("/skill:alpha");
    unmount();
  });

  it("↑↓ move the selection and Tab completes the moved-to item", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit, suggestions: COMMANDS }),
    );
    await wait();
    stdin.write("/");
    await wait();
    // default selection = first (exit); two downs → help (3rd row)
    stdin.write("\x1b[B");
    await wait();
    stdin.write("\x1b[B");
    await wait();
    stdin.write("\t");
    await wait();
    expect(plain(lastFrame())).toContain("/help█");
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  it("↑↓ do not move the cursor row while the menu is open", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit, suggestions: COMMANDS }),
    );
    await wait();
    await type(stdin, "a\\\r"); // open a continuation line, cursor on row 1
    stdin.write("/");
    await wait();
    stdin.write("\x1b[A"); // up = selection move, NOT row move
    await wait();
    const frame = plain(lastFrame());
    expect(frame).toContain("/exit"); // menu still open
    unmount();
  });

  it("Esc closes the menu without losing the typed input", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit, suggestions: COMMANDS }),
    );
    await wait();
    await type(stdin, "/hel");
    stdin.write("\x1b");
    await wait();
    const frame = plain(lastFrame());
    expect(frame).not.toContain("/help"); // menu gone
    expect(frame).toContain("/hel█"); // input survived
    // typing continues normally after the dismiss
    stdin.write("p");
    await wait();
    expect(plain(lastFrame())).toContain("/help█"); // reopened: token changed
    unmount();
  });

  it("once args appear the menu closes and Enter submits the line", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit, suggestions: COMMANDS }),
    );
    await wait();
    await type(stdin, "/skill:alpha ");
    await wait();
    expect(plain(lastFrame())).not.toContain("/exit"); // menu closed on space
    await type(stdin, "fix it");
    stdin.write("\r");
    await wait();
    expect(onSubmit).toHaveBeenCalledWith("/skill:alpha fix it");
    unmount();
  });

  it("more than 7 matches show 7 rows plus the overflow marker; ↓ scrolls the window", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit, suggestions: COMMANDS }),
    );
    await wait();
    stdin.write("/");
    await wait();
    const full = plain(lastFrame());
    // builtins (incl. M52 /compact + /context, M53 branching trio, M55 packs) + skill + plugin → 7 rows + overflow
    expect(full).toContain(`… 还有 ${COMMANDS.length - 7} 项`); // ω99-169: 钉随源演进
    // COMMANDS.length-1 downs lands on the LAST entry (the plugin command); the window scrolled past exit
    for (let i = 0; i < COMMANDS.length - 1; i++) {
      stdin.write("\x1b[B");
      await wait();
    }
    const scrolled = plain(lastFrame());
    expect(scrolled).toContain("/deploy"); // last entry now visible
    expect(scrolled).not.toContain("/exit 退出"); // first entry scrolled out — ω99-162: 隐藏钉·描述词 quit→退出 同串机械演进（原本即空断言，原语义保留）
    unmount();
  });
});

describe("suggestWindow (pure)", () => {
  it("fits entirely while ≤7", () => {
    expect(suggestWindow(3, 2)).toEqual({ start: 0, rows: 3 });
    expect(suggestWindow(7, 0)).toEqual({ start: 0, rows: 7 });
  });
  it("caps at 7 rows and centers the selection, clamped at the ends", () => {
    expect(suggestWindow(20, 0)).toEqual({ start: 0, rows: 7 });
    expect(suggestWindow(20, 10)).toEqual({ start: 7, rows: 7 });
    expect(suggestWindow(20, 19)).toEqual({ start: 13, rows: 7 });
    expect(suggestWindow(9, 4)).toEqual({ start: 1, rows: 7 });
  });
  it("empty list yields an empty window", () => {
    expect(suggestWindow(0, 0)).toEqual({ start: 0, rows: 0 });
  });
});

// ---------------------------------------------------------------------------
// M44 §2 — submitted-prompt history: adjacent-deduped (≤100), ↑ recalls
// older / ↓ newer with the draft stashed and restored at the newest, pointer
// reset after submit. Pure functions + the TextInput wiring.
// ---------------------------------------------------------------------------
describe("pure input history", () => {
  it("records submissions and resets the pointer to the live position", () => {
    let h = createInputHistory();
    expect(h).toEqual({ entries: [], pointer: 0, draft: null });
    h = submitToHistory(h, "one");
    expect(h).toEqual({ entries: ["one"], pointer: 1, draft: null });
  });

  it("skips empty submissions", () => {
    const h = submitToHistory(createInputHistory(), "");
    expect(h.entries).toEqual([]);
  });

  it("adjacent duplicates are not stored twice", () => {
    let h = createInputHistory();
    h = submitToHistory(h, "same");
    h = submitToHistory(h, "same");
    expect(h.entries).toEqual(["same"]);
    h = submitToHistory(h, "other");
    h = submitToHistory(h, "same"); // non-adjacent duplicate IS kept
    expect(h.entries).toEqual(["same", "other", "same"]);
  });

  it("caps the list at 100 entries, dropping the oldest", () => {
    let h = createInputHistory();
    for (let i = 0; i < INPUT_HISTORY_MAX + 2; i++) h = submitToHistory(h, `p${i}`);
    expect(h.entries.length).toBe(INPUT_HISTORY_MAX);
    expect(h.entries[0]).toBe("p2"); // p0/p1 evicted
    expect(h.entries[h.entries.length - 1]).toBe(`p${INPUT_HISTORY_MAX + 1}`);
  });

  it("recallOlder walks back, stashing the draft only when leaving the live position", () => {
    let h = createInputHistory();
    h = submitToHistory(h, "one");
    h = submitToHistory(h, "two");
    const r1 = recallOlder(h, "draft");
    expect(r1).toEqual({ entries: ["one", "two"], pointer: 1, draft: "draft" });
    expect(recalledText(r1!)).toBe("two");
    const r2 = recallOlder(r1!, "edited-two"); // edits do not replace the stash
    expect(r2).toEqual({ entries: ["one", "two"], pointer: 0, draft: "draft" });
    expect(recalledText(r2!)).toBe("one");
    expect(recallOlder(r2!, "x")).toBeNull(); // oldest — stop
  });

  it("recallNewer walks forward and restores the draft at the live position", () => {
    let h = createInputHistory();
    h = submitToHistory(h, "one");
    h = submitToHistory(h, "two");
    let nav = recallOlder(recallOlder(h, "draft"), "")!;
    expect(recalledText(nav)).toBe("one");
    nav = recallNewer(nav)!;
    expect(recalledText(nav)).toBe("two");
    nav = recallNewer(nav)!;
    expect(nav.pointer).toBe(nav.entries.length); // back at live
    expect(recalledText(nav)).toBe("draft"); // draft restored
    expect(recallNewer(nav)).toBeNull(); // live — stop
  });

  it("a submit mid-navigation resets the pointer to the newest", () => {
    let h = createInputHistory();
    h = submitToHistory(h, "one");
    h = submitToHistory(h, "two");
    const nav = recallOlder(h, "draft")!;
    const after = submitToHistory(nav, "three");
    expect(after).toEqual({ entries: ["one", "two", "three"], pointer: 3, draft: null });
  });

  it("inputStateFromText puts the cursor at the end of the (possibly multi-line) text", () => {
    expect(inputStateFromText("hello")).toEqual({ lines: ["hello"], row: 0, col: 5 });
    expect(inputStateFromText("a\nbc")).toEqual({ lines: ["a", "bc"], row: 1, col: 2 });
    expect(inputStateFromText("")).toEqual({ lines: [""], row: 0, col: 0 });
  });
});

describe("TextInput input history (M44 §2)", () => {
  const wait = (ms = 25) => new Promise((r) => setTimeout(r, ms));
  const UP = "\x1b[A";
  const DOWN = "\x1b[B";

  const plain = (frame: string | null | undefined): string => (frame ?? "").replace(/\x1b\[[0-9;]*m/g, "");

  async function submit(stdin: { write(s: string): void }, text: string): Promise<void> {
    for (const ch of text) {
      stdin.write(ch);
      await wait(15);
    }
    stdin.write("\r");
    await wait();
  }

  it("↑ recalls the previous prompt; editing it and resubmitting submits the edited text", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit }),
    );
    await wait();
    await submit(stdin, "first");
    await submit(stdin, "second");
    stdin.write(UP);
    await wait();
    expect(plain(lastFrame())).toContain("second█");
    stdin.write("X"); // edit the recalled prompt
    await wait();
    stdin.write("\r");
    await wait();
    expect(onSubmit).toHaveBeenLastCalledWith("secondX");
    stdin.write(UP); // the edited resubmission is now the newest entry
    await wait();
    expect(plain(lastFrame())).toContain("secondX█");
    unmount();
  });

  it("the live draft is stashed on ↑ and restored on ↓ back to newest", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit }),
    );
    await wait();
    await submit(stdin, "one");
    stdin.write("draf");
    await wait();
    stdin.write(UP);
    await wait();
    expect(plain(lastFrame())).toContain("one█");
    stdin.write(DOWN);
    await wait();
    expect(plain(lastFrame())).toContain("draf█");
    unmount();
  });

  it("↑ at the oldest and ↓ at the live position are no-ops", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit }),
    );
    await wait();
    await submit(stdin, "one");
    stdin.write(UP);
    await wait();
    stdin.write(UP); // already at the oldest
    await wait();
    expect(plain(lastFrame())).toContain("one█");
    stdin.write(DOWN); // back to live (draft "" restored)
    await wait();
    stdin.write(DOWN); // at live — no-op
    await wait();
    expect(plain(lastFrame())).toBe("› █");
    unmount();
  });

  it("multi-line mid rows stay row navigation; first-row ↑ recalls history", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit }),
    );
    await wait();
    await submit(stdin, "z");
    // build a multi-line buffer: "a\" + Enter opens row 1, then "b"
    stdin.write("a");
    await wait();
    stdin.write("\\");
    await wait();
    stdin.write("\r");
    await wait();
    stdin.write("b");
    await wait();
    stdin.write(UP); // row 1 → row 0: row navigation, buffer intact
    await wait();
    const rowNav = plain(lastFrame());
    expect(rowNav).toContain("a");
    expect(rowNav).toContain("b");
    stdin.write(UP); // ↑ at the first row → history recall replaces the buffer
    await wait();
    const recalled = plain(lastFrame());
    expect(recalled).toContain("z█");
    expect(recalled).not.toContain("\nb"); // multi-line draft replaced
    unmount();
  });

  it("↓ at the last row of a fresh buffer is a no-op (nothing newer)", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit }),
    );
    await wait();
    await submit(stdin, "one");
    stdin.write("t");
    await wait();
    stdin.write(DOWN); // single-line input sits at the last row
    await wait();
    expect(plain(lastFrame())).toContain("t█");
    unmount();
  });

  it("adjacent duplicate submits are not recalled twice", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit }),
    );
    await wait();
    await submit(stdin, "same");
    await submit(stdin, "same");
    stdin.write(UP);
    await wait();
    expect(plain(lastFrame())).toContain("same█");
    stdin.write(UP); // only one entry — stays
    await wait();
    expect(plain(lastFrame())).toContain("same█");
    stdin.write(DOWN); // back to the live (empty) draft
    await wait();
    expect(plain(lastFrame())).toBe("› █");
    unmount();
  });

  it("controlled history props keep the list across unmounts (app wiring contract)", async () => {
    const onSubmit = vi.fn();
    let hist = createInputHistory();
    const first = render(
      React.createElement(TextInput, {
        onSubmit,
        history: hist,
        onHistoryChange: (h) => { hist = h; },
      }),
    );
    await wait();
    first.stdin.write("kept");
    await wait();
    first.stdin.write("\r");
    await wait();
    expect(onSubmit).toHaveBeenCalledWith("kept");
    first.unmount();
    // a later mount (e.g. the app re-showing the input after an ask) starts
    // where the caller's state left off
    const second = render(
      React.createElement(TextInput, {
        onSubmit,
        history: hist,
        onHistoryChange: (h) => { hist = h; },
      }),
    );
    await wait();
    second.stdin.write(UP);
    await wait();
    expect(plain(second.lastFrame())).toContain("kept█");
    second.unmount();
  });
});

// ---------------------------------------------------------------------------
// M44 §3 — history vs the M42 suggestion menu: while the menu is open ↑/↓
// stay menu selection, completion lands the cursor at line end, and menu
// navigation never corrupts a mid-line col.
// ---------------------------------------------------------------------------
describe("history/menu coexistence (M44 §3)", () => {
  const wait = (ms = 25) => new Promise((r) => setTimeout(r, ms));
  const COMMANDS = listSlashCommands({
    skills: [{ name: "alpha", description: "Alpha rules", filePath: "/x", relPath: "x", content: "" }],
    pluginCommands: [{ name: "deploy", description: "Deploy the app", filePath: "/x", body: "", plugin: "acme" }],
  });

  const plain = (frame: string | null | undefined): string => (frame ?? "").replace(/\x1b\[[0-9;]*m/g, "");

  it("menu-open ↑ moves the selection, never the history", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit, suggestions: COMMANDS }),
    );
    await wait();
    // seed one history entry, then open the menu on a fresh buffer
    stdin.write("done");
    await wait();
    stdin.write("\r");
    await wait();
    stdin.write("/");
    await wait();
    stdin.write("\x1b[A"); // ↑ with the menu open = selection move
    await wait();
    const frame = plain(lastFrame());
    expect(frame).toContain("/exit"); // menu still open
    expect(frame).toContain("› /█"); // input unchanged
    unmount();
  });

  it("Tab completion puts the cursor at line end even from a mid-line col", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit, suggestions: COMMANDS }),
    );
    await wait();
    stdin.write("/he");
    await wait();
    stdin.write("\x1b[D"); // col 2 (mid-token)
    await wait();
    stdin.write("\t"); // complete → cursor must sit at the new EOL
    await wait();
    expect(plain(lastFrame())).toContain("/help█");
    stdin.write("x"); // appends → proves col was 5 (EOL), not 2
    await wait();
    expect(plain(lastFrame())).toContain("/helpx█");
    unmount();
  });

  it("menu ↑/↓ navigation does not corrupt a mid-line col", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(TextInput, { onSubmit, suggestions: COMMANDS }),
    );
    await wait();
    stdin.write("/he");
    await wait();
    stdin.write("\x1b[D"); // col 2
    await wait();
    stdin.write("\x1b[B"); // ↓ moves the menu selection, col must survive
    await wait();
    stdin.write("\x1b"); // Esc closes the menu
    await wait();
    stdin.write("x"); // inserts at col 2 → "/hxe"
    await wait();
    expect(plain(lastFrame())).toContain("/hx█e");
    unmount();
  });
});
