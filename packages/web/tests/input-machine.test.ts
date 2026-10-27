// The input machine rules — the reused TUI contract (cli/src/tui/
// input-state.ts): submitted-prompt history (dedup, cap, pointer, draft
// stash/restore), the caret mapping, and the Enter rule (submit vs the
// `\`+Enter continuation). These pin the web surface to the same behavior.
import { describe, expect, it } from "vitest";
import {
  INPUT_HISTORY_MAX,
  caretLine,
  caretPos,
  createInputHistory,
  enterAction,
  recallNewer,
  recallOlder,
  recalledText,
  submitToHistory,
} from "../src/input-state.js";
import { completeSlashLine, filterSlashCommands, slashToken, suggestWindow } from "../src/slash.js";
import { parseFrontendCommand } from "../src/frontend-commands.js";

describe("input history (M44 §2 rules)", () => {
  it("empty and adjacent-duplicate submits are skipped", () => {
    let h = createInputHistory();
    h = submitToHistory(h, "");
    h = submitToHistory(h, "one");
    h = submitToHistory(h, "one");
    h = submitToHistory(h, "");
    expect(h.entries).toEqual(["one"]);
    expect(h.pointer).toBe(1);
  });

  it("recall stashes the live draft going up and restores it coming back down", () => {
    let h = submitToHistory(createInputHistory(), "a");
    h = submitToHistory(h, "b");
    const up = recallOlder(h, "live draft");
    expect(up).not.toBeNull();
    expect(up?.pointer).toBe(1);
    expect(up?.draft).toBe("live draft");
    expect(recalledText(up!)).toBe("b");
    const up2 = recallOlder(up!, recalledText(up!));
    expect(recalledText(up2!)).toBe("a");
    const down = recallNewer(up2!);
    expect(recalledText(down!)).toBe("b");
    const down2 = recallNewer(down!);
    expect(recalledText(down2!)).toBe("live draft"); // draft restored at the live slot
    expect(recallNewer(down2!)).toBeNull(); // nothing newer
    expect(recallOlder(createInputHistory(), "x")).toBeNull(); // empty history
  });

  it("caps at 100 entries, dropping the oldest", () => {
    let h = createInputHistory();
    for (let i = 0; i < INPUT_HISTORY_MAX + 10; i++) h = submitToHistory(h, `p${i}`);
    expect(h.entries.length).toBe(INPUT_HISTORY_MAX);
    expect(h.entries[0]).toBe(`p10`);
    expect(h.entries.at(-1)).toBe(`p${INPUT_HISTORY_MAX + 9}`);
  });
});

describe("caret mapping", () => {
  it("maps selectionStart to {row, col}", () => {
    expect(caretPos("ab\ncde\nf", 5)).toEqual({ row: 1, col: 2 });
    expect(caretPos("ab\ncde", 2)).toEqual({ row: 0, col: 2 });
    expect(caretPos("", 0)).toEqual({ row: 0, col: 0 });
  });

  it("caretLine returns the line the caret sits on (the menu's token source)", () => {
    expect(caretLine("/he", 3)).toBe("/he");
    expect(caretLine("x\n/pl", 5)).toBe("/pl");
  });
});

describe("Enter rule", () => {
  it("bare Enter submits the buffer", () => {
    expect(enterAction("hello", 5)).toEqual({ kind: "submit", text: "hello" });
    expect(enterAction("a\nb", 1)).toEqual({ kind: "submit", text: "a\nb" });
  });

  it("`\\` immediately left of the caret strips and splits (continuation)", () => {
    expect(enterAction("abc\\", 4)).toEqual({ kind: "newline", value: "abc\n", caret: 4 });
    expect(enterAction("a\\bc", 2)).toEqual({ kind: "newline", value: "a\nbc", caret: 2 });
    // A backslash NOT at the caret does not continue.
    expect(enterAction("a\\b", 3)).toEqual({ kind: "submit", text: "a\\b" });
  });
});

describe("slash menu rules (M42 §2 mirror)", () => {
  const cmds = [
    { name: "help", description: "show this", source: "builtin" as const },
    { name: "skill:", description: "invoke", args: "name", source: "builtin" as const },
    { name: "skill:alpha", description: "a", source: "skill" as const },
  ];

  it("slashToken: the command word only — whitespace or no slash closes the menu", () => {
    expect(slashToken("/he")).toBe("he");
    expect(slashToken("/")).toBe("");
    expect(slashToken("/plan goal")).toBeUndefined();
    expect(slashToken("x /he")).toBeUndefined();
  });

  it("prefix filter (no fuzzy, no substring)", () => {
    expect(filterSlashCommands(cmds, "skill").map((c) => c.name)).toEqual(["skill:", "skill:alpha"]);
    expect(filterSlashCommands(cmds, "hel").map((c) => c.name)).toEqual(["help"]);
    expect(filterSlashCommands(cmds, "elp")).toEqual([]);
  });

  it("completion rebuilds the whole line", () => {
    expect(completeSlashLine("/sk", "skill:")).toBe("/skill:");
  });

  it("suggestWindow: whole list while it fits; 7-row scrolled window beyond", () => {
    expect(suggestWindow(3, 0)).toEqual({ start: 0, rows: 3 });
    expect(suggestWindow(10, 0)).toEqual({ start: 0, rows: 7 });
    expect(suggestWindow(10, 5)).toEqual({ start: 2, rows: 7 });
    expect(suggestWindow(10, 8)).toEqual({ start: 3, rows: 7 });
    expect(suggestWindow(10, 9)).toEqual({ start: 3, rows: 7 });
    expect(suggestWindow(0, 0)).toEqual({ start: 0, rows: 0 });
  });
});

describe("frontend command router", () => {
  it("intercepts exactly the four builtin UI commands", () => {
    expect(parseFrontendCommand("")).toEqual({ kind: "noop" });
    expect(parseFrontendCommand("   ")).toEqual({ kind: "noop" });
    expect(parseFrontendCommand("/exit")).toEqual({ kind: "exit" });
    expect(parseFrontendCommand("/quit")).toEqual({ kind: "exit" });
    expect(parseFrontendCommand("/clear")).toEqual({ kind: "clear" });
    expect(parseFrontendCommand("/help")).toEqual({ kind: "help" });
    expect(parseFrontendCommand("/?")).toEqual({ kind: "help" });
    expect(parseFrontendCommand("/resume")).toEqual({ kind: "resume" });
    expect(parseFrontendCommand("/resume 3")).toEqual({ kind: "resume" });
  });

  it("everything else passes through verbatim (driver-side routing)", () => {
    expect(parseFrontendCommand("/plan ship it")).toEqual({ kind: "pass", text: "/plan ship it" });
    expect(parseFrontendCommand("/rewind 2")).toEqual({ kind: "pass", text: "/rewind 2" });
    expect(parseFrontendCommand("/skill:alpha x")).toEqual({ kind: "pass", text: "/skill:alpha x" });
    expect(parseFrontendCommand("ok")).toEqual({ kind: "pass", text: "ok" });
    expect(parseFrontendCommand("改 tighten it")).toEqual({ kind: "pass", text: "改 tighten it" });
    expect(parseFrontendCommand("hello @src/a.ts")).toEqual({ kind: "pass", text: "hello @src/a.ts" });
  });
});
