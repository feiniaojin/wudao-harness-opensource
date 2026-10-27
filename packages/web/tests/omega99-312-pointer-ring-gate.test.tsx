// @vitest-environment jsdom
// ω99-312 — #456 second reopen (0.3.87): 「箭头指向的黑框还在」. The 0.3.86
// fix (ω99-306: defer the chip refocus one task past the click gesture) moved
// the focus() AFTER the gesture task — but WebKit's :focus-visible heuristic
// classifies a script focus as keyboard-visible based on the INPUT CONTEXT,
// not the task boundary: after any pointer tap, a later .focus() still rings.
// setTimeout cannot outwait a heuristic that does not expire. The renderer-
// proof fix is the what-input idiom — the app tracks the input context
// ITSELF: pointerdown stamps html.input-pointer, a real keydown clears it,
// and the ring rules stay gated OFF while the pointer context holds. Tab
// clears the class first, so the keyboard ring (ω99-297 contract) returns
// the instant the user actually uses the keyboard.
//
// What jsdom CAN pin: the class stamp/clear behavior, the stylesheet gate,
// and that nothing about the global ring rule itself was weakened.
import { describe, expect, it, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readStyles } from "./styles-source.js";
import { usePointerInputMode } from "../src/use-pointer-input-mode.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The lightest possible consumer of the hook — mounting it must be enough
 *  to arm the input-context tracking (in production App.tsx mounts it). */
const PointerInputModeProbe = (): null => {
  usePointerInputMode();
  return null;
};

let root: Root | null = null;
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.documentElement.classList.remove("input-pointer");
  document.body.innerHTML = "";
});

const mountProbe = (): void => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(PointerInputModeProbe));
  });
};

const firePointerDown = (): void => {
  act(() => {
    // jsdom ships no PointerEvent constructor — the listener keys on the
    // event TYPE, so a MouseEvent carrier is the faithful simulation.
    window.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  });
};
const fireKeydown = (): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  });
};

describe("ω99-312 — the pointer input context gates the ring", () => {
  it("pointerdown stamps html.input-pointer; a real keydown clears it", () => {
    mountProbe();
    expect(document.documentElement.classList.contains("input-pointer")).toBe(false);
    firePointerDown();
    expect(document.documentElement.classList.contains("input-pointer")).toBe(true); // the pointer context holds…
    firePointerDown();
    expect(document.documentElement.classList.contains("input-pointer")).toBe(true); // …across further taps
    fireKeydown();
    expect(document.documentElement.classList.contains("input-pointer")).toBe(false); // any keyboard use ends it
  });

  it("the gate starts clean on mount and unmounts its listeners", () => {
    document.documentElement.classList.add("input-pointer"); // a stale stamp from a previous session
    mountProbe();
    expect(document.documentElement.classList.contains("input-pointer")).toBe(false); // mount does not inherit a stale context
    act(() => {
      root?.unmount();
    });
    firePointerDown();
    expect(document.documentElement.classList.contains("input-pointer")).toBe(false); // the listener died with the app
  });
});

describe("ω99-312 — the stylesheet gate (source census)", () => {
  const css = readStyles();

  it("carries the html.input-pointer ring suppression (outline AND halo)", () => {
    // The halo is a box-shadow on the global :focus-visible rule — the gate
    // must kill BOTH halves or the ring survives half-painted.
    expect(css).toMatch(/html\.input-pointer[\s\S]{0,120}:focus-visible\s*\{[^}]*outline:\s*none/);
    expect(css).toMatch(/html\.input-pointer[\s\S]{0,120}:focus-visible\s*\{[^}]*box-shadow:\s*none/);
  });

  it("does NOT weaken the global keyboard ring itself", () => {
    // ω99-297: the ONE keyboard ring rule stays — the gate only overlays a
    // pointer-context suppression on top of it, never edits it away.
    const globalRing = css.match(/:focus-visible\s*\{[^}]*\}/)?.[0] ?? "";
    expect(globalRing).toContain("outline: 1.5px solid var(--accent)");
    expect(globalRing).toContain("outline: 1.5px solid var(--accent)");
  });
});
