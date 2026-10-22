// @vitest-environment jsdom
// persona-settings T7 — the ProviderDetail「Persona 绑定」row, mounted
// DIRECTLY against a MOCKED op client (the personaList op lands with T5; the
// wire contract is pinned here): the three-state selector round-trips the
// registry's `persona` column — 跟随全局 (key absent) / 指定 <id> / 强制无
// (explicit null) — through BOTH save payloads; the custom FULL payload echoes
// the card's existing binding untouched (the F1/reasoningFormat rule: the
// server replaces the registry row wholesale, so an unechoed field dies), and
// a builtin save keeps the rest of the overlay intact (persona rides ALONGSIDE
// reasoningFormat + models, never replacing them). The dropdown's options are
// personaList's rows (a stale binding id not in the list still renders as its
// own option so the state is visible and round-trips), and a personaList
// failure degrades — the row still works for follow-global/forced-none.
// iter3 (strict master-detail): the panel also owns the CARDS' old lanes now
// — the keyrow (settingsSaveKey + the pasted-key 测试连接) and the quick-switch
// model chips (/model same-provider, /provider cross) — pinned below against
// the same mocked client.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProviderDetail } from "../src/components/ProviderDetail.js";
import type { ProviderCard, PersonaListResult, WudaoClient as WudaoClientType } from "../src/protocol.js";

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

// --- fixtures (the T5 wire contract) -------------------------------------------

const LIST: PersonaListResult = {
  personas: [
    { id: "the upstream format", displayName: "DeepSeek Harness", source: "builtin", layers: "headers+prompt", editable: false },
    { id: "alpha", displayName: "Alpha", source: "global", layers: "headers", editable: true },
  ],
};

/** A BUILTIN card carrying an existing overlay: a compiled reasoningFormat
 *  and one registered model row — the binding row must save WITHOUT losing
 *  either. No `persona` key (the follow-global default state). */
const BUILTIN_CARD: ProviderCard = {
  provider: "deepseek",
  label: "deepseek",
  status: "ready",
  keySource: "env",
  endpoint: "https://api.deepseek.com",
  defaultModel: "deepseek-v4-flash",
  custom: false,
  reasoningFormat: "deepseek",
  models: [{ name: "deepseek-chat", contextLength: 128000 }],
};

/** A registry custom with an EXISTING binding — the full-payload echo case. */
const CUSTOM_CARD: ProviderCard = {
  provider: "my-gateway",
  label: "My Gateway",
  status: "ready",
  keySource: "credentials",
  endpoint: "https://gw.example.com/v1",
  defaultModel: "m-x",
  baseUrl: "https://gw.example.com/v1",
  custom: true,
  defaultContextLength: 131072,
  reasoningFormat: "deepseek",
  persona: "alpha",
  models: [{ name: "m-x", contextLength: 64000 }],
};

// --- the mocked-op-client harness ----------------------------------------------

type Spy = ReturnType<typeof vi.fn>;

interface Harness {
  container: HTMLElement;
  personaListMock: Spy;
  saveProviderMock: Spy;
  /** iter3: the detail's key lane (settingsSaveKey) + the chip/apply switch
   *  lane (submit) — mocked alongside the registry save from day one. */
  saveKeyMock: Spy;
  testMock: Spy;
  submitMock: Spy;
  /** 模型配置反馈 2026-08-29 ②④: the boot-default write lane + the /models
   *  probe the picker rides. */
  setMock: Spy;
  listModelsMock: Spy;
  notify: Spy;
  refresh: Spy;
}

/** Flush the mock promise chains (personaList → setState → render) in act. */
const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

async function renderDetail(opts: {
  readonly card: ProviderCard;
  readonly list?: PersonaListResult | "reject";
  /** iter3: the chips row's model list (the parent's cardModels product).
   *  Defaults to the card's defaultModel — enough for the binding suites,
   *  which never click a chip. */
  readonly models?: readonly string[];
  /** The live identity the chips' lanes ride (defaults to the card itself =
   *  every chip same-provider; a DIFFERENT id makes them cross-provider). */
  readonly currentProvider?: string;
  /** The live MODEL (defaults to the card's defaultModel, as the parent
   *  passes it). */
  readonly currentModel?: string;
  /** 模型配置反馈 2026-08-29 ②: the boot default (settings.defaultModel)
   *  the 默认 badge + the per-row 设为默认 lane ride. Default undefined =
   *  no boot default written yet. */
  readonly defaultModel?: { readonly provider: string; readonly model: string } | null;
  /** ④: the /models probe's scripted reply (default ok + empty catalog). */
  readonly listModels?: { ok: true; models: readonly { name: string; contextLength?: number }[] } | { ok: false; state: string; message: string };
  /** The registry save's scripted reply (default ok). */
  readonly saveProvider?: { ok: false; error: string };
  /** round 5 (2026-08-30 spec): the panel's render mode. "edit" is the LEGACY
   *  default for this suite — every pre-round-5 test exercises the form, so
   *  the harness enters edit mode for them (one declared click, not forty
   *  scattered ones). "read" mounts the dossier the user actually sees. */
  readonly mode?: "edit" | "read";
}): Promise<Harness> {
  const personaListMock =
    opts.list === "reject"
      ? vi.fn(() => Promise.reject(new Error("boom")))
      : vi.fn(() => Promise.resolve(opts.list ?? LIST));
  const saveProviderMock =
    opts.saveProvider !== undefined
      ? vi.fn(() => Promise.resolve(opts.saveProvider))
      : vi.fn(() => Promise.resolve({ ok: true as const, provider: opts.card.provider }));
  const saveKeyMock = vi.fn(() => Promise.resolve({ provider: opts.card.provider, saved: true, keyCount: 3 }));
  const testMock = vi.fn(() => Promise.resolve({ ok: true, state: "ok", message: "连接成功" }));
  const submitMock = vi.fn(() => Promise.resolve("started"));
  const setMock = vi.fn(() => Promise.resolve({ key: "", saved: true }));
  const listModelsMock = vi.fn(() => Promise.resolve(opts.listModels ?? { ok: true as const, models: [] }));
  const client = {
    personaList: personaListMock,
    settingsSaveProvider: saveProviderMock,
    settingsSaveKey: saveKeyMock,
    settingsTestConnection: testMock,
    submit: submitMock,
    settingsSet: setMock,
    settingsListModels: listModelsMock,
  } as unknown as WudaoClientType;
  const notify = vi.fn();
  const refresh = vi.fn();
  const container = mount(
    <ProviderDetail
      client={client}
      card={opts.card}
      models={opts.models ?? (opts.card.defaultModel !== "" ? [opts.card.defaultModel] : [])}
      currentProvider={opts.currentProvider ?? opts.card.provider}
      currentModel={opts.currentModel ?? opts.card.defaultModel}
      defaultModel={opts.defaultModel}
      notify={notify}
      refresh={refresh}
    />,
  );
  await flush();
  if (opts.mode !== "read") {
    // round 5: the form exists only once 「编辑」 opens it.
    const edit = [...container.querySelectorAll("button")].find((x) => x.textContent === "编辑");
    if (edit === undefined) throw new Error("编辑 button missing (read mode is the default render)");
    act(() => {
      edit.click();
    });
    await flush();
  }
  return {
    container,
    personaListMock,
    saveProviderMock,
    // The iter3 key/chip lanes' mocks — narrowed from the same unknown cast.
    saveKeyMock,
    testMock,
    submitMock,
    setMock,
    listModelsMock,
    notify,
    refresh,
  };
}

// --- DOM helpers (the suite's userEvent/screen: raw queries + native events) ---

const bindingSelect = (c: HTMLElement): HTMLSelectElement => {
  const el = c.querySelector('select[aria-label="Persona 绑定"]');
  if (!(el instanceof HTMLSelectElement)) throw new Error("Persona 绑定 select missing");
  return el;
};

/** The binding row's layer qualifier select (iteration 2 T2) — the
 *  `id:layers` spec's tail, applied only to a bound persona. */
const layerSelect = (c: HTMLElement): HTMLSelectElement => {
  const el = c.querySelector('select[aria-label="Persona 层"]');
  if (!(el instanceof HTMLSelectElement)) throw new Error("Persona 层 select missing");
  return el;
};

const btnByText = (scope: HTMLElement, text: string): HTMLButtonElement => {
  const b = [...scope.querySelectorAll("button")].find((x) => x.textContent === text);
  if (b === undefined) throw new Error(`button "${text}" missing`);
  return b as HTMLButtonElement;
};

const click = (el: HTMLElement): void => {
  act(() => {
    el.click();
  });
};

/** Type into an input the React way (native setter + input event). */
const type = (el: HTMLInputElement, text: string): void => {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const selectOption = (el: HTMLSelectElement, value: string): void => {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

// The selector's three states: the sentinels can never collide with a persona
// id (PERSONA_ID_RE is lowercase kebab).
const FOLLOW_GLOBAL = "";
const FORCED_NONE = "::none";

/** Click 保存修改 and return the config payload that left (null when the
 *  gate blocked — nothing left the browser). */
async function savePayload(h: Harness): Promise<Record<string, unknown> | null> {
  click(btnByText(h.container, "保存修改"));
  await flush();
  const calls = h.saveProviderMock.mock.calls as unknown as [string, Record<string, unknown>][];
  return calls.length > 0 ? (calls[calls.length - 1]?.[1] ?? null) : null;
}

/** Round 5 (契约反转): a successful save EXITS to read mode — tests that
 *  keep editing after a save re-enter through the door the product has
 *  (编辑). The drafts survived the exit, so the continuation is seamless. */
async function enterEdit(h: Harness): Promise<void> {
  click(btnByText(h.container, "编辑"));
  await flush();
}

// --- the binding row ------------------------------------------------------------

describe("ProviderDetail Persona binding (mocked op client)", () => {
  it.each([
    ["follow-global", FOLLOW_GLOBAL, undefined],
    ["bound", "alpha", "alpha"],
    ["forced-none", FORCED_NONE, null],
  ] as const)("binding selector round-trips persona=%p", async (_name, choice, expected) => {
    const h = await renderDetail({ card: BUILTIN_CARD });
    selectOption(bindingSelect(h.container), choice);
    const payload = await savePayload(h);
    expect(payload).not.toBeNull();
    // The contract: follow-global OMITS the key entirely (the absent state is
    // a choice, distinct from null); bound carries the id; forced-none carries
    // an EXPLICIT null.
    if (expected === undefined) {
      expect(Object.prototype.hasOwnProperty.call(payload, "persona")).toBe(false);
    } else {
      expect(payload?.["persona"]).toBe(expected);
    }
  });

  it("saving the binding on a builtin card keeps the rest of the overlay intact", async () => {
    const h = await renderDetail({ card: BUILTIN_CARD });
    selectOption(bindingSelect(h.container), FORCED_NONE);
    const payload = await savePayload(h);
    expect(payload?.["persona"]).toBeNull();
    expect(payload?.["reasoningFormat"]).toBe(BUILTIN_CARD.reasoningFormat); // 不丢其他字段
    expect(payload?.["models"]).toEqual(BUILTIN_CARD.models); // the overlay's content survives too
    expect(payload?.["label"]).toBeUndefined(); // unchanged label still never rides (overlay rule)
  });

  it.each([
    ["echoes a bound id untouched", "alpha", "alpha"],
    ["echoes forced-none untouched", null, null],
    ["omits the key when unbound", undefined, undefined],
  ] as const)(
    "custom full save %p (the F1 echo — an untouched binding never dies)",
    async (_name, initial, expected) => {
      const h = await renderDetail({ card: { ...CUSTOM_CARD, persona: initial } });
      // No selector interaction: open + save immediately.
      const payload = await savePayload(h);
      if (expected === undefined) {
        expect(Object.prototype.hasOwnProperty.call(payload, "persona")).toBe(false);
      } else {
        expect(payload?.["persona"]).toBe(expected);
      }
      // The rest of the FULL payload still rides every registry field.
      expect(payload).toMatchObject({
        label: "My Gateway",
        baseUrl: "https://gw.example.com/v1",
        defaultModel: "m-x",
        defaultContextLength: 131072,
        reasoningFormat: "deepseek",
        models: [{ name: "m-x", contextLength: 64000 }],
      });
    },
  );

  it("the dropdown lists personaList's rows between the two sentinels; a bound card seeds the selector", async () => {
    const h = await renderDetail({ card: CUSTOM_CARD });
    expect(h.personaListMock).toHaveBeenCalledTimes(1);
    const sel = bindingSelect(h.container);
    const options = [...sel.querySelectorAll("option")].map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(["", "the upstream format", "alpha", "::none"]);
    // The custom's existing binding seeds the selector (visible state).
    expect(sel.value).toBe("alpha");
  });

  it("a stale binding id not in personaList still renders as its own option and round-trips", async () => {
    const h = await renderDetail({ card: { ...BUILTIN_CARD, persona: "ghost" } });
    const sel = bindingSelect(h.container);
    expect([...sel.querySelectorAll("option")].map((o) => (o as HTMLOptionElement).value)).toContain("ghost");
    expect(sel.value).toBe("ghost");
    const payload = await savePayload(h);
    expect(payload?.["persona"]).toBe("ghost"); // the visible state saves back unchanged
  });

  it("a personaList failure degrades — the row still switches and saves", async () => {
    const h = await renderDetail({ card: BUILTIN_CARD, list: "reject" });
    await flush();
    const sel = bindingSelect(h.container);
    // Only the sentinels are choosable, but the three-state contract holds.
    expect([...sel.querySelectorAll("option")].map((o) => (o as HTMLOptionElement).value)).toEqual(["", "::none"]);
    selectOption(sel, FORCED_NONE);
    const payload = await savePayload(h);
    expect(payload?.["persona"]).toBeNull();
  });
});

// --- the binding row's layer qualifier (iteration 2 T2) --------------------------

describe("ProviderDetail 协议 (wire) row — 0.3.13 #215 (mocked op client)", () => {
  const wireSelect = (c: HTMLElement): HTMLSelectElement => {
    const el = c.querySelector('select[aria-label$=" 协议"]');
    if (!(el instanceof HTMLSelectElement)) throw new Error("协议 select missing");
    return el;
  };

  it("a custom card carries an editable selector; an untouched anthropic wire round-trips (the F1 echo)", async () => {
    const h = await renderDetail({ card: { ...CUSTOM_CARD, wire: "anthropic" } });
    expect(wireSelect(h.container).value).toBe("anthropic");
    const payload = await savePayload(h);
    expect(payload?.["wire"]).toBe("anthropic");
  });

  it("a wire-less custom stays wire-less after a save (absence is the default state, never a materialized openai-chat)", async () => {
    const h = await renderDetail({ card: CUSTOM_CARD });
    expect(wireSelect(h.container).value).toBe("");
    const payload = await savePayload(h);
    expect(Object.prototype.hasOwnProperty.call(payload, "wire")).toBe(false);
  });

  it("switching the selector to Anthropic lands wire:anthropic in the save payload", async () => {
    const h = await renderDetail({ card: CUSTOM_CARD });
    selectOption(wireSelect(h.container), "anthropic");
    const payload = await savePayload(h);
    expect(payload?.["wire"]).toBe("anthropic");
  });

  it("a builtin card renders its FIXED protocol (no selector); the save echoes the profile's pin and omits absence", async () => {
    const h = await renderDetail({ card: BUILTIN_CARD });
    expect(h.container.querySelector('select[aria-label$=" 协议"]')).toBeNull(); // fixed text, not a picker
    expect(h.container.querySelector(".detail-wire-fixed")?.textContent).toContain("OpenAI 兼容");
    const payload = await savePayload(h);
    expect(Object.prototype.hasOwnProperty.call(payload, "wire")).toBe(false); // deepseek has no pin — stays absent
    // the anthropic builtin's compiled-in pin rides the card and the echo
    const h2 = await renderDetail({ card: { ...BUILTIN_CARD, provider: "anthropic", label: "anthropic", wire: "anthropic" } });
    expect(h2.container.querySelector(".detail-wire-fixed")?.textContent).toContain("Anthropic");
    const payload2 = await savePayload(h2);
    expect(payload2?.["wire"]).toBe("anthropic");
  });
});

describe("ProviderDetail Persona layer qualifier (mocked op client)", () => {
  it("仅 headers qualifies the bound persona; 全部层 restores the plain id", async () => {
    const h = await renderDetail({ card: BUILTIN_CARD });
    selectOption(bindingSelect(h.container), "alpha");
    selectOption(layerSelect(h.container), "headers");
    expect((await savePayload(h))?.["persona"]).toBe("alpha:headers");
    await enterEdit(h); // round 5: the save exited the form
    selectOption(layerSelect(h.container), "");
    expect((await savePayload(h))?.["persona"]).toBe("alpha");
  });

  it("the headers+prompt choice writes the + joined spec", async () => {
    const h = await renderDetail({ card: BUILTIN_CARD });
    selectOption(bindingSelect(h.container), "the upstream format");
    selectOption(layerSelect(h.container), "headers+prompt");
    expect((await savePayload(h))?.["persona"]).toBe("the upstream format:headers+prompt");
  });

  it("a layer picked BEFORE the persona still qualifies it; the sentinels never carry one", async () => {
    const h = await renderDetail({ card: BUILTIN_CARD });
    // Layer first, persona second — the pre-picked qualifier applies.
    selectOption(layerSelect(h.container), "prompt");
    selectOption(bindingSelect(h.container), "alpha");
    expect((await savePayload(h))?.["persona"]).toBe("alpha:prompt");
    await enterEdit(h); // round 5: the save exited the form
    // 强制无 and 跟随全局 are layer-free by construction.
    selectOption(bindingSelect(h.container), FORCED_NONE);
    expect((await savePayload(h))?.["persona"]).toBeNull();
    await enterEdit(h); // round 5: that save exited the form too
    selectOption(bindingSelect(h.container), FOLLOW_GLOBAL);
    const payload = await savePayload(h);
    expect(Object.prototype.hasOwnProperty.call(payload, "persona")).toBe(false);
  });

  it("a layer choice with NO persona bound never mints a persona key", async () => {
    const h = await renderDetail({ card: BUILTIN_CARD });
    selectOption(layerSelect(h.container), "headers");
    const payload = await savePayload(h);
    expect(Object.prototype.hasOwnProperty.call(payload, "persona")).toBe(false);
    expect(payload?.["reasoningFormat"]).toBe(BUILTIN_CARD.reasoningFormat); // the overlay survives
  });

  it("a pre-qualified card binding seeds BOTH selectors and round-trips untouched (the F1 echo)", async () => {
    const h = await renderDetail({ card: { ...CUSTOM_CARD, persona: "alpha:prompt" } });
    expect(bindingSelect(h.container).value).toBe("alpha");
    expect(layerSelect(h.container).value).toBe("prompt");
    // No interaction: the qualified binding echoes back byte-identical.
    expect((await savePayload(h))?.["persona"]).toBe("alpha:prompt");
  });

  it("a stale qualified binding renders its id as its own option and round-trips", async () => {
    const h = await renderDetail({ card: { ...BUILTIN_CARD, persona: "ghost:headers" } });
    const sel = bindingSelect(h.container);
    expect(sel.value).toBe("ghost");
    expect([...sel.querySelectorAll("option")].map((o) => (o as HTMLOptionElement).value)).toContain("ghost");
    expect((await savePayload(h))?.["persona"]).toBe("ghost:headers");
  });
});

// --- the keyrow + the quick-switch chips (iter3: moved in from the cards) --------

describe("ProviderDetail key lane (mocked op client)", () => {
  const keyInput = (c: HTMLElement): HTMLInputElement => {
    const el = c.querySelector("input.key-input");
    if (!(el instanceof HTMLInputElement)) throw new Error("key input missing");
    return el;
  };

  it("保存修改 commits a pasted key through the SAME click (the keyrow's own save button is gone); the reply clears the input, receipts, and refreshes", async () => {
    const h = await renderDetail({ card: BUILTIN_CARD });
    type(keyInput(h.container), "sk-paste-me");
    click(btnByText(h.container, "保存修改"));
    await flush();
    // The single save fired BOTH lanes: the key store and the registry config.
    expect(h.saveKeyMock).toHaveBeenCalledWith("deepseek", "sk-paste-me");
    expect(h.saveProviderMock).toHaveBeenCalled();
    // Round 5: the save exited the form — the paste box itself is GONE
    // (nothing retains the key client-side, stronger than an emptied input).
    expect(h.container.querySelector("input.key-input")).toBeNull();
    expect(h.notify).toHaveBeenCalledWith("已保存 deepseek 的 Key(凭据文件现有 3 个,权限 0600)——下会话可用");
    expect(h.refresh).toHaveBeenCalled();
  });

  it("the keyrow carries NO second save button (one commit edge per panel)", async () => {
    const h = await renderDetail({ card: BUILTIN_CARD });
    // 保存修改 is the ONLY button whose text starts with 保存.
    const saves = [...h.container.querySelectorAll("button")].filter((b) => b.textContent?.startsWith("保存"));
    expect(saves.map((b) => b.textContent)).toEqual(["保存修改"]);
  });

  it("a pasted key rides 测试连接 (unsaved-paste testing) and the reply renders in place", async () => {
    const h = await renderDetail({ card: BUILTIN_CARD, models: ["deepseek-chat", "deepseek-v4-flash"] });
    type(keyInput(h.container), "sk-unsaved");
    click(btnByText(h.container, "测试连接"));
    await flush();
    // The paste rides the op (not the stored key) + the list's FIRST model.
    expect(h.testMock).toHaveBeenCalledWith("deepseek", { key: "sk-unsaved", model: "deepseek-chat" });
    expect(h.container.querySelector(".test-result")?.getAttribute("data-state")).toBe("ok");
    expect(h.container.querySelector(".test-result")?.textContent).toContain("连接成功");
  });
});

// 0.3.24 round 4 (用户反馈「供应商和模型详情还是不满意」): the chips row is
// GONE — the panel showed every model TWICE (a chip row above, the table
// below), the loudest single clutter on the page. The per-row 「使用」 button
// is the chips' successor and rides the SAME modelPickCommand lanes:
// same-provider → /model (the current row a disabled no-op), cross-provider
// → /provider with the cold-cache receipt.
describe("ProviderDetail 模型行「使用」lane — the chips' successor (mocked op client)", () => {
  /** Round 6: 使用 sits ON the read row (the round-5 expand card is gone) —
   *  find the row by its name span and return the row element. */
  const rowOf = (h: Harness, model: string): HTMLElement => {
    const row = [...h.container.querySelectorAll(".model-row")].find((r) => r.querySelector(".model-row-name")?.textContent === model);
    if (!(row instanceof HTMLElement)) throw new Error(`model row ${model} missing`);
    return row;
  };

  it("the chips row is gone — the read row is the ONLY per-model surface", async () => {
    const h = await renderDetail({ card: BUILTIN_CARD, models: ["deepseek-chat", "deepseek-v4-flash"] });
    expect(h.container.querySelectorAll(".model-chip").length).toBe(0);
    expect(h.container.querySelector(".card-models")).toBeNull();
  });

  it("a same-provider 使用 submits /model; the CURRENT model's button is a disabled no-op", async () => {
    // Round 6: 使用 on the row itself — the lane pins survive the move
    // untouched (same /model command, same receipt, the live row a no-op).
    const h = await renderDetail({
      card: {
        ...BUILTIN_CARD,
        models: [{ name: "deepseek-chat", contextLength: 128000 }, { name: "deepseek-v4-flash" }],
      },
      currentModel: "deepseek-v4-flash",
      mode: "read",
    });
    expect((btnByText(rowOf(h, "deepseek-v4-flash"), "使用") as HTMLButtonElement).disabled).toBe(true); // the live row — a no-op
    click(btnByText(rowOf(h, "deepseek-chat"), "使用"));
    await flush();
    expect(h.submitMock).toHaveBeenCalledWith("/model deepseek-chat");
    expect(h.notify).toHaveBeenCalledWith("模型 → deepseek-chat — 下一轮生效"); // ω99-195: 钉随源演进（census 漏列）
  });

  it("a CROSS-provider 使用 submits /provider with the cold-cache receipt", async () => {
    // The session runs glm while the panel shows deepseek — every row is a
    // cross-provider switch.
    const h = await renderDetail({
      card: { ...BUILTIN_CARD, models: [{ name: "deepseek-v4-flash" }] },
      currentProvider: "glm",
      mode: "read",
    });
    const b = btnByText(rowOf(h, "deepseek-v4-flash"), "使用") as HTMLButtonElement;
    expect(b.disabled).toBe(false); // cross rows are clickable
    expect(b.title).toContain("/provider deepseek");
    click(b);
    await flush();
    expect(h.submitMock).toHaveBeenCalledWith("/provider deepseek");
    expect(h.notify).toHaveBeenCalledWith(
      "供应商 → deepseek — 下一轮起切换端点,历史将全部重新处理(缓存全冷)", // ω99-310: 称谓随设置面统一
    );
  });
});

// 0.3.24 round 4: the commit edge tells the truth about the draft — any edit
// surfaces 未保存的修改 next to 保存修改, and a SUCCESSFUL config save clears
// it (the server accepted the payload, so the drafts mirror the truth again).
describe("ProviderDetail commit edge — the unsaved honesty affordance", () => {
  it("clean mount: no hint; an edit surfaces it; a successful save clears it", async () => {
    const h = await renderDetail({ card: CUSTOM_CARD });
    expect(h.container.querySelector(".detail-unsaved")).toBeNull();
    type(h.container.querySelector("input.detail-label-input") as HTMLInputElement, " Renamed");
    expect(h.container.querySelector(".detail-unsaved")?.textContent).toBe("未保存的修改");
    click(btnByText(h.container, "保存修改"));
    await flush();
    expect(h.container.querySelector(".detail-unsaved")).toBeNull();
  });

  it("a FAILED save keeps the hint (the drafts are still ahead of the server)", async () => {
    const h = await renderDetail({ card: CUSTOM_CARD, saveProvider: { ok: false, error: "registry refused" } });
    type(h.container.querySelector("input.detail-label-input") as HTMLInputElement, " X");
    click(btnByText(h.container, "保存修改"));
    await flush();
    expect(h.notify).toHaveBeenCalledWith("⚠️ 保存失败：registry refused");
    expect(h.container.querySelector(".detail-unsaved")?.textContent).toBe("未保存的修改");
  });
});

// 推理档三级配置 + 语言 chip S5 (spec 2026-08-28 §5) — the「推理档绑定」row,
// the persona binding's exact twin over the registry's `effort` column:
// 跟随全局 (key absent — settings model.defaultEffort applies) / a bound
// level (low|medium|high|max|none — "none" IS a wire value) / 强制不发送
// (explicit null — the global never applies). Both save payloads ECHO it
// (the wholesale-replace rule).
describe("ProviderDetail 推理档绑定 (S5)", () => {
  const EFFORT_FOLLOW = "";
  const EFFORT_FORCED_NONE = "::none";
  const effortSelect = (c: HTMLElement): HTMLSelectElement => {
    const s = c.querySelector("select.detail-effort") as HTMLSelectElement | null;
    if (s === null) throw new Error("effort binding select missing");
    return s;
  };

  it("seeds from the wire card's three states: bound / follow-global / forced-none", async () => {
    const h1 = await renderDetail({ card: { ...CUSTOM_CARD, effort: "high" } });
    expect(effortSelect(h1.container).value).toBe("high");
    const h2 = await renderDetail({ card: { ...CUSTOM_CARD } }); // no effort key
    expect(effortSelect(h2.container).value).toBe(EFFORT_FOLLOW);
    const h3 = await renderDetail({ card: { ...CUSTOM_CARD, effort: null } });
    expect(effortSelect(h3.container).value).toBe(EFFORT_FORCED_NONE);
  });

  it("a pin rides the FULL custom payload (the wholesale-replace rule: persona/models survive)", async () => {
    const h = await renderDetail({ card: { ...CUSTOM_CARD, effort: "low" } });
    selectOption(effortSelect(h.container), "max");
    const payload = await savePayload(h);
    expect(payload).not.toBeNull();
    expect(payload!.effort).toBe("max");
    expect(payload!.persona).toBe("alpha"); // echoed untouched
    expect(payload!.models).toEqual([{ name: "m-x", contextLength: 64000 }]);
    expect(payload!.baseUrl).toBe("https://gw.example.com/v1");
  });

  it("follow-global OMITS the key; forced-none carries an explicit null", async () => {
    const h = await renderDetail({ card: { ...CUSTOM_CARD, effort: "high" } });
    selectOption(effortSelect(h.container), EFFORT_FOLLOW);
    const p1 = await savePayload(h);
    expect(Object.prototype.hasOwnProperty.call(p1, "effort")).toBe(false);
    const h2 = await renderDetail({ card: { ...CUSTOM_CARD, effort: "high" } });
    selectOption(effortSelect(h2.container), EFFORT_FORCED_NONE);
    const p2 = await savePayload(h2);
    expect(p2!.effort).toBeNull();
  });

  it("a builtin pin keeps the overlay intact (reasoningFormat + models ride alongside)", async () => {
    const h = await renderDetail({ card: { ...BUILTIN_CARD, persona: "alpha" } });
    selectOption(effortSelect(h.container), "none");
    const payload = await savePayload(h);
    expect(payload).not.toBeNull();
    expect(payload!.effort).toBe("none"); // "none" is a real wire value
    expect(payload!.reasoningFormat).toBe("deepseek");
    expect(payload!.persona).toBe("alpha");
    expect(payload!.models).toEqual([{ name: "deepseek-chat", contextLength: 128000 }]);
    expect(payload!.baseUrl).toBeUndefined(); // the overlay lane
  });
});

// --- 0.3.28 ② — builtin baseUrl overlay editing (registeredBaseUrl) -------
// The card's `baseUrl` is the EFFECTIVE base (overlay ?? compiled default);
// `registeredBaseUrl` is the RAW overlay (absent = none). The builtin edit
// form seeds from the RAW value only: empty = the compiled default stays in
// force, so an un-overlaid builtin never prefills-and-pins the compiled URL.
describe("ProviderDetail 内置 baseUrl 覆盖 (0.3.28 ②)", () => {
  const baseUrlInput = (c: HTMLElement): HTMLInputElement => {
    const el = c.querySelector('input[aria-label="deepseek Base URL"]');
    if (!(el instanceof HTMLInputElement)) throw new Error("builtin baseUrl input missing in edit mode");
    return el;
  };

  it("edit mode opens the baseUrl input for builtins too, seeded from the RAW overlay (empty when none)", async () => {
    // No overlay (registeredBaseUrl absent): the input exists and is EMPTY —
    // seeding the compiled default would pin it into the registry on save.
    const h1 = await renderDetail({ card: { ...BUILTIN_CARD, baseUrl: "https://api.deepseek.com" } });
    expect(baseUrlInput(h1.container).value).toBe("");
    // An existing overlay: the input seeds with the override.
    const h2 = await renderDetail({
      card: { ...BUILTIN_CARD, baseUrl: "https://mirror.test/v1", registeredBaseUrl: "https://mirror.test/v1" },
    });
    expect(baseUrlInput(h2.container).value).toBe("https://mirror.test/v1");
  });

  it("an untouched no-overlay builtin save OMITS baseUrl; a typed value rides the overlay payload", async () => {
    const h1 = await renderDetail({ card: { ...BUILTIN_CARD, baseUrl: "https://api.deepseek.com" } });
    const p1 = await savePayload(h1);
    expect(Object.prototype.hasOwnProperty.call(p1, "baseUrl")).toBe(false);
    const h2 = await renderDetail({ card: { ...BUILTIN_CARD, baseUrl: "https://api.deepseek.com" } });
    type(baseUrlInput(h2.container), "https://mirror.test/v1");
    const p2 = await savePayload(h2);
    expect(p2!.baseUrl).toBe("https://mirror.test/v1");
  });

  it("an existing overlay round-trips untouched; clearing the input reverts to the compiled default (omitted)", async () => {
    const OVERLAID = { ...BUILTIN_CARD, baseUrl: "https://mirror.test/v1", registeredBaseUrl: "https://mirror.test/v1" };
    const h1 = await renderDetail({ card: OVERLAID });
    const p1 = await savePayload(h1);
    expect(p1!.baseUrl).toBe("https://mirror.test/v1"); // echo, not eaten
    const h2 = await renderDetail({ card: OVERLAID });
    type(baseUrlInput(h2.container), "");
    const p2 = await savePayload(h2);
    expect(Object.prototype.hasOwnProperty.call(p2, "baseUrl")).toBe(false);
  });

  it("read mode still shows the EFFECTIVE base as text (the overlay when present)", async () => {
    const h = await renderDetail({
      card: { ...BUILTIN_CARD, baseUrl: "https://mirror.test/v1", registeredBaseUrl: "https://mirror.test/v1" },
      mode: "read",
    });
    const field = [...h.container.querySelectorAll(".detail-field")].find(
      (r) => r.querySelector(".detail-field-label")?.textContent === "baseUrl",
    );
    expect(field?.querySelector(".card-endpoint")?.textContent).toBe("https://mirror.test/v1");
    const input = field?.querySelector("input");
    expect(input).toBeNull(); // 读态零输入框 (round 5)
  });
});

// --- 模型配置卡反馈 2026-08-29(四条) -----------------------------------------
// ① 「上下文窗口是空的,继承供应商默认 —— 那默认是多少?」→ the resolved tail
//    (defaultContextLength ?? windowFallback) must SHOW as the number an
//    empty window inherits: the head hint AND the per-row placeholder.
// ② 「多个模型,该如何设置为默认/换默认」→ a per-row 设为默认 writing the
//    boot default (model.defaultModel — the ModelSelector footer's lane),
//    with HONEST badges: 默认 = the configured boot default, 当前 = the live
//    session model (the old badge mislabeled the live model as 默认).
// ③ 「每一行只有一个输入元素,避免展示不完全」→ the row splits into two
//    lines: the name input alone on the main line, the ctx input alone on
//    its own line.
// ④ 「/models 拉取先弹框,用户点了才加入」→ the pull opens an INLINE picker
//    (chips, NOT a modal) of NOT-yet-listed models; 添加所选 appends only
//    the picked ones; nothing auto-appends anymore.
describe("ProviderDetail 模型配置反馈 2026-08-29 (mocked op client)", () => {
  /** A custom card with TWO rows — the badge/set-default lanes need a row
   *  that is neither the default nor the live model. */
  const TWO_ROW_CARD: ProviderCard = {
    ...CUSTOM_CARD,
    models: [{ name: "m-x", contextLength: 64000 }, { name: "m-two" }],
  };

  /** Round 6: rows are READ spans — match the name span's exact text. */
  const rowByName = (c: HTMLElement, name: string): HTMLElement => {
    const el = [...c.querySelectorAll(".model-row")].find((r) => r.querySelector(".model-row-name")?.textContent === name);
    if (!(el instanceof HTMLElement)) throw new Error(`model row ${name} missing`);
    return el;
  };

  // ① — the resolved window value is a NUMBER the user can see ON THE ROW
  // (round 6: the head hint and the edit-table placeholder are gone; the
  // modal's add-ctx placeholder carries the hint now — pinned in
  // model-config-modal.test.tsx — and the ROW carries the display).
  it("① the row ctx span shows the override, else the RESOLVED fallback (defaultContextLength ?? windowFallback); graceful when neither rides", async () => {
    // A row override shows its own number, verbatim.
    const h0 = await renderDetail({ card: TWO_ROW_CARD });
    expect(rowByName(h0.container, "m-x").querySelector(".model-row-ctx")?.textContent).toBe("64000");
    // A builtin row with no override + the server's env tail: the number
    // shows, not 「供应商默认」(BUILTIN_CARD's own row carries 128000 —
    // strip it; the read span shows the override, unlike the old input's
    // always-visible placeholder).
    const h1 = await renderDetail({ card: { ...BUILTIN_CARD, models: [{ name: "deepseek-chat" }], windowFallback: 64000 } });
    expect(rowByName(h1.container, "deepseek-chat").querySelector(".model-row-ctx")?.textContent).toBe("继承 64000");
    // A custom with defaultContextLength: the provider default wins.
    expect(rowByName(h0.container, "m-two").querySelector(".model-row-ctx")?.textContent).toBe("继承 131072");
    // An old server with neither field: the wording degrades, never a blank.
    const h3 = await renderDetail({ card: { ...BUILTIN_CARD, models: [{ name: "deepseek-chat" }] } });
    expect(rowByName(h3.container, "deepseek-chat").querySelector(".model-row-ctx")?.textContent).toBe("继承供应商默认");
  });

  // ② — badges are honest and 设为默认 rides the boot-default lane.
  // Round 5 D: the actuator is a ☆/★ star (aria-labeled), not a text button.
  // Round 6: the stars sit ON the read row (no expand card anymore).
  it("② the boot default row's ★ is a disabled no-op; 当前 marks the live model; ☆ writes model.defaultModel with the receipt", async () => {
    const h = await renderDetail({
      card: TWO_ROW_CARD,
      currentModel: "m-two",
      defaultModel: { provider: "my-gateway", model: "m-x" },
    });
    const defRow = rowByName(h.container, "m-x");
    const liveRow = rowByName(h.container, "m-two");
    // m-x is the configured boot default: its ★ is the STATE itself — a
    // disabled no-op, not an actuator.
    const defStar = [...defRow.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "已是默认模型 m-x") as HTMLButtonElement | undefined;
    if (defStar === undefined) throw new Error("★ (boot default) missing on the default row");
    expect(defStar.disabled).toBe(true);
    // m-two is the LIVE session model — 当前, never mislabeled 默认 again.
    expect(liveRow.querySelector(".model-badge.live")?.textContent).toContain("当前");
    // Setting m-two as the default rides the ModelSelector footer's exact
    // lane (settingsSet model.defaultModel) with its receipt + refresh.
    const setStar = [...liveRow.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "设为默认模型 m-two") as HTMLButtonElement | undefined;
    if (setStar === undefined) throw new Error("☆ set-default star missing on the non-default row");
    click(setStar);
    await flush();
    expect(h.setMock).toHaveBeenCalledWith("model.defaultModel", { provider: "my-gateway", model: "m-two" });
    expect(h.notify).toHaveBeenCalledWith("已设为默认:my-gateway/m-two —— 下次启动 wudao ui 生效");
    expect(h.refresh).toHaveBeenCalled();
  });

  it("② with NO boot default written, no row wears a ★ — every named row offers the ☆", async () => {
    const h = await renderDetail({ card: TWO_ROW_CARD, defaultModel: null, currentModel: "m-two" });
    expect(
      [...h.container.querySelectorAll("button")].some((b) => b.getAttribute("aria-label")?.startsWith("已是默认模型")),
    ).toBe(false);
    expect(
      [...rowByName(h.container, "m-x").querySelectorAll("button")].some((b) => b.getAttribute("aria-label") === "设为默认模型 m-x"),
    ).toBe(true);
  });

  // ③ — round 6 (0.3.26 visual pass): the edit TABLE is gone; the row is a
  // read-only one-liner — name span + ctx span + state lane, zero inputs.
  // The aligned-grid history (two-line → fixed-track grid → now constant
  // read spans) ends here: no input can be squeezed anywhere.
  it("③ each model row is ONE read-only line: name/ctx/state spans, zero input/select in the model section (both render modes)", async () => {
    for (const mode of ["read", "edit"] as const) {
      const h = await renderDetail({ card: TWO_ROW_CARD, defaultModel: null, mode });
      const mgr = h.container.querySelector(".model-manager") as HTMLElement;
      if (!(mgr instanceof HTMLElement)) throw new Error("model manager missing");
      const rows = [...mgr.querySelectorAll(".model-row")];
      expect(rows.length).toBe(2);
      expect(mgr.querySelectorAll("input, select").length).toBe(0); // the edit table is GONE
      for (const row of rows) {
        expect(row.querySelector(".model-row-name")).not.toBeNull();
        expect(row.querySelector(".model-row-ctx")).not.toBeNull();
        expect(row.querySelector(".model-row-state")).not.toBeNull();
      }
    }
  });

  // ④ — round 6: the inline pull-picker and 手工添加 are GONE — the modal is
  // the only model edit door (dropdown/filter/pick/已配置 live-set behavior
  // is pinned in model-config-modal.test.tsx ③④⑩). Panel-side negative pin.
  it("④ the panel offers NO pull button and NO 手工添加 — 「配置模型」 is the model section's only edit door", async () => {
    const h = await renderDetail({ card: CUSTOM_CARD, defaultModel: null, mode: "edit" });
    expect([...h.container.querySelectorAll("button")].some((b) => b.textContent?.includes("拉取"))).toBe(false);
    expect(h.container.querySelector(".pull-panel")).toBeNull();
    expect(h.container.querySelector(".pull-chip")).toBeNull();
    expect(h.container.textContent).not.toContain("手工添加");
    expect(btnByText(h.container, "配置模型")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// round 5 (2026-08-30 spec, 用户第五轮反馈): 读态默认 + 编辑门 + 模型两级详情。
// 契约反转如实记——
//   读态是默认渲染（零 input/select,「编辑」是进入表单的唯一门),
//   「使用」从编辑态行迁入读态的模型展开卡,
//   设为默认文本钮 → ★/☆ aria 语义不变,
//   「当前」徽章 → 行选中态 (.model-row.live + 状态 chip)。
// round 6 (2026-08-30, 用户第六轮反馈): 展开卡撤销——模型编辑全部进
//   ModelConfigModal 弹框(见 model-config-modal.test.tsx),行回到普通
//   只读一行;★/☆/使用 留在行上。下列 describe 已按 round 6 契约改钉。
// ---------------------------------------------------------------------------

describe("ProviderDetail round 5 — 读态默认 + 编辑门", () => {
  it("mount renders READ mode: zero input/select controls; 编辑 present, 保存修改 absent", async () => {
    const h = await renderDetail({ card: CUSTOM_CARD, mode: "read" });
    expect(h.container.querySelectorAll("input, select")).toHaveLength(0);
    expect(btnByText(h.container, "编辑")).toBeTruthy();
    expect([...h.container.querySelectorAll("button")].some((b) => b.textContent === "保存修改")).toBe(false);
    // The read-mode key row: status + probe, no paste box.
    expect(h.container.textContent).toContain("已配 · 凭据文件");
    expect(btnByText(h.container, "测试连接")).toBeTruthy();
  });

  it("编辑 opens the form; 取消编辑 rolls drafts back to the snapshot and exits", async () => {
    const h = await renderDetail({ card: CUSTOM_CARD, mode: "read" });
    click(btnByText(h.container, "编辑"));
    await flush();
    const name = h.container.querySelector("input.detail-label-input") as HTMLInputElement;
    type(name, "Renamed");
    expect(h.container.querySelector(".detail-unsaved")).toBeTruthy();
    click(btnByText(h.container, "取消编辑"));
    await flush();
    expect(h.container.querySelectorAll("input, select")).toHaveLength(0);
    click(btnByText(h.container, "编辑"));
    await flush();
    const again = h.container.querySelector("input.detail-label-input") as HTMLInputElement;
    expect(again.value).toBe("My Gateway");
  });

  it("a successful save exits to read mode", async () => {
    const h = await renderDetail({ card: CUSTOM_CARD, mode: "read" });
    click(btnByText(h.container, "编辑"));
    await flush();
    await savePayload(h);
    expect(h.saveProviderMock).toHaveBeenCalled();
    expect(h.container.querySelectorAll("input, select")).toHaveLength(0);
  });
});

describe("ProviderDetail round 6 — 模型行（展开卡已删,读态一行内联）", () => {
  /** Round 6: the round-5 expand card (.model-row-head click →
   *  .model-detail-card) is GONE — the effective window, the ☆/★ lane, and
   *  使用 all sit on the one-line read row. These pins migrate the expand
   *  card's coverage to row level. */
  const rowByName = (h: { container: HTMLElement }, name: string): HTMLElement => {
    const el = [...h.container.querySelectorAll(".model-row")].find((r) => r.querySelector(".model-row-name")?.textContent === name);
    if (!(el instanceof HTMLElement)) throw new Error(`model row ${name} missing`);
    return el;
  };

  it("no row head is clickable and no expand card exists — the row itself carries the detail", async () => {
    const h = await renderDetail({ card: CUSTOM_CARD, mode: "read", models: ["m-x"] });
    expect(h.container.querySelectorAll(".model-row-head").length).toBe(0);
    expect(h.container.querySelector(".model-detail-card")).toBeNull();
    const row = rowByName(h, "m-x");
    expect(row.querySelector(".model-row-ctx")?.textContent).toBe("64000"); // the override, on the row
    expect(btnByText(row, "使用")).toBeTruthy();
  });

  it("the LIVE row wears the selected state; the boot-default ★ is a disabled no-op; another row's ☆ writes model.defaultModel", async () => {
    const h = await renderDetail({
      card: { ...CUSTOM_CARD, models: [{ name: "m-x", contextLength: 64000 }, { name: "m-y" }] },
      mode: "read",
      models: ["m-x"],
      currentProvider: "my-gateway",
      currentModel: "m-x",
      defaultModel: { provider: "my-gateway", model: "m-x" },
    });
    const liveRow = h.container.querySelector(".model-row.live");
    expect(liveRow).toBeTruthy();
    expect(liveRow?.textContent).toContain("当前");
    expect(rowByName(h, "m-y").className).not.toContain("live");
    // The boot-default row's ★: visible as state, the no-op is disabled.
    const star = [...h.container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "已是默认模型 m-x");
    expect(star?.disabled).toBe(true);
    // m-y's ☆ actuator sits ON the row now — one click, no expand first.
    const setStar = [...rowByName(h, "m-y").querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "设为默认模型 m-y") as HTMLButtonElement | undefined;
    if (setStar === undefined) throw new Error("☆ set-default actuator missing");
    click(setStar);
    await flush();
    expect(h.setMock).toHaveBeenCalledWith("model.defaultModel", { provider: "my-gateway", model: "m-y" });
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("已设为默认"));
  });

  it("an inherited window (no row override) shows the resolved fallback on the row", async () => {
    const h = await renderDetail({ card: { ...CUSTOM_CARD, models: [{ name: "m-bare" }] }, mode: "read", models: ["m-bare"] });
    // CUSTOM_CARD.defaultContextLength = 131072 — the bare row inherits it.
    expect(rowByName(h, "m-bare").querySelector(".model-row-ctx")?.textContent).toContain("131072");
  });
});
