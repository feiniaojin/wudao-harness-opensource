// 推理档三级配置 + 语言 chip S5 (spec
// docs/superpowers/specs/2026-08-28-effort-tiering-language-chip-design.md
// §5) — the WEB surfaces of the S3/S4 chains, part 1: the LanguageSelector
// chip (双旋钮 dropdown — 回答 auto|on|off / 思考 auto|zh|en|off; rows are
// SESSION picks riding /language, per-group 设为默认 footers persist the
// session-effective value via settingsSet language.*), the pure wire helpers
// (languagePickCommand / languageDefaultKey / providerEffortSavePayload — the
// modelPickCommand pattern), and the chip's MOUNT. ω99-234 census 演进
// （同形）：the InputBox mounting segment evolved wholesale to the
// settings-page mounting form — the chip retired off the composer (频率分层
// 归位) and now lives on the 偏好 tab, where rows/footers pin the global
// default through the tab's settingsSet write lane.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanguageSelector } from "../src/components/LanguageSelector.js";
import { EffortSelector } from "../src/components/EffortSelector.js";
import { InputBox } from "../src/components/InputBox.js";
import { PreferencesTab } from "../src/components/PreferencesTab.js";
import { languagePickCommand, languageDefaultKey, providerEffortSavePayload } from "../src/protocol.js";
import type { ProviderCard, WudaoClient } from "../src/protocol.js";

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

// ---------------------------------------------------------------------------
// The pure wire helpers (the modelPickCommand pattern: App callbacks stay
// one-liners, the line formats are pinned HERE).
// ---------------------------------------------------------------------------
describe("S5 — languagePickCommand / languageDefaultKey", () => {
  it("builds the /language submission line for each knob and mode", () => {
    expect(languagePickCommand("reply", "on")).toBe("/language reply on");
    expect(languagePickCommand("reply", "off")).toBe("/language reply off");
    expect(languagePickCommand("reply", "auto")).toBe("/language reply auto");
    expect(languagePickCommand("reasoning", "zh")).toBe("/language reasoning zh");
    expect(languagePickCommand("reasoning", "en")).toBe("/language reasoning en");
    expect(languagePickCommand("reasoning", "off")).toBe("/language reasoning off");
  });

  it("maps each knob to its settingsSet key (the S3 write lane)", () => {
    expect(languageDefaultKey("reply")).toBe("language.reply");
    expect(languageDefaultKey("reasoning")).toBe("language.reasoning");
  });
});

// ---------------------------------------------------------------------------
// providerEffortSavePayload — the EffortSelector footer's save: the registry
// row save REPLACES wholesale (F1), so the pin must ECHO the full card.
// ---------------------------------------------------------------------------
describe("S5 — providerEffortSavePayload (the FULL-echo rule)", () => {
  const BUILTIN: ProviderCard = {
    provider: "deepseek",
    label: "deepseek",
    status: "ready",
    keySource: "env",
    endpoint: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-flash",
    custom: false,
    reasoningFormat: "deepseek",
    persona: "alpha",
    models: [{ name: "deepseek-chat", contextLength: 128000 }],
  };
  const CUSTOM: ProviderCard = {
    ...BUILTIN,
    provider: "my-gateway",
    label: "My Gateway",
    custom: true,
    baseUrl: "https://gw.example.com/v1",
    defaultContextLength: 131072,
    wire: "openai-chat",
    models: [{ name: "m-x" }, { name: "m-y", contextLength: 64000 }],
  };

  it("builtin: the overlay payload carries models + reasoningFormat + persona + the new effort", () => {
    const p = providerEffortSavePayload(BUILTIN, "high");
    expect(p.effort).toBe("high");
    expect(p.models).toEqual([{ name: "deepseek-chat", contextLength: 128000 }]);
    expect(p.reasoningFormat).toBe("deepseek");
    expect(p.persona).toBe("alpha");
    expect(p.baseUrl).toBeUndefined(); // the overlay lane never carries baseUrl
  });

  it("custom: the FULL echo — every registry field rides back, effort replaced", () => {
    const card: ProviderCard = { ...CUSTOM, effort: "low" };
    const p = providerEffortSavePayload(card, "max");
    expect(p.effort).toBe("max"); // replaced, not merged
    expect(p.label).toBe("My Gateway");
    expect(p.baseUrl).toBe("https://gw.example.com/v1");
    expect(p.defaultModel).toBe("deepseek-v4-flash");
    expect(p.defaultContextLength).toBe(131072);
    expect(p.reasoningFormat).toBe("deepseek");
    expect(p.wire).toBe("openai-chat");
    expect(p.persona).toBe("alpha");
    expect(p.models).toEqual([{ name: "m-x" }, { name: "m-y", contextLength: 64000 }]);
  });
});

// ---------------------------------------------------------------------------
// LanguageSelector — the 双旋钮 chip.
// ---------------------------------------------------------------------------
describe("S5 — LanguageSelector (the language chip)", () => {
  const VALUE = { reply: "auto" as const, reasoning: "auto" as const };

  it("chip shows 语言 at auto/auto (no .sel); a deviating knob adds .sel and the label follows reply", () => {
    const c1 = mount(<LanguageSelector value={VALUE} onPick={vi.fn()} onPersistDefault={vi.fn()} />);
    const chip1 = c1.querySelector<HTMLButtonElement>("button.chip.lang")!;
    expect(chip1).not.toBeNull();
    expect(chip1.textContent).toContain("语言");
    expect(chip1.classList.contains("sel")).toBe(false);

    const c2 = mount(<LanguageSelector value={{ reply: "on", reasoning: "auto" }} onPick={vi.fn()} onPersistDefault={vi.fn()} />);
    const chip2 = c2.querySelector<HTMLButtonElement>("button.chip.lang")!;
    expect(chip2.textContent).toContain("中文");
    expect(chip2.classList.contains("sel")).toBe(true);

    // reply auto but reasoning deviates: label stays 语言, the chip is .sel
    const c3 = mount(<LanguageSelector value={{ reply: "auto", reasoning: "zh" }} onPick={vi.fn()} onPersistDefault={vi.fn()} />);
    expect(c3.querySelector("button.chip.lang")!.classList.contains("sel")).toBe(true);
  });

  it("opens on chip click: two groups (回答/思考) with the right rows, current values .on", () => {
    const c = mount(<LanguageSelector value={{ reply: "on", reasoning: "zh" }} onPick={vi.fn()} onPersistDefault={vi.fn()} />);
    act(() => {
      c.querySelector<HTMLButtonElement>("button.chip.lang")!.click();
    });
    const heads = [...c.querySelectorAll<HTMLElement>(".menu .lang-head")].map((h) => h.textContent);
    expect(heads).toEqual(["回答", "思考"]);
    const replyRows = [...c.querySelectorAll<HTMLElement>('.menu .mi[data-knob="reply"]')].map((r) => r.dataset.mode);
    expect(replyRows).toEqual(["auto", "on", "off"]);
    const reasonRows = [...c.querySelectorAll<HTMLElement>('.menu .mi[data-knob="reasoning"]')].map((r) => r.dataset.mode);
    expect(reasonRows).toEqual(["auto", "zh", "en", "off"]);
    expect(c.querySelector<HTMLElement>('.mi[data-knob="reply"][data-mode="on"]')!.classList.contains("on")).toBe(true);
    expect(c.querySelector<HTMLElement>('.mi[data-knob="reasoning"][data-mode="zh"]')!.classList.contains("on")).toBe(true);
  });

  it("a row click is a SESSION pick (onPick(knob, mode)) and closes the menu", () => {
    const onPick = vi.fn();
    const c = mount(<LanguageSelector value={VALUE} onPick={onPick} onPersistDefault={vi.fn()} />);
    act(() => {
      c.querySelector<HTMLButtonElement>("button.chip.lang")!.click();
    });
    act(() => {
      c.querySelector<HTMLButtonElement>('.mi[data-knob="reply"][data-mode="on"]')!.click();
    });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("reply", "on");
    expect(c.querySelector(".menu")).toBeNull();
  });

  it("per-group 设为默认 footers fire onPersistDefault(knob) exactly once", () => {
    const onPersist = vi.fn();
    const c = mount(
      <LanguageSelector value={{ reply: "on", reasoning: "zh" }} onPick={vi.fn()} onPersistDefault={onPersist} />,
    );
    act(() => {
      c.querySelector<HTMLButtonElement>("button.chip.lang")!.click();
    });
    const footers = c.querySelectorAll<HTMLButtonElement>(".menu .mf");
    expect(footers).toHaveLength(2);
    act(() => {
      footers[0]!.click();
    });
    expect(onPersist).toHaveBeenCalledWith("reply");
    act(() => {
      c.querySelector<HTMLButtonElement>("button.chip.lang")!.click();
    });
    act(() => {
      c.querySelector<HTMLButtonElement>('.menu .mf[data-persist="reasoning"]')!.click();
    });
    expect(onPersist).toHaveBeenCalledWith("reasoning");
    expect(onPersist).toHaveBeenCalledTimes(2);
  });

  it("Esc closes and refocuses the chip; the footer is absent without onPersistDefault", async () => {
    const c = mount(<LanguageSelector value={VALUE} onPick={vi.fn()} onPersistDefault={vi.fn()} />);
    const chip = c.querySelector<HTMLButtonElement>("button.chip.lang")!;
    act(() => {
      chip.click();
    });
    act(() => {
      c
        .querySelector<HTMLDivElement>(".pop")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(c.querySelector(".menu")).toBeNull();
    // #456 (ω99-306): the refocus is deferred one task past the keypress.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.activeElement).toBe(chip);

    const c2 = mount(<LanguageSelector value={VALUE} onPick={vi.fn()} />);
    act(() => {
      c2.querySelector<HTMLButtonElement>("button.chip.lang")!.click();
    });
    expect(c2.querySelectorAll(".menu .mf")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EffortSelector's 设为 {provider} 默认 footer (the provider-binding pin).
// ---------------------------------------------------------------------------
describe("S5 — EffortSelector persist-default footer", () => {
  it("renders the footer with the provider label; a click fires onPersistDefault once and closes", () => {
    const onPersist = vi.fn();
    const c = mount(
      <EffortSelector efforts={["low", "high"]} current="high" providerLabel="DeepSeek" onPick={vi.fn()} onPersistDefault={onPersist} />,
    );
    act(() => {
      c.querySelector<HTMLButtonElement>("button.chip")!.click();
    });
    const foot = c.querySelector<HTMLButtonElement>('[data-action="persist-effort-default"]');
    expect(foot).not.toBeNull();
    expect(foot!.textContent).toContain("DeepSeek");
    act(() => {
      foot!.click();
    });
    expect(onPersist).toHaveBeenCalledTimes(1);
    expect(c.querySelector(".menu")).toBeNull();
  });

  it("no footer without the prop (the bare chip is unchanged)", () => {
    const c = mount(<EffortSelector efforts={["low"]} current="low" onPick={vi.fn()} />);
    act(() => {
      c.querySelector<HTMLButtonElement>("button.chip")!.click();
    });
    expect(c.querySelector('[data-action="persist-effort-default"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The chip's mount (ω99-234: composer → settings 偏好). The InputBox mounting
// segment evolved same-form: the composer renders NO language chip anymore
// (the retirement pin); the SAME component lives on the 偏好 tab, mounted
// when the language feed is non-null, its rows/footers writing the GLOBAL
// default (settingsSet language.* — the tab's own write lane).
// ---------------------------------------------------------------------------
describe("S5 — the chip's mount (ω99-234: composer → settings 偏好)", () => {
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

  it("InputBox renders NO language chip (retired off the composer); model/effort chips stay", () => {
    const c = mount(
      <InputBox
        {...BASE}
        modelLabel="deepseek-v4-flash"
        modelProvider="deepseek"
        modelChoices={[{ provider: "deepseek", model: "deepseek-v4-flash", source: "registry" }]}
        onPickModel={vi.fn()}
        efforts={["low", "high"]}
        effort="high"
        onPickEffort={vi.fn()}
      />,
    );
    expect(c.querySelector(".composer-tools .chip.lang")).toBeNull(); // the retirement pin
    expect(c.querySelector(".composer-tools .chip.model")).not.toBeNull(); // 不误伤
    expect(c.querySelector(".composer-tools button.chip[title='推理强度(会话内,下一轮生效)']")).not.toBeNull();
  });

  it("PreferencesTab mounts the SAME chip when language non-null; absent when null; a row pick pins the default", async () => {
    const settingsSet = vi.fn().mockResolvedValue({ saved: true });
    const client = { settingsSet } as unknown as WudaoClient;
    const notify = vi.fn();
    const refresh = vi.fn();
    const c = mount(
      <PreferencesTab client={client} settings={null} notify={notify} refresh={refresh} language={{ reply: "auto", reasoning: "auto" }} />,
    );
    const chip = c.querySelector<HTMLButtonElement>("button.chip.lang");
    expect(chip).not.toBeNull();
    act(() => {
      chip!.click();
    });
    await act(async () => {
      c.querySelector<HTMLButtonElement>('.mi[data-knob="reasoning"][data-mode="en"]')!.click();
    });
    expect(settingsSet).toHaveBeenCalledWith("language.reasoning", "en");
    expect(notify).toHaveBeenCalledWith("已设为默认:思考 en —— 新会话生效");

    const c2 = mount(<PreferencesTab client={client} settings={null} notify={notify} refresh={refresh} language={null} />);
    expect(c2.querySelector(".chip.lang")).toBeNull(); // 旧服务端 null 门语义沿设
  });
});
