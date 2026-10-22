// @vitest-environment jsdom
// M63 §B / M64-visual §2 — the permission tier selector (research 35 #4):
// the four tiers map onto ask/workspace/auto/plan and collapse into a 26px
// chip that opens a popup menu; the risky tier commits only after an inline
// confirm click, and Esc / outside closes without change. 0.3.13: the LABELS
// are the the upstream formatvocabulary ask/accept/auto (no emoji, no shield stack); 0.3.14
// adds plan (只读探查) as the fourth stop; the mode values stay
// workspace/ask/auto/plan.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ShieldSelector, SHIELD_TIERS, RISK_CONFIRM_TEXT, shieldValueOf } from "../src/components/ShieldSelector.js";

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

describe("SHIELD_TIERS (the mapping)", () => {
  it("four tiers map onto ask / workspace / auto / plan with the upstream format labels (ask/accept/auto/plan)", () => {
    expect(SHIELD_TIERS.map((t) => [t.mode, t.label])).toEqual([
      ["ask", "ask"],
      ["workspace", "accept"],
      ["auto", "auto"],
      ["plan", "plan"],
    ]);
    expect(SHIELD_TIERS.filter((t) => t.risky).map((t) => t.mode)).toEqual(["auto"]);
  });

  it("hints keep the one-line Chinese semantics (accept is the default and names the sensitive classes)", () => {
    const byMode = new Map(SHIELD_TIERS.map((t) => [t.mode, t]));
    expect(byMode.get("workspace")?.hint).toContain("默认");
    expect(byMode.get("workspace")?.hint).toContain("仍确认");
    expect(byMode.get("workspace")?.hint).toContain("命令");
    expect(byMode.get("ask")?.hint).toContain("每次询问");
    expect(byMode.get("auto")?.hint).toContain("全自动");
    expect(byMode.get("plan")?.hint).toContain("只读探查");
    expect(byMode.get("plan")?.hint).toContain("拒绝");
  });

  it("shieldValueOf maps the runtime modes (unknown folds to the workspace tier)", () => {
    expect(shieldValueOf("ask")).toBe("ask");
    expect(shieldValueOf("workspace")).toBe("workspace");
    expect(shieldValueOf("auto")).toBe("auto");
    expect(shieldValueOf("plan")).toBe("plan");
    expect(shieldValueOf("read-only")).toBe("workspace"); // retired mode name → default tier
  });
});

describe("ShieldSelector interaction", () => {
  /** The chip click that opens the menu (the only entry to the tiers). */
  const openMenu = (c: HTMLElement): HTMLElement => {
    const chip = c.querySelector(".chip") as HTMLButtonElement;
    expect(chip).not.toBeNull();
    act(() => {
      chip.click();
    });
    const menu = c.querySelector(".pop .menu") as HTMLElement;
    expect(menu).not.toBeNull();
    return menu;
  };

  it("renders the chip (current tier + caret); the menu is closed until clicked", () => {
    const c = mount(<ShieldSelector value="ask" onChange={() => {}} />);
    const chip = c.querySelector(".pop .chip") as HTMLButtonElement;
    expect(chip.textContent).toContain("ask"); // the the upstream format label — no emoji
    expect(chip.textContent).toContain("▾");
    expect(chip.className).toContain("sel"); // a non-default tier highlights
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(c.querySelector(".pop .menu")).toBeNull();
    openMenu(c);
    const items = [...c.querySelectorAll(".pop .mi")] as HTMLButtonElement[];
    expect(items.map((m) => m.getAttribute("data-mode"))).toEqual(["ask", "workspace", "auto", "plan"]);
    expect(items[0]?.getAttribute("aria-checked")).toBe("true");
    expect(items[1]?.getAttribute("aria-checked")).toBe("false");
  });

  it("the workspace tier's chip carries no `.sel`; a disabled chip never opens the menu", () => {
    const c = mount(<ShieldSelector value="workspace" onChange={() => {}} />);
    expect((c.querySelector(".pop .chip") as HTMLElement).className).not.toContain("sel");
    const c2 = mount(<ShieldSelector value="workspace" onChange={() => {}} disabled={true} />);
    const chip = c2.querySelector(".pop .chip") as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    act(() => {
      chip.click(); // swallowed by the disabled control
    });
    expect(c2.querySelector(".pop .menu")).toBeNull();
  });

  it("the safe tiers pick directly: ask→ask, accept→workspace, plan→plan (menu closes)", async () => {
    const onPick = vi.fn();
    const c = mount(<ShieldSelector value="workspace" onChange={onPick} />);
    openMenu(c);
    await act(async () => {
      (c.querySelector(".pop .mi[data-mode='ask']") as HTMLButtonElement).click();
    });
    expect(onPick).toHaveBeenCalledWith("ask");
    expect(c.querySelector(".pop .menu")).toBeNull(); // committed → closed
    openMenu(c);
    await act(async () => {
      (c.querySelector(".pop .mi[data-mode='workspace']") as HTMLButtonElement).click();
    });
    expect(onPick).toHaveBeenCalledWith("workspace");
    // plan is safe (read-only 探查) — a direct pick, no confirm gate, and it
    // highlights the chip (a non-default tier).
    openMenu(c);
    await act(async () => {
      (c.querySelector(".pop .mi[data-mode='plan']") as HTMLButtonElement).click();
    });
    expect(onPick).toHaveBeenCalledWith("plan");
    expect(c.querySelector(".pop .menu")).toBeNull();
    const c2 = mount(<ShieldSelector value="plan" onChange={onPick} />);
    expect((c2.querySelector(".pop .chip") as HTMLElement).className).toContain("sel");
  });

  it("the risky tier (auto) needs the inline confirm: first click arms, second commits", async () => {
    const onPick = vi.fn();
    const c = mount(<ShieldSelector value="workspace" onChange={onPick} />);
    openMenu(c);
    const risky = c.querySelector(".pop .mi[data-mode='auto']") as HTMLButtonElement;
    // The badge rides the risky item from the start.
    expect(c.querySelector(".pop .mi .warned")?.textContent).toContain("需确认");
    await act(async () => {
      risky.click(); // first click — inline confirm state, nothing committed
    });
    expect(onPick).not.toHaveBeenCalled();
    expect(c.textContent).toContain(RISK_CONFIRM_TEXT);
    expect(c.querySelector(".pop .menu")).not.toBeNull(); // still open, still changeable
    await act(async () => {
      risky.click(); // second click — the explicit confirm
    });
    expect(onPick).toHaveBeenCalledWith("auto");
    expect(c.querySelector(".pop .menu")).toBeNull();
    // Review MEDIUM (a11y): the committed item unmounts — focus returns to
    // the chip, never to <body>. #456 (ω99-306): the refocus is deferred one
    // task past the click — flush it (async act alone only drains microtasks,
    // which is exactly why this pin was flaky before the flush).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.activeElement).toBe(c.querySelector(".pop .chip"));
  });

  it("Esc closes the menu without committing; an armed confirm resets on reopen", async () => {
    const onPick = vi.fn();
    const c = mount(<ShieldSelector value="workspace" onChange={onPick} />);
    openMenu(c);
    await act(async () => {
      (c.querySelector(".pop .mi[data-mode='auto']") as HTMLButtonElement).click(); // arm the confirm
    });
    await act(async () => {
      (c.querySelector(".pop") as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(onPick).not.toHaveBeenCalled();
    expect(c.querySelector(".pop .menu")).toBeNull();
    // Review MEDIUM (a11y): Esc also returns focus to the chip. #456
    // (ω99-306): the refocus is deferred one task past the keypress —
    // flush before asserting.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.activeElement).toBe(c.querySelector(".pop .chip"));
    // Reopening starts fresh: the risky item is back to its un-armed wording.
    openMenu(c);
    expect(c.textContent).not.toContain(RISK_CONFIRM_TEXT);
    // An outside pointerdown closes without change too.
    await act(async () => {
      document.dispatchEvent(new Event("pointerdown"));
    });
    expect(onPick).not.toHaveBeenCalled();
    expect(c.querySelector(".pop .menu")).toBeNull();
  });

  it("starting in auto: re-selecting it needs no confirm; after dropping to a safer tier it re-locks", async () => {
    const onPick = vi.fn();
    const c = mount(<ShieldSelector value="auto" onChange={onPick} />);
    openMenu(c);
    await act(async () => {
      (c.querySelector(".pop .mi[data-mode='auto']") as HTMLButtonElement).click();
    });
    expect(onPick).toHaveBeenCalledWith("auto"); // already the risky tier — no re-confirm
    // The parent applies workspace (value change) — the confirm gate re-locks.
    await act(async () => {
      root?.render(<ShieldSelector value="workspace" onChange={onPick} />);
    });
    openMenu(c);
    await act(async () => {
      (c.querySelector(".pop .mi[data-mode='auto']") as HTMLButtonElement).click();
    });
    expect(onPick).toHaveBeenCalledTimes(1); // armed, not committed
    expect(c.textContent).toContain(RISK_CONFIRM_TEXT);
  });
});
