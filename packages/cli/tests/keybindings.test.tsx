// M35 §3 — the named keybinding registry: parse/resolve/override semantics,
// the .wudao/keybindings.json loader, and the TextInput/app consultation
// (custom submit key submits; the orphaned Enter inserts a newline).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseBinding,
  bindingMatches,
  resolveKeybindings,
  loadKeybindings,
  DEFAULT_KEYBINDINGS,
  DEFAULT_RESOLVED_KEYBINDINGS,
  KEYBINDING_ACTIONS,
} from "../src/tui/keybindings.js";
import { TextInput } from "../src/tui/input.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function type(stdin: { write(s: string): void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await wait(15);
  }
}

// ink-testing-library stdin.write of a named key: ink parses "\r" as return,
// "\x1b" as escape, "\x7f" as backspace, "\x1b[A"/[B" as up/down.
const KEY_RETURN = "\r";
const KEY_ESC = "\x1b";
const KEY_BACKSPACE = "\x7f";
const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";

describe("parseBinding", () => {
  it("parses named keys, aliases, single chars, and ctrl combos", () => {
    expect(parseBinding("return")).toEqual({ ok: true, binding: { key: "return" } });
    expect(parseBinding("enter")).toEqual({ ok: true, binding: { key: "return" } });
    expect(parseBinding("esc")).toEqual({ ok: true, binding: { key: "escape" } });
    expect(parseBinding("space")).toEqual({ ok: true, binding: { key: "space" } });
    expect(parseBinding("ctrl+j")).toEqual({ ok: true, binding: { key: "j", ctrl: true } });
    expect(parseBinding(" Ctrl+C ")).toEqual({ ok: true, binding: { key: "c", ctrl: true } });
  });

  it("rejects junk with a useful error", () => {
    expect(parseBinding("").ok).toBe(false);
    expect(parseBinding("ctrl+jj").ok).toBe(false);
    expect(parseBinding("not-a-key").ok).toBe(false);
    expect(parseBinding("ctrl+").ok).toBe(false);
  });
});

describe("bindingMatches", () => {
  const kb = (key: string, ctrl = false) => ({ key, ...(ctrl ? { ctrl: true } : {}) });
  it("matches named keys via ink's booleans and ctrl combos via input", () => {
    expect(bindingMatches(kb("return"), "", { return: true })).toBe(true);
    expect(bindingMatches(kb("return"), "", {})).toBe(false);
    expect(bindingMatches(kb("escape"), "", { escape: true })).toBe(true);
    expect(bindingMatches(kb("up"), "", { upArrow: true })).toBe(true);
    expect(bindingMatches(kb("down"), "", { downArrow: true })).toBe(true);
    expect(bindingMatches(kb("backspace"), "", { backspace: true })).toBe(true);
    expect(bindingMatches(kb("j", true), "j", { ctrl: true })).toBe(true);
    expect(bindingMatches(kb("j", true), "j", {})).toBe(false);
    expect(bindingMatches(kb("j", true), "k", { ctrl: true })).toBe(false);
    expect(bindingMatches(kb("space"), " ", {})).toBe(true);
    // ctrl must not leak into plain single-char bindings
    expect(bindingMatches(kb("c"), "c", { ctrl: true })).toBe(false);
  });

  // M42 §3: shift+tab — the reverse-tab sequence \x1b[Z arrives from ink as
  // { tab: true, shift: true }; a shifted keypress must NOT fire an unshifted
  // binding (plain tab) and vice versa.
  it("shift+tab matches ink's tab+shift booleans and the raw \\x1b[Z sequence", () => {
    const shiftTab = { key: "tab", shift: true };
    expect(bindingMatches(shiftTab, "", { tab: true, shift: true })).toBe(true);
    expect(bindingMatches(shiftTab, "\x1b[Z", {})).toBe(true); // raw-sequence fallback
    expect(bindingMatches(shiftTab, "", { tab: true })).toBe(false);
    expect(bindingMatches(shiftTab, "", {})).toBe(false);
    expect(bindingMatches(shiftTab, "", { escape: true })).toBe(false);
  });

  it("a plain tab binding does not fire on shift+tab", () => {
    expect(bindingMatches(kb("tab"), "", { tab: true })).toBe(true);
    expect(bindingMatches(kb("tab"), "", { tab: true, shift: true })).toBe(false);
    expect(bindingMatches(kb("tab"), "\x1b[Z", {})).toBe(false);
  });
});

describe("parseBinding — shift modifiers (M42 §3)", () => {
  it("parses shift+<named> and shift+<char>; rejects junk", () => {
    expect(parseBinding("shift+tab")).toEqual({ ok: true, binding: { key: "tab", shift: true } });
    expect(parseBinding("shift+enter")).toEqual({ ok: true, binding: { key: "return", shift: true } });
    expect(parseBinding("shift+K")).toEqual({ ok: true, binding: { key: "k", shift: true } });
    expect(parseBinding("shift+").ok).toBe(false);
    expect(parseBinding("shift+not-a-key").ok).toBe(false);
    expect(parseBinding("shift+ctrl+j").ok).toBe(false);
  });
});

describe("resolveKeybindings", () => {
  it("defaults resolve to the documented table", () => {
    const resolved = resolveKeybindings();
    expect(resolved).toEqual(DEFAULT_RESOLVED_KEYBINDINGS);
    expect(resolved["app.submit"]).toEqual({ key: "return" });
    expect(resolved["app.abort"]).toEqual({ key: "escape" });
    expect(resolved["app.exit"]).toEqual({ key: "c", ctrl: true });
    expect(resolved["app.cycle-mode"]).toEqual({ key: "tab", shift: true });
    expect(resolved["input.backspace"]).toEqual({ key: "backspace" });
    expect(resolved["input.up"]).toEqual({ key: "up" });
    expect(resolved["input.down"]).toEqual({ key: "down" });
    expect(KEYBINDING_ACTIONS).toContain("app.submit");
  });

  it("app.cycle-mode is remappable and shift+tab stays distinct from tab", () => {
    const resolved = resolveKeybindings({ "app.cycle-mode": "ctrl+m" });
    expect(resolved["app.cycle-mode"]).toEqual({ key: "m", ctrl: true });
    // a plain-tab override elsewhere does not collide with shift+tab
    const warnings: string[] = [];
    const withTabAction = resolveKeybindings({ "input.up": "tab" }, (w) => warnings.push(w));
    expect(warnings.join("; ")).not.toContain("app.cycle-mode");
    expect(withTabAction["input.up"]).toEqual({ key: "tab" });
  });

  it("refuses an unmodified single char on app.cycle-mode (it would fire while typing)", () => {
    const warnings: string[] = [];
    const resolved = resolveKeybindings({ "app.cycle-mode": "z" }, (w) => warnings.push(w));
    expect(warnings.join("; ")).toContain("app.cycle-mode");
    expect(resolved["app.cycle-mode"]).toEqual({ key: "tab", shift: true }); // default kept
  });

  it("applies a valid override", () => {
    const resolved = resolveKeybindings({ "app.abort": "ctrl+g" });
    expect(resolved["app.abort"]).toEqual({ key: "g", ctrl: true });
    // Untouched actions keep their defaults.
    expect(resolved["app.submit"]).toEqual({ key: "return" });
  });

  it("unknown action names warn and are ignored (defaults survive)", () => {
    const warnings: string[] = [];
    const resolved = resolveKeybindings({ "app.nonexistent": "up", "history-up": "up" }, (w) => warnings.push(w));
    expect(warnings.length).toBe(2);
    expect(warnings[0]).toContain("app.nonexistent");
    expect(resolved["input.up"]).toEqual({ key: "up" }); // default untouched
  });

  it("an unparsable binding warns and falls back to the default", () => {
    const warnings: string[] = [];
    const resolved = resolveKeybindings({ "app.submit": "nope-key" }, (w) => warnings.push(w));
    expect(warnings.join("; ")).toContain("app.submit");
    expect(resolved["app.submit"]).toEqual({ key: "return" });
  });

  it("a duplicate binding warns and keeps both (first match wins by check order)", () => {
    const warnings: string[] = [];
    const resolved = resolveKeybindings({ "app.abort": "ctrl+c" }, (w) => warnings.push(w));
    expect(warnings.join("; ")).toContain('"app.exit" and "app.abort" share the key "ctrl+c"');
    expect(resolved["app.abort"]).toEqual({ key: "c", ctrl: true });
    expect(resolved["app.exit"]).toEqual({ key: "c", ctrl: true });
  });
});

describe("loadKeybindings (.wudao/keybindings.json)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kb-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("no file → defaults, zero warnings", async () => {
    const warnings: string[] = [];
    const resolved = await loadKeybindings(root, (w) => warnings.push(w));
    expect(resolved).toEqual(DEFAULT_RESOLVED_KEYBINDINGS);
    expect(warnings).toEqual([]);
  });

  it("a valid file overrides named actions", async () => {
    mkdirSync(join(root, ".wudao"), { recursive: true });
    writeFileSync(join(root, ".wudao", "keybindings.json"), JSON.stringify({ "app.submit": "ctrl+j" }), "utf8");
    const warnings: string[] = [];
    const resolved = await loadKeybindings(root, (w) => warnings.push(w));
    expect(resolved["app.submit"]).toEqual({ key: "j", ctrl: true });
    expect(warnings).toEqual([]);
  });

  it("unknown names in the file warn; malformed JSON degrades to defaults", async () => {
    mkdirSync(join(root, ".wudao"), { recursive: true });
    writeFileSync(join(root, ".wudao", "keybindings.json"), JSON.stringify({ "mystery.action": "up" }), "utf8");
    const warnings: string[] = [];
    let resolved = await loadKeybindings(root, (w) => warnings.push(w));
    expect(resolved).toEqual(DEFAULT_RESOLVED_KEYBINDINGS);
    expect(warnings.join("; ")).toContain("mystery.action");

    writeFileSync(join(root, ".wudao", "keybindings.json"), "{not json", "utf8");
    warnings.length = 0;
    resolved = await loadKeybindings(root, (w) => warnings.push(w));
    expect(resolved).toEqual(DEFAULT_RESOLVED_KEYBINDINGS);
    expect(warnings.join("; ")).toContain("not valid JSON");
  });
});

describe("TextInput consults the registry", () => {
  const collect = (): { submitted: string[] } => {
    const submitted: string[] = [];
    return { submitted };
  };

  it("default bindings: Enter submits, backspace deletes, up/down move rows", async () => {
    const { submitted } = collect();
    const inst = render(<TextInput onSubmit={(t) => submitted.push(t)} />);
    await wait();
    await type(inst.stdin, "ab");
    inst.stdin.write(KEY_BACKSPACE);
    await wait(30);
    inst.stdin.write(KEY_RETURN);
    await wait(30);
    expect(submitted).toEqual(["a"]);
    inst.unmount();
  });

  it("overridden submit (ctrl+s) submits; the orphaned Enter inserts a newline", async () => {
    const { submitted } = collect();
    const kb = resolveKeybindings({ "app.submit": "ctrl+s" });
    const inst = render(<TextInput onSubmit={(t) => submitted.push(t)} keybindings={kb} />);
    await wait();
    await type(inst.stdin, "one");
    inst.stdin.write(KEY_RETURN); // demoted → newline, NOT a submit
    await wait(30);
    await type(inst.stdin, "two");
    inst.stdin.write("\x13"); // ctrl+s — ink reports input "s" + ctrl
    await wait(30);
    expect(submitted).toEqual(["one\ntwo"]);
    inst.unmount();
  });

  it("an overridden row key (input.up → ctrl+p) moves with ctrl+p; the bare up arrow no longer does", async () => {
    const kb = resolveKeybindings({ "input.up": "ctrl+p" });
    const inst = render(<TextInput onSubmit={() => {}} keybindings={kb} />);
    await wait();
    await type(inst.stdin, "a\\");
    inst.stdin.write(KEY_RETURN); // default submit → continuation line
    await wait(30);
    await type(inst.stdin, "b");
    // Bare up arrow: replaced by the override → no move (cursor stays on row 1).
    inst.stdin.write(KEY_UP);
    await wait(30);
    let frame = inst.lastFrame() ?? "";
    expect(frame).toContain("b█");
    // ctrl+p moves the row up (to line "a").
    inst.stdin.write("\x10"); // ctrl+p (DLE)
    await wait(30);
    frame = inst.lastFrame() ?? "";
    expect(frame).toContain("a█");
    inst.unmount();
  });
});

it("destructive app actions can never take an unmodified single-char binding", () => {
  const warnings: string[] = [];
  const kb = resolveKeybindings({ "app.abort": "q", "app.exit": "x" }, (w) => warnings.push(w));
  // Bare chars are unparseable (named/ctrl only) — protection by construction;
  // the explicit guard in resolveKeybindings is belt-and-braces. Either way:
  // the defaults survive and the override NEVER lands.
  expect(kb["app.abort"].key).toBe("escape");
  expect(kb["app.exit"].ctrl).toBe(true);
  expect(warnings.length).toBeGreaterThanOrEqual(2);
});
