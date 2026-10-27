// EffortSelector — the composer's 推理强度 chip (spec 2026-08-28 §2.3).
// ShieldSelector's dropdown mechanics, minus the risk-confirm gate: .pop +
// .menu + .mi/.on, outside pointerdown closes (refocus:false), Esc closes
// and refocuses the chip, every reopen starts fresh.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EffortSelector } from "../src/components/EffortSelector.js";

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
});

const EFFORTS = ["off", "low", "high", "max"];

describe("EffortSelector (the composer's 推理强度 chip)", () => {
  it("shows the current level on the chip; null shows the generic 强度 label", () => {
    const c1 = mount(<EffortSelector efforts={EFFORTS} current="high" onPick={vi.fn()} />);
    expect(c1.querySelector("button.chip")?.textContent).toContain("high");

    const c2 = mount(<EffortSelector efforts={EFFORTS} current={null} onPick={vi.fn()} />);
    expect(c2.querySelector("button.chip")?.textContent).toContain("强度");
  });

  it("opens on chip click: one .mi per effort, current row .on + aria-checked", () => {
    const c = mount(<EffortSelector efforts={EFFORTS} current="high" onPick={vi.fn()} />);
    const chip = c.querySelector<HTMLButtonElement>("button.chip")!;
    act(() => {
      chip.click();
    });
    const items = c.querySelectorAll<HTMLElement>(".menu .mi");
    expect(items).toHaveLength(EFFORTS.length);
    const on = c.querySelector<HTMLElement>(".mi.on");
    expect(on?.getAttribute("aria-checked")).toBe("true");
    expect(on?.textContent).toContain("high");
  });

  it("clicking a row picks exactly once and closes the menu", () => {
    const onPick = vi.fn();
    const c = mount(<EffortSelector efforts={EFFORTS} current="off" onPick={onPick} />);
    act(() => {
      c.querySelector<HTMLButtonElement>("button.chip")!.click();
    });
    const rows = c.querySelectorAll<HTMLButtonElement>(".menu .mi");
    act(() => {
      rows[2]!.click(); // "high"
    });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("high");
    expect(c.querySelector(".menu")).toBeNull(); // closed after commit
  });

  it("Esc closes and refocuses the chip; an outside pointerdown closes without stealing focus", async () => {
    const c = mount(<EffortSelector efforts={EFFORTS} current="off" onPick={vi.fn()} />);
    const chip = c.querySelector<HTMLButtonElement>("button.chip")!;
    act(() => {
      chip.click();
    });
    expect(c.querySelector(".menu")).not.toBeNull();

    // Esc: close + focus returns to the chip (the .mi unmounts). #456: the
    // refocus is DEFERRED one task past the keypress — flush it before
    // asserting (ω99-306).
    act(() => {
      c
        .querySelector<HTMLDivElement>(".pop")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(c.querySelector(".menu")).toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.activeElement).toBe(chip);

    // Reopen, then an outside pointerdown closes without refocus.
    act(() => {
      chip.click();
    });
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    act(() => {
      outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(c.querySelector(".menu")).toBeNull();
  });
});
