// @vitest-environment jsdom
// ui-review-r5 — the round's web-wave fix suite (I2/I3/I4 live in their
// surfaces' suites; this file pins the App-level and pure pieces):
//   P1  the busy /resume + /edit refusals join the Chinese family
//       (「⚠️ 运行中无法 /resume · /edit」, r4-P2's /clear tone; the
//       （任务进行中） suffix is r7 P1's unified shape)
//   P4  attachmentSave's admission failures map to Chinese with the code in
//       parens (both wire shapes — the code and core's prose); the warn
//       glyph is ⚠️ everywhere (ContextMeter's legend, StatusBar's ctx
//       segment — FileViewer's is pinned in its own suite)
//   I2  the no-restart-myth invariant holds App-wide: no 「重启」 copy in
//       the provider-switch surfaces (the chips' behavior is pinned in
//       settings-page.test)
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/components/App.js";
import { StatusBar } from "../src/components/StatusBar.js";
import { ContextMeter } from "../src/components/ContextMeter.js";
import { WudaoClient } from "../src/protocol.js";
import type { DriverStatus, SettingsStatus } from "../src/protocol.js";
import { attachmentSendErrorText } from "../src/attachments.js";
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
function type(el: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  window.localStorage.removeItem("wudao.ui.v1");
});

// --- the App-level harness (the r3/r4 lineage). ---

interface Harness {
  container: HTMLElement;
  client: WudaoClient;
  server: FakeServer;
  answered: Set<number>;
}

function mountedApp(): Harness {
  const server = fakeServer();
  const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
  const container = mount(<App client={client} />);
  act(() => {
    client.connect();
    server.socket.serverOpen();
  });
  return { container, client, server, answered: new Set() };
}

type OpFrame = { id: number; op: Record<string, unknown> };
const opFrames = (h: Harness): OpFrame[] =>
  h.server.clientFrames().filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f);

function sendState(h: Harness, overrides: Record<string, unknown>): void {
  act(() => {
    h.server.socket.serverSend({
      t: "state",
      state: {
        live: { reasoning: "", answer: "", busyTools: [] },
        busy: false, queued: [], boardProgress: null, ctxTokens: null, mode: "workspace",
        cachePercent: null, bg: { active: 0, spawned: 0 }, pendingPermission: null, planBoard: null,
        sessionId: "wudao-test-0001", sidecar: null,
        ...overrides,
      },
    });
  });
}

async function drain(h: Harness, settings: Partial<SettingsStatus["settings"]> = {}): Promise<void> {
  await act(async () => {
    for (const f of opFrames(h)) {
      if (h.answered.has(f.id)) continue;
      h.answered.add(f.id);
      let ok: unknown = [];
      if (f.op.op === "settingsStatus") {
        ok = {
          providers: [],
          credentials: { path: "/root/.wudao/credentials.json", keyCount: 0 },
          settings: { memoryEnabled: false, uiDefaultMode: null, wizardCompletedVersion: 1, uiTheme: null, uiAccent: null, ...settings },
          current: { provider: "deepseek", model: "deepseek-chat" },
          envKey: false, readiness: false, efforts: [],
        };
      }
      h.server.socket.serverSend({ t: "result", id: f.id, ok });
    }
  });
}

async function connectedApp(settings: Partial<SettingsStatus["settings"]> = {}): Promise<Harness> {
  const h = mountedApp();
  await act(async () => {
    authOk(h.server.socket);
  });
  await drain(h, settings);
  await drain(h, settings);
  return h;
}

const textarea = (h: Harness): HTMLTextAreaElement => h.container.querySelector("textarea.wudao-input") as HTMLTextAreaElement;

async function submitLine(h: Harness, text: string): Promise<void> {
  const input = textarea(h);
  await act(async () => {
    type(input, text);
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
}

// ---------------------------------------------------------------------------
// P1 — the busy refusals for /resume and /edit join the Chinese family.
// ---------------------------------------------------------------------------
describe("ui-review-r5 P1 — busy-refusal copy (Chinese, the r4 family)", () => {
  it("/resume while busy reads 「⚠️ 运行中无法 /resume（任务进行中）」 — the unified r7 family", async () => {
    const h = await connectedApp();
    sendState(h, { busy: true });
    await submitLine(h, "/resume");
    expect(h.container.textContent).toContain("⚠️ 运行中无法 /resume（任务进行中）");
    expect(h.container.textContent).not.toContain("cannot /resume");
    // Refused before the wire: no sessions op left the socket. ω99-156: the
    // ONE sessions op on the wire is App's boot-time activeName read (this
    // harness runs advanced, no sidebar) — the refusal added none, so the
    // count pins at exactly that boot read.
    expect(opFrames(h).filter((o) => o.op.op === "sessions").length).toBe(1);
  });

  it("/edit while busy reads 「⚠️ 运行中无法 /edit（任务进行中）」", async () => {
    const h = await connectedApp();
    sendState(h, { busy: true });
    await submitLine(h, "/edit 1");
    expect(h.container.textContent).toContain("⚠️ 运行中无法 /edit（任务进行中）");
    expect(h.container.textContent).not.toContain("cannot /edit");
    expect(opFrames(h).some((o) => o.op.op === "edit")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P4 — the error taxonomy: admission codes map to Chinese (+ the code in
// parens); the warn glyph is ⚠️ everywhere.
// ---------------------------------------------------------------------------
describe("ui-review-r5 P4 — attachment admission mapping (attachmentSendErrorText)", () => {
  it("maps the code shape a server that prefixes the code would send", () => {
    expect(attachmentSendErrorText("admission failed: IMAGES_TOO_LARGE")).toBe("图片体积超出上限(IMAGES_TOO_LARGE)");
    expect(attachmentSendErrorText("admission failed: TOO_MANY_IMAGES")).toBe("图片数量超出上限(TOO_MANY_IMAGES)");
  });

  it("maps core's PROSE (the wire carries .message — the code rides the typed error, not the string)", () => {
    expect(attachmentSendErrorText("10 images exceed the per-request cap of 9")).toBe("图片数量超出上限(TOO_MANY_IMAGES)");
    expect(attachmentSendErrorText("images total 22020096 base64 bytes, over the 20971520-byte request budget")).toBe(
      "图片体积超出上限(IMAGES_TOO_LARGE)",
    );
  });

  it("non-admission errors pass through verbatim", () => {
    expect(attachmentSendErrorText("connection closed (1006)")).toBe("connection closed (1006)");
    expect(attachmentSendErrorText("not connected")).toBe("not connected");
  });
});

describe("ui-review-r5 P4 — the warn glyph is a token-colored alert icon everywhere (116 弧 C：⚠️ emoji → triangle-alert 细线)", () => {
  it("ContextMeter's near-limit legend line carries the alert icon, not an emoji", async () => {
    const c = mount(<ContextMeter ctx={{ used: 120000, window: 131072, nearLimit: true }} />);
    await act(async () => {
      (c.querySelector(".ctx-btn") as HTMLButtonElement).click();
    });
    const line = c.querySelector(".ctxmeter-legend .row.warn") as HTMLElement;
    expect(line.querySelector("svg")).not.toBeNull();
    expect(line.textContent).toContain("接近上限");
    expect(line.textContent).not.toMatch(/⚠/); // zero emoji warn glyphs in the line
  });

  it("StatusBar's near-limit ctx segment carries the alert icon, not an emoji", () => {
    const status = {
      live: { reasoning: "", answer: "", busyTools: [] },
      busy: false, queued: [], boardProgress: null,
      ctxTokens: { used: 120000, window: 131072, nearLimit: true },
      mode: "workspace", cachePercent: null, bg: { active: 0, spawned: 0 },
      pendingPermission: null, planBoard: null, sessionId: "wudao-t", sidecar: null,
    } as DriverStatus;
    const c = mount(<StatusBar status={status} />);
    const seg = c.querySelector(".seg-ctx") as HTMLElement;
    expect(seg.querySelector(".warn svg")).not.toBeNull();
    expect(seg.textContent).not.toMatch(/⚠/);
  });
});

// ---------------------------------------------------------------------------
// I2 — the no-restart-myth invariant, App-wide (the behavior pins live in
// settings-page.test): the provider-switch surfaces never claim a restart.
// ---------------------------------------------------------------------------
describe("ui-review-r5 I2 — no restart-myth copy", () => {
  it("the settings page (open) carries no 「重启」 provider-switch copy", async () => {
    const h = await connectedApp();
    await act(async () => {
      (h.container.querySelector(".topbar button[aria-label='设置']") as HTMLButtonElement).click();
    });
    await act(async () => {
      const op = opFrames(h).find((o) => !h.answered.has(o.id) && o.op.op === "settingsStatus");
      if (op !== undefined) {
        h.answered.add(op.id);
        h.server.socket.serverSend({
          t: "result", id: op.id,
          ok: {
            providers: [
              { provider: "deepseek", label: "deepseek", status: "ready", keySource: "env", endpoint: "https://api.deepseek.com", defaultModel: "deepseek-v4-flash", custom: false, models: []},
              { provider: "glm", label: "glm", status: "missing-key", keySource: null, endpoint: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4.6", custom: false, models: [{ name: "glm-4.6" }]},
            ],
            credentials: { path: "/root/.wudao/credentials.json", keyCount: 0 },
            settings: { memoryEnabled: false, uiDefaultMode: null, wizardCompletedVersion: 1, uiTheme: null, uiAccent: null },
            current: { provider: "deepseek", model: "deepseek-v4-flash", effort: "high" },
            envKey: false, readiness: true, efforts: ["high"],
          },
        });
      }
    });
    expect(h.container.querySelector(".settings-page")).not.toBeNull();
    expect(h.container.textContent).not.toContain("重启");
    // iter3 (master-detail) + 0.3.24 round 4: glm's model TABLE renders in
    // its DETAIL — select the glm card first, then the cross-provider row's
    // 使用 is clickable and names its real lane. round 6: 使用 sits ON the
    // one-line read row (the round-5 expansion card is gone).
    await act(async () => {
      const glmCard = [...h.container.querySelectorAll(".provider-card")].find((n) =>
        n.querySelector(".card-name")?.textContent?.includes("glm") === true,
      ) as HTMLElement;
      (glmCard.querySelector(".card-name") as HTMLButtonElement).click();
    });
    expect(
      [...h.container.querySelectorAll(".model-row")].some((n) =>
        n.querySelector(".model-row-name")?.textContent === "glm-4.6",
      ),
    ).toBe(true);
    const glmUse = [...h.container.querySelectorAll("button.model-use")].find(
      (b) => b.getAttribute("aria-label") === "切换到 glm-4.6",
    ) as HTMLButtonElement;
    expect(glmUse).toBeDefined();
    expect(glmUse.disabled).toBe(false);
    expect(glmUse.title).toContain("/provider glm");
  });
});
