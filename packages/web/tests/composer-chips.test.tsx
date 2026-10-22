// The composer's model + effort chips (spec 2026-08-28 §2.1/2.2/2.4) —
// InputBox-level: the model chip is the ModelSelector dropdown (2026-08-28
// user feedback: the modal is gone; a row click rides
// onPickModel(model, provider)); the effort chip (EffortSelector) mounts
// only when the provider publishes efforts; both stay clickable while busy
// (they take effect next turn — only a dead connection disables them).
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InputBox } from "../src/components/InputBox.js";

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

const BASE = {
  busy: false,
  mode: "workspace" as const,
  commands: [],
  connected: true,
  onSubmit: vi.fn(),
  onInterrupt: vi.fn(),
  onShield: vi.fn(),
  onCycleMode: vi.fn(),
};

describe("InputBox composer chips (model + 推理强度)", () => {
  it("model chip: renders the label, a menu row click rides onPickModel(model, provider); absent when label is null", () => {
    const onPickModel = vi.fn();
    const c = mount(
      <InputBox
        {...BASE}
        modelLabel="deepseek-v3.2"
        modelProvider="deepseek"
        modelChoices={[
          { provider: "deepseek", model: "deepseek-v3.2", source: "registry" },
          { provider: "glm", model: "glm-5", source: "env" },
        ]}
        onPickModel={onPickModel}
      />,
    );
    const chip = c.querySelector<HTMLButtonElement>(".composer-tools .chip.model")!;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toContain("deepseek-v3.2");
    act(() => {
      chip.click(); // opens the dropdown (no direct-fire lane anymore)
    });
    // 2026-08-31 联动两栏:左列点供应商(常驻不消失),右栏联动出其模型。
    act(() => {
      c.querySelector<HTMLButtonElement>('.menu .mroot .mi.mprov[data-provider="glm"]')!.click();
    });
    const row = c.querySelector<HTMLButtonElement>('.menu .mi[data-model="glm-5"]');
    expect(row).not.toBeNull();
    act(() => {
      row!.click();
    });
    expect(onPickModel).toHaveBeenCalledTimes(1);
    expect(onPickModel).toHaveBeenCalledWith("glm-5", "glm");
    expect(c.querySelector(".menu")).toBeNull(); // picked → closed

    const c2 = mount(<InputBox {...BASE} modelLabel={null} onPickModel={onPickModel} />);
    expect(c2.querySelector(".composer-tools .chip.model")).toBeNull();
  });

  it("effort chip: absent on an empty efforts list; present with the current level otherwise", () => {
    const c1 = mount(
      <InputBox {...BASE} efforts={["off", "high"]} effort="off" onPickEffort={vi.fn()} />,
    );
    const chips = [...c1.querySelectorAll<HTMLButtonElement>(".composer-tools .chip")];
    expect(chips.some((b) => b.textContent?.includes("off") === true)).toBe(true);

    const cEmpty = mount(<InputBox {...BASE} efforts={[]} effort={null} onPickEffort={vi.fn()} />);
    const chipsEmpty = [...cEmpty.querySelectorAll<HTMLButtonElement>(".composer-tools .chip")];
    expect(chipsEmpty.some((b) => b.textContent?.includes("强度") === true)).toBe(false);
  });

  it("busy does NOT disable the chips (next-turn semantics); they sit after the shield chip", () => {
    const onPickModel = vi.fn();
    const c = mount(
      <InputBox
        {...BASE}
        busy={true}
        modelLabel="m"
        modelProvider="deepseek"
        modelChoices={[{ provider: "deepseek", model: "m", source: "registry" }]}
        onPickModel={onPickModel}
        efforts={["high"]}
        effort="high"
        onPickEffort={vi.fn()}
      />,
    );
    const model = c.querySelector<HTMLButtonElement>(".composer-tools .chip.model")!;
    expect(model.disabled).toBe(false);
    // The effort chip (a .pop) also enabled; locate via its aria-haspopup menu chip.
    const pops = [...c.querySelectorAll<HTMLButtonElement>(".composer-tools .pop > .chip")];
    const effortChip = pops.find((b) => b.textContent?.includes("high") === true);
    expect(effortChip?.disabled).toBe(false);
    // Order: shield before model before effort within composer-tools.
    const shieldChip = c.querySelector<HTMLButtonElement>('.composer-tools .pop > .chip[data-mode]')!;
    expect(
      shieldChip.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      model.compareDocumentPosition(effortChip!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
