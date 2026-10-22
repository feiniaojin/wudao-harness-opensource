// @vitest-environment jsdom
// Round 6 (2026-08-30 spec, docs/superpowers/specs/2026-08-30-model-config-modal-design.md):
// the model section's ONLY edit door is the 「配置模型」 modal — the page
// keeps read rows (name / window / ★ / 当前 / 使用), the modal owns the
// dual-channel add (manual input + the /models dropdown) and the row
// editors. These tests pin the spec §5 table: dialog mount + auto-pull,
// dropdown filter/pick/disabled-configured, manual add guards, row
// edit/✕, the card-echo save payload (the panel's unsaved label/baseUrl
// drafts never ride the modal's save — the reverse pin), the clobber
// defense (modal save syncs the panel's rows via RAW setDraft — R1: clean
// stays clean — so a later panel save carries the NEW rows), the cancel
// family (zero ops + Esc never bubbles to the settings page's own Esc →
// 返回会话 — R2), and the pull failure lane (classifier text + retry +
// manual add unblocked).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProviderDetail } from "../src/components/ProviderDetail.js";
import { SettingsPage } from "../src/components/SettingsPage.js";
import type { PersonaListResult, ProviderCard, SettingsStatus, WudaoClient as WudaoClientType } from "../src/protocol.js";

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

// --- fixtures -----------------------------------------------------------------

const LIST: PersonaListResult = {
  personas: [
    { id: "the upstream format", displayName: "DeepSeek Harness", source: "builtin", layers: "headers+prompt", editable: false },
    { id: "alpha", displayName: "Alpha", source: "global", layers: "headers", editable: true },
  ],
};

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

const CATALOG = [
  { name: "deepseek-chat", contextLength: 128000 },
  { name: "glm-5" },
  { name: "glm-5-air", contextLength: 200000 },
];

// --- the mocked-op harness ------------------------------------------------------

type Spy = ReturnType<typeof vi.fn>;

interface Harness {
  container: HTMLElement;
  personaListMock: Spy;
  saveProviderMock: Spy;
  saveKeyMock: Spy;
  testMock: Spy;
  submitMock: Spy;
  setMock: Spy;
  listModelsMock: Spy;
  statusMock: Spy;
  notify: Spy;
  refresh: Spy;
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

async function renderDetail(opts: {
  readonly card: ProviderCard;
  readonly listModels?: { ok: true; models: readonly { name: string; contextLength?: number }[] } | { ok: false; state: string; message: string };
  readonly saveProvider?: { ok: false; error: string };
  readonly mode?: "edit" | "read";
}): Promise<Harness> {
  const personaListMock = vi.fn(() => Promise.resolve(LIST));
  const saveProviderMock =
    opts.saveProvider !== undefined
      ? vi.fn(() => Promise.resolve(opts.saveProvider))
      : vi.fn(() => Promise.resolve({ ok: true as const, provider: opts.card.provider }));
  const saveKeyMock = vi.fn(() => Promise.resolve({ provider: opts.card.provider, saved: true, keyCount: 3 }));
  const testMock = vi.fn(() => Promise.resolve({ ok: true, state: "ok", message: "连接成功" }));
  const submitMock = vi.fn(() => Promise.resolve("started"));
  const setMock = vi.fn(() => Promise.resolve({ key: "", saved: true }));
  const listModelsMock = vi.fn(() => Promise.resolve(opts.listModels ?? { ok: true as const, models: CATALOG }));
  const statusMock = vi.fn(() => Promise.resolve(STATUS_ONE));
  const client = {
    personaList: personaListMock,
    settingsSaveProvider: saveProviderMock,
    settingsSaveKey: saveKeyMock,
    settingsTestConnection: testMock,
    submit: submitMock,
    settingsSet: setMock,
    settingsListModels: listModelsMock,
    settingsStatus: statusMock,
  } as unknown as WudaoClientType;
  const notify = vi.fn();
  const refresh = vi.fn();
  const container = mount(
    <ProviderDetail
      client={client}
      card={opts.card}
      models={opts.card.defaultModel !== "" ? [opts.card.defaultModel] : []}
      currentProvider={opts.card.provider}
      currentModel={opts.card.defaultModel}
      defaultModel={undefined}
      notify={notify}
      refresh={refresh}
    />,
  );
  await flush();
  if (opts.mode === "edit") {
    const edit = [...container.querySelectorAll("button")].find((x) => x.textContent === "编辑");
    if (edit === undefined) throw new Error("编辑 button missing");
    act(() => {
      edit.click();
    });
    await flush();
  }
  return { container, personaListMock, saveProviderMock, saveKeyMock, testMock, submitMock, setMock, listModelsMock, statusMock, notify, refresh };
}

const STATUS_ONE: SettingsStatus = {
  providers: [BUILTIN_CARD],
  credentials: { path: "/home/u/.wudao/.credentials.yaml", keyCount: 2 },
  settings: { memoryEnabled: true, uiDefaultMode: "simple", wizardCompletedVersion: 1, uiTheme: null, uiAccent: null },
  current: { provider: "deepseek", model: "deepseek-chat", effort: "high" },
  envKey: false,
  readiness: true,
  efforts: ["low", "medium", "high"],
};

// --- DOM helpers ----------------------------------------------------------------

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

const type = (el: HTMLInputElement, text: string): void => {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

/** Open the modal: the model section's one edit door. */
async function openModal(h: Harness): Promise<HTMLElement> {
  click(btnByText(h.container, "配置模型"));
  await flush();
  const dlg = h.container.querySelector('[role="dialog"]');
  if (dlg === null) throw new Error("配置模型 dialog missing");
  return dlg as HTMLElement;
}

const addName = (dlg: HTMLElement): HTMLInputElement => {
  const el = dlg.querySelector('input[aria-label="模型名称"]');
  if (!(el instanceof HTMLInputElement)) throw new Error("模型名称 input missing");
  return el;
};

const addCtx = (dlg: HTMLElement): HTMLInputElement => {
  const el = dlg.querySelector('input[aria-label="上下文窗口"]');
  if (!(el instanceof HTMLInputElement)) throw new Error("上下文窗口 input missing");
  return el;
};

const rowInput = (dlg: HTMLElement, aria: string): HTMLInputElement => {
  const el = dlg.querySelector(`input[aria-label="${aria}"]`);
  if (!(el instanceof HTMLInputElement)) throw new Error(`input ${aria} missing`);
  return el;
};

/** Type into the add row and click 添加. */
async function addManual(h: Harness, name: string, ctx = ""): Promise<void> {
  const dlg = await openModal(h);
  type(addName(dlg), name);
  if (ctx !== "") type(addCtx(dlg), ctx);
  click(btnByText(dlg, "添加"));
  await flush();
}

// --- §5 table --------------------------------------------------------------------

describe("ModelConfigModal (round 6 spec §5)", () => {
  it("1 — the model section is constant read rows + the one 配置模型 door: no inputs, no expand, rows carry name/window/使用", async () => {
    const h = await renderDetail({ card: BUILTIN_CARD });
    const mgr = h.container.querySelector(".model-manager") as HTMLElement;
    if (mgr === null) throw new Error(".model-manager missing");
    expect(mgr.querySelectorAll("input, select").length).toBe(0); // zero form controls in the section
    expect(btnByText(mgr, "配置模型")).toBeTruthy(); // the only edit door
    expect(mgr.querySelector('[role="button"][aria-expanded]')).toBeNull(); // no row-head expand (round 5 deleted)
    const row = mgr.querySelector(".model-row") as HTMLElement;
    if (row === null) throw new Error("model row missing");
    expect(row.querySelector(".model-row-name")?.textContent).toBe("deepseek-chat");
    expect(row.querySelector(".model-row-ctx")?.textContent).toBe("128000");
    expect(btnByText(row, "使用")).toBeTruthy();
    // The edit form does not grow a model table either — the section is
    // IDENTICAL in edit mode (恒定形态).
    const h2 = await renderDetail({ card: BUILTIN_CARD, mode: "edit" });
    const mgr2 = h2.container.querySelector(".model-manager") as HTMLElement;
    if (mgr2 === null) throw new Error(".model-manager missing (edit)");
    expect(mgr2.querySelectorAll("input, select").length).toBe(0);
    expect(btnByText(mgr2, "配置模型")).toBeTruthy();
  });

  it("2 — 配置模型 mounts the dialog (aria-label) and auto-pulls /models with the provider id and NO key", async () => {
    const h = await renderDetail({ card: BUILTIN_CARD });
    const dlg = await openModal(h);
    expect(dlg.getAttribute("aria-label")).toBe("配置模型 deepseek");
    expect(dlg.getAttribute("aria-modal")).toBe("true");
    // Auto-pull on open: read mode walks the server's stored-key ladder
    // (env → credentials) — no key param rides the op.
    expect(h.listModelsMock).toHaveBeenCalledWith("deepseek", undefined);
    // The add row's name input takes focus on open.
    expect(document.activeElement).toBe(addName(dlg));
  });

  it("3 — the dropdown lists the whole catalog, the typed text filters, and picking fills name + context", async () => {
    const h = await renderDetail({ card: BUILTIN_CARD });
    const dlg = await openModal(h);
    const toggle = dlg.querySelector('button[aria-label="选择模型"]') as HTMLButtonElement;
    click(toggle);
    await flush();
    let opts = [...dlg.querySelectorAll(".mcm-opt")];
    expect(opts.map((o) => o.querySelector(".mcm-opt-name")?.textContent)).toEqual(["deepseek-chat", "glm-5", "glm-5-air"]);
    // Typing filters while open (the input text IS the filter word).
    type(addName(dlg), "glm");
    opts = [...dlg.querySelectorAll(".mcm-opt")];
    expect(opts.map((o) => o.querySelector(".mcm-opt-name")?.textContent)).toEqual(["glm-5", "glm-5-air"]);
    // Picking fills the name AND the catalog's contextLength (editable after).
    click(opts[1] as HTMLElement);
    await flush();
    expect(addName(dlg).value).toBe("glm-5-air");
    expect(addCtx(dlg).value).toBe("200000");
    expect(dlg.querySelector(".mcm-drop")).toBeNull(); // the list closes on pick
  });

  it("4 — already-configured models are disabled in the dropdown and tagged 已配置 (computed against the LIVE rows)", async () => {
    const h = await renderDetail({ card: BUILTIN_CARD });
    const dlg = await openModal(h);
    // Manual add mid-session makes the newcomer configured too — the set is
    // live, not an open-time snapshot.
    type(addName(dlg), "glm-5");
    click(btnByText(dlg, "添加"));
    await flush();
    const toggle = dlg.querySelector('button[aria-label="选择模型"]') as HTMLButtonElement;
    click(toggle);
    await flush();
    const opts = [...dlg.querySelectorAll(".mcm-opt")];
    const byName = new Map(opts.map((o) => [o.querySelector(".mcm-opt-name")?.textContent, o as HTMLButtonElement]));
    const seeded = byName.get("deepseek-chat");
    if (seeded === undefined) throw new Error("deepseek-chat option missing");
    expect((seeded as HTMLButtonElement).disabled).toBe(true);
    expect(seeded.textContent).toContain("已配置");
    const added = byName.get("glm-5");
    if (added === undefined) throw new Error("glm-5 option missing");
    expect((added as HTMLButtonElement).disabled).toBe(true);
    const fresh = byName.get("glm-5-air") as HTMLButtonElement;
    expect(fresh.disabled).toBe(false);
  });

  it("5 — manual add appends a row; empty and duplicate (trimmed) names disable 添加", async () => {
    const h = await renderDetail({ card: BUILTIN_CARD });
    const dlg = await openModal(h);
    expect(btnByText(dlg, "添加").disabled).toBe(true); // empty name
    type(addName(dlg), "  glm-5  ");
    expect(btnByText(dlg, "添加").disabled).toBe(false); // a NEW name is addable (trim applied)
    click(btnByText(dlg, "添加"));
    await flush();
    expect(dlg.querySelector(".mcm-list-head")?.textContent).toBe("已配置（2）");
    expect(rowInput(dlg, "模型名 glm-5").value).toBe("glm-5"); // trimmed into the row
    // Duplicate against the LIVE rows disables again.
    type(addName(dlg), "glm-5");
    expect(btnByText(dlg, "添加").disabled).toBe(true);
    type(addName(dlg), "  "); // whitespace-only is empty
    expect(btnByText(dlg, "添加").disabled).toBe(true);
  });

  it("6 — rows edit inline (name + ctx) and ✕ deletes", async () => {
    const h = await renderDetail({ card: BUILTIN_CARD });
    const dlg = await openModal(h);
    type(rowInput(dlg, "模型名 deepseek-chat"), "deepseek-chat-v2");
    await flush();
    type(rowInput(dlg, "上下文 deepseek-chat-v2"), "256000");
    await flush();
    const del = dlg.querySelector('button[aria-label="删除模型 deepseek-chat-v2"]') as HTMLButtonElement;
    click(del);
    await flush();
    expect(dlg.querySelector(".mcm-list-head")?.textContent).toBe("已配置（0）");
    expect(dlg.textContent).toContain("从上方添加模型"); // the empty state's guide line
  });

  it("7 — the save payload echoes the CARD (not the panel's drafts); builtin stays an overlay; failure keeps the modal", async () => {
    // Custom: a DIRTY panel (unsaved label/baseUrl drafts) must not ride the
    // modal's save — every echo field comes from the card at open.
    const h = await renderDetail({ card: CUSTOM_CARD, mode: "edit" });
    const labelInput = h.container.querySelector("input.detail-label-input") as HTMLInputElement;
    type(labelInput, "Draft Label");
    const baseInput = h.container.querySelector("input.detail-baseurl") as HTMLInputElement;
    type(baseInput, "https://stale.example.com/v1");
    await addManual(h, "m-new", "99000");
    click(btnByText(h.container.querySelector('[role="dialog"]') as HTMLElement, "保存"));
    await flush();
    const payload = (h.saveProviderMock.mock.calls as unknown as [string, Record<string, unknown>][])[0]?.[1];
    expect(payload).toEqual({
      label: "My Gateway", // card.label — the panel's "Draft Label" does NOT ride
      baseUrl: "https://gw.example.com/v1", // card.baseUrl — not the stale draft
      defaultModel: "m-x",
      defaultContextLength: 131072,
      reasoningFormat: "deepseek",
      persona: "alpha",
      models: [
        { name: "m-x", contextLength: 64000 },
        { name: "m-new", contextLength: 99000 },
      ],
    });
    expect(h.refresh).toHaveBeenCalled();
    expect(h.container.querySelector('[role="dialog"]')).toBeNull(); // success closes
    expect(h.notify.mock.calls.flat().join("\n")).toContain("模型配置");

    // Builtin: the modal cannot change the label, so the overlay payload is
    // models + the binding echoes only.
    const h2 = await renderDetail({ card: BUILTIN_CARD });
    const dlg2 = await openModal(h2);
    click(dlg2.querySelector('button[aria-label="删除模型 deepseek-chat"]') as HTMLButtonElement);
    await flush();
    click(btnByText(dlg2, "保存"));
    await flush();
    const payload2 = (h2.saveProviderMock.mock.calls as unknown as [string, Record<string, unknown>][])[0]?.[1];
    expect(payload2).toEqual({ models: [], reasoningFormat: "deepseek" });

    // Failure: ⚠️ receipt, the modal STAYS (the draft survives).
    const h3 = await renderDetail({ card: BUILTIN_CARD, saveProvider: { ok: false, error: "registry refused" } });
    await addManual(h3, "glm-5");
    click(btnByText(h3.container.querySelector('[role="dialog"]') as HTMLElement, "保存"));
    await flush();
    expect(h3.container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(h3.notify.mock.calls.flat().join("\n")).toContain("⚠️ 保存失败");
    expect(rowInput(h3.container.querySelector('[role="dialog"]') as HTMLElement, "模型名 glm-5")).toBeTruthy();
  });

  it("8 — clobber defense: the modal save syncs the panel rows via RAW setDraft (R1) and a later panel save carries them", async () => {
    // R1: a CLEAN panel stays clean through the modal's save — no false
    // 未保存的修改 marker from the mirror write.
    const clean = await renderDetail({ card: CUSTOM_CARD, mode: "edit" });
    await addManual(clean, "m-modal");
    click(btnByText(clean.container.querySelector('[role="dialog"]') as HTMLElement, "保存"));
    await flush();
    expect(clean.container.textContent).not.toContain("未保存的修改");
    // The synced row is visible on the page immediately (the mirror write).
    expect(clean.container.querySelector(".model-manager")?.textContent).toContain("m-modal");

    // The two-step clobber sequence: a DIRTY panel (label draft) saves AFTER
    // the modal — its payload must carry the NEW rows + its own label draft.
    const dirty = await renderDetail({ card: CUSTOM_CARD, mode: "edit" });
    type(dirty.container.querySelector("input.detail-label-input") as HTMLInputElement, "Draft Label");
    await addManual(dirty, "m-new");
    click(btnByText(dirty.container.querySelector('[role="dialog"]') as HTMLElement, "保存"));
    await flush();
    // The panel is still dirty (its label draft) and still editing.
    expect(dirty.container.textContent).toContain("未保存的修改");
    click(btnByText(dirty.container, "保存修改"));
    await flush();
    const calls = dirty.saveProviderMock.mock.calls as unknown as [string, Record<string, unknown>][];
    const last = calls[calls.length - 1]?.[1];
    expect(last?.label).toBe("Draft Label");
    expect(last?.models).toEqual([
      { name: "m-x", contextLength: 64000 },
      { name: "m-new" },
    ]); // the panel save carried the MODAL's rows, not the pre-modal ones
  });

  it("9 — 取消/✕/overlay/Esc close with zero ops; Esc never bubbles to the settings page (R2)", async () => {
    // 取消 — everything drops, no op fires, the page keeps its rows.
    const h = await renderDetail({ card: BUILTIN_CARD });
    await addManual(h, "glm-5");
    click(btnByText(h.container.querySelector('[role="dialog"]') as HTMLElement, "取消"));
    await flush();
    expect(h.container.querySelector('[role="dialog"]')).toBeNull();
    expect(h.saveProviderMock).not.toHaveBeenCalled();
    expect(h.listModelsMock).toHaveBeenCalledTimes(1); // the auto-pull only
    expect(h.container.querySelector(".model-manager")?.textContent).not.toContain("glm-5");

    // ✕ (the head's close affordance) and the overlay click — same deal.
    const h2 = await renderDetail({ card: BUILTIN_CARD });
    const dlg2 = await openModal(h2);
    click(dlg2.querySelector('button[aria-label="关闭"]') as HTMLButtonElement);
    await flush();
    expect(h2.container.querySelector('[role="dialog"]')).toBeNull();
    const h3 = await renderDetail({ card: BUILTIN_CARD });
    const dlg3 = await openModal(h3);
    const overlay = h3.container.querySelector(".scrim") as HTMLElement;
    act(() => {
      overlay.click(); // e.target === e.currentTarget — the scrim, not the card
    });
    await flush();
    expect(h3.container.querySelector('[role="dialog"]')).toBeNull();

    // R2: Esc inside the REAL settings page closes the modal WITHOUT closing
    // the page (the page root's Esc → 返回会话 must never fire).
    const onClose = vi.fn();
    const client = {
      personaList: vi.fn(() => Promise.resolve(LIST)),
      settingsSaveProvider: vi.fn(() => Promise.resolve({ ok: true, provider: "deepseek" })),
      settingsSaveKey: vi.fn(() => Promise.resolve({ provider: "deepseek", saved: true, keyCount: 1 })),
      settingsTestConnection: vi.fn(() => Promise.resolve({ ok: true, state: "ok", message: "ok" })),
      submit: vi.fn(() => Promise.resolve("started")),
      settingsSet: vi.fn(() => Promise.resolve({ key: "", saved: true })),
      settingsListModels: vi.fn(() => Promise.resolve({ ok: true as const, models: CATALOG })),
      settingsStatus: vi.fn(() => Promise.resolve(STATUS_ONE)),
    } as unknown as WudaoClientType;
    const page = mount(<SettingsPage client={client} status={null} onClose={onClose} pendingAsk={false} />);
    await flush();
    // 0.3.38: the detail is the pvd MODAL — open deepseek's card first; the
    // 配置模型 button lives inside that dialog.
    click(
      [...page.querySelectorAll(".provider-card .card-name")].find((b) =>
        b.textContent?.includes("deepseek"),
      ) as HTMLButtonElement,
    );
    await flush();
    click(btnByText(page, "配置模型"));
    await flush();
    // Esc targets the mcm (nested inside the pvd dialog): the model modal
    // eats it, its HOST dialog survives, and the settings page does too.
    const mcm = page.querySelector(".mcm") as HTMLElement;
    act(() => {
      mcm.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(page.querySelector(".mcm")).toBeNull(); // the model modal ate it…
    expect(page.querySelector(".pvd")).not.toBeNull(); // …its host dialog survived…
    expect(onClose).not.toHaveBeenCalled(); // …and the settings page survived
  });

  it("10 — a failed pull renders the classifier state+message with a working retry, and manual add stays open", async () => {
    const h = await renderDetail({
      card: BUILTIN_CARD,
      listModels: { ok: false, state: "missing-key", message: "未配置 API Key,且环境变量与凭据文件均未提供" },
    });
    const dlg = await openModal(h);
    const err = dlg.querySelector(".mcm-pull-error");
    if (err === null) throw new Error("pull error block missing");
    expect(err.getAttribute("data-state")).toBe("missing-key");
    expect(err.textContent).toContain("未配置 API Key");
    // Retry re-fires the op.
    click(btnByText(err as HTMLElement, "重试"));
    await flush();
    expect(h.listModelsMock).toHaveBeenCalledTimes(2);
    // Manual add is never blocked by the pull's failure.
    type(addName(dlg), "glm-5");
    expect(btnByText(dlg, "添加").disabled).toBe(false);
    click(btnByText(dlg, "添加"));
    await flush();
    expect(dlg.querySelector(".mcm-list-head")?.textContent).toBe("已配置（2）");
  });

  it("11 — the key ladder: a pasted (unsaved) panel key rides the modal's pull; read mode sends none", async () => {
    const h = await renderDetail({ card: BUILTIN_CARD, mode: "edit" });
    const keyInput = h.container.querySelector("input.key-input") as HTMLInputElement;
    type(keyInput, "sk-paste");
    await openModal(h);
    expect(h.listModelsMock).toHaveBeenCalledWith("deepseek", { key: "sk-paste" });
  });

  // 0.3.28 ④ (用户:下拉列表无法点击,而且只有个小三角,非常不显眼): the toggle
  // is a LABELED button that stays actionable. With a failed auto-pull the old
  // toggle was disabled (pool === null) — a dead button that read as "dropdown
  // broken"; now the click itself re-pulls and opens.
  it("12 — the toggle is labeled (选择 ▾, never a bare glyph) and reflects open state (收起 ▴)", async () => {
    const h = await renderDetail({ card: BUILTIN_CARD });
    const dlg = await openModal(h);
    const toggle = dlg.querySelector('button[aria-label="选择模型"]') as HTMLButtonElement;
    expect(toggle.textContent).toContain("选择");
    expect(toggle.textContent).not.toBe("▾"); // the bare 1.9rem glyph is gone
    click(toggle);
    await flush();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toContain("收起");
  });

  it("13 — a failed auto-pull leaves the toggle CLICKABLE: the click re-pulls; the dropdown appears when the retry lands", async () => {
    // First open: the auto-pull fails (no key) → pool stays null.
    const h = await renderDetail({
      card: BUILTIN_CARD,
      listModels: { ok: false, state: "missing-key", message: "未配置 API Key" },
    });
    const dlg = await openModal(h);
    expect(h.listModelsMock).toHaveBeenCalledTimes(1);
    // The toggle is NOT disabled despite the null pool — that was the bug.
    const toggle = dlg.querySelector('button[aria-label="选择模型"]') as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    // Clicking it re-fires the pull; a still-failing pull renders no dead
    // dropdown, and a succeeding one (key saved meanwhile) opens the catalog.
    let ok = false;
    h.listModelsMock.mockImplementation(() =>
      Promise.resolve(ok ? { ok: true as const, models: CATALOG } : { ok: false as const, state: "missing-key", message: "未配置 API Key" }),
    );
    click(toggle);
    await flush();
    expect(h.listModelsMock).toHaveBeenCalledTimes(2); // the click re-pulled
    expect(dlg.querySelector(".mcm-drop")).toBeNull(); // pool still failed → no dead dropdown
    ok = true; // next pull succeeds
    click(toggle);
    await flush();
    expect(h.listModelsMock).toHaveBeenCalledTimes(3);
    const opts = [...dlg.querySelectorAll(".mcm-opt")];
    expect(opts.length).toBe(3); // the catalog renders now
  });
});
