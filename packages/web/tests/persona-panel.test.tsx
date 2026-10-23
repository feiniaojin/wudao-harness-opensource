// @vitest-environment jsdom
// persona-settings T6 — the settings page's Persona tab, mounted DIRECTLY
// against a MOCKED op client (the server ops land with T5; the wire contract
// is pinned here): the master list renders builtin personas read-only in the
// same layout (disabled form, no save), the create form's client-side mirror
// rejects forbidden header keys BEFORE any op leaves (and the per-wire body
// dropdown is exactly the mirror's whitelist), a refused save's field-path
// errors map back onto their rows, delete rides the two-step reference →
// unbind protocol, and the global-default picker writes settingsSet
// persona.id ("" clears). The last test pins the SettingsPage registration
// (6th tab between preferences and plugins, lazy mount, real wire client).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsPage } from "../src/components/SettingsPage.js";
import {
  PersonaPanel,
  buildPersonaDefinition,
  editorFromDefinition,
  isPersonaDefinitionRoundTrippable,
} from "../src/components/PersonaPanel.js";
import { WudaoClient } from "../src/protocol.js";
import type { PersonaDefinition, SettingsStatus, WudaoClient as WudaoClientType } from "../src/protocol.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";

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

const LIST = {
  personas: [
    { id: "deepseek-native", displayName: "DeepSeek Native", source: "builtin" as const, layers: "headers+prompt", editable: false },
    { id: "alpha", displayName: "Alpha", source: "global" as const, layers: "headers", editable: true },
  ],
};

const DEEPSEEK_DEF: PersonaDefinition = {
  id: "deepseek-native",
  displayName: "DeepSeek Native",
  source: { kind: "workspace-source", provenance: "doc90 §3 (openai-chat reference)", pinnedVersion: "b150a551" },
  headers: { "openai-chat": { "user-agent": "wudao-harness/0.4.14" } },
  prompt: { system: { mode: "prefix", text: "You are an AI agent powered by DeepSeek Harness." } },
};

const ALPHA_DEF: PersonaDefinition = {
  id: "alpha",
  displayName: "Alpha",
  source: { kind: "workspace-source", provenance: "user-defined (wudao settings persona tab)", pinnedVersion: "1" },
  headers: { anthropic: { "x-session-id": "{{sessionId}}" } },
};

/** Iteration 2 T2 — the「header 是空的」bug's shape: a reference harness's headers
 *  live ONLY on the anthropic wire, so the fixed openai-chat default tab
 *  opened the detail on an empty headers form. */
const CLAUDE_CODE_DEF: PersonaDefinition = {
  id: "anthropic-cli",
  displayName: "Anthropic CLI",
  source: { kind: "external-research", provenance: "a reference harness", pinnedVersion: "2.x" },
  headers: { anthropic: { "anthropic-beta": "oauth-2025-04-20", "user-agent": "wudao-harness/2.0.0 (external, cli)" } },
  prompt: { system: { mode: "prefix", text: "You are Claude Code, Anthropic's official CLI for Claude." } },
};

/** Iteration 2 T2 — a prompt-only persona: EVERY wire is empty (headers/body
 *  both absent), the auto-select's all-empty branch keeps openai-chat. */
const PROMPT_ONLY_DEF: PersonaDefinition = {
  id: "prompt-only",
  displayName: "Prompt Only",
  source: { kind: "workspace-source", provenance: "user-defined (wudao settings persona tab)", pinnedVersion: "1" },
  headers: {},
  prompt: { system: { mode: "prefix", text: "You are minimal." } },
};

// --- final-review F2 fixtures — hand-authored global personas ---------------------
// The editor's builder only emits prefix-mode prompt + headers/body (+ the
// fixed editor source row). A GLOBAL persona carrying anything else — saved
// via the editor once, then hand-edited in the registry JSON — must open
// VIEW-ONLY: the server writes the client definition verbatim, so a save
// through the editor silently destroyed the unmapped fields.

/** The plain regression base: prefix prompt + headers + the editor's own
 *  source row — everything the builder reproduces field-for-field. */
const PLAIN_GLOBAL_DEF: PersonaDefinition = {
  id: "plain-global",
  displayName: "Plain Global",
  source: { kind: "workspace-source", provenance: "user-defined (wudao settings persona tab)", pinnedVersion: "1" },
  headers: { anthropic: { "x-session-id": "{{sessionId}}" } },
  prompt: { system: { mode: "prefix", text: "You are plain." } },
};

/** A hand-added toolNameMap under prompt — invisible in the form. */
const HAND_MAP_DEF: PersonaDefinition = {
  ...PLAIN_GLOBAL_DEF,
  id: "hand-map",
  displayName: "Hand Map",
  prompt: { system: { mode: "prefix", text: "You are hand-authored." }, toolNameMap: { Write: "write_file" } },
};

/** A hand-added defaultLayers overlay. */
const HAND_LAYERS_DEF: PersonaDefinition = {
  ...PLAIN_GLOBAL_DEF,
  id: "hand-layers",
  displayName: "Hand Layers",
  defaultLayers: { headers: true, prompt: true },
};

const F2_LIST = {
  personas: [
    { id: "plain-global", displayName: "Plain Global", source: "global" as const, layers: "headers+prompt", editable: true },
    { id: "hand-map", displayName: "Hand Map", source: "global" as const, layers: "headers+prompt", editable: true },
    { id: "hand-layers", displayName: "Hand Layers", source: "global" as const, layers: "headers+prompt", editable: true },
  ],
};

const F2_DEFS: Record<string, PersonaDefinition> = {
  "plain-global": PLAIN_GLOBAL_DEF,
  "hand-map": HAND_MAP_DEF,
  "hand-layers": HAND_LAYERS_DEF,
};

/** R1 — whitespace-only prompt text: it types as a string so it once passed
 *  the gate, but the builder DROPS the prompt key when trim() === "" — a
 *  save would silently lose the prompt object, so the gate must trip. */
const WHITESPACE_PROMPT_DEF: PersonaDefinition = {
  ...PLAIN_GLOBAL_DEF,
  id: "whitespace-prompt",
  displayName: "Whitespace Prompt",
  prompt: { system: { mode: "prefix", text: "   \n\t " } },
};

const R1_LIST = {
  personas: [
    { id: "hand-map", displayName: "Hand Map", source: "global" as const, layers: "headers+prompt", editable: true },
    { id: "whitespace-prompt", displayName: "Whitespace Prompt", source: "global" as const, layers: "prompt", editable: true },
  ],
};

const R1_DEFS: Record<string, PersonaDefinition> = {
  "hand-map": HAND_MAP_DEF,
  "whitespace-prompt": WHITESPACE_PROMPT_DEF,
};

const STATUS: SettingsStatus = {
  providers: [],
  credentials: { path: "/home/u/.wudao/.credentials.yaml", keyCount: 1 },
  settings: { memoryEnabled: true, uiDefaultMode: null, wizardCompletedVersion: 1, uiTheme: null, uiAccent: null, personaId: null },
  current: { provider: "deepseek", model: "deepseek-v4-flash", effort: "high" },
  envKey: false,
  readiness: true,
  efforts: [],
};

// --- the mocked-op-client harness -------------------------------------------------

type Spy = ReturnType<typeof vi.fn>;

interface Harness {
  container: HTMLElement;
  personaListMock: Spy;
  personaGetMock: Spy;
  personaSaveMock: Spy;
  personaDeleteMock: Spy;
  settingsSetMock: Spy;
  notify: Spy;
  refresh: Spy;
}

/** Flush the mock promise chains (personaList → setState → render) inside act. */
const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

async function renderPanel(opts?: {
  /** A personaList body override (default: LIST). */
  readonly list?: unknown;
  /** The personaGet fixture map (default: a reference harness + alpha). */
  readonly defs?: Record<string, PersonaDefinition>;
}): Promise<Harness> {
  const defs = opts?.defs ?? { "deepseek-native": DEEPSEEK_DEF, alpha: ALPHA_DEF };
  const personaListMock = vi.fn(() => Promise.resolve(opts?.list ?? LIST));
  const personaGetMock = vi.fn((id: string) => Promise.resolve({ definition: defs[id] ?? DEEPSEEK_DEF }));
  const personaSaveMock = vi.fn(() => Promise.resolve({ ok: true as const }));
  const personaDeleteMock = vi.fn(() => Promise.resolve({ ok: true as const }));
  const settingsSetMock = vi.fn(() => Promise.resolve({ key: "persona.id", saved: true }));
  const client = {
    personaList: personaListMock,
    personaGet: personaGetMock,
    personaSave: personaSaveMock,
    personaDelete: personaDeleteMock,
    settingsSet: settingsSetMock,
  } as unknown as WudaoClientType;
  const notify = vi.fn();
  const refresh = vi.fn();
  const container = mount(<PersonaPanel client={client} settings={STATUS} notify={notify} refresh={refresh} />);
  await flush();
  return { container, personaListMock, personaGetMock, personaSaveMock, personaDeleteMock, settingsSetMock, notify, refresh };
}

// --- DOM helpers (the suite's userEvent/screen: raw queries + native events) ----

const byLabelText = (c: HTMLElement, label: string): HTMLElement => {
  const el = c.querySelector(`[aria-label="${label}"]`);
  if (el === null) throw new Error(`element labeled "${label}" missing`);
  return el as HTMLElement;
};

const byText = (c: HTMLElement, text: string): HTMLElement => {
  const el = [...c.querySelectorAll("button,span,div,li,option")].find((n) => n.textContent === text);
  if (el === undefined) throw new Error(`text "${text}" missing`);
  return el as HTMLElement;
};

const byTextMatch = (c: HTMLElement, re: RegExp): HTMLElement => {
  const el = [...c.querySelectorAll("button,span,div,li")].find((n) => re.test(n.textContent ?? ""));
  if (el === undefined) throw new Error(`text /${re.source}/ missing`);
  return el as HTMLElement;
};

const click = (el: HTMLElement): void => {
  act(() => {
    el.click();
  });
};

/** A wire tab strip button (T2: the tabs carry count badges, so the label
 *  text alone no longer identifies the button — data-wire does). */
const wireTab = (c: HTMLElement, w: string): HTMLButtonElement => {
  const b = c.querySelector(`button[data-wire="${w}"]`);
  if (!(b instanceof HTMLButtonElement)) throw new Error(`wire tab "${w}" missing`);
  return b;
};

/** A wire tab's row-count badge (headers + body rows on that wire). */
const wireBadge = (c: HTMLElement, w: string): Element => {
  const el = c.querySelector(`button[data-wire="${w}"] .wire-count`);
  if (el === null) throw new Error(`wire-count badge for "${w}" missing`);
  return el;
};

const typeInto = (el: HTMLInputElement | HTMLTextAreaElement, text: string): void => {
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const selectOption = (el: HTMLSelectElement, value: string): void => {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

async function openCreateForm(h: Harness): Promise<void> {
  click(byText(h.container, "＋ 新建"));
  await flush();
}

async function select(h: Harness, id: string): Promise<void> {
  click(byText(h.container, id));
  await flush();
}

/** The SAVE action's payload — null when the client gate blocks (no op left
 *  the browser). Clicks 保存 and reports what actually went out. */
async function savePayload(h: Harness): Promise<PersonaDefinition | null> {
  click(byText(h.container, "保存"));
  await flush();
  const calls = h.personaSaveMock.mock.calls as unknown as [PersonaDefinition][];
  return calls.length > 0 ? (calls[calls.length - 1]?.[0] ?? null) : null;
}

/** Fill a minimal VALID create form: id/displayName/prompt + one valid
 *  anthropic header row (the user-agent row test 4's server error names). */
async function fillMinimalValid(h: Harness): Promise<void> {
  typeInto(byLabelText(h.container, "id") as HTMLInputElement, "beta");
  typeInto(byLabelText(h.container, "displayName") as HTMLInputElement, "Beta");
  typeInto(byLabelText(h.container, "prompt") as HTMLTextAreaElement, "You are Beta.");
  click(wireTab(h.container, "anthropic"));
  typeInto(byLabelText(h.container, "headers.anthropic.key") as HTMLInputElement, "user-agent");
  typeInto(byLabelText(h.container, "headers.anthropic.value") as HTMLInputElement, "{{sessionId}}");
}

// --- the panel -------------------------------------------------------------------

describe("PersonaPanel (mocked op client)", () => {
  it("renders builtin personas with source badges and read-only form", async () => {
    const h = await renderPanel();
    // The master list shows both rows: id + 内置 badge + layers.
    expect(byText(h.container, "deepseek-native")).toBeTruthy();
    expect(byText(h.container, "内置").textContent).toBe("内置");
    expect(byText(h.container, "headers+prompt")).toBeTruthy();
    await select(h, "deepseek-native");
    // Same layout, disabled: the prompt textarea is disabled and there is NO
    // save button (no delete either — builtin personas are read-only).
    expect((byLabelText(h.container, "prompt") as HTMLTextAreaElement).disabled).toBe(true);
    expect((byLabelText(h.container, "displayName") as HTMLInputElement).disabled).toBe(true);
    expect([...h.container.querySelectorAll("button")].some((b) => b.textContent === "保存")).toBe(false);
    expect([...h.container.querySelectorAll("button")].some((b) => b.textContent === "删除")).toBe(false);
    expect(h.personaGetMock).toHaveBeenCalledWith("deepseek-native");
  });

  it("rejects forbidden header key client-side (authorization)", async () => {
    const h = await renderPanel();
    await openCreateForm(h);
    typeInto(byLabelText(h.container, "headers.openai-chat.key") as HTMLInputElement, "authorization");
    await flush();
    expect(byTextMatch(h.container, /禁用键|forbidden/i)).toBeTruthy();
    expect(
      (byLabelText(h.container, "headers.openai-chat.key") as HTMLInputElement).closest(".row")?.className,
    ).toContain("error");
    // The client gate: clicking 保存 sends NOTHING (savePayload null).
    expect(await savePayload(h)).toBeNull();
    expect(h.personaSaveMock).not.toHaveBeenCalled();
  });

  it("body key dropdown is per-wire whitelist (anthropic has thinking, not reasoning_effort)", async () => {
    const h = await renderPanel();
    await openCreateForm(h);
    click(wireTab(h.container, "anthropic"));
    const sel = byLabelText(h.container, "body.anthropic.key") as HTMLSelectElement;
    const opts = [...sel.querySelectorAll("option")].map((o) => o.textContent);
    expect(opts).toContain("thinking");
    expect(opts).not.toContain("reasoning_effort");
    expect(opts).toContain("stop_sequences");
    // The openai-chat wire carries reasoning_effort instead — per-wire sets.
    click(wireTab(h.container, "openai-chat"));
    const chatOpts = [...(byLabelText(h.container, "body.openai-chat.key") as HTMLSelectElement).querySelectorAll("option")].map((o) => o.textContent);
    expect(chatOpts).toContain("reasoning_effort");
    expect(chatOpts).not.toContain("thinking");
  });

  it("saving a minimal create posts the structured definition; body values parse as JSON", async () => {
    const h = await renderPanel();
    await openCreateForm(h);
    await fillMinimalValid(h);
    selectOption(byLabelText(h.container, "body.anthropic.key") as HTMLSelectElement, "thinking");
    typeInto(byLabelText(h.container, "body.anthropic.value") as HTMLInputElement, '{"type":"enabled","budget_tokens":1024}');
    const payload = await savePayload(h);
    expect(payload).toMatchObject({
      id: "beta",
      displayName: "Beta",
      headers: { anthropic: { "user-agent": "{{sessionId}}" } },
      body: { anthropic: { thinking: { type: "enabled", budget_tokens: 1024 } } },
      prompt: { system: { mode: "prefix", text: "You are Beta." } },
    });
    // An invalid body JSON value blocks the NEXT save (no second op).
    typeInto(byLabelText(h.container, "body.anthropic.value") as HTMLInputElement, "not json");
    click(byText(h.container, "保存"));
    await flush();
    expect(h.personaSaveMock).toHaveBeenCalledTimes(1);
    expect(byTextMatch(h.container, /合法 JSON/)).toBeTruthy();
  });

  it("save surfaces server field errors to matching rows", async () => {
    const h = await renderPanel();
    await openCreateForm(h);
    await fillMinimalValid(h);
    h.personaSaveMock.mockResolvedValueOnce({ ok: false, errors: ["headers.anthropic.user-agent: unknown template slot {{foo}}"] });
    click(byText(h.container, "保存"));
    await flush();
    // The field-path error renders (once — on its row) and that row errors.
    expect(byTextMatch(h.container, /unknown template slot/)).toBeTruthy();
    expect(
      (byLabelText(h.container, "headers.anthropic.key") as HTMLInputElement).closest(".row")?.className,
    ).toContain("error");
  });

  it("delete with references shows the reference list, unbind+delete clears", async () => {
    const h = await renderPanel();
    await select(h, "alpha");
    h.personaDeleteMock.mockResolvedValueOnce({ ok: false, references: { providers: ["deepseek"], isGlobalDefault: true } });
    click(byText(h.container, "删除"));
    await flush();
    expect(h.personaDeleteMock).toHaveBeenCalledWith({ id: "alpha" });
    // The reference inventory is visible: the bound provider + the global
    // default flag.
    expect(byTextMatch(h.container, /供应商 deepseek/)).toBeTruthy();
    expect(h.container.textContent).toContain("全局默认 persona");
    h.personaDeleteMock.mockResolvedValueOnce({ ok: true });
    click(byText(h.container, "解绑并删除"));
    await flush();
    expect(h.personaDeleteMock).toHaveBeenLastCalledWith({ id: "alpha", unbind: true });
  });

  it("global default picker writes settingsSet persona.id", async () => {
    const h = await renderPanel();
    selectOption(byLabelText(h.container, "全局默认 persona") as HTMLSelectElement, "alpha");
    await flush();
    // The codebase's settingsSet call form (key, value) — the brief's
    // {key, value} shape at the same assertion semantics.
    expect(h.settingsSetMock).toHaveBeenCalledWith("persona.id", "alpha");
    expect(h.refresh).toHaveBeenCalled();
  });
});

// --- iteration 2 T2: wire tab auto-select + badges + layer-qualified default ------

const T2_DEFS: Record<string, PersonaDefinition> = {
  "deepseek-native": DEEPSEEK_DEF,
  alpha: ALPHA_DEF,
  "anthropic-cli": CLAUDE_CODE_DEF,
  "prompt-only": PROMPT_ONLY_DEF,
};

const T2_LIST = {
  personas: [
    { id: "anthropic-cli", displayName: "Anthropic CLI", source: "builtin" as const, layers: "headers+prompt", editable: false },
    { id: "prompt-only", displayName: "Prompt Only", source: "global" as const, layers: "prompt", editable: true },
    { id: "alpha", displayName: "Alpha", source: "global" as const, layers: "headers", editable: true },
  ],
};

describe("PersonaPanel wire tabs + layer-qualified global default (iteration 2 T2)", () => {
  it("opens a loaded persona on the FIRST wire with content (a reference harness → anthropic)", async () => {
    const h = await renderPanel({ list: T2_LIST, defs: T2_DEFS });
    await select(h, "anthropic-cli");
    // The tab strip's initial position is the anthropic wire — the fixed
    // openai-chat default showed an empty headers form (the「header 是空的」bug).
    expect(wireTab(h.container, "anthropic").getAttribute("aria-selected")).toBe("true");
    expect(wireTab(h.container, "openai-chat").getAttribute("aria-selected")).toBe("false");
    expect(byText(h.container, "headers(anthropic)")).toBeTruthy();
  });

  it("an all-empty persona keeps the first wire (openai-chat)", async () => {
    const h = await renderPanel({ list: T2_LIST, defs: T2_DEFS });
    await select(h, "prompt-only");
    expect(wireTab(h.container, "openai-chat").getAttribute("aria-selected")).toBe("true");
    expect(byText(h.container, "headers(openai-chat)")).toBeTruthy();
  });

  it("wire tabs carry per-wire row-count badges; a zero count dims", async () => {
    const h = await renderPanel({ list: T2_LIST, defs: T2_DEFS });
    await select(h, "anthropic-cli");
    // a reference harness: 2 anthropic header rows; the other two wires are empty.
    expect(wireBadge(h.container, "anthropic").textContent).toBe("2");
    expect(wireBadge(h.container, "openai-chat").textContent).toBe("0");
    expect(wireBadge(h.container, "openai-chat").className).toContain("zero");
    expect(wireBadge(h.container, "responses").textContent).toBe("0");
    expect(wireBadge(h.container, "responses").className).toContain("zero");
  });

  it("the layer selector qualifies the global default; 全部层 restores the plain id", async () => {
    const h = await renderPanel();
    selectOption(byLabelText(h.container, "全局默认 persona") as HTMLSelectElement, "alpha");
    await flush();
    expect(h.settingsSetMock).toHaveBeenLastCalledWith("persona.id", "alpha");
    selectOption(byLabelText(h.container, "全局默认层") as HTMLSelectElement, "headers");
    await flush();
    expect(h.settingsSetMock).toHaveBeenLastCalledWith("persona.id", "alpha:headers");
    selectOption(byLabelText(h.container, "全局默认层") as HTMLSelectElement, "headers+prompt");
    await flush();
    expect(h.settingsSetMock).toHaveBeenLastCalledWith("persona.id", "alpha:headers+prompt");
    selectOption(byLabelText(h.container, "全局默认层") as HTMLSelectElement, "");
    await flush();
    expect(h.settingsSetMock).toHaveBeenLastCalledWith("persona.id", "alpha");
  });

  it("a layer picked with NO persona writes nothing and qualifies the next pick", async () => {
    const h = await renderPanel();
    // The qualifier only applies to an actual persona pick — alone it writes
    // nothing (the "(未设置)" state never carries a layer).
    selectOption(byLabelText(h.container, "全局默认层") as HTMLSelectElement, "prompt");
    await flush();
    expect(h.settingsSetMock).not.toHaveBeenCalled();
    selectOption(byLabelText(h.container, "全局默认 persona") as HTMLSelectElement, "alpha");
    await flush();
    expect(h.settingsSetMock).toHaveBeenLastCalledWith("persona.id", "alpha:prompt");
  });

  it("clearing the global default writes \"\" with no qualifier", async () => {
    const h = await renderPanel();
    selectOption(byLabelText(h.container, "全局默认 persona") as HTMLSelectElement, "alpha");
    await flush();
    selectOption(byLabelText(h.container, "全局默认层") as HTMLSelectElement, "headers");
    await flush();
    selectOption(byLabelText(h.container, "全局默认 persona") as HTMLSelectElement, "");
    await flush();
    expect(h.settingsSetMock).toHaveBeenLastCalledWith("persona.id", "");
  });
});

// --- final review F2 — the shape gate: hand-authored globals open view-only -------

describe("PersonaPanel shape gate (final review F2)", () => {
  it("a global persona carrying prompt.toolNameMap opens VIEW-ONLY (no save/delete, explanatory hint)", async () => {
    const h = await renderPanel({ list: F2_LIST, defs: F2_DEFS });
    await select(h, "hand-map");
    // Same layout, disabled — the builtin read-only idiom, plus WHY.
    expect((byLabelText(h.container, "prompt") as HTMLTextAreaElement).disabled).toBe(true);
    expect((byLabelText(h.container, "displayName") as HTMLInputElement).disabled).toBe(true);
    expect([...h.container.querySelectorAll("button")].some((b) => b.textContent === "保存")).toBe(false);
    expect([...h.container.querySelectorAll("button")].some((b) => b.textContent === "删除")).toBe(false);
    expect(h.container.textContent).toContain("高级字段");
    expect(h.container.textContent).toContain("仅支持查看");
    expect(h.personaSaveMock).not.toHaveBeenCalled();
  });

  it("a global persona carrying defaultLayers opens VIEW-ONLY too", async () => {
    const h = await renderPanel({ list: F2_LIST, defs: F2_DEFS });
    await select(h, "hand-layers");
    expect((byLabelText(h.container, "prompt") as HTMLTextAreaElement).disabled).toBe(true);
    expect([...h.container.querySelectorAll("button")].some((b) => b.textContent === "保存")).toBe(false);
    expect(h.container.textContent).toContain("仅支持查看");
    expect(h.personaSaveMock).not.toHaveBeenCalled();
  });

  it("regression pin: a plain prefix+headers global stays fully editable and saves byte-identical", async () => {
    const h = await renderPanel({ list: F2_LIST, defs: F2_DEFS });
    await select(h, "plain-global");
    expect((byLabelText(h.container, "prompt") as HTMLTextAreaElement).disabled).toBe(false);
    expect((byLabelText(h.container, "displayName") as HTMLInputElement).disabled).toBe(false);
    expect([...h.container.querySelectorAll("button")].some((b) => b.textContent === "保存")).toBe(true);
    // The untouched editor rebuilds the definition EXACTLY as loaded — the
    // gate must not have narrowed the editable set.
    const payload = await savePayload(h);
    expect(payload).toEqual(PLAIN_GLOBAL_DEF);
    expect(JSON.stringify(payload)).toBe(JSON.stringify(PLAIN_GLOBAL_DEF));
  });
});

// The gate's pure core — every schema field the builder cannot reproduce
// trips it (snapshot prompt, toolNameMap, defaultLayers, confidence, a
// foreign source row, an unknown future field, non-JSON-round-trippable
// body values); everything the builder emits passes.
describe("isPersonaDefinitionRoundTrippable (final review F2)", () => {
  it("passes the builder's own output shape (alpha + the plain global + body values)", () => {
    expect(isPersonaDefinitionRoundTrippable(ALPHA_DEF)).toBe(true);
    expect(isPersonaDefinitionRoundTrippable(PLAIN_GLOBAL_DEF)).toBe(true);
    // A built definition (the create lane's own payload) is round-trippable
    // by construction, headers AND body.
    const built = buildPersonaDefinition(
      { ...editorFromDefinition({ ...PLAIN_GLOBAL_DEF, body: { anthropic: { thinking: { type: "enabled", budget_tokens: 1024 } } } }), id: "beta", displayName: "Beta" },
      false,
    );
    expect(built).not.toBeNull();
    expect(isPersonaDefinitionRoundTrippable(built as PersonaDefinition)).toBe(true);
  });

  it("trips on every unmapped schema field", () => {
    expect(isPersonaDefinitionRoundTrippable(HAND_MAP_DEF)).toBe(false); // prompt.toolNameMap
    expect(isPersonaDefinitionRoundTrippable(HAND_LAYERS_DEF)).toBe(false); // defaultLayers
    expect(isPersonaDefinitionRoundTrippable({ ...PLAIN_GLOBAL_DEF, confidence: "byte-verified" })).toBe(false);
    expect(isPersonaDefinitionRoundTrippable({ ...PLAIN_GLOBAL_DEF, prompt: { system: { mode: "snapshot", text: "You are a snapshot." } } })).toBe(false);
    // A foreign source row: the builder overwrites source with the fixed
    // editor triple — a hand-written provenance would be destroyed.
    expect(
      isPersonaDefinitionRoundTrippable({
        ...PLAIN_GLOBAL_DEF,
        source: { kind: "workspace-source", provenance: "hand-written registry file", pinnedVersion: "9" },
      }),
    ).toBe(false);
    // An unknown FUTURE field — the gate is allow-list shaped, not
    // deny-list shaped, so schema growth stays safe by default.
    expect(isPersonaDefinitionRoundTrippable({ ...PLAIN_GLOBAL_DEF, futureField: true } as unknown as PersonaDefinition)).toBe(false);
    // Body values JSON cannot round-trip (NaN stringifies to null).
    expect(isPersonaDefinitionRoundTrippable({ ...PLAIN_GLOBAL_DEF, body: { "openai-chat": { temperature: Number.NaN } } })).toBe(false);
  });

  it("R1: trips on whitespace-only prompt text (the builder drops the prompt key when trim() === \"\")", () => {
    expect(isPersonaDefinitionRoundTrippable(WHITESPACE_PROMPT_DEF)).toBe(false);
  });
});

// --- R1 — scope the gate hint to EDITABLE personas; tighten the prompt trip ---------

describe("PersonaPanel gate scoping (R1)", () => {
  it("a builtin persona keeps its provenance hint (内置指纹), NOT the 手工编写 line", async () => {
    const h = await renderPanel();
    await select(h, "deepseek-native");
    // a reference harness trips the round-trip check (foreign source row) but a
    // builtin is read-only regardless — the hint must stay the provenance
    // line, not claim the gate held it.
    expect(h.container.textContent).toContain("内置指纹(workspace-source)");
    expect(h.container.textContent).toContain("只读");
    expect(h.container.textContent).not.toContain("手工编写");
  });

  it("an external-research builtin keeps 社区逆向指纹, NOT the 手工编写 line", async () => {
    const h = await renderPanel({ list: T2_LIST, defs: T2_DEFS });
    await select(h, "anthropic-cli");
    expect(h.container.textContent).toContain("社区逆向指纹(external-research)");
    expect(h.container.textContent).not.toContain("手工编写");
  });

  it("a gated GLOBAL persona still shows the 手工编写 hint", async () => {
    const h = await renderPanel({ list: R1_LIST, defs: R1_DEFS });
    await select(h, "hand-map");
    expect((byLabelText(h.container, "prompt") as HTMLTextAreaElement).disabled).toBe(true);
    expect(h.container.textContent).toContain("手工编写");
    expect(h.container.textContent).toContain("仅支持查看");
  });

  it("R1: a whitespace-only prompt text global opens VIEW-ONLY (a save would drop the prompt key)", async () => {
    const h = await renderPanel({ list: R1_LIST, defs: R1_DEFS });
    await select(h, "whitespace-prompt");
    expect((byLabelText(h.container, "prompt") as HTMLTextAreaElement).disabled).toBe(true);
    expect((byLabelText(h.container, "displayName") as HTMLInputElement).disabled).toBe(true);
    expect([...h.container.querySelectorAll("button")].some((b) => b.textContent === "保存")).toBe(false);
    expect(h.container.textContent).toContain("手工编写");
    expect(h.personaSaveMock).not.toHaveBeenCalled();
  });
});

// --- the SettingsPage registration (real wire client, in-memory server) -----------

describe("SettingsPage registration", () => {
  it("persona is the 6th tab (preferences → persona → mcp → plugins); opening it fires personaList", async () => {
    const server = fakeServer();
    const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
    act(() => {
      client.connect();
      server.socket.serverOpen();
    });
    act(() => {
      authOk(server.socket);
    });
    const container = mount(<SettingsPage client={client} status={null} onClose={() => {}} />);
    const opsOf = (): { id: number; op: Record<string, unknown> }[] =>
      server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } =>
        typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>),
      ) as { id: number; op: Record<string, unknown> }[];
    await act(async () => {
      const statusOp = opsOf().find((o) => o.op.op === "settingsStatus");
      server.socket.serverSend({ t: "result", id: statusOp?.id, ok: STATUS });
    });
    const tabs = [...container.querySelectorAll("[data-settings-tab]")].map((b) => b.getAttribute("data-settings-tab"));
    expect(tabs).toEqual(["provider", "permissions", "appearance", "preferences", "persona", "mcp", "plugins"]);
    // Lazy mount: the persona ops stay off the wire until the tab opens.
    expect(opsOf().some((o) => String(o.op.op).startsWith("persona"))).toBe(false);
    await act(async () => {
      (container.querySelector("button[data-settings-tab='persona']") as HTMLButtonElement).click();
    });
    const listOps = opsOf().filter((o) => o.op.op === "personaList");
    expect(listOps.length).toBe(1);
    await act(async () => {
      server.socket.serverSend({ t: "result", id: listOps[0]?.id, ok: LIST });
    });
    await flush();
    expect(container.querySelector("[data-persona-tab]")).not.toBeNull();
    expect(container.querySelector("#settings-panel-persona")?.getAttribute("aria-labelledby")).toBe("settings-tab-persona");
  });
});

// ω99-305 (弹层 Esc 可达性): the pvd dialog OWNS focus on open — the family
// idiom (ref + tabIndex -1 + a focus effect on detailOpen) is what makes the
// card's element-level Esc live. Opening from a row click leaves focus on
// <body> (a programmatic click moves nothing); without the pull, Esc presses
// target the body and the dialog's onKeyDown never fires.
describe("ω99-305 — the pvd dialog owns focus on open (Esc reachability)", () => {
  it("selecting a persona focuses the dialog card, and Esc closes it", async () => {
    const h = await renderPanel();
    await select(h, "alpha");
    const card = h.container.querySelector(".modal-card.pvd");
    expect(card).not.toBeNull();
    expect(document.activeElement).toBe(card);
    act(() => {
      card?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(h.container.querySelector(".scrim")).toBeNull();
  });

  it("the create dialog pulls focus too (＋ 新建 opens it keyboard-alive)", async () => {
    const h = await renderPanel();
    await openCreateForm(h);
    const card = h.container.querySelector(".modal-card.pvd");
    expect(card).not.toBeNull();
    expect(document.activeElement).toBe(card);
  });
});
