// @vitest-environment jsdom
// M63 §C — the first-run wizard: the readiness gate (any provider ready →
// the wizard NEVER mounts; a stale copy version re-shows it), the step flow
// (test-before-continue at the key step with the three human failure
// states), completion writing through the ops (save + settingsSet +
// /provider + /model), and the skip path (browse-only + the persistent
// 去配置 banner). All op traffic runs over the in-memory fake WS — the
// settings ops' semantics are covered server/cli-side; here they are mocks.
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WudaoClient } from "../src/protocol.js";
import type { DriverStatus, SettingsStatus } from "../src/protocol.js";
import { matrixReady, wizardShouldShow, WIZARD_COPY_VERSION } from "../src/wizard.js";
import { Wizard } from "../src/components/Wizard.js";
import { App } from "../src/components/App.js";
import { authOk, fakeServer } from "./mock-ws.js";
import type { FakeServer } from "./mock-ws.js";
// 墨线 T13: the visual pins — the sheet rides jsdom's CSSOM (decl() reads
// as-declared values; jsdom never resolves var()), and the raw sheet text
// backs the shorthands cssstyle drops (the .act/.todo-box precedent).
import { stylesCss } from "./styles-source.js";
import "../src/styles.css";
import { decl } from "./css-test-utils.js";

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

/** The raw sheet text — shorthand/animation pins read the source (cssstyle
 *  drops var()-bearing border/transition/animation shorthands). */
const STYLES_CSS = stylesCss;

const card = (provider: string, status: SettingsStatus["providers"][number]["status"]): SettingsStatus["providers"][number] => ({
  provider,
  label: provider,
  status,
  keySource: status === "ready" ? "credentials" : null,
  endpoint: provider === "wudao" ? null : `https://${provider}.example/v1`,
  defaultModel: provider === "deepseek" ? "deepseek-v4-flash" : provider === "glm" ? "glm-4.6" : provider === "qwen" ? "qwen3-max" : "wudao-preview",
  custom: false,
  models: [],
});

/** Nothing ready — the wizard's world. */
const NOT_READY: SettingsStatus = {
  providers: [card("deepseek", "missing-key"), card("glm", "missing-key"), card("qwen", "missing-key"), card("wudao", "missing-endpoint")],
  credentials: { path: "/home/u/.wudao/.credentials.yaml", keyCount: 0 },
  settings: { memoryEnabled: true, uiDefaultMode: "simple", wizardCompletedVersion: 0, uiTheme: null, uiAccent: null },
  current: { provider: "deepseek", model: "deepseek-v4-flash" },
  envKey: false,
  readiness: false,
  efforts: ["low", "medium", "high", "max", "none"],
};

/** deepseek ready via the credentials file — the whole surface is ready. */
const READY: SettingsStatus = {
  ...NOT_READY,
  providers: [card("deepseek", "ready"), card("glm", "missing-key"), card("qwen", "missing-key"), card("wudao", "missing-endpoint")],
  readiness: true,
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

const replyTo = async (server: FakeServer, opName: string, ok: unknown): Promise<void> => {
  await act(async () => {
    const op = [...opsOf(server)].reverse().find((o) => o.op.op === opName);
    server.socket.serverSend({ t: "result", id: op?.id, ok });
  });
};

const btnByText = (scope: HTMLElement, text: string): HTMLButtonElement => {
  const b = [...scope.querySelectorAll("button")].find((x) => x.textContent === text);
  if (b === undefined) throw new Error(`button "${text}" missing`);
  return b as HTMLButtonElement;
};

/** Mount the wizard standalone (steps driven directly; no App gate). */
function mountedWizard(onDone: () => void = () => {}): Harness {
  const server = fakeServer();
  const client = connectedClient(server);
  const container = mount(<Wizard client={client} status={null} settings={NOT_READY} onDone={onDone} />);
  return { container, client, server };
}

/** Mount the App and answer both boot ops (listSlashCommands +
 *  settingsStatus) — the wizard gate resolves from the status reply. */
async function mountedApp(status: SettingsStatus): Promise<Harness> {
  const server = fakeServer();
  const client = connectedClient(server);
  const container = mount(<App client={client} />);
  await act(async () => {
    for (const name of ["listSlashCommands", "settingsStatus"]) {
      const op = [...opsOf(server)].reverse().find((o) => o.op.op === name);
      if (op !== undefined) {
        server.socket.serverSend({ t: "result", id: op.id, ok: name === "settingsStatus" ? status : [] });
      }
    }
  });
  return { container, client, server };
}

/** Walk ①→② picking `provider`, landing on the key step. */
async function wizardAtKeyStep(h: Harness, provider = "glm"): Promise<void> {
  await act(async () => {
    btnByText(h.container, "开始配置").click();
  });
  await act(async () => {
    const el = [...h.container.querySelectorAll(".wizard-provider-card")].find(
      (n) => n.querySelector(".card-name")?.textContent?.includes(provider) === true,
    );
    if (el === undefined) throw new Error(`provider card ${provider} missing`);
    (el as HTMLElement).click();
  });
  await act(async () => {
    btnByText(h.container, "下一步").click();
  });
}

// ---------------------------------------------------------------------------
// The pure gate
// ---------------------------------------------------------------------------

describe("the readiness gate (pure)", () => {
  it("matrixReady: ANY ready provider = ready (the join)", () => {
    expect(matrixReady(READY.providers)).toBe(true);
    expect(matrixReady(NOT_READY.providers)).toBe(false);
    expect(matrixReady([])).toBe(false);
  });

  it("wizardShouldShow: readiness beats everything — a ready matrix never shows the wizard", () => {
    expect(wizardShouldShow({ providers: READY.providers, wizardCompletedVersion: 0 })).toBe(false);
  });

  it("not ready + never seen → shows; current version seen → stays hidden (the banner owns it)", () => {
    expect(wizardShouldShow({ providers: NOT_READY.providers, wizardCompletedVersion: 0 })).toBe(true);
    expect(wizardShouldShow({ providers: NOT_READY.providers, wizardCompletedVersion: WIZARD_COPY_VERSION })).toBe(false);
  });

  it("a copy bump re-shows: a stored version below the new copy shows again", () => {
    // The user completed/skipped version 1; the copy bumps to 2 → re-show.
    expect(wizardShouldShow({ providers: NOT_READY.providers, wizardCompletedVersion: 1, copyVersion: 2 })).toBe(true);
    expect(wizardShouldShow({ providers: NOT_READY.providers, wizardCompletedVersion: 2, copyVersion: 2 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// App wiring — the gate and the banner
// ---------------------------------------------------------------------------

describe("App wiring (the gate + the banner)", () => {
  it("readiness ready → the wizard NEVER mounts, and no banner", async () => {
    const h = await mountedApp(READY);
    expect(h.container.querySelector(".wizard-overlay")).toBeNull();
    expect(h.container.querySelector(".no-key-banner")).toBeNull();
  });

  it("not ready + unseen → the wizard takes over (full-viewport overlay)", async () => {
    const h = await mountedApp(NOT_READY);
    expect(h.container.querySelector(".wizard-overlay")).not.toBeNull();
    expect(h.container.querySelector('[data-step="welcome"]')).not.toBeNull();
    // The banner never co-exists with the wizard.
    expect(h.container.querySelector(".no-key-banner")).toBeNull();
  });

  it("not ready + this copy already seen → no wizard, the browse-only banner with 去配置", async () => {
    const h = await mountedApp({ ...NOT_READY, settings: { ...NOT_READY.settings, wizardCompletedVersion: WIZARD_COPY_VERSION } });
    expect(h.container.querySelector(".wizard-overlay")).toBeNull();
    const banner = h.container.querySelector(".no-key-banner");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("只读浏览模式");
    await act(async () => {
      btnByText(h.container, "去配置").click();
    });
    expect(h.container.querySelector(".wizard-overlay")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The step flow
// ---------------------------------------------------------------------------

describe("steps ②③ — provider choice and the key test", () => {
  it("② no selection → 下一步 disabled; a card pick enables it", async () => {
    const h = mountedWizard();
    await act(async () => {
      btnByText(h.container, "开始配置").click();
    });
    expect(btnByText(h.container, "下一步").disabled).toBe(true);
    await act(async () => {
      ([...h.container.querySelectorAll(".wizard-provider-card")].find(
        (n) => n.querySelector(".card-name")?.textContent?.includes("glm") === true,
      ) as HTMLElement).click();
    });
    expect(btnByText(h.container, "下一步").disabled).toBe(false);
  });

  it("③ test-before-continue: the three human failure states render and 下一步 stays disabled; only a pass unlocks it", async () => {
    const h = mountedWizard();
    await wizardAtKeyStep(h);
    const input = h.container.querySelector("input.key-input") as HTMLInputElement;
    // Empty paste → the test button itself is disabled.
    expect(btnByText(h.container, "测试连接").disabled).toBe(true);
    await act(async () => {
      type(input, "sk-maybe-bad");
    });
    expect(btnByText(h.container, "测试连接").disabled).toBe(false);

    const failures: readonly { reply: unknown; state: string; expectText: string }[] = [
      { reply: { ok: false, state: "auth", message: "Key 无效或无余额——检查是否复制完整、账户是否有余额" }, state: "auth", expectText: "Key 无效或无余额" },
      { reply: { ok: false, state: "network", message: "网络不通——检查网络或稍后再试" }, state: "network", expectText: "网络不通" },
      { reply: { ok: false, state: "model", message: "模型名不存在——试试推荐模型" }, state: "model", expectText: "模型名不存在" },
    ];
    for (const f of failures) {
      await act(async () => {
        btnByText(h.container, "测试连接").click();
      });
      const op = opsOf(h.server).find((o) => o.op.op === "settingsTestConnection");
      expect(op?.op).toMatchObject({ provider: "glm", key: "sk-maybe-bad" });
      await replyTo(h.server, "settingsTestConnection", f.reply);
      const result = h.container.querySelector(".test-result");
      expect(result?.getAttribute("data-state")).toBe(f.state);
      expect(result?.textContent).toContain(f.expectText);
      expect(btnByText(h.container, "下一步").disabled).toBe(true); // gated until a pass
    }

    // The pass: the test op, then the auto-save, then the unlock.
    await act(async () => {
      btnByText(h.container, "测试连接").click();
    });
    await replyTo(h.server, "settingsTestConnection", { ok: true, state: "ok", message: "连接成功" });
    await replyTo(h.server, "settingsSaveKey", { provider: "glm", saved: true, keyCount: 1 });
    expect(h.container.textContent).toContain("Key 已保存");
    expect(btnByText(h.container, "下一步").disabled).toBe(false);
    // The paste box cleared — nothing retains the key client-side.
    expect((h.container.querySelector("input.key-input") as HTMLInputElement).value).toBe("");
    expect(h.container.textContent).not.toContain("sk-maybe-bad");

    // Review nit: after a pass, a re-paste affordance re-arms the step (a
    // valid-but-wrong key is correctable in place) — 下一步 re-locks until
    // the new paste passes.
    await act(async () => {
      btnByText(h.container, "重新粘贴另一个 Key").click();
    });
    expect(btnByText(h.container, "下一步").disabled).toBe(true);
    expect((h.container.querySelector("input.key-input") as HTMLInputElement).disabled).toBe(false);
  });
});

describe("steps ④⑤⑥ — model, shield, and the completion writes", () => {
  /** Walk to the model step with a passed+saved glm key. */
  async function wizardAtModelStep(h: Harness, model?: string): Promise<void> {
    await wizardAtKeyStep(h);
    const input = h.container.querySelector("input.key-input") as HTMLInputElement;
    await act(async () => {
      type(input, "sk-good");
    });
    await act(async () => {
      btnByText(h.container, "测试连接").click();
    });
    await replyTo(h.server, "settingsTestConnection", { ok: true, state: "ok", message: "连接成功" });
    await replyTo(h.server, "settingsSaveKey", { provider: "glm", saved: true, keyCount: 1 });
    await act(async () => {
      btnByText(h.container, "下一步").click();
    });
    if (model !== undefined) {
      await act(async () => {
        const chip = [...h.container.querySelectorAll(".model-chip")].find((c) => c.textContent?.startsWith(model));
        if (chip === undefined) throw new Error(`model chip ${model} missing`);
        (chip as HTMLElement).click();
      });
    }
  }

  it("④ the provider default is preselected (推荐); another model is a click", async () => {
    const h = mountedWizard();
    await wizardAtModelStep(h);
    const chips = [...h.container.querySelectorAll(".model-chip")] as HTMLElement[];
    expect(chips.length).toBeGreaterThan(0);
    const recommended = chips.find((c) => c.textContent?.includes("(推荐)"));
    expect(recommended?.textContent).toContain("glm-4.6");
    expect(recommended?.className).toContain("primary");
    // A different pick moves the selection.
    await act(async () => {
      (chips.find((c) => c.textContent?.startsWith("glm-4.6")) as HTMLElement).click();
    });
    expect(([...h.container.querySelectorAll(".model-chip")] as HTMLElement[]).find((c) => c.textContent?.startsWith("glm-4.6"))?.className).toContain("primary");
  });

  it("⑥ completion writes through the ops: setMode + settingsSet(permissions.defaultMode) + ui.defaultMode + wizard.completedVersion + /provider + /model", async () => {
    const h = mountedWizard();
    await wizardAtModelStep(h, "glm-4.6");
    await act(async () => {
      btnByText(h.container, "下一步").click();
    });
    // ⑤: the default tier is workspace (chip carries it, un-highlighted);
    // open the menu and pick ask, then 完成.
    const shieldChip = h.container.querySelector(".pop .chip") as HTMLButtonElement;
    expect(shieldChip.getAttribute("data-mode")).toBe("workspace");
    await act(async () => {
      shieldChip.click();
    });
    await act(async () => {
      (h.container.querySelector(".pop .mi[data-mode='ask']") as HTMLButtonElement).click();
    });
    await act(async () => {
      btnByText(h.container, "完成").click();
    });
    expect(h.container.querySelector('[data-step="done"]')).not.toBeNull();

    const ops = opsOf(h.server).map((o) => o.op);
    expect(ops.find((o) => o.op === "setMode")).toMatchObject({ mode: "ask" });
    // 0.3.11: ⑤'s「之后也能随时在设置里调整」promise — the pick ALSO persists
    // as the next session's starting tier (the live switch stays setMode).
    expect(ops.find((o) => o.op === "settingsSet" && o.key === "permissions.defaultMode")).toMatchObject({ value: "ask" });
    expect(ops.find((o) => o.op === "settingsSet" && o.key === "ui.defaultMode")).toMatchObject({ value: "simple" });
    expect(ops.find((o) => o.op === "settingsSet" && o.key === "wizard.completedVersion")).toMatchObject({ value: WIZARD_COPY_VERSION });
    expect(ops.find((o) => o.op === "submit" && (o.text as string).startsWith("/provider"))).toMatchObject({ text: "/provider glm" });
    expect(ops.find((o) => o.op === "submit" && (o.text as string).startsWith("/model"))).toMatchObject({ text: "/model glm-4.6" });
    // The key write already happened at the passing test (step ③).
    expect(ops.find((o) => o.op === "settingsSaveKey")).toMatchObject({ provider: "glm", key: "sk-good" });

    // 开始使用 hands control back (the overlay unmounts via onDone).
    await act(async () => {
      btnByText(h.container, "开始使用").click();
    });
  });

  it("⑥ fires even from the safe default (no shield click needed)", async () => {
    const h = mountedWizard();
    await wizardAtModelStep(h);
    await act(async () => {
      btnByText(h.container, "下一步").click();
    });
    await act(async () => {
      btnByText(h.container, "完成").click();
    });
    expect(opsOf(h.server).map((o) => o.op).find((o) => o.op === "setMode")).toMatchObject({ mode: "workspace" });
    // 0.3.11: the safe default persists too (the starting tier is explicit,
    // not just "whatever the boot happens to default to"). 0.3.12: the
    // starting tier is workspace (shown as accept).
    expect(opsOf(h.server).map((o) => o.op).find((o) => o.op === "settingsSet" && o.key === "permissions.defaultMode")).toMatchObject({ value: "workspace" });
  });

  // R6 quickwin (R5-web review MINOR): a failed /provider switch must tell
  // the truth — the Key IS saved, so re-picking the provider is the fix. The
  // old copy promised「重启 wudao ui 后生效」, but nothing persists the
  // provider choice: a restart alone never makes it effective.
  it("⑥ a failed /provider switch says re-pick the provider — never the restart myth", async () => {
    const h = mountedWizard();
    await wizardAtModelStep(h, "glm-4.6");
    await act(async () => {
      btnByText(h.container, "下一步").click();
    });
    await act(async () => {
      btnByText(h.container, "完成").click();
    });
    expect(h.container.querySelector('[data-step="done"]')).not.toBeNull();
    // Fail ONLY the provider switch; let the other writes settle untouched.
    await act(async () => {
      const op = [...opsOf(h.server)].reverse().find((o) => o.op.op === "submit" && (o.op.text as string).startsWith("/provider"));
      if (op === undefined) throw new Error("/provider submit missing");
      h.server.socket.serverSend({ t: "result", id: op.id, err: "switch rejected" });
    });
    const errors = h.container.querySelector(".entry-error")?.textContent ?? "";
    expect(errors).toContain("provider 切换失败");
    expect(errors).toContain("switch rejected");
    expect(errors).toContain("请重新选择供应商后重试");
    expect(errors).toContain("保存的 Key 已生效");
    // The myth is gone: no restart promise for something never persisted.
    expect(errors).not.toContain("重启");
  });
});

// ---------------------------------------------------------------------------
// The skip path
// ---------------------------------------------------------------------------

describe("skip → browse-only + the persistent banner", () => {
  it("skipping marks the copy version seen and hands back; the banner appears; 去配置 re-opens", async () => {
    const h = await mountedApp(NOT_READY);
    expect(h.container.querySelector(".wizard-overlay")).not.toBeNull();
    await act(async () => {
      btnByText(h.container, "开始配置").click();
    });
    await act(async () => {
      btnByText(h.container, "跳过,先逛逛").click();
    });
    // The overlay is gone; the skip marker went through settingsSet.
    expect(h.container.querySelector(".wizard-overlay")).toBeNull();
    expect(opsOf(h.server).map((o) => o.op).find((o) => o.op === "settingsSet")).toMatchObject({
      key: "wizard.completedVersion",
      value: WIZARD_COPY_VERSION,
    });
    // The banner is the persistent way back.
    const banner = h.container.querySelector(".no-key-banner");
    expect(banner).not.toBeNull();
    await act(async () => {
      btnByText(h.container, "去配置").click();
    });
    expect(h.container.querySelector(".wizard-overlay")).not.toBeNull();
  });

  it("skippable at every step after ① (the key step too)", async () => {
    const h = mountedWizard();
    await wizardAtKeyStep(h);
    expect(btnByText(h.container, "跳过,先逛逛")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Driver-status model choices ride step ④ (the same list the settings page
// shows — learn-once).
// ---------------------------------------------------------------------------

describe("step ④ model list", () => {
  it("driver choices for the chosen provider appear; other providers' do not", async () => {
    const server = fakeServer();
    const client = connectedClient(server);
    const driverStatus = {
      live: { reasoning: "", answer: "", busyTools: [] },
      busy: false, queued: [], boardProgress: null, ctxTokens: null, mode: "workspace",
      cachePercent: null, bg: { active: 0, spawned: 0 }, pendingPermission: null, planBoard: null,
      sessionId: "wudao-t", sidecar: null,
      model: {
        label: "deepseek-v4-flash",
        provider: "deepseek",
        choices: [
          { provider: "deepseek", model: "deepseek-v4-flash", source: "profile" },
          { provider: "glm", model: "glm-4.6", source: "profile" },
          { provider: "glm", model: "glm-4.5-air", source: "profile" },
        ],
      },
    } as DriverStatus;
    const container = mount(<Wizard client={client} status={driverStatus} settings={NOT_READY} onDone={() => {}} />);
    await wizardAtKeyStep({ container, client, server } as Harness, "glm");
    const input = container.querySelector("input.key-input") as HTMLInputElement;
    await act(async () => {
      type(input, "sk-x");
    });
    await act(async () => {
      btnByText(container, "测试连接").click();
    });
    await replyTo(server, "settingsTestConnection", { ok: true, state: "ok", message: "连接成功" });
    await replyTo(server, "settingsSaveKey", { provider: "glm", saved: true, keyCount: 1 });
    await act(async () => {
      btnByText(container, "下一步").click();
    });
    const models = [...container.querySelectorAll(".model-chip")].map((c) => c.textContent ?? "");
    expect(models.some((m) => m.startsWith("glm-4.5-air"))).toBe(true);
    expect(models.some((m) => m.startsWith("deepseek"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 墨线 T13 — the wizard's ink-line shell (.wiz): the 2px accent progress
// line + the mono "01/06" step counter replace the six-dot row; the card
// pops in on --dur-med. The step/total DISPLAY props pin the shell here
// without touching the state machine (the walk's live values are the
// default source).
// ---------------------------------------------------------------------------

describe("墨线 T13 — 向导壳 (.wiz)", () => {
  /** The pinned render — the brief's fixture on this suite's mount seam. */
  const pinnedWizard = (): Harness => {
    const server = fakeServer();
    const client = connectedClient(server);
    const props = { client, status: null, settings: NOT_READY, onDone: () => {} };
    const container = mount(<Wizard {...props} step={1} total={4} />);
    return { container, client, server };
  };

  it("wizard: 2px accent progress line + mono step counter", () => {
    const { container } = pinnedWizard();
    expect(container.querySelector(".wiz-bar")).toBeTruthy();
    expect(container.querySelector(".wiz-step")?.textContent).toBe("01/04");
  });

  it("the shell nests .wiz > (.wiz-bar + .wiz-head(.wiz-step + .wiz-title)) + .wiz-body; the dots row retires", () => {
    const { container } = pinnedWizard();
    const card = container.querySelector(".wiz") as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.firstElementChild?.classList.contains("wiz-bar")).toBe(true);
    expect(container.querySelector(".wiz > .wiz-head .wiz-step")).toBeTruthy();
    // The head's title is the CURRENT step's label (① → 欢迎).
    expect(container.querySelector(".wiz-head .wiz-title")?.textContent).toBe("欢迎");
    expect(container.querySelector(".wiz > .wiz-body")).toBeTruthy();
    // The bar's inline width is the step/total ratio (1/4 → 25%), the
    // todo-bar seam.
    expect((container.querySelector(".wiz-bar") as HTMLElement).style.width).toBe("25%");
    expect(container.querySelector(".wizard-steps")).toBeNull();
    expect(container.querySelector(".wizard-step-dot")).toBeNull();
  });

  it("the default walk: 01/06 at ① → 02/06 after 开始配置 (the counter tracks the state machine)", async () => {
    const h = mountedWizard();
    expect(h.container.querySelector(".wiz-step")?.textContent).toBe("01/06");
    expect((h.container.querySelector(".wiz-bar") as HTMLElement).style.width).toBe("17%"); // round(100/6)
    await act(async () => {
      btnByText(h.container, "开始配置").click();
    });
    expect(h.container.querySelector(".wiz-step")?.textContent).toBe("02/06");
    expect((h.container.querySelector(".wiz-bar") as HTMLElement).style.width).toBe("33%"); // round(200/6)
  });

  it("the shell rides the tokens: 2px accent bar, mono caption counter, title tier, pop entry on --dur-med", () => {
    const h = mountedWizard();
    expect(h.container.querySelector(".wiz")).toBeTruthy();
    // 墨线 T14: the entry animation rides the shared .pop-in companion class.
    expect(h.container.querySelector(".wiz.pop-in")).toBeTruthy();
    expect(decl(".wiz-bar", "height")).toBe("2px");
    expect(decl(".wiz-bar", "background")).toBe("var(--accent)");
    expect(decl(".wiz-step", "font-family")).toBe("var(--mono)");
    expect(decl(".wiz-step", "font-size")).toBe("var(--fs-caption)");
    expect(decl(".wiz-step", "color")).toBe("var(--text-3)");
    expect(decl(".wiz-title", "font-size")).toBe("var(--fs-title)");
    expect(decl(".wiz-title", "font-weight")).toBe("var(--fw-strong)"); // P2 §2.5 字重令牌化
    expect(decl(".wiz-title", "color")).toBe("var(--text-1)");
    expect(decl(".wiz-head", "display")).toBe("flex");
    expect(decl(".wiz-head", "align-items")).toBe("baseline");
    expect(decl(".wiz-head", "gap")).toBe("var(--sp-2)");
    // decl(".wiz", …) walks into .wizard-overlay's earlier substring match
    // for background/display — only border-radius is unambiguous there; the
    // card's surface/border/overflow/entry animation pin off the raw sheet
    // (cssstyle drops the var()-bearing shorthands, the T11 seam).
    expect(decl(".wiz", "border-radius")).toBe("var(--radius-lg)");
    expect(STYLES_CSS).toMatch(/\.wiz\s*\{[^}]*background:\s*var\(--surface\);/s);
    // 116 弧 A: the wizard card is a modal-tier ELEVATION surface — border
    // retired, hairline stroke drawn into --elev-3 (no double outline).
    expect(STYLES_CSS).toMatch(/\.wiz\s*\{[^}]*border:\s*0;/s);
    expect(STYLES_CSS).toMatch(/\.wiz\s*\{[^}]*box-shadow:\s*var\(--elev-3\);/s);
    expect(STYLES_CSS).toMatch(/\.wiz\s*\{[^}]*overflow:\s*hidden;/s);
    // 墨线 T14: the pop entry promoted from the inline .wiz declaration into
    // the shared .pop-in family class — the wizard card carries it alongside
    // .wiz (one home for the animation).
    expect(STYLES_CSS).toMatch(/\.pop-in\s*\{[^}]*animation:\s*pop var\(--dur-med\) var\(--ease\);/s);
    expect(STYLES_CSS).toMatch(/\.wiz-head\s*\{[^}]*padding:\s*var\(--sp-3\) var\(--sp-4\);/s);
    // The width transition + the pop keyframe (shared with the T14 family).
    expect(STYLES_CSS).toMatch(/\.wiz-bar\s*\{[^}]*transition:\s*width var\(--dur-med\) var\(--ease\);/s);
    expect(STYLES_CSS).toMatch(/@keyframes pop \{[^}]*\}[^}]*\}/s);
  });
});
