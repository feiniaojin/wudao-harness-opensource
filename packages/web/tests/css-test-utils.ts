// css-test-utils — the shared seams of the visual suites (final-review F9:
// mount/decl/prop were copy-pasted across the four suites). One React root
// per test FILE (vitest isolates files), the same act-mounted render the
// suites always used; teardown is `unmount()` from each suite's afterEach.
// `decl` reads a DECLARED value off the mounted stylesheet through the
// CSSOM (jsdom does not resolve var()/color-mix in getComputedStyle, so
// token derivations are pinned as-declared); `prop` resolves a custom
// property on <html>, which jsdom DOES resolve like a browser. No
// assertions live here — the suites keep their own expectations.
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

let root: Root | null = null;

/** Render `el` into a fresh container under act; returns the container. */
export const mount = (el: ReactElement): HTMLElement => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(el);
  });
  return container;
};

/** The afterEach teardown: unmount the last mount and clear the body. */
export const unmount = (): void => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
};

/** Declared value of `prop` on the FIRST mounted rule whose selector
 *  contains `selector` (substring, so pseudo-classes/overrides stay
 *  matchable) — pins the token derivation exactly. */
export function decl(selector: string, prop: string): string {
  for (const sheet of [...document.styleSheets] as CSSStyleSheet[]) {
    for (const rule of [...sheet.cssRules]) {
      if (rule instanceof CSSStyleRule && rule.selectorText.includes(selector)) {
        const v = rule.style.getPropertyValue(prop);
        if (v !== "") return v;
      }
    }
  }
  throw new Error(`no rule matching ${selector} declares ${prop}`);
}

/** Resolved value of a custom property on <html> under the current
 *  theme/accent. */
export const prop = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
