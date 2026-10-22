// @vitest-environment jsdom
// M63 §B — the settings page: the provider-card matrix renders with the
// right status dots, key save goes through the WS op and NEVER reads the key
// back, 测试连接 renders the three human failure states, the shield selector
// drives setMode, and the preference toggles drive settingsSet. All op
// traffic runs over the in-memory fake WS (the fetch happens server-side —
// the page only renders the returned status).
// T12 墨线: the shell re-skinned — 左导航(.sb-i 复用) + 表单控件统一(.ctl)。
import { afterEach, describe, expect, it, vi } from "vitest";
import { stylesCss } from "./styles-source.js";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WudaoClient } from "../src/protocol.js";
import type { DriverStatus, SettingsStatus } from "../src/protocol.js";
import { App } from "../src/components/App.js";
import { SettingsPage } from "../src/components/SettingsPage.js";
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
  window.localStorage.removeItem("wudao.ui.v1"); // ui-review-r3 P2: reset the persisted layout between tests
});

const STATUS: SettingsStatus = {
  providers: [
    // 0.3.24 round 4: the model chips row is gone — the detail's model TABLE
    // is the only per-model surface, so the fixture rows carry the profile
    // defaults the tests expect to see in the panel.
    { provider: "deepseek", label: "deepseek", status: "ready", keySource: "env", endpoint: "https://api.deepseek.com", defaultModel: "deepseek-v4-flash", custom: false, models: [{ name: "deepseek-v4-flash" }] },
    { provider: "glm", label: "glm", status: "missing-key", keySource: null, endpoint: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4.6", custom: false, models: [{ name: "glm-4.6" }] },
    { provider: "qwen", label: "qwen", status: "ready", keySource: "credentials", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen3-max", custom: false, models: []},
    { provider: "wudao", label: "wudao", status: "missing-endpoint", keySource: "credentials", endpoint: null, defaultModel: "wudao-preview", custom: false, models: []},
  ],
  credentials: { path: "/home/u/.wudao/.credentials.yaml", keyCount: 2 },
  settings: { memoryEnabled: true, uiDefaultMode: "simple", wizardCompletedVersion: 1, uiTheme: null, uiAccent: null },
  current: { provider: "deepseek", model: "deepseek-v4-flash", effort: "high" },
  envKey: true,
  readiness: true,
  efforts: ["low", "medium", "high", "max", "none"],
};

interface Harness {
  container: HTMLElement;
  client: WudaoClient;
  server: FakeServer;
}

function connectedClient(server: FakeServer): WudaoClient {
  const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
  act(() => {
    client.connect();
    server.socket.serverOpen();
  });
  // The post-auth state frame flips the client to "connected" — setMode and
  // the ops only send on a live authenticated socket.
  act(() => {
    authOk(server.socket);
  });
  return client;
}

function opsOf(server: FakeServer): { id: number; op: Record<string, unknown> }[] {
  return server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } =>
    typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>),
  ) as { id: number; op: Record<string, unknown> }[];
}

/** Mount the page with a connected client and answer its initial
 *  settingsStatus (and any connected-effect listSlashCommands). */
async function mountedPage(opts?: { readonly pendingAsk?: boolean }): Promise<Harness> {
  const server = fakeServer();
  const client = connectedClient(server);
  const container = mount(<SettingsPage client={client} status={null} onClose={() => {}} pendingAsk={opts?.pendingAsk ?? false} />);
  await act(async () => {
    const statusOp = opsOf(server).find((o) => o.op.op === "settingsStatus");
    server.socket.serverSend({ t: "result", id: statusOp?.id, ok: STATUS });
  });
  return { container, client, server };
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

/** iter3 (strict master-detail): the selected card's detail panel — the ONLY
 *  place the key input, 测试连接, and the model chips render now. */
const detailPanel = (c: HTMLElement): HTMLElement => {
  const el = c.querySelector(".provider-detail");
  if (!(el instanceof HTMLElement)) throw new Error("detail panel missing");
  return el;
};

/** Select a provider card (its head button) — the detail follows. */
const selectProvider = async (c: HTMLElement, provider: string): Promise<void> => {
  await act(async () => {
    (card(c, provider).querySelector(".card-name") as HTMLButtonElement).click();
  });
};

/** round 5 A (契约反转): the detail opens in READ mode — enter its edit
 *  form, the single door to the config surface the form tests exercise. */
const enterEdit = async (c: HTMLElement): Promise<void> => {
  await act(async () => {
    btnByText(detailPanel(c), "编辑").click();
  });
};

/** round 6: the round-5 expansion card is gone — 使用 / ☆ sit directly on
 *  the one-line read row. */
const modelRow = (c: HTMLElement, name: string): HTMLElement => {
  const row = [...c.querySelectorAll(".model-row")].find((n) => n.querySelector(".model-row-name")?.textContent === name);
  if (!(row instanceof HTMLElement)) throw new Error(`model row ${name} missing`);
  return row;
};

const btnByText = (scope: HTMLElement, text: string): HTMLButtonElement => {
  const b = [...scope.querySelectorAll("button")].find((x) => x.textContent === text);
  if (b === undefined) throw new Error(`button "${text}" missing`);
  return b as HTMLButtonElement;
};

/** settings-split: open a non-provider tab (the shell mounts ONLY the active
 *  panel, so a section's assertions route through its tab first; the provider
 *  tab is the default and needs no click). */
const openTab = async (c: HTMLElement, id: "permissions" | "appearance" | "preferences" | "plugins"): Promise<void> => {
  await act(async () => {
    (c.querySelector(`button[data-settings-tab='${id}']`) as HTMLButtonElement).click();
  });
};

describe("the provider-card matrix", () => {
  it("renders all four cards with the correct status dots, key sources, and the default badge", async () => {
    const h = await mountedPage();
    const cards = [...h.container.querySelectorAll(".provider-card")] as HTMLElement[];
    expect(cards.length).toBe(4);
    expect(card(h.container, "deepseek").getAttribute("data-status")).toBe("ready");
    expect(card(h.container, "deepseek").querySelector(".dot")?.className).toContain("ready");
    expect(card(h.container, "glm").getAttribute("data-status")).toBe("missing-key");
    expect(card(h.container, "qwen").getAttribute("data-status")).toBe("ready");
    expect(card(h.container, "wudao").getAttribute("data-status")).toBe("missing-endpoint");
    // The human status words + the custom-endpoint labeling.
    expect(card(h.container, "glm").textContent).toContain("缺 Key");
    expect(card(h.container, "wudao").textContent).toContain("兼容端点");
    expect(card(h.container, "wudao").textContent).toContain("缺端点");
    // Default badge + key badges (iter3: 已配/未配 off the wire keySource).
    expect(card(h.container, "deepseek").textContent).toContain("默认");
    expect(card(h.container, "deepseek").textContent).toContain("已配 · 环境变量");
    expect(card(h.container, "qwen").textContent).toContain("已配 · 凭据文件");
    expect(card(h.container, "glm").textContent).toContain("未配 Key");
    // Model lists ride the SELECTED card's detail TABLE (round 4: the chips
    // row is gone; round 5: the read-mode rows carry the name as text, so
    // textContent is the assertion again). 0.3.38: the detail is the pvd
    // MODAL — nothing auto-selects on load, so deepseek is OPENED, then glm
    // after its selection.
    const rowNames = (c: HTMLElement): string[] =>
      [...detailPanel(c).querySelectorAll(".model-row .model-row-name")].map((n): string => n.textContent ?? "");
    await selectProvider(h.container, "deepseek");
    expect(rowNames(h.container)).toContain("deepseek-v4-flash");
    await selectProvider(h.container, "glm");
    expect(rowNames(h.container)).toContain("glm-4.6");
    // env-wins note + the credentials COUNT (never a value).
    expect(h.container.textContent).toContain("环境变量优先于凭据文件");
    expect(h.container.textContent).toContain("现有 2 个 Key");
  });

  it("no key material ever renders (the status payload carries none by contract)", async () => {
    const h = await mountedPage();
    // round 5 A (契约反转): read mode carries ZERO inputs — the paste box
    // only exists once the 编辑 door opens. 0.3.38: the detail is the pvd
    // MODAL — deepseek is OPENED first (nothing auto-selects on load).
    expect(h.container.querySelector("input[type=password]")).toBeNull();
    await selectProvider(h.container, "deepseek");
    await enterEdit(h.container);
    const allInputs = [...h.container.querySelectorAll("input[type=password]")] as HTMLInputElement[];
    expect(allInputs.length).toBeGreaterThan(0); // the detail's paste box exists
    for (const i of allInputs) expect(i.value).toBe(""); // start empty
    expect(h.container.textContent).not.toMatch(/sk-/);
  });
});

describe("key management", () => {
  it("保存 sends the settingsSaveKey op; the receipt shows the status and the input clears", async () => {
    const h = await mountedPage();
    await selectProvider(h.container, "glm");
    await enterEdit(h.container); // round 5 契约反转: the paste box lives behind 编辑
    const input = detailPanel(h.container).querySelector("input.key-input") as HTMLInputElement;
    await act(async () => {
      type(input, "sk-paste-me");
    });
    await act(async () => {
      btnByText(detailPanel(h.container), "保存修改").click();
    });
    const op = opsOf(h.server).find((o) => o.op.op === "settingsSaveKey");
    expect(op?.op).toMatchObject({ provider: "glm", key: "sk-paste-me" });
    await replyTo(h.server, "settingsSaveProvider", { ok: true, provider: "glm" });
    await replyTo(h.server, "settingsSaveKey", { provider: "glm", saved: true, keyCount: 3 });
    expect(h.container.textContent).toContain("已保存 glm 的 Key");
    expect(h.container.textContent).toContain("凭据文件现有 3 个");
    // round 5 A: save success EXITS edit (back to read) — the paste box is
    // gone entirely, so nothing retains the key client-side.
    expect(detailPanel(h.container).querySelector("input.key-input")).toBeNull();
    expect(h.container.textContent).not.toContain("sk-paste-me");
  });

  it("测试连接 renders the three human failure states from the op's status reply", async () => {
    const h = await mountedPage();
    const cases: readonly { provider: string; reply: unknown; expectText: string }[] = [
      { provider: "glm", reply: { ok: false, state: "auth", message: "Key 无效或无余额——检查是否复制完整、账户是否有余额" }, expectText: "Key 无效或无余额" },
      { provider: "qwen", reply: { ok: false, state: "network", message: "网络不通——检查网络或稍后再试" }, expectText: "网络不通" },
      { provider: "deepseek", reply: { ok: false, state: "model", message: "模型名不存在——试试推荐模型" }, expectText: "模型名不存在" },
    ];
    for (const c of cases) {
      // iter3: the test lane lives in the SELECTED card's detail.
      await selectProvider(h.container, c.provider);
      await act(async () => {
        btnByText(detailPanel(h.container), "测试连接").click();
      });
      const op = opsOf(h.server).find((o) => o.op.op === "settingsTestConnection" && o.op.provider === c.provider);
      expect(op).toBeDefined();
      await replyTo(h.server, "settingsTestConnection", c.reply);
      const result = detailPanel(h.container).querySelector(".test-result");
      expect(result?.getAttribute("data-state")).toBe((c.reply as { state: string }).state);
      expect(result?.textContent).toContain(c.expectText);
    }
    // And the success state.
    await selectProvider(h.container, "deepseek");
    await act(async () => {
      btnByText(detailPanel(h.container), "测试连接").click();
    });
    await replyTo(h.server, "settingsTestConnection", { ok: true, state: "ok", message: "连接成功" });
    expect(detailPanel(h.container).querySelector(".test-result")?.textContent).toContain("连接成功");
  });

  it("a pasted key rides the test op (unsaved-paste testing, the wizard flow)", async () => {
    const h = await mountedPage();
    await selectProvider(h.container, "glm");
    await enterEdit(h.container); // round 5 契约反转: the paste box lives behind 编辑
    const input = detailPanel(h.container).querySelector("input.key-input") as HTMLInputElement;
    await act(async () => {
      type(input, "sk-unsaved");
    });
    await act(async () => {
      btnByText(detailPanel(h.container), "测试连接").click();
    });
    const op = opsOf(h.server).find((o) => o.op.op === "settingsTestConnection");
    expect(op?.op).toMatchObject({ provider: "glm", key: "sk-unsaved" });
  });
});

describe("defaults, shields, and preferences", () => {
  it("the model table carries no chips (round 4); the strip carries no effort row (0.3.26 ①)", async () => {
    const h = await mountedPage();
    // The chips row is gone (0.3.24 round 4 — the table showed every model
    // twice); the current-model disabled no-op lives on the 使用 lane, pinned
    // in provider-detail.test.tsx. 0.3.38: OPEN deepseek's detail modal first
    // (nothing auto-selects on load).
    await selectProvider(h.container, "deepseek");
    expect(detailPanel(h.container).querySelectorAll(".model-chip").length).toBe(0);
    // 0.3.26 ① deleted the strip's effort row; 0.3.31 ② (用户:默认
    // deepseek/… 也去掉) its 默认模型 row — the strip itself is GONE. The
    // boot-default setting lives on in the detail pane (☆ 设为默认 + the
    // row-level 默认 badge); the effort entry points live on the composer /
    // 偏好 tab / /effort command, none orphaned.
    expect(h.container.querySelectorAll(".global-defaults").length).toBe(0);
  });

  it("0.3.11: the permissions tab binds the PERSISTED default (settingsSet permissions.defaultMode), never setMode", async () => {
    const h = await mountedPage();
    await openTab(h.container, "permissions");
    // M64-visual §2: the chip opens the tier menu (the row of tiers is gone).
    await act(async () => {
      (h.container.querySelector(".pop .chip") as HTMLButtonElement).click();
    });
    const items = [...h.container.querySelectorAll(".pop .mi")] as HTMLButtonElement[];
    expect(items.map((m) => m.getAttribute("data-mode"))).toEqual(["ask", "workspace", "auto", "plan"]);
    await act(async () => {
      items[1]?.click(); // accept → workspace
    });
    const setOp = opsOf(h.server).find((o) => o.op.op === "settingsSet" && o.op.key === "permissions.defaultMode");
    expect(setOp?.op).toMatchObject({ value: "workspace" });
    expect(opsOf(h.server).some((o) => o.op.op === "setMode")).toBe(false);
    // The risky tier commits only on the second (confirm) click — component
    // tests cover the full arming; here one click must send nothing.
    await act(async () => {
      (h.container.querySelector(".pop .chip") as HTMLButtonElement).click();
    });
    await act(async () => {
      (h.container.querySelector(".pop .mi[data-mode='auto']") as HTMLButtonElement).click();
    });
    const setOps = opsOf(h.server).filter((o) => o.op.op === "settingsSet" && o.op.key === "permissions.defaultMode");
    expect(setOps.length).toBe(1);
  });

  it("the memory toggle and the 简洁/高级 default both write through settingsSet", async () => {
    const h = await mountedPage();
    await openTab(h.container, "preferences");
    const memory = h.container.querySelector(".setrow input[type=checkbox]") as HTMLInputElement;
    expect(memory.checked).toBe(true);
    await act(async () => {
      memory.click();
    });
    let op = opsOf(h.server).find((o) => o.op.op === "settingsSet");
    expect(op?.op).toMatchObject({ key: "memoryEnabled", value: false });
    await replyTo(h.server, "settingsSet", { key: "memoryEnabled", saved: true });
    expect(h.container.textContent).toContain("记忆已关闭");
    const advanced = btnByText(h.container, "高级模式");
    await act(async () => {
      advanced.click();
    });
    op = opsOf(h.server).filter((o) => o.op.op === "settingsSet").pop();
    expect(op?.op).toMatchObject({ key: "ui.defaultMode", value: "advanced" });
    await replyTo(h.server, "settingsSet", { key: "ui.defaultMode", saved: true });
    // ui-review-r2 I8: the receipt now tells the truth — the write flips the
    // live shell immediately (重载后完全生效 is the panel/polish residue).
    expect(h.container.textContent).toContain("高级模式 —— 已切换,重载后完全生效");
  });
});

describe("App wiring (M63 §B)", () => {
  const MODEL_STATUS = {
    model: {
      label: "deepseek-v4-flash",
      provider: "deepseek",
      choices: [
        { provider: "deepseek", model: "deepseek-v4-flash", source: "profile" },
        { provider: "glm", model: "glm-4.6", source: "profile" },
      ],
    },
  };

  it("the header 设置 button swaps the chat surface for the settings page; 返回 restores it", async () => {
    const server = fakeServer();
    const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
    const container = mount(<App client={client} />);
    act(() => {
      client.connect();
      server.socket.serverOpen();
    });
    await act(async () => {
      // T9 墨线: the topbar's .tb-name now carries the FIRST user move's
      // first line shell-wide (it stays visible above the settings page), so
      // the chat-swap sentinel needs a second turn the name never surfaces.
      authOk(server.socket, MODEL_STATUS, [
        { kind: "user", text: "the first move" },
        { kind: "user", text: "old turn" },
      ]);
    });
    await act(async () => {
      const ops = opsOf(server).map((o) => o); // answer listSlashCommands
      server.socket.serverSend({ t: "result", id: ops[0]?.id, ok: [] });
    });
    expect(container.textContent).toContain("old turn");
    await act(async () => {
      // M64-visual §4: the 设置 entry is the topbar's ⚙ icon button now.
      (container.querySelector(".topbar button[aria-label='设置']") as HTMLButtonElement).click();
    });
    // The page asked for its status on open — answer it.
    await act(async () => {
      const statusOp = opsOf(server).find((o) => o.op.op === "settingsStatus");
      server.socket.serverSend({ t: "result", id: statusOp?.id, ok: STATUS });
    });
    expect(container.querySelector(".settings-page")).not.toBeNull();
    expect(container.querySelector(".chat")).toBeNull(); // chat hidden while open
    expect(container.textContent).not.toContain("old turn");
    await act(async () => {
      (container.querySelector(".settings-head button") as HTMLButtonElement).click();
    });
    expect(container.querySelector(".settings-page")).toBeNull();
    expect(container.textContent).toContain("old turn");
  });

  it("model chips ride the driver's /model matrix (same-provider switch from the page)", async () => {
    const h = await mountedPage();
    // Re-mount with a status carrying a second same-provider model ROW (round
    // 4: the table's 使用 lane is the switch surface — the model must be a
    // registry row, not a driver choice alone).
    const server = fakeServer();
    const client = connectedClient(server);
    const status = {
      ...STATUS,
      providers: STATUS.providers.map((p) =>
        p.provider === "deepseek"
          ? { ...p, models: [{ name: "deepseek-v4-flash" }, { name: "deepseek-r2" }] }
          : p,
      ),
    } as SettingsStatus;
    const driverStatus = {
      live: { reasoning: "", answer: "", busyTools: [] },
      busy: false, queued: [], boardProgress: null, ctxTokens: null, mode: "workspace",
      cachePercent: null, bg: { active: 0, spawned: 0 }, pendingPermission: null, planBoard: null,
      sessionId: "wudao-t", sidecar: null,
      model: { label: "deepseek-v4-flash", provider: "deepseek", choices: [
        { provider: "deepseek", model: "deepseek-v4-flash", source: "profile" },
        { provider: "deepseek", model: "deepseek-r2", source: "profile" },
      ] },
    } as DriverStatus;
    const container = mount(<SettingsPage client={client} status={driverStatus} onClose={() => {}} />);
    await act(async () => {
      const op = opsOf(server).find((o) => o.op.op === "settingsStatus");
      server.socket.serverSend({ t: "result", id: op?.id, ok: status });
    });
    // 0.3.38: OPEN deepseek's detail modal first (nothing auto-selects).
    await selectProvider(container, "deepseek");
    // round 6: 使用 sits ON the read row (the expansion card is gone).
    expect(modelRow(container, "deepseek-r2").textContent).toContain("deepseek-r2");
    const use = [...container.querySelectorAll("button.model-use")].find(
      (b) => b.getAttribute("aria-label") === "切换到 deepseek-r2",
    ) as HTMLButtonElement;
    expect(use).toBeDefined();
    expect(use.disabled).toBe(false);
    await act(async () => {
      use.click();
    });
    const submitOp = opsOf(server).find((o) => o.op.op === "submit");
    expect(submitOp?.op).toMatchObject({ text: "/model deepseek-r2" });
  });

  // ui-review-r5 I2: the settings surface and the StatusBar picker told
  // opposite stories — the picker switched cross-provider in-session (/provider,
  // M63 §A) while the settings rows sat disabled behind a 「重启并指定
  // --provider」 myth. The 使用 lane rides the SAME modelPickCommand lanes.
  it("r5-I2: a CROSS-provider 使用 submits /provider (the picker's lane), enabled, with no restart copy anywhere", async () => {
    const server = fakeServer();
    const client = connectedClient(server);
    // The session runs deepseek; the glm card's default (glm-4.6) is a
    // cross-provider row.
    const status = {
      ...STATUS,
      providers: STATUS.providers.map((p) =>
        p.provider === "glm" ? { ...p, models: [{ name: "glm-4.6" }] } : p,
      ),
    } as SettingsStatus;
    const driverStatus = {
      live: { reasoning: "", answer: "", busyTools: [] },
      busy: false, queued: [], boardProgress: null, ctxTokens: null, mode: "workspace",
      cachePercent: null, bg: { active: 0, spawned: 0 }, pendingPermission: null, planBoard: null,
      sessionId: "wudao-t", sidecar: null,
      model: { label: "deepseek-v4-flash", provider: "deepseek", choices: [
        { provider: "deepseek", model: "deepseek-v4-flash", source: "profile" },
      ] },
    } as DriverStatus;
    const container = mount(<SettingsPage client={client} status={driverStatus} onClose={() => {}} />);
    await act(async () => {
      const op = opsOf(server).find((o) => o.op.op === "settingsStatus");
      server.socket.serverSend({ t: "result", id: op?.id, ok: status });
    });
    // iter3: glm's rows render in its DETAIL — select the card first.
    await selectProvider(container, "glm");
    // round 6: 使用 rides the one-line read row directly.
    expect(modelRow(container, "glm-4.6")).toBeTruthy();
    const glmUse = [...container.querySelectorAll("button.model-use")].find(
      (b) => b.getAttribute("aria-label") === "切换到 glm-4.6",
    ) as HTMLButtonElement;
    expect(glmUse).toBeDefined();
    expect(glmUse.disabled).toBe(false); // clickable — the endpoint switch is in-session
    expect(glmUse.title).toContain("/provider glm"); // the lane it rides, named
    await act(async () => {
      glmUse.click();
    });
    const submitOp = opsOf(server).find((o) => o.op.op === "submit");
    expect(submitOp?.op).toMatchObject({ text: "/provider glm" });
    // The receipt names the endpoint switch (and its fully cold cache).
    await replyTo(server, "submit", "started");
    expect(container.textContent).toContain("供应商 → glm"); // ω99-310: 称谓随设置面统一
    // No restart-myth copy anywhere on the page.
    expect(container.textContent).not.toContain("重启");
  });
});

// Review L5 — the page's identity badge follows the LIVE driver model, not
// the env-derived settingsStatus.current (under `wudao ui --provider glm`
// the env still names deepseek; the session runs glm).
describe("live identity wins over env-derived (review L5)", () => {
  it("the 默认 badge lands on the driver's provider when status.model exists", async () => {
    const server = fakeServer();
    const client = connectedClient(server);
    const driverStatus = {
      live: { reasoning: "", answer: "", busyTools: [] },
      busy: false, queued: [], boardProgress: null, ctxTokens: null, mode: "workspace",
      cachePercent: null, bg: { active: 0, spawned: 0 }, pendingPermission: null, planBoard: null,
      sessionId: "wudao-t", sidecar: null,
      model: { label: "glm-4.6", provider: "glm", choices: [{ provider: "glm", model: "glm-4.6", source: "profile" }] },
    } as DriverStatus;
    const container = mount(<SettingsPage client={client} status={driverStatus} onClose={() => {}} />);
    await act(async () => {
      const op = opsOf(server).find((o) => o.op.op === "settingsStatus");
      // settingsStatus.current says deepseek (env-derived default) — the
      // live driver says glm.
      server.socket.serverSend({ t: "result", id: op?.id, ok: STATUS });
    });
    const glmCard = card(container, "glm");
    const dsCard = card(container, "deepseek");
    expect(glmCard.textContent).toContain("默认");
    expect(dsCard.textContent).not.toContain("默认");
    // 0.3.31 ②: the strip that once carried the current-identity line in
    // its title is GONE — the card-level 默认 tag above IS the current-
    // identity mark now.
    expect(container.querySelectorAll(".global-defaults").length).toBe(0);
  });
});

// R6 quickwin 的 Ctrl+S 手势随 0.3.26 ①(供应商页默认推理强度条删除)一并退场:
// 会话内切换走 composer EffortSelector(/effort lane),默认档持久化走偏好 tab
// (settingsSet model.defaultEffort,preferences-tab 套件已钉)。0.3.31 ②(用户:
// 默认 deepseek/deepseek-v4-flash 也去掉)删掉了 strip 最后一行——strip 本体
// 退场;boot 默认模型的设置/回显只在详情面板(☆ 设为默认 + 行级 默认 badge)。
describe("global-defaults strip: retired (0.3.31 ②)", () => {
  it("the strip never renders, written default or not — the joined 默认 <p>/<m> text exists nowhere", async () => {
    const h = await mountedPage();
    expect(h.container.querySelectorAll(".global-defaults").length).toBe(0);
    expect(h.container.textContent).not.toContain("默认模型未设置");
    // A status reply carrying stored defaults surfaces them nowhere on the
    // strip lane (the detail badge is that setting's surface now).
    const server = fakeServer();
    const client = connectedClient(server);
    const container = mount(<SettingsPage client={client} status={null} onClose={() => {}} />);
    await act(async () => {
      const statusOp = opsOf(server).find((o) => o.op.op === "settingsStatus");
      server.socket.serverSend({
        t: "result",
        id: statusOp?.id,
        ok: { ...STATUS, defaultModel: { provider: "deepseek", model: "deepseek-v4-flash" }, defaultEffort: "high" },
      });
    });
    expect(container.querySelectorAll(".global-defaults").length).toBe(0);
    expect(container.textContent).not.toContain("默认 deepseek/deepseek-v4-flash");
  });
});

// —— T12 墨线 — the settings shell: 左导航 + 表单控件统一 ——
// The tab mechanism / a11y tabpanel semantics are UNTOUCHED (the
// settings-tabpanel-a11y suite is the regression net); this pins only the
// new visual container: .set > .set-nav (the tab pair riding the SIDEBAR's
// .sb-i row language) + .set-body > .set-sec(h3.set-title) + the shared
// 28px .ctl base + the 三选 pickers on the T7 .chip language.
describe("T12 墨线 — the settings page shell (left nav + .ctl)", () => {
  it("settings: left nav reuses sidebar item language (.sb-i)", async () => {
    const h = await mountedPage();
    expect(h.container.querySelector(".set")).toBeTruthy(); // the flex shell
    const on = h.container.querySelector(".set-nav .sb-i.on");
    expect(on).toBeTruthy(); // the selected nav row
    expect(on?.getAttribute("role")).toBe("tab"); // the tab contract rides the row
    expect(on?.getAttribute("data-settings-tab")).toBe("provider"); // 供应商 selected on load
    // settings-split + persona-settings T6 + MCP visibility: the nav carries
    // the SEVEN rows (spec §2's order, persona and mcp between preferences
    // and plugins).
    expect(
      [...h.container.querySelectorAll(".set-nav [data-settings-tab]")].map((n): string => n.getAttribute("data-settings-tab") ?? ""),
    ).toEqual(["provider", "permissions", "appearance", "preferences", "persona", "mcp", "plugins"]);
    expect(h.container.querySelector(".set-nav [data-settings-tab='plugins'].sb-i")).toBeTruthy();
  });

  it("the right column stacks .set-sec sections under h3.set-title (per tab)", async () => {
    const h = await mountedPage();
    expect(h.container.querySelector(".set-body[role='tabpanel']")).toBeTruthy();
    const titles = (): string[] => [...h.container.querySelectorAll(".set-sec > h3.set-title")].map((n): string => n.textContent ?? "");
    // round 5 E: the bottom 默认模型/推理档 section is GONE — the defaults
    // ride the strip under the toolbar (one section, no scrolling hunt).
    expect(titles()).toEqual(["供应商"]);
    await openTab(h.container, "permissions");
    expect(titles()).toEqual(["权限档(新会话默认)"]);
    await openTab(h.container, "appearance");
    expect(titles()).toEqual(["外观"]);
    await openTab(h.container, "preferences");
    expect(titles()).toEqual(["偏好"]);
  });

  it("form controls share the .ctl base; the 三选 pickers ride .chip.pick", async () => {
    const h = await mountedPage();
    // The DETAIL's key paste box and its buttons carry the base (iter3: the
    // keyrow lives in the detail). 0.3.12: the keyrow's own save button is
    // GONE — the single 保存修改 owns the commit. round 5 契约反转: those
    // controls live behind the 编辑 door; 0.3.38: the detail is the pvd
    // MODAL — deepseek is OPENED (nothing auto-selects on load).
    await selectProvider(h.container, "deepseek");
    await enterEdit(h.container);
    expect(detailPanel(h.container).querySelector("input.key-input")?.className).toContain("ctl");
    expect(btnByText(detailPanel(h.container), "保存修改").className).toContain("ctl");
    expect(btnByText(detailPanel(h.container), "测试连接").className).toContain("ctl");
    await openTab(h.container, "appearance");
    // 120 弧「选择语言」：三选芯片 → .seg 分段选择（凹槽+浮起药丸）——
    // 选中的 LIVE pick 带 .on。
    expect(h.container.querySelector("[data-appearance-theme='dark']")?.className).toContain("segctl-opt");
    expect(h.container.querySelector("[data-appearance-theme='dark']")?.className).toContain("on");
    expect(h.container.querySelector("[data-appearance-theme='light']")?.className).not.toContain("on");
    expect(h.container.querySelector("[data-appearance-accent='green']")?.className).toContain("on");
    expect(h.container.querySelector("[data-appearance-accent='blue']")?.className).not.toContain("on");
  });

  it("form controls share the .ctl 28px base (css pin)", () => {
    const css = stylesCss; // ?raw — the jsdom suite's file-read seam (shell-visual)
    expect(css).toMatch(/\.ctl\s*{[^}]*height:\s*28px[^}]*var\(--radius-sm\)/s);
    expect(css).toMatch(/\.set-title\s*{[^}]*var\(--fs-title\)[^}]*600/s);
    // The shell geometry + rhythm, pinned off the raw sheet — jsdom/cssstyle
    // drops var()-bearing shorthands through the CSSOM (T10/T11 seam).
    expect(css).toMatch(/\.set\s*{[^}]*display:\s*flex;[^}]*height:\s*100%/s);
    expect(css).toMatch(/\.set-nav\s*{[^}]*width:\s*180px[^}]*var\(--hair-1\)/s);
    expect(css).toMatch(/\.set-body\s*{[^}]*flex:\s*1;[^}]*overflow-y:\s*auto;[^}]*padding:\s*var\(--sp-6\) var\(--sp-8\)/s);
    expect(css).toMatch(/\.set-sec \+ \.set-sec\s*{[^}]*margin-top:\s*var\(--sp-8\)/s);
    expect(css).toMatch(/\.ctl:hover\s*{[^}]*border-color:\s*var\(--hair-2\)/s);
    // 116 弧 A: the pick chip's accent edge retired — chips select NEUTRALLY
    // (the global .chip.on idiom); no accent border may return here.
    expect(css).not.toMatch(/\.chip\.pick\.on\s*{[^}]*border-color:\s*var\(--accent\)/s);
  });
});

// —— iter4 (trial feedback) — the receipts are TOASTS now ——
// The panels' inline .settings-receipts strip is RETIRED from the settings
// page (Wizard.tsx keeps its OWN .settings-receipts usage — independent):
// notify() feeds a floating .settings-toasts stack (role=status /
// aria-live=polite) anchored to the page's bottom-right, rendered INSIDE the
// same .settings-page container — the textContent-containment seam every
// receipt assertion above rides stays intact with zero edits. Toast
// semantics: 4000ms auto-dismiss, click-to-dismiss, ≤3 stacked (oldest
// dropped), ⚠️-prefixed text = data-variant="error".
describe("settings notices as toasts (iter4)", () => {
  const toastHost = (c: HTMLElement): HTMLElement => {
    const el = c.querySelector(".settings-page > .settings-toasts");
    if (!(el instanceof HTMLElement)) throw new Error("toast host missing");
    return el;
  };
  const toasts = (c: HTMLElement): HTMLElement[] => [...c.querySelectorAll(".settings-toast")] as HTMLElement[];

  /** Reply to the LAST settingsSet op with an ERROR — the appearance tab's
   * failed-write lane (notify("⚠️ 主题未保存：…")). */
  const replyErrTo = async (server: FakeServer, err: string): Promise<void> => {
    await act(async () => {
      const op = [...opsOf(server)].reverse().find((o) => o.op.op === "settingsSet");
      server.socket.serverSend({ t: "result", id: op?.id, err });
    });
  };

  // The appearance pickers WRITE documentElement + the localStorage mirrors —
  // reset both so a theme/accent pick never leaks into the next test's
  // readTheme()/readAccent() (the permissions-appearance-tabs idiom). Also
  // restore real timers if a fake-timer test bailed early.
  afterEach(() => {
    vi.useRealTimers();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.accent;
    window.localStorage.removeItem("wudao.ui.theme");
    window.localStorage.removeItem("wudao.ui.accent");
  });

  it("保存 receipts land in the floating .settings-toasts host (role=status, polite), not an inline strip", async () => {
    const h = await mountedPage();
    await selectProvider(h.container, "glm");
    await enterEdit(h.container); // round 5 契约反转: the paste box lives behind 编辑
    const input = detailPanel(h.container).querySelector("input.key-input") as HTMLInputElement;
    await act(async () => {
      type(input, "sk-toast-me");
    });
    await act(async () => {
      btnByText(detailPanel(h.container), "保存修改").click();
    });
    await replyTo(h.server, "settingsSaveProvider", { ok: true, provider: "glm" });
    await replyTo(h.server, "settingsSaveKey", { provider: "glm", saved: true, keyCount: 3 });
    // The host is a DIRECT CHILD of .settings-page (the containment seam),
    // and the entry carries the existing receipt copy verbatim. 0.3.12: the
    // single save fires BOTH lanes → two receipts (config + key), each its
    // own honest fact in the floating host.
    const host = toastHost(h.container);
    expect(host.getAttribute("role")).toBe("status");
    expect(host.getAttribute("aria-live")).toBe("polite");
    expect(toasts(h.container).length).toBe(2);
    expect(toasts(h.container).map((t) => t.textContent).join("\n")).toContain("已保存 glm 的 Key");
    expect(toasts(h.container).map((t) => t.textContent).join("\n")).toContain("已保存供应商 glm 的注册表配置");
    expect(toasts(h.container)[0]?.getAttribute("data-variant")).toBe("ok");
    expect(toasts(h.container)[0]?.querySelector("button[aria-label='关闭']")).not.toBeNull();
    // The panels' inline strip is GONE (only the persistent load error stays
    // inline — it must not ride a lane that auto-dismisses).
    expect(h.container.querySelector(".set-body .settings-receipts")).toBeNull();
  });

  it("auto-dismisses at 4000ms, closes on click, and unmounting a live toast is clean", async () => {
    vi.useFakeTimers();
    try {
      const h = await mountedPage();
      await openTab(h.container, "appearance");
      // (Ambient timers exist — the client/React seams schedule their own —
      // so the timer assertions below compare BEFORE/AFTER states, never
      // absolute counts.)
      const pick = async (attr: "theme" | "accent", v: string): Promise<void> => {
        await act(async () => {
          (h.container.querySelector(`[data-appearance-${attr}='${v}']`) as HTMLButtonElement).click();
        });
        await replyTo(h.server, "settingsSet", { saved: true });
      };
      // #1: appears, and the 4000ms fuse — not one ms earlier — retires it.
      await pick("theme", "light");
      expect(toasts(h.container).length).toBe(1);
      const withFuse = vi.getTimerCount(); // includes the toast's own timer
      act(() => {
        vi.advanceTimersByTime(3999);
      });
      expect(toasts(h.container).length).toBe(1); // still alive at 3999
      const stillWithFuse = vi.getTimerCount(); // nothing fired in that window
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(toasts(h.container).length).toBe(0); // gone at 4000
      expect(vi.getTimerCount()).toBe(stillWithFuse - 1); // exactly ITS fuse burned
      expect(withFuse).toBeGreaterThan(0);
      // #2: the close button retires a toast IMMEDIATELY (no timer advance).
      await pick("accent", "blue");
      expect(toasts(h.container).length).toBe(1);
      const clickFuse = vi.getTimerCount();
      await act(async () => {
        (toasts(h.container)[0]?.querySelector("button[aria-label='关闭']") as HTMLButtonElement).click();
      });
      expect(toasts(h.container).length).toBe(0);
      expect(vi.getTimerCount()).toBe(clickFuse - 1); // the click CANCELLED the fuse
      // #3: unmounting with a LIVE toast — the pending timer dies with the
      // page (no setState-after-unmount; nothing fires later).
      await pick("theme", "dark");
      expect(toasts(h.container).length).toBe(1);
      const liveFuse = vi.getTimerCount();
      expect(() =>
        act(() => {
          root?.unmount();
        }),
      ).not.toThrow();
      root = null;
      expect(vi.getTimerCount()).toBeLessThan(liveFuse); // the fuse was cleared
      expect(() =>
        act(() => {
          vi.advanceTimersByTime(10_000);
        }),
      ).not.toThrow();
      expect(() =>
        act(() => {
          vi.advanceTimersByTime(10_000);
        }),
      ).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps the stack at 3 visible toasts — the OLDEST is dropped, order kept", async () => {
    const h = await mountedPage();
    await openTab(h.container, "appearance");
    // Five DISTINCT receipt texts (theme picks say 主题 → …, accent picks say
    // 主色 → …) so which entries survive the cap is provable from the text.
    for (const [attr, v] of [
      ["theme", "light"],
      ["accent", "black"],
      ["accent", "blue"],
      ["accent", "green"],
      ["theme", "dark"],
    ] as const) {
      await act(async () => {
        (h.container.querySelector(`[data-appearance-${attr}='${v}']`) as HTMLButtonElement).click();
      });
      await replyTo(h.server, "settingsSet", { saved: true });
    }
    const entries = toasts(h.container);
    expect(entries.length).toBe(3); // 5 notifies → ≤3
    expect(entries[0]?.textContent).toContain("蓝"); // keeps the LATEST three…
    expect(entries[1]?.textContent).toContain("绿");
    expect(entries[2]?.textContent).toContain("暗色");
    expect(entries[0]?.textContent).not.toContain("浅色"); // …the oldest two are dropped
    expect(entries[0]?.textContent).not.toContain("墨黑");
  });

  it("a ⚠️-prefixed receipt lands as data-variant=error", async () => {
    const h = await mountedPage();
    await openTab(h.container, "appearance");
    await act(async () => {
      (h.container.querySelector("[data-appearance-theme='light']") as HTMLButtonElement).click();
    });
    await replyErrTo(h.server, "boom");
    const entries = toasts(h.container);
    expect(entries.length).toBe(1);
    expect(entries[0]?.getAttribute("data-variant")).toBe("error");
    expect(entries[0]?.textContent).toContain("⚠️ 主题未保存");
  });
});

// —— final review F1 — the pending permission ask while settings is open ——
// The ask mounts as an INLINE card in the chat column (settings-trial r7) —
// the very column this page REPLACES. Fail-closed semantics are intact (the
// ask parks until answered); the hole was DISCOVERABILITY: zero indication
// inside the page until the user returns. The fix is a PERSISTENT in-page
// banner (role=status, no buttons, no auto-dismiss — deliberately NOT the
// toast lane, whose 4000ms fuse cannot outlive an ask) wired from the same
// App-level ask state that mounts the card.
describe("pending permission ask while settings is open (final review F1)", () => {
  it("renders the persistent banner while an ask pends — on every tab, never as a toast", async () => {
    const h = await mountedPage({ pendingAsk: true });
    const banner = h.container.querySelector(".settings-pending-ask");
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("role")).toBe("status");
    expect(banner?.textContent).toContain("有权限请求待确认");
    expect(banner?.textContent).toContain("关闭设置后处理");
    // Informational only — no buttons ride the banner.
    expect(banner?.querySelector("button")).toBeNull();
    // NOT the toast lane: nothing auto-dismisses, nothing data-variant'd.
    expect(h.container.querySelectorAll(".settings-toast").length).toBe(0);
    // The notice rides the top of EVERY tab panel (the pageNotices idiom) —
    // a user on 权限 sees it too, not just the default 供应商 frame.
    await openTab(h.container, "permissions");
    expect(h.container.querySelector(".settings-pending-ask")).not.toBeNull();
  });

  it("no banner without a pending ask", async () => {
    const h = await mountedPage();
    expect(h.container.querySelector(".settings-pending-ask")).toBeNull();
  });

  // The App wiring + the untouched answer lane: with a parked ask AND the
  // page open the card is gone (chat replaced) but the banner names it;
  // closing the page brings the SAME .permission-card back and its y key
  // still answers (components.test.tsx pins the full y/n/Enter lane).
  it("App: banner shows over the replaced chat; closing settings restores the answering card", async () => {
    const server = fakeServer();
    const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
    const container = mount(<App client={client} />);
    act(() => {
      client.connect();
      server.socket.serverOpen();
    });
    await act(async () => {
      authOk(server.socket, { busy: true, pendingPermission: { toolName: "write_file", summary: "src/a.ts", input: {} } });
    });
    await act(async () => {
      const ops = opsOf(server); // answer the connected-effect listSlashCommands
      server.socket.serverSend({ t: "result", id: ops[0]?.id, ok: [] });
    });
    await act(async () => {
      (container.querySelector(".topbar button[aria-label='设置']") as HTMLButtonElement).click();
    });
    await act(async () => {
      const statusOp = opsOf(server).find((o) => o.op.op === "settingsStatus");
      // uiDefaultMode ADVANCED — the settingsStatus reply flips the live
      // shell (App applies uiDefaultMode), and the ask's inline card lives
      // in the ADVANCED column (SimpleMode answers in-place instead).
      server.socket.serverSend({
        t: "result",
        id: statusOp?.id,
        ok: { ...STATUS, settings: { ...STATUS.settings, uiDefaultMode: "advanced" } },
      });
    });
    // The chat column (and its inline ask card) is replaced — the banner is
    // the only in-page indication of the parked ask.
    expect(container.querySelector(".permission-card")).toBeNull();
    expect(container.querySelector(".settings-pending-ask")?.textContent).toContain("有权限请求待确认");
    await act(async () => {
      (container.querySelector(".settings-head button") as HTMLButtonElement).click();
    });
    const card = container.querySelector(".permission-card") as HTMLElement;
    expect(card).not.toBeNull();
    await act(async () => {
      card.dispatchEvent(new KeyboardEvent("keydown", { key: "y", bubbles: true, cancelable: true }));
    });
    expect(opsOf(server).some((o) => o.op.op === "answerPermission" && o.op.allow === true)).toBe(true);
  });
});
