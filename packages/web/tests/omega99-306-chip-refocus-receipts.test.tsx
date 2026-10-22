// @vitest-environment jsdom
// ω99-306 — #456 reopened (0.3.84): 「会话输入这里，不管是选中auto模式，
// 还是思维强度，选中之后都会在胶囊外面加一个难看的大黑框」. The 0.3.83
// patch (:focus:not(:focus-visible) {outline:none}) was CSS-verified only —
// jsdom does not implement :focus-visible at all, so the branch WKWebView
// actually takes was invisible to the receipts: a programmatic .focus()
// fired from INSIDE the click task is classified focus-VISIBLE by WebKit's
// gesture-task heuristic (Chrome's heuristic differs), so the keyboard ring
// (outline + halo, offset OUTSIDE the pill) paints after every mouse pick.
// The overlay family's focus() never rings because it rides a passive
// effect — a task AFTER the gesture. The fix: the chip selectors' close()
// defers the refocus one task past the gesture, body-guarded so the late
// focus never steals a target the user already moved to.
//
// What jsdom CAN pin is the behavioral contract (the renderer-proof half):
// no focus in the gesture task itself, focus still returns after it, and
// the body guard holds. The visual half is the in-app empirical law the
// modal family already rides.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { EffortSelector } from "../src/components/EffortSelector.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
/** A click the way a real mouse delivers it (detail ≥ 1). */
const mouseClick = (el: Element): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  });
};
/** Flush the deferred refocus task. */
const flushTask = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
});

describe("ω99-306 — chip picks refocus AFTER the gesture task (#456)", () => {
  it("a mouse pick focuses NOTHING in the gesture task, then returns focus to the chip", async () => {
    const onPick = vi.fn();
    const c = mount(createElement(EffortSelector, { efforts: ["low", "medium", "high"], current: "medium", onPick }));
    mouseClick(c.querySelector("button.chip") as Element); // open the menu
    expect(c.querySelector('[role="menu"]')).not.toBeNull();
    // The 456 contract: at the END of the click task the active element is
    // still <body> — the OLD code refocused the chip right here, inside the
    // gesture, which is exactly the task WKWebView paints the ring for.
    mouseClick(c.querySelector('.mi[data-effort="high"]') as Element);
    expect(onPick).toHaveBeenCalledWith("high");
    expect(c.querySelector('[role="menu"]')).toBeNull(); // the menu closed
    expect(document.activeElement).toBe(document.body); // …and no gesture-task focus
    // One task later the focus DOES come back (the native-menu contract).
    await flushTask();
    expect(document.activeElement).toBe(c.querySelector("button.chip"));
  });

  it("the deferred refocus is body-guarded — it never steals a live target", async () => {
    const c = mount(createElement(EffortSelector, { efforts: ["low", "high"], current: null, onPick: () => {} }));
    const bystander = document.createElement("button");
    document.body.appendChild(bystander);
    bystander.focus(); // the user already moved on
    mouseClick(c.querySelector("button.chip") as Element);
    mouseClick(c.querySelector('.mi[data-effort="low"]') as Element);
    await flushTask();
    expect(document.activeElement).toBe(bystander); // the late focus backed off
  });
});

describe("ω99-306 — the four chip selectors carry the deferred idiom (source census)", () => {
  it("ShieldSelector / EffortSelector / LanguageSelector / ModelSelector all defer past the gesture task", () => {
    for (const name of ["ShieldSelector", "EffortSelector", "LanguageSelector", "ModelSelector"]) {
      // process.cwd() — this file is jsdom-env (the behavioral half needs a
      // DOM), and vitest stubs import.meta.url rootless under jsdom; the
      // package's vitest runs are cwd = packages/web (the npm scripts).
      const src = readFileSync(resolve(process.cwd(), "src/components", `${name}.tsx`), "utf8");
      expect(src, `${name} lost its #456 deferral`).toContain("#456");
      // The deferral itself: the refocus rides a timeout, not the call site.
      expect(src, `${name} refocuses synchronously again`).toMatch(/setTimeout\(\(\) => \{[\s\S]*?chipRef\.current\?\.focus\(\);/);
    }
  });
});
