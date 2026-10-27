// @vitest-environment jsdom
// settings-split T1 — the ProviderTab (extracted from SettingsPage's 常规
// tab): the provider-card matrix (dot words, cardModels' choices+default
// merge, the L5 live-provider default badge), the envKey hint moved in from
// page level (renders ABOVE the first section), the key flow (settingsSaveKey
// op on the wire → reply → input cleared + receipt + refresh), the effort
// chips (click = /effort lane), and the Ctrl+S set-as-default lane
// (settingsSet model.defaultEffort). Direct mount — no SettingsPage shell,
// settings arrives as a prop (the page-level fetch is T4's concern).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WudaoClient } from "../src/protocol.js";
import type { DriverStatus, SettingsStatus } from "../src/protocol.js";
import { ProviderTab } from "../src/components/ProviderTab.js";
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

function type(el: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
});

// The tab-panel a11y fixture's STATUS, trimmed to two cards: deepseek (ready,
// env key) + glm (missing key) — enough matrix to pin the merge and the badge.
const STATUS: SettingsStatus = {
  providers: [
    { provider: "deepseek", label: "deepseek", status: "ready", keySource: "env", endpoint: "https://api.deepseek.com", defaultModel: "deepseek-v4-flash", custom: false, models: []},
    { provider: "glm", label: "glm", status: "missing-key", keySource: null, endpoint: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4.6", custom: false, models: []},
  ],
  credentials: { path: "/home/u/.wudao/.credentials.yaml", keyCount: 1 },
  settings: { memoryEnabled: true, uiDefaultMode: "advanced", wizardCompletedVersion: 1, uiTheme: null, uiAccent: null },
  current: { provider: "deepseek", model: "deepseek-v4-flash", effort: "high" },
  envKey: false,
  readiness: true,
  efforts: ["low", "medium", "high", "max", "none"],
};

// The LIVE driver identity: glm is what the session actually runs (L5 — it
// wins over settingsStatus.current.provider=deepseek for the default badge),
// and its model matrix carries choices for BOTH providers.
const DRIVER: DriverStatus = {
  live: { reasoning: "", answer: "", busyTools: [] },
  busy: false,
  queued: [],
  boardProgress: null,
  ctxTokens: null,
  mode: "workspace",
  cachePercent: null,
  bg: { active: 0, spawned: 0 },
  pendingPermission: null,
  planBoard: null,
  sessionId: "wudao-t",
  sidecar: null,
  model: {
    label: "glm-5",
    provider: "glm",
    choices: [
      { provider: "deepseek", model: "deepseek-v4-flash", source: "profile" },
      { provider: "deepseek", model: "deepseek-v4-pro", source: "profile" },
      { provider: "glm", model: "glm-5", source: "profile" },
    ],
  },
};

interface Harness {
  container: HTMLElement;
  client: WudaoClient;
  server: FakeServer;
  notify: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
}

function connectedClient(server: FakeServer): WudaoClient {
  const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
  act(() => {
    client.connect();
    server.socket.serverOpen();
  });
  act(() => {
    authOk(server.socket);
  });
  return client;
}

function mountedTab(settings: SettingsStatus | null = STATUS, status: DriverStatus | null = null): Harness {
  const server = fakeServer();
  const client = connectedClient(server);
  const notify = vi.fn();
  const refresh = vi.fn();
  const container = mount(<ProviderTab client={client} settings={settings} status={status} notify={notify} refresh={refresh} />);
  return { container, client, server, notify, refresh };
}

function opsOf(server: FakeServer): { id: number; op: Record<string, unknown> }[] {
  return server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } =>
    typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>),
  ) as { id: number; op: Record<string, unknown> }[];
}

const replyTo = async (server: FakeServer, opName: string, ok: unknown): Promise<void> => {
  await act(async () => {
    const op = [...opsOf(server)].reverse().find((o) => o.op.op === opName);
    server.socket.serverSend({ t: "result", id: op?.id, ok });
  });
};

const card = (c: HTMLElement, provider: string): HTMLElement => {
  const el = [...c.querySelectorAll(".provider-card")].find((n) => n.querySelector(".card-name")?.textContent?.includes(provider) === true);
  if (el === undefined) throw new Error(`card ${provider} missing`);
  return el as HTMLElement;
};

const btnByText = (scope: HTMLElement, text: string): HTMLButtonElement => {
  const b = [...scope.querySelectorAll("button")].find((x) => x.textContent === text);
  if (b === undefined) throw new Error(`button "${text}" missing`);
  return b as HTMLButtonElement;
};

describe("the provider-card matrix", () => {
  it("renders dot words, the key badge, and the 默认 badge on the LIVE provider (L5) — with ZERO editing surface (iter3)", () => {
    const h = mountedTab(STATUS, DRIVER);
    // The human status words.
    expect(card(h.container, "deepseek").textContent).toContain("可用");
    expect(card(h.container, "glm").textContent).toContain("缺 Key");
    expect(card(h.container, "glm").getAttribute("data-status")).toBe("missing-key");
    // The key badge (iter3): 已配/未配 off the wire keySource — the ONLY key
    // fact the master column still shows.
    expect(card(h.container, "deepseek").textContent).toContain("已配 · 环境变量");
    expect(card(h.container, "glm").textContent).toContain("未配 Key");
    // Strict master-detail: no key input, no inline buttons, no chips on ANY
    // card — all of that lives in the selected card's detail.
    expect(card(h.container, "deepseek").querySelector("input")).toBeNull();
    expect(card(h.container, "glm").querySelectorAll("button.model-chip").length).toBe(0);
    // L5: the LIVE driver identity (status.model.provider=glm) wins over
    // settingsStatus.current.provider=deepseek — glm carries the badge.
    expect(card(h.container, "glm").textContent).toContain("默认");
    expect(card(h.container, "deepseek").textContent).not.toContain("默认");
  });

  it("the model TABLE is the detail's only per-model surface — the chips row is gone (0.3.24 round 4)", async () => {
    const h = mountedTab(STATUS, DRIVER);
    // 0.3.38: nothing is selected on load — open deepseek's detail modal.
    await selectCard(h, "deepseek");
    // its registry row list is EMPTY (the fixture) — the cardModels merge no
    // longer paints a SECOND copy of the table as chips.
    expect(detailPanel(h.container).querySelectorAll(".model-chip").length).toBe(0);
    expect(detailPanel(h.container).querySelectorAll("button.model-use").length).toBe(0);
    // my-gateway carries one registry row → exactly one 使用, and with the
    // session running glm it is a cross-provider switch (clickable, its
    // title names the /provider lane).
    const reg = mountedTab(REGISTRY, DRIVER);
    await selectCard(reg, "my-gateway");
    // Round 6: 使用 sits ON the read row (the round-5 expand card is gone).
    const use = [...detailPanel(reg.container).querySelectorAll("button.model-use")] as HTMLButtonElement[];
    expect(use.length).toBe(1);
    expect(use[0]?.title).toContain("/provider my-gateway");
    expect(use[0]?.disabled).toBe(false);
  });
});

describe("the envKey hint (moved in from page level, spec §2)", () => {
  it("renders above the first section when settings.envKey === true; absent otherwise", () => {
    const on = mountedTab({ ...STATUS, envKey: true });
    const hint = [...on.container.querySelectorAll(".hint")].find((n) =>
      (n.textContent ?? "").includes("检测到环境变量 Key(WUDAO_API_KEY)"),
    );
    expect(hint?.textContent).toBe(
      "检测到环境变量 Key(WUDAO_API_KEY)——环境变量优先于凭据文件;保存到文件的 Key 只在没有环境变量时生效",
    );
    // ABOVE the first section — the hint comes before anything else in the tab.
    const firstSection = on.container.querySelector(".settings-section") as HTMLElement;
    expect(firstSection).not.toBeNull();
    expect(hint !== undefined && (hint.compareDocumentPosition(firstSection) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
    // And the byte-identical copy stays out when envKey is false.
    const off = mountedTab(STATUS);
    expect(off.container.textContent).not.toContain("检测到环境变量 Key");
  });
});

describe("key management", () => {
  it("保存修改 commits a pasted key from the DETAIL through the SINGLE save (the keyrow's own 保存 button is gone); the reply clears the input, receipts through notify, and refreshes", async () => {
    const h = mountedTab();
    // 0.3.38: nothing auto-selects — open deepseek's detail modal first; the
    // detail owns the key input (iter3).
    await selectCard(h, "deepseek");
    await enterDetailEdit(h); // round 5: the paste box only exists in the form
    const input = detailPanel(h.container).querySelector("input.key-input") as HTMLInputElement;
    await act(async () => {
      type(input, "sk-paste-me");
    });
    await act(async () => {
      btnByText(detailPanel(h.container), "保存修改").click();
    });
    const op = opsOf(h.server).find((o) => o.op.op === "settingsSaveKey");
    expect(op?.op).toMatchObject({ provider: "deepseek", key: "sk-paste-me" });
    // The same click also carried the registry config lane.
    const cfgOp = opsOf(h.server).find((o) => o.op.op === "settingsSaveProvider");
    expect(cfgOp?.op).toMatchObject({ id: "deepseek" });
    await replyTo(h.server, "settingsSaveKey", { provider: "deepseek", saved: true, keyCount: 2 });
    await replyTo(h.server, "settingsSaveProvider", { ok: true, provider: "deepseek" });
    // Round 5: the save closed the form — the paste box itself is gone
    // (nothing retains the key client-side, stronger than an emptied input).
    expect(detailPanel(h.container).querySelector("input.key-input")).toBeNull();
    expect(h.notify).toHaveBeenCalledWith("已保存 deepseek 的 Key(凭据文件现有 2 个,权限 0600)——下会话可用");
    expect(h.refresh).toHaveBeenCalled();
  });
});

// 0.3.26 ①: the 默认模型 / 推理档 strip's effort-chip click / Ctrl+S lanes
// were deleted with the row (and this once-empty describe with them — an
// empty suite fails the whole file under vitest's no-test check). The click
// lane stays pinned on the composer side (effort-selector suite — a pick
// rides the /effort submit); the default-persist capability lives on in the
// 偏好 tab (preferences-tab suite pins settingsSet model.defaultEffort). The
// Ctrl+S GESTURE itself is gone — no orphaned setting: three entry points
// remain (composer EffortSelector / 偏好 tab / the /effort command).

// ---------------------------------------------------------------------------
// provider-management T4 (spec §6) — the master-detail rework: cross-field
// search over a registry-scale matrix, per-card selection (aria-current) with
// the detail panel (baseUrl / the model table with contextLength / the
// /models pull's diff-append / save payloads / custom-only delete), the
// inline add form, and the fail-visible invalid rows.
// ---------------------------------------------------------------------------

// A registry-shaped fixture: one builtin, one custom (with a catalog row
// carrying a contextLength), one INVALID registry row (fail-visible).
const REGISTRY: SettingsStatus = {
  providers: [
    { provider: "deepseek", label: "deepseek", status: "ready", keySource: "env", endpoint: "https://api.deepseek.com", defaultModel: "deepseek-v4-flash", custom: false, models: [] },
    {
      provider: "my-gateway", label: "My Gateway", status: "ready", keySource: "credentials", endpoint: "https://gw.example.com/v1",
      defaultModel: "m-x", baseUrl: "https://gw.example.com/v1", custom: true, defaultContextLength: 131072, reasoningFormat: "deepseek",
      models: [{ name: "m-x", contextLength: 64000 }],
    },
    { provider: "bad-gw", label: "bad-gw", status: "missing-key", keySource: null, endpoint: null, defaultModel: "", custom: true, models: [], invalidReason: "baseUrl \"not-a-url\" is not a valid URL" },
  ],
  credentials: { path: "/home/u/.wudao/.credentials.yaml", keyCount: 2 },
  settings: { memoryEnabled: true, uiDefaultMode: "advanced", wizardCompletedVersion: 1, uiTheme: null, uiAccent: null },
  current: { provider: "deepseek", model: "deepseek-v4-flash", effort: "high" },
  envKey: false,
  readiness: true,
  efforts: ["low", "medium", "high", "max", "none"],
};

/** The R1 scale fixture: the STATUS base (2 builtins) + 100 registry customs
 *  (gw-000…gw-099), each with a baseUrl and a model row (gw-042's carries a
 *  distinctive name so a model-name search can surface exactly its provider). */
function bigFixture(): SettingsStatus {
  const customs: SettingsStatus["providers"][number][] = [];
  for (let i = 0; i < 100; i++) {
    const n = String(i).padStart(3, "0");
    customs.push({
      provider: `gw-${n}`,
      label: `Gateway ${n}`,
      status: "ready",
      keySource: null,
      endpoint: `https://gw${i}.example.com/v1`,
      defaultModel: `m-${n}`,
      baseUrl: `https://gw${i}.example.com/v1`,
      custom: true,
      models: i === 42 ? [{ name: "Nebula-42", contextLength: 1000000 }] : [{ name: `m-${n}` }],
    });
  }
  return { ...STATUS, providers: [...STATUS.providers, ...customs] };
}

const detailPanel = (c: HTMLElement): HTMLElement => {
  const el = c.querySelector(".provider-detail");
  if (!(el instanceof HTMLElement)) throw new Error("detail panel missing");
  return el;
};

/** The master row BY ID (the label may differ from the id for customs —
 *  card() matches label text only). */
const rowOf = (c: HTMLElement, provider: string): HTMLElement => {
  const el = c.querySelector(`.provider-card[data-provider="${provider}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`card ${provider} missing`);
  return el;
};

const selectCard = async (h: Harness, provider: string): Promise<void> => {
  await act(async () => {
    (rowOf(h.container, provider).querySelector(".card-name") as HTMLButtonElement).click();
  });
};

/** Round 5 (契约反转): the detail renders READ by default — form tests open
 *  the door first (编辑 is the form's only way in). */
const enterDetailEdit = async (h: Harness): Promise<void> => {
  const b = [...detailPanel(h.container).querySelectorAll("button")].find((x) => x.textContent === "编辑");
  if (b === undefined) throw new Error("detail 编辑 button missing");
  await act(async () => {
    b.click();
  });
};

const findBtn = (scope: HTMLElement, text: string): HTMLButtonElement | undefined =>
  ([...scope.querySelectorAll("button")].find((x) => x.textContent === text)) as HTMLButtonElement | undefined;

describe("provider management T4 — master-detail selection", () => {
  it("0.3.38: load renders the LIST only (no auto-select, no modal); a card click opens the pvd dialog with that provider's detail and moves aria-current", async () => {
    const h = mountedTab(REGISTRY);
    // 用户 (2026-08-31): 拉到最下面点编辑,详情却躲在页面顶上 —— 现在点开就是
    // 居中弹窗。载入时只有列表:无 aria-current、无 .provider-detail、无弹窗
    // (自动选中+弹窗会把老问题倒过来:一进页就挡住选择器)。
    expect(rowOf(h.container, "deepseek").getAttribute("aria-current")).toBeNull();
    expect(h.container.querySelector(".provider-detail")).toBeNull();
    expect(h.container.querySelector(".pvd")).toBeNull();
    await selectCard(h, "my-gateway");
    // The card click opened the dialog (role=dialog, the modal-card family).
    const dlg = h.container.querySelector(".modal-card.pvd") as HTMLElement;
    expect(dlg.getAttribute("role")).toBe("dialog");
    expect(dlg.getAttribute("aria-modal")).toBe("true");
    expect(dlg.getAttribute("aria-label")).toBe("供应商 My Gateway");
    expect(rowOf(h.container, "my-gateway").getAttribute("aria-current")).toBe("true");
    expect(detailPanel(h.container).textContent).toContain("my-gateway");
    expect(detailPanel(h.container).textContent).toContain("My Gateway");
    // The builtin/custom fact rides the detail head.
    expect(detailPanel(h.container).textContent).toContain("自定义");
    // Switching targets: another card click swaps the dialog's detail (the
    // vanishing-card guard closes it, the next click reopens on the new id).
    await act(async () => {
      btnByText(h.container.querySelector(".modal-card.pvd") as HTMLElement, "✕")!.click();
    });
    expect(h.container.querySelector(".pvd")).toBeNull();
    expect(rowOf(h.container, "my-gateway").getAttribute("aria-current")).toBe("true"); // the mark survives close
    await selectCard(h, "deepseek");
    expect(rowOf(h.container, "deepseek").getAttribute("aria-current")).toBe("true");
    expect(rowOf(h.container, "my-gateway").getAttribute("aria-current")).toBeNull();
    expect(detailPanel(h.container).textContent).toContain("deepseek");
  });

  it("the detail renders the custom's registered baseUrl as an editable field; a builtin shows it read-only", async () => {
    const h = mountedTab(REGISTRY);
    await selectCard(h, "my-gateway");
    await enterDetailEdit(h); // round 5: the input only exists in the form
    const custom = detailPanel(h.container).querySelector("input.detail-baseurl") as HTMLInputElement;
    expect(custom.value).toBe("https://gw.example.com/v1");
    // deepseek (builtin, selected on load): no baseUrl input — read-only display only.
    await selectCard(h, "deepseek");
    expect(detailPanel(h.container).querySelector("input.detail-baseurl")).toBeNull();
  });
});

// iter3 (strict master-detail) — the cards' ONE actuator: 「应用」switches the
// session to that provider in-place, riding the same /provider lane the
// cross-provider model chips always used (ui-review-r5 I2 semantics).
describe("provider management iter3 — the cards' 应用 lane", () => {
  it("应用 submits the in-session /provider switch with the cold-cache receipt; the CURRENT provider's card is a disabled no-op", async () => {
    const h = mountedTab(STATUS, DRIVER);
    // The session runs glm (L5) — glm's own 应用 is a no-op.
    const glmApply = btnByText(rowOf(h.container, "glm"), "应用");
    expect(glmApply.disabled).toBe(true);
    expect(glmApply.title).toContain("已是当前供应商");
    const dsApply = btnByText(rowOf(h.container, "deepseek"), "应用");
    expect(dsApply.disabled).toBe(false);
    expect(dsApply.title).toContain("/provider deepseek"); // the lane, named
    await act(async () => {
      dsApply.click();
    });
    const op = opsOf(h.server).find((o) => o.op.op === "submit");
    expect(op?.op).toMatchObject({ text: "/provider deepseek" });
    await replyTo(h.server, "submit", { ok: true });
    expect(h.notify).toHaveBeenCalledWith("供应商 → deepseek — 下一轮起切换端点,历史将全部重新处理(缓存全冷)"); // ω99-310: 称谓随设置面统一
  });

  it("应用 is an apply, NOT a selection (stopPropagation); clicking the card BODY opens the detail modal", async () => {
    const h = mountedTab(REGISTRY);
    // 0.3.38: nothing is open on load; my-gateway's 应用 must not OPEN the
    // detail dialog (the stopPropagation guard — an apply is not an edit).
    await act(async () => {
      btnByText(rowOf(h.container, "my-gateway"), "应用").click();
    });
    expect(h.container.querySelector(".pvd")).toBeNull();
    expect(rowOf(h.container, "my-gateway").getAttribute("aria-current")).toBeNull();
    // The card body click (outside the head button and the apply row) opens
    // the modal — the whole card is the master row.
    await act(async () => {
      (rowOf(h.container, "my-gateway").querySelector(".card-status") as HTMLElement).click();
    });
    expect(rowOf(h.container, "my-gateway").getAttribute("aria-current")).toBe("true");
    expect(detailPanel(h.container).textContent).toContain("my-gateway");
  });
});

describe("provider management T4 — registry-scale search (R1)", () => {
  it("filters 101 cards across id/label/baseUrl (case-insensitive) and empties to a no-match hint", async () => {
    const h = mountedTab(bigFixture());
    expect(h.container.querySelectorAll(".provider-card").length).toBe(102);
    const search = h.container.querySelector("input.provider-search") as HTMLInputElement;
    await act(async () => {
      type(search, "gw-042");
    });
    expect(h.container.querySelectorAll(".provider-card").length).toBe(1);
    await act(async () => {
      type(search, "gateway 007");
    });
    expect(h.container.querySelectorAll(".provider-card").length).toBe(1);
    await act(async () => {
      type(search, "gw7.example.com");
    });
    expect(h.container.querySelectorAll(".provider-card").length).toBe(1);
    await act(async () => {
      type(search, "zzz-no-such");
    });
    expect(h.container.querySelectorAll(".provider-card").length).toBe(0);
    expect(h.container.textContent).toContain("无匹配");
  });

  it("a MODEL-name hit surfaces its provider (the a reference harness picker rule)", async () => {
    const h = mountedTab(bigFixture());
    const search = h.container.querySelector("input.provider-search") as HTMLInputElement;
    await act(async () => {
      type(search, "Nebula-42");
    });
    expect(h.container.querySelectorAll(".provider-card").length).toBe(1);
    expect(rowOf(h.container, "gw-042").querySelector(".card-name")?.textContent).toContain("Gateway 042");
  });
});

describe("provider management T4 — the model manager", () => {
  /** Round 6: ALL model editing rides the 配置模型 modal. Open it for the
   *  selected card and return the dialog element (the auto-pull fires on
   *  mount — the caller replies to it). */
  const openModelModal = async (h: ReturnType<typeof mountedTab>): Promise<HTMLElement> => {
    await act(async () => {
      btnByText(detailPanel(h.container), "配置模型").click();
    });
    const dlg = h.container.querySelector(".mcm") as HTMLElement | null;
    if (!(dlg instanceof HTMLElement)) throw new Error("model config modal missing");
    return dlg;
  };

  // 模型配置反馈 ④ (2026-08-29) → round 6: the inline picker is gone — the
  // modal's dropdown is the picker. The existing-row guarantee survives:
  // a listed model renders disabled + 已配置 in the dropdown, so its
  // contextLength can never be clobbered by a pull.
  it("配置模型 opens the modal (auto-pull; listed models render disabled 已配置; a pick joins on 添加); failures render state+message in place", async () => {
    const h = mountedTab(REGISTRY);
    await selectCard(h, "my-gateway");
    const dlg0 = await openModelModal(h);
    expect(dlg0.getAttribute("role")).toBe("dialog");
    expect(opsOf(h.server).find((o) => o.op.op === "settingsListModels")?.op).toMatchObject({ provider: "my-gateway" });
    await replyTo(h.server, "settingsListModels", {
      ok: true,
      models: [
        { name: "m-x", contextLength: 999999 },
        { name: "m-lite", contextLength: 32000 },
      ],
    });
    const dlg = h.container.querySelector(".mcm") as HTMLElement;
    await act(async () => {
      (dlg.querySelector("button.mcm-drop-toggle") as HTMLButtonElement).click();
    });
    // m-x is already configured → disabled + tagged, never pickable (its
    // 64000 can never be clobbered); only m-lite offers itself.
    const opts = [...h.container.querySelectorAll(".mcm-opt")] as HTMLButtonElement[];
    expect(opts.length).toBe(2);
    expect(opts[0]?.disabled).toBe(true);
    expect(opts[0]?.querySelector(".mcm-opt-tag")?.textContent).toContain("已配置");
    // Picking m-lite fills name+ctx; 添加 appends exactly one row.
    await act(async () => {
      opts[1]?.click();
    });
    await act(async () => {
      btnByText(h.container.querySelector(".mcm") as HTMLElement, "添加").click();
    });
    const rows = [...h.container.querySelectorAll(".mcm-row")];
    expect(rows.length).toBe(2);
    // m-x kept its 64000 — the pull NEVER clobbers an existing row's value.
    expect((rows[0]?.querySelector("input[aria-label='模型名 m-x']") as HTMLInputElement).value).toBe("m-x");
    expect((rows[0]?.querySelector("input[aria-label='上下文 m-x']") as HTMLInputElement).value).toBe("64000");
    expect((rows[1]?.querySelector("input[aria-label='模型名 m-lite']") as HTMLInputElement).value).toBe("m-lite");
    expect((rows[1]?.querySelector("input[aria-label='上下文 m-lite']") as HTMLInputElement).value).toBe("32000");
    // A failed refresh renders the classifier's state+message VERBATIM, in
    // place (spec §2: 刷新 re-pulls on demand, beyond the open-time auto-pull).
    await act(async () => {
      (h.container.querySelector("button[aria-label='刷新模型列表']") as HTMLButtonElement).click();
    });
    await replyTo(h.server, "settingsListModels", { ok: false, state: "model", message: "模型名不存在——试试推荐模型" });
    const err = h.container.querySelector(".mcm-pull-error") as HTMLElement;
    expect(err.getAttribute("data-state")).toBe("model");
    expect(err.textContent).toContain("模型名不存在——试试推荐模型");
  });

  it("the modal save sends the OVERLAY payload for a builtin (models only, unchanged fields never ride)", async () => {
    const h = mountedTab(REGISTRY);
    // 0.3.38: open deepseek's detail modal first (no auto-select on load).
    await selectCard(h, "deepseek");
    const dlg0 = await openModelModal(h);
    expect(dlg0.getAttribute("aria-label")).toBe("配置模型 deepseek");
    await replyTo(h.server, "settingsListModels", { ok: true, models: [] });
    const dlg = h.container.querySelector(".mcm") as HTMLElement;
    await act(async () => {
      type(dlg.querySelector("input[aria-label='模型名称']") as HTMLInputElement, "deepseek-chat");
      type(dlg.querySelector("input[aria-label='上下文窗口']") as HTMLInputElement, "128000");
    });
    await act(async () => {
      btnByText(dlg, "添加").click();
    });
    await act(async () => {
      btnByText(dlg, "保存").click();
    });
    const op = opsOf(h.server).find((o) => o.op.op === "settingsSaveProvider");
    expect(op?.op).toMatchObject({ id: "deepseek" });
    expect(op?.op.config).toEqual({ models: [{ name: "deepseek-chat", contextLength: 128000 }] });
    await replyTo(h.server, "settingsSaveProvider", { ok: true, provider: "deepseek" });
    expect(h.notify).toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalled();
    expect(h.container.querySelector(".mcm")).toBeNull(); // closed on success
  });

  it("保存修改 sends the FULL registry payload for a custom — echoing every registry field the wire card carries (F1)", async () => {
    const h = mountedTab(REGISTRY);
    await selectCard(h, "my-gateway");
    await enterDetailEdit(h); // round 5: 保存修改 only exists in the form
    await act(async () => {
      btnByText(detailPanel(h.container), "保存修改").click();
    });
    const op = [...opsOf(h.server)].reverse().find((o) => o.op.op === "settingsSaveProvider");
    expect(op?.op).toMatchObject({ id: "my-gateway" });
    expect(op?.op.config).toEqual({
      label: "My Gateway",
      baseUrl: "https://gw.example.com/v1",
      // F1: the replace-row save must echo the card's registry fields back,
      // or they vanish from providers.json (defaultModel "" = nothing stored).
      defaultModel: "m-x",
      defaultContextLength: 131072,
      // T4b (F1 structural half): reasoningFormat rides the wire card now, so
      // the full custom payload echoes it — a web edit-save never drops the
      // format (which would silently break reasoning parsing).
      reasoningFormat: "deepseek",
      models: [{ name: "m-x", contextLength: 64000 }],
    });
  });

  it("T4b: a custom card WITHOUT a wire reasoningFormat sends NO reasoningFormat field (the guard, not a null)", async () => {
    const NO_FORMAT: SettingsStatus = {
      ...REGISTRY,
      providers: REGISTRY.providers.map((c) => (c.provider === "my-gateway" ? { ...c, reasoningFormat: undefined } : c)),
    };
    const h = mountedTab(NO_FORMAT);
    await selectCard(h, "my-gateway");
    await enterDetailEdit(h); // round 5
    await act(async () => {
      btnByText(detailPanel(h.container), "保存修改").click();
    });
    const op = [...opsOf(h.server)].reverse().find((o) => o.op.op === "settingsSaveProvider");
    expect(op?.op.config).not.toHaveProperty("reasoningFormat");
  });

  it("the modal row's ✕ removes the row; its save sends the FULL registry payload with models: [] (custom branch, card-echo)", async () => {
    const h = mountedTab(REGISTRY);
    await selectCard(h, "my-gateway");
    await openModelModal(h);
    await replyTo(h.server, "settingsListModels", { ok: true, models: [] });
    const dlg = h.container.querySelector(".mcm") as HTMLElement;
    await act(async () => {
      (dlg.querySelector("button[aria-label='删除模型 m-x']") as HTMLButtonElement).click();
    });
    expect(h.container.querySelectorAll(".mcm-row").length).toBe(0);
    expect(h.container.querySelector(".mcm-empty")?.textContent).toContain("从上方添加模型");
    await act(async () => {
      btnByText(dlg, "保存").click();
    });
    const op = [...opsOf(h.server)].reverse().find((o) => o.op.op === "settingsSaveProvider");
    expect(op?.op.config).toEqual({
      label: "My Gateway",
      baseUrl: "https://gw.example.com/v1",
      defaultModel: "m-x",
      defaultContextLength: 131072,
      reasoningFormat: "deepseek",
      models: [],
    });
  });
});

describe("provider management T4 — delete + invalid rows (fail-visible)", () => {
  it("a builtin carries NO delete button; a custom deletes through settingsDeleteProvider", async () => {
    const h = mountedTab(REGISTRY);
    // 0.3.38: open deepseek's detail first (no auto-select on load).
    await selectCard(h, "deepseek");
    expect(findBtn(detailPanel(h.container), "删除供应商")).toBeUndefined();
    await selectCard(h, "my-gateway");
    await enterDetailEdit(h); // round 5: the delete button lives in the form footer
    await act(async () => {
      btnByText(detailPanel(h.container), "删除供应商").click();
    });
    expect(opsOf(h.server).find((o) => o.op.op === "settingsDeleteProvider")?.op).toMatchObject({ id: "my-gateway" });
    await replyTo(h.server, "settingsDeleteProvider", { ok: true });
    expect(h.notify).toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalled();
  });

  it("an invalid registry row is grayed + reason-badged, unselectable — but deletable from the row", async () => {
    const h = mountedTab(REGISTRY);
    // 0.3.38: open deepseek's detail first — the refusal below keeps THIS
    // dialog (no swap, no close).
    await selectCard(h, "deepseek");
    const bad = rowOf(h.container, "bad-gw");
    expect(bad.getAttribute("data-invalid")).toBe("true");
    expect(bad.textContent).toContain("baseUrl \"not-a-url\" is not a valid URL");
    // No keyrow/chips on an invalid row (the wire card is minimal).
    expect(bad.querySelector("input.key-input")).toBeNull();
    expect(bad.querySelectorAll(".model-chip").length).toBe(0);
    // Selecting refuses: the detail stays on deepseek.
    await act(async () => {
      (bad.querySelector(".card-name") as HTMLButtonElement).click();
    });
    expect(rowOf(h.container, "bad-gw").getAttribute("aria-current")).toBeNull();
    expect(detailPanel(h.container).textContent).toContain("deepseek");
    // …but the row deletes (invalid rows ARE custom rows).
    await act(async () => {
      btnByText(bad, "删除").click();
    });
    expect(opsOf(h.server).find((o) => o.op.op === "settingsDeleteProvider")?.op).toMatchObject({ id: "bad-gw" });
  });
});

// iter5 (trial feedback) — 添加供应商 no longer pops an inline form: it
// inserts a BLANK provider card at the HEAD of the master list (selected) and
// the detail column becomes the completion form — the same interaction as
// editing an existing provider. The create op lane is the old form's VERBATIM
// (payload shape, receipts, refresh).
describe("provider management iter5 — 添加供应商 (blank lead card + detail completion)", () => {
  it("inserts a selected draft card at .provider-cards index 0 (above any query); the inline addform is gone and the detail becomes the create form", async () => {
    const h = mountedTab(REGISTRY);
    await act(async () => {
      btnByText(h.container, "＋ 添加供应商").click();
    });
    // The draft card LEADS the list — index 0, draft-marked, selected.
    const cards = [...h.container.querySelectorAll(".provider-cards .provider-card")];
    expect(cards[0]?.getAttribute("data-draft")).toBe("true");
    expect(cards[0]?.getAttribute("data-provider")).toBe("__draft__");
    expect(cards[0]?.getAttribute("aria-current")).toBe("true");
    expect(cards[0]?.textContent).toContain("新增供应商");
    expect(cards[0]?.textContent).toContain("未保存");
    // The draft IS the selection — no real card carries aria-current.
    expect(rowOf(h.container, "deepseek").getAttribute("aria-current")).toBeNull();
    // The old inline form is gone for good.
    expect(h.container.querySelector(".provider-addform")).toBeNull();
    // The detail column is the create form now (same .provider-detail shell).
    expect(detailPanel(h.container).querySelector("input.add-id")).not.toBeNull();
    // The draft card leads REGARDLESS of the query — even a no-match filter.
    await act(async () => {
      type(h.container.querySelector("input.provider-search") as HTMLInputElement, "zzz-no-such");
    });
    const filtered = [...h.container.querySelectorAll(".provider-cards .provider-card")];
    expect(filtered.length).toBe(1);
    expect(filtered[0]?.getAttribute("data-draft")).toBe("true");
  });

  it("创建 sends the old form's VERBATIM op (8 formats, none default, label when non-empty), receipts, and lands the new card selected", async () => {
    const h = mountedTab(REGISTRY);
    await act(async () => {
      btnByText(h.container, "＋ 添加供应商").click();
    });
    const form = detailPanel(h.container);
    const select = form.querySelector("select.add-format") as HTMLSelectElement;
    expect([...select.querySelectorAll("option")].map((o) => (o as HTMLOptionElement).value)).toEqual([
      "none", "deepseek", "zai", "qwen", "qwen-chat-template", "openrouter", "together", "baseten",
    ]);
    expect(select.value).toBe("none");
    await act(async () => {
      type(form.querySelector("input.add-id") as HTMLInputElement, "my-new-gw");
      type(form.querySelector("input.add-label") as HTMLInputElement, "New GW");
      type(form.querySelector("input.add-baseurl") as HTMLInputElement, "https://new.example.com/v1");
      const sel = form.querySelector("select.add-format") as HTMLSelectElement;
      sel.value = "openrouter";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      btnByText(form, "创建").click();
    });
    expect(opsOf(h.server).find((o) => o.op.op === "settingsSaveProvider")?.op).toEqual({
      op: "settingsSaveProvider",
      id: "my-new-gw",
      config: { label: "New GW", baseUrl: "https://new.example.com/v1", reasoningFormat: "openrouter", models: [] },
    });
    await replyTo(h.server, "settingsSaveProvider", { ok: true, provider: "my-new-gw" });
    expect(h.notify).toHaveBeenCalledWith("已添加供应商 my-new-gw —— 保存 Key 后即可使用");
    expect(h.refresh).toHaveBeenCalled();
    // The draft card vanishes the moment the ok reply lands.
    expect(h.container.querySelector('.provider-card[data-draft="true"]')).toBeNull();
    // The new card lands SELECTED once the refreshed matrix carries it.
    const refreshed: SettingsStatus = {
      ...REGISTRY,
      providers: [
        ...REGISTRY.providers,
        { provider: "my-new-gw", label: "New GW", status: "missing-key", keySource: null, endpoint: "https://new.example.com/v1", defaultModel: "m", baseUrl: "https://new.example.com/v1", custom: true, models: [] },
      ],
    };
    await act(async () => {
      root?.render(<ProviderTab client={h.client} settings={refreshed} status={null} notify={h.notify} refresh={h.refresh} />);
    });
    expect(rowOf(h.container, "my-new-gw").getAttribute("aria-current")).toBe("true");
    expect(detailPanel(h.container).textContent).toContain("my-new-gw");
  });

  it("0.3.13 #215: the create form's 协议 selector — default stays wire-less; picking Anthropic lands wire:anthropic in the create op", async () => {
    const h = mountedTab(REGISTRY);
    await act(async () => {
      btnByText(h.container, "＋ 添加供应商").click();
    });
    const form = detailPanel(h.container);
    const wire = form.querySelector("select.add-wire") as HTMLSelectElement;
    expect(wire.value).toBe(""); // OpenAI 兼容(默认) = absence
    await act(async () => {
      type(form.querySelector("input.add-id") as HTMLInputElement, "ant-gw");
      type(form.querySelector("input.add-baseurl") as HTMLInputElement, "https://ant.example.com");
      wire.value = "anthropic";
      wire.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      btnByText(form, "创建").click();
    });
    const op = opsOf(h.server).find((o) => o.op.op === "settingsSaveProvider");
    expect(op?.op.config).toEqual({
      baseUrl: "https://ant.example.com",
      reasoningFormat: "none",
      wire: "anthropic",
      models: [],
    });
  });

  it("an EMPTY label never rides the create payload (the old form's guard)", async () => {
    const h = mountedTab(REGISTRY);
    await act(async () => {
      btnByText(h.container, "＋ 添加供应商").click();
    });
    const form = detailPanel(h.container);
    await act(async () => {
      type(form.querySelector("input.add-id") as HTMLInputElement, "bare-gw");
      type(form.querySelector("input.add-baseurl") as HTMLInputElement, "https://bare.example.com/v1");
    });
    await act(async () => {
      btnByText(form, "创建").click();
    });
    const op = opsOf(h.server).find((o) => o.op.op === "settingsSaveProvider");
    expect(op?.op.config).toEqual({ baseUrl: "https://bare.example.com/v1", reasoningFormat: "none", models: [] });
    expect(op?.op.config).not.toHaveProperty("label");
  });

  it("取消 (detail), ✕ 取消草稿 (card), and selecting a real card each drop the draft — no op ever fires", async () => {
    const h = mountedTab(REGISTRY);
    // The draft's create dialog is up (the ＋ opened the pvd modal on it).
    await act(async () => {
      btnByText(h.container, "＋ 添加供应商").click();
    });
    // (a) the form's 取消 drops the draft AND closes the dialog (0.3.38:
    // closing the create dialog IS its cancel — nothing was ever selected,
    // so no aria-current returns).
    await act(async () => {
      btnByText(detailPanel(h.container), "取消").click();
    });
    expect(h.container.querySelector('.provider-card[data-draft="true"]')).toBeNull();
    expect(h.container.querySelector(".pvd")).toBeNull();
    expect(h.container.querySelector(".provider-detail")).toBeNull();
    // (b) the draft card's own ✕ — same drop (the dialog closes with it:
    // draftNew false + nothing selected = nothing to show).
    await act(async () => {
      btnByText(h.container, "＋ 添加供应商").click();
    });
    const draft = h.container.querySelector('.provider-card[data-draft="true"]') as HTMLElement;
    await act(async () => {
      btnByText(draft, "✕ 取消草稿").click();
    });
    expect(h.container.querySelector('.provider-card[data-draft="true"]')).toBeNull();
    expect(h.container.querySelector(".pvd")).toBeNull();
    // (c) clicking a REAL card drops the draft and opens that card's detail.
    await act(async () => {
      btnByText(h.container, "＋ 添加供应商").click();
    });
    await selectCard(h, "my-gateway");
    expect(h.container.querySelector('.provider-card[data-draft="true"]')).toBeNull();
    expect(rowOf(h.container, "my-gateway").getAttribute("aria-current")).toBe("true");
    expect(detailPanel(h.container).textContent).toContain("my-gateway");
    // Nothing fired through the whole cancel tour.
    expect(opsOf(h.server).find((o) => o.op.op === "settingsSaveProvider")).toBeUndefined();
  });

  it("创建 stays disabled until BOTH id and baseUrl are non-empty (the old form's guard)", async () => {
    const h = mountedTab(REGISTRY);
    await act(async () => {
      btnByText(h.container, "＋ 添加供应商").click();
    });
    const form = detailPanel(h.container);
    expect(btnByText(form, "创建").disabled).toBe(true); // both empty
    await act(async () => {
      type(form.querySelector("input.add-id") as HTMLInputElement, "half-gw");
    });
    expect(btnByText(form, "创建").disabled).toBe(true); // baseUrl still empty
    await act(async () => {
      type(form.querySelector("input.add-baseurl") as HTMLInputElement, "https://half.example.com/v1");
    });
    expect(btnByText(form, "创建").disabled).toBe(false);
  });
});

// iter6 — the persona binding rides the CREATE form: NewProviderDetail wears
// the edit panel's 「Persona 绑定」row (same sentinels, same personaList
// fetch, same layer qualifier), and the three states ride the SAME create op
// (跟随全局 = the persona key ABSENT, a bound id (optionally `:layers`-
// qualified) = the spec string, 强制无 = explicit null) — no create-then-edit
// round-trip to bind a new provider.
describe("provider management iter6 — Persona 绑定 rides the create form", () => {
  // The personaList reply the create form's mount-time fetch awaits (the same
  // two-row fixture provider-detail's suite pins the wire contract with).
  const PERSONAS_REPLY = {
    personas: [
      { id: "deepseek-native", displayName: "DeepSeek Native", source: "builtin", layers: "headers+prompt", editable: false },
      { id: "alpha", displayName: "Alpha", source: "global", layers: "headers", editable: true },
    ],
  };

  /** Open the create form (the draft card leads) and answer its personaList. */
  const openCreateForm = async (): Promise<{ readonly h: ReturnType<typeof mountedTab>; readonly form: HTMLElement }> => {
    const h = mountedTab(REGISTRY);
    await act(async () => {
      btnByText(h.container, "＋ 添加供应商").click();
    });
    // replyTo targets the LAST personaList op — the create form's (the edit
    // panel's mount-time fetch, fired for the initially-selected deepseek,
    // may stay pending forever; its catch never runs).
    await replyTo(h.server, "personaList", PERSONAS_REPLY);
    return { h, form: detailPanel(h.container) };
  };

  /** Native select change (the suite's no-userEvent lane). */
  const setSel = (form: HTMLElement, className: string, value: string): void => {
    const sel = form.querySelector(`select.${className}`) as HTMLSelectElement;
    sel.value = value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  };

  it("the binding row lists personaList's rows between the two sentinels; 跟随全局 (default) keeps the persona key OFF the create payload", async () => {
    const { h, form } = await openCreateForm();
    const sel = form.querySelector("select.detail-persona") as HTMLSelectElement;
    expect([...sel.querySelectorAll("option")].map((o) => (o as HTMLOptionElement).value)).toEqual([
      "", "deepseek-native", "alpha", "::none",
    ]);
    expect(sel.value).toBe(""); // 跟随全局 — the draft starts unbound
    // The layer qualifier select rides alongside (the edit row's exactly).
    const layer = form.querySelector("select.detail-persona-layer") as HTMLSelectElement;
    expect([...layer.querySelectorAll("option")].map((o) => (o as HTMLOptionElement).value)).toEqual([
      "", "headers", "prompt", "headers+prompt",
    ]);
    // Create untouched → the payload carries NO persona key (absence IS the
    // follow-global choice, never a forced null).
    await act(async () => {
      type(form.querySelector("input.add-id") as HTMLInputElement, "follow-gw");
      type(form.querySelector("input.add-baseurl") as HTMLInputElement, "https://follow.example.com/v1");
      btnByText(form, "创建").click();
    });
    const op = opsOf(h.server).find((o) => o.op.op === "settingsSaveProvider");
    expect(op?.op.config).not.toHaveProperty("persona");
  });

  it("binding a persona composes the layer qualifier into the spec — 仅 headers rides as `<id>:headers`", async () => {
    const { h, form } = await openCreateForm();
    await act(async () => {
      type(form.querySelector("input.add-id") as HTMLInputElement, "bound-gw");
      type(form.querySelector("input.add-baseurl") as HTMLInputElement, "https://bound.example.com/v1");
      // Bind first (全部层 = the plain id), then narrow the layer — the edit
      // row's re-qualify lane.
      setSel(form, "detail-persona", "alpha");
      setSel(form, "detail-persona-layer", "headers");
      btnByText(form, "创建").click();
    });
    const op = opsOf(h.server).find((o) => o.op.op === "settingsSaveProvider");
    expect(op?.op.config).toMatchObject({ persona: "alpha:headers" });
  });

  it("a layer picked BEFORE the binding is remembered and composes onto the next binding pick", async () => {
    const { h, form } = await openCreateForm();
    await act(async () => {
      type(form.querySelector("input.add-id") as HTMLInputElement, "memory-gw");
      type(form.querySelector("input.add-baseurl") as HTMLInputElement, "https://memory.example.com/v1");
      // Layer first, persona second — the remembered choice applies.
      setSel(form, "detail-persona-layer", "prompt");
      setSel(form, "detail-persona", "alpha");
      btnByText(form, "创建").click();
    });
    const op = opsOf(h.server).find((o) => o.op.op === "settingsSaveProvider");
    expect(op?.op.config).toMatchObject({ persona: "alpha:prompt" });
  });

  it("强制无 rides the create payload as an explicit null", async () => {
    const { h, form } = await openCreateForm();
    await act(async () => {
      type(form.querySelector("input.add-id") as HTMLInputElement, "none-gw");
      type(form.querySelector("input.add-baseurl") as HTMLInputElement, "https://none.example.com/v1");
      setSel(form, "detail-persona", "::none");
      btnByText(form, "创建").click();
    });
    const op = opsOf(h.server).find((o) => o.op.op === "settingsSaveProvider");
    expect(op?.op.config).toMatchObject({ persona: null });
  });

  it("a layer picked with NOTHING bound never mints a persona key (it only remembers)", async () => {
    const { h, form } = await openCreateForm();
    await act(async () => {
      type(form.querySelector("input.add-id") as HTMLInputElement, "layerless-gw");
      type(form.querySelector("input.add-baseurl") as HTMLInputElement, "https://layerless.example.com/v1");
      setSel(form, "detail-persona-layer", "headers+prompt");
      btnByText(form, "创建").click();
    });
    const op = opsOf(h.server).find((o) => o.op.op === "settingsSaveProvider");
    expect(op?.op.config).not.toHaveProperty("persona");
  });
});

// ---------------------------------------------------------------------------
// fix round 1 (review-4 findings): F1's custom-payload echo pins live above
// (the two payload tests); below — the F3 默认徽标 pin, F4 unsaved-edit
// retention across an unrelated refresh, F6 pull dedupe, F9 mutual disable,
// and F7's per-row accessible names.
// ---------------------------------------------------------------------------

// The LIVE identity rides my-gateway/m-x while settings.current still says
// deepseek — the L5 rule (status.model wins) is what the 默认徽标 must hit.
const LIVE_DRIVER: DriverStatus = {
  ...DRIVER,
  model: {
    label: "m-x",
    provider: "my-gateway",
    choices: [{ provider: "my-gateway", model: "m-x", source: "registry" }],
  },
};

describe("fix round 1 — review-4 findings", () => {
  // ② 模型配置反馈 (2026-08-29) re-labeled the badge: the LIVE identity hit
  // wears 当前 (honest — the configured BOOT default wears 默认). F3's
  // substance — the hit rides status.model over settings.current — is
  // unchanged.
  it("F3: the model-row 当前 badge rides the LIVE identity hit (status.model wins over settings.current)", async () => {
    const h = mountedTab(REGISTRY, LIVE_DRIVER);
    await selectCard(h, "my-gateway");
    const badges = [...detailPanel(h.container).querySelectorAll(".model-row .model-badge.live")];
    expect(badges.length).toBe(1);
    expect(badges[0]?.textContent).toBe("当前");
    // Negative: with no live driver state, settings.current (deepseek) rules —
    // my-gateway's row carries NO live badge (and no 默认 either — the
    // fixture writes no boot default).
    const off = mountedTab(REGISTRY, null);
    await selectCard(off, "my-gateway");
    expect(detailPanel(off.container).querySelector(".model-row .model-badge.live")).toBeNull();
    expect(detailPanel(off.container).querySelector(".model-row .model-badge")).toBeNull();
  });

  it("F4: unsaved panel edits survive an unrelated refresh (a 设为默认 write, 0.3.24)", async () => {
    const h = mountedTab(REGISTRY);
    await selectCard(h, "my-gateway");
    await enterDetailEdit(h); // the label input only exists in the form
    await act(async () => {
      type(detailPanel(h.container).querySelector("input.detail-label-input") as HTMLInputElement, "Draft GW");
    });
    // The boot-default lane is genuinely UNRELATED to the drafts:
    // settingsSet model.defaultModel → refresh, never touching the registry
    // row the drafts edit. (Round 6 note: model-row edits no longer live in
    // the panel draft at all — they ride the modal's own draft world; the
    // F4 guard now protects the panel's FIELD drafts: label/baseUrl.)
    await act(async () => {
      // Round 5 D: the boot-default actuator is the ☆ star now.
      ([...detailPanel(h.container).querySelectorAll("button.model-star:not(:disabled)")][0] as HTMLButtonElement).click();
    });
    await replyTo(h.server, "settingsSet", { key: "", saved: true });
    expect(h.refresh).toHaveBeenCalled();
    await act(async () => {
      root?.render(
        <ProviderTab
          client={h.client}
          settings={{ ...REGISTRY, providers: REGISTRY.providers.map((c) => ({ ...c })) }}
          status={null}
          notify={h.notify}
          refresh={h.refresh}
        />,
      );
    });
    // The dirty edit is retained — the refresh did not silently revert it.
    expect((detailPanel(h.container).querySelector("input.detail-label-input") as HTMLInputElement).value).toBe("Draft GW");
    // …and a CLEAN panel still tracks the server: a fresh mount re-seeds.
    const fresh = mountedTab(REGISTRY);
    await selectCard(fresh, "my-gateway");
    await enterDetailEdit(fresh);
    expect((detailPanel(fresh.container).querySelector("input.detail-label-input") as HTMLInputElement).value).toBe("My Gateway");
  });

  // ④ 模型配置反馈 (2026-08-29) → round 6: F6's first-occurrence-wins dedup
  // lives at the DROPDOWN level now (the duplicate name renders one option,
  // carrying the first occurrence's window), and picking it appends one row.
  it("F6: a /models response listing a name twice renders ONE dropdown option (first occurrence wins)", async () => {
    const h = mountedTab(REGISTRY);
    await selectCard(h, "my-gateway");
    await act(async () => {
      btnByText(detailPanel(h.container), "配置模型").click();
    });
    await replyTo(h.server, "settingsListModels", {
      ok: true,
      models: [
        { name: "m-dup", contextLength: 128000 },
        { name: "m-dup", contextLength: 256000 },
      ],
    });
    const dlg = h.container.querySelector(".mcm") as HTMLElement;
    await act(async () => {
      (dlg.querySelector("button.mcm-drop-toggle") as HTMLButtonElement).click();
    });
    const opts = [...h.container.querySelectorAll(".mcm-opt")] as HTMLButtonElement[];
    expect(opts.length).toBe(1); // ONE option for the duplicate name
    expect(opts[0]?.textContent).toContain("128000"); // first occurrence wins
    await act(async () => {
      opts[0]?.click();
    });
    await act(async () => {
      btnByText(h.container.querySelector(".mcm") as HTMLElement, "添加").click();
    });
    const rows = [...h.container.querySelectorAll(".mcm-row")];
    expect(rows.length).toBe(2); // m-x + ONE m-dup
    expect((rows[1]?.querySelector("input[aria-label='模型名 m-dup']") as HTMLInputElement).value).toBe("m-dup");
    expect((rows[1]?.querySelector("input[aria-label='上下文 m-dup']") as HTMLInputElement).value).toBe("128000"); // first occurrence wins
  });

  // Round 6: the panel's pull/delete lanes are gone — the mutual exclusion
  // that remains is INSIDE the modal: the dropdown waits out the pull, and
  // 保存 waits out its own op. (The panel's 保存修改/删除供应商 stay usable
  // while the modal is open — two independent draft worlds, spec §2.)
  it("F9: inside the modal, the dropdown waits out the pull and 保存 waits out its own op", async () => {
    const h = mountedTab(REGISTRY);
    await selectCard(h, "my-gateway");
    await act(async () => {
      btnByText(detailPanel(h.container), "配置模型").click();
    });
    // The auto-pull is in flight → the dropdown toggle is disabled.
    let toggle = h.container.querySelector("button.mcm-drop-toggle") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    await replyTo(h.server, "settingsListModels", { ok: true, models: [] });
    toggle = h.container.querySelector("button.mcm-drop-toggle") as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    // And the save lane disables itself while IT is in flight.
    const dlg = h.container.querySelector(".mcm") as HTMLElement;
    await act(async () => {
      btnByText(dlg, "保存").click();
    });
    expect(btnByText(h.container.querySelector(".mcm") as HTMLElement, "保存").disabled).toBe(true);
    await replyTo(h.server, "settingsSaveProvider", { ok: true, provider: "my-gateway" });
    expect(h.container.querySelector(".mcm")).toBeNull(); // closed on success
  });

  it("F7: per-row accessible names in the modal — the row's model name rides every aria-label", async () => {
    const h = mountedTab(REGISTRY);
    await selectCard(h, "my-gateway");
    await act(async () => {
      btnByText(detailPanel(h.container), "配置模型").click();
    });
    await replyTo(h.server, "settingsListModels", { ok: true, models: [] });
    const dlg = h.container.querySelector(".mcm") as HTMLElement;
    await act(async () => {
      type(dlg.querySelector("input[aria-label='模型名称']") as HTMLInputElement, "m-two");
    });
    await act(async () => {
      btnByText(dlg, "添加").click();
    });
    const rows = [...h.container.querySelectorAll(".mcm-row")];
    expect(rows.length).toBe(2);
    // The registry row names the model; a row whose name gets CLEARED falls
    // back to its row number — never two inputs sharing one accessible name.
    expect((rows[0]?.querySelector("input[aria-label='模型名 m-x']") as HTMLInputElement).getAttribute("aria-label")).toContain("m-x");
    expect((rows[0]?.querySelector("input[aria-label='上下文 m-x']") as HTMLInputElement).getAttribute("aria-label")).toContain("m-x");
    expect(rows[0]?.querySelector("button[aria-label='删除模型 m-x']")).toBeTruthy();
    await act(async () => {
      type(rows[1]?.querySelector("input[aria-label='模型名 m-two']") as HTMLInputElement, "");
    });
    const cleared = [...h.container.querySelectorAll(".mcm-row")][1] as HTMLElement;
    expect((cleared.querySelector("input[aria-label^='模型名 第']") as HTMLInputElement).getAttribute("aria-label")).toContain("2");
    expect((cleared.querySelector("input[aria-label^='上下文 第']") as HTMLInputElement).getAttribute("aria-label")).toContain("2");
    expect(cleared.querySelector("button[aria-label^='删除模型 第']")?.getAttribute("aria-label")).toContain("2");
  });
});

// ---------------------------------------------------------------------------
// round 5 (2026-08-30 spec) — 全局「默认模型 / 推理档」上移:the bottom
// settings-section is GONE; a compact strip under the toolbar carries the
// boot default + effort chips, visible without scrolling (用户: 太靠下了,
// 不翻下来根本看不到).
// ---------------------------------------------------------------------------

describe("round 5 — 默认模型/推理档全局条:两步退场", () => {
  it("the strip is GONE (0.3.26 ① effort row → 0.3.31 ② 默认模型 row); the tab keeps its one section title", () => {
    const h = mountedTab(STATUS);
    // 0.3.31 ② (用户:默认 deepseek/deepseek-v4-flash 也去掉): the strip's
    // LAST row is deleted — with 0.3.26 ① having taken the effort row, the
    // strip itself is gone. The setting lives on in the detail pane only
    // (☆ 设为默认 + the row-level 默认 badge).
    expect(h.container.querySelector(".global-defaults")).toBeNull();
    // The 供应商 section title is the ONLY section title left on the tab.
    expect([...h.container.querySelectorAll(".set-title")].map((t) => t.textContent)).toEqual(["供应商"]);
    // Neither strip text state renders anywhere on the tab anymore.
    expect(h.container.textContent).not.toContain("默认模型未设置");
  });

  it("a written boot default no longer renders the strip's 默认 <provider>/<model> line", () => {
    const h = mountedTab({ ...STATUS, defaultModel: { provider: "deepseek", model: "deepseek-v4-flash" } });
    expect(h.container.querySelector(".global-defaults")).toBeNull();
    // The joined strip text is gone; the per-card 默认 tag (the CURRENT
    // provider mark, a different thing) may still render on its own.
    expect(h.container.textContent).not.toContain("默认 deepseek/deepseek-v4-flash");
  });

  it("round 5 master cards carry the model-count line (卡内高度与详情对齐的一部分)", () => {
    const h = mountedTab(STATUS, DRIVER);
    const deepseek = card(h.container, "deepseek");
    expect(deepseek.querySelector(".card-model-count")?.textContent).toContain("2");
  });
});

// ω99-305 (弹层 Esc 可达性): the pvd dialog owns focus on open — the family
// idiom (ref + tabIndex -1 + a focus effect on detailOpen). Without it a
// card click leaves focus under the scrim and the card's element-level Esc
// is dead; with it, Esc reaches the handler from the very first press.
describe("ω99-305 — the pvd dialog owns focus on open (Esc reachability)", () => {
  it("a card click focuses the dialog card, and Esc closes it", async () => {
    const h = await mountedTab();
    await selectCard(h, "deepseek");
    const card = h.container.querySelector(".modal-card.pvd");
    expect(card).not.toBeNull();
    expect(document.activeElement).toBe(card);
    act(() => {
      card?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(h.container.querySelector(".scrim")).toBeNull();
  });
});
