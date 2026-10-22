// @vitest-environment jsdom
// settings-split T2 — the 权限档 and 外观 tabs mounted DIRECTLY (no shell:
// T4 wires them into the 5-tab SettingsPage; these tests pin the moved
// behavior so the extraction is observable before the shell lands). 0.3.11:
// the 权限档 tab binds the PERSISTED default (settings.permissionsDefaultMode
// via settingsSet) — the LIVE tier is named read-only in the hint, never
// driven here; the appearance pickers apply live to documentElement, persist
// through settingsSet (ui.theme/ui.accent), fire onAccentPicked on accent
// picks ONLY, and revert the applied value when the write fails.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WudaoClient } from "../src/protocol.js";
import { AppearanceTab } from "../src/components/AppearanceTab.js";
import { PermissionsTab } from "../src/components/PermissionsTab.js";
import { readAccent, readTheme } from "../src/theme.js";
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
  // The appearance pickers WRITE documentElement + the localStorage mirrors
  // — reset both so a pick never leaks into the next test's readTheme().
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.accent;
  localStorage.clear();
});

/** A connected + authed client over the scripted socket (the settings-tab
 * harness pattern — these tabs fire their ops straight through client). */
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

const opsOf = (server: FakeServer): { id: number; op: Record<string, unknown> }[] =>
  server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } =>
    typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>),
  ) as { id: number; op: Record<string, unknown> }[];

/** Answer the LATEST op of a name — `ok` resolves the tab's promise, `err`
 * rejects it (the revert path). */
const reply = async (server: FakeServer, opName: string, frame: { ok: unknown } | { err: string }): Promise<void> => {
  await act(async () => {
    const op = [...opsOf(server)].reverse().find((o) => o.op.op === opName);
    server.socket.serverSend({ t: "result", id: op?.id, ...frame });
  });
};

/** The ShieldSelector's collapsed chip (the one button carrying data-mode). */
const shieldChip = (c: HTMLElement): HTMLButtonElement => {
  const b = c.querySelector("button.chip[data-mode]") as HTMLButtonElement | null;
  if (b === null) throw new Error("shield chip missing");
  return b;
};

/** A minimal DriverStatus carrying only `mode` (the settings-page harness
 *  shape) — for the 0.3.11 pin that the LIVE tier never drives the chip. */
const STATUS_MODE = {
  live: { reasoning: "", answer: "", busyTools: [] },
  busy: false, queued: [], boardProgress: null, ctxTokens: null,
  cachePercent: null, bg: { active: 0, spawned: 0 }, pendingPermission: null,
  planBoard: null, sessionId: "wudao-t", sidecar: null,
  model: { label: "deepseek-x", provider: "deepseek", choices: [] },
} as unknown as import("../src/protocol.js").DriverStatus;

describe("PermissionsTab", () => {
  /** Answer the tab's mount-time settingsStatus with a given persisted
   *  default (the tab reads ONLY settings.permissionsDefaultMode). */
  const replyStatus = async (server: FakeServer, permissionsDefaultMode: string | null): Promise<void> => {
    await act(async () => {
      const op = opsOf(server).find((o) => o.op.op === "settingsStatus");
      server.socket.serverSend({ t: "result", id: op?.id, ok: { settings: { permissionsDefaultMode } } });
    });
  };

  it("mount reads the persisted default; never-written → accept(workspace)档,未选中态;标题与 hint 说明两语义", async () => {
    const server = fakeServer();
    const client = connectedClient(server);
    const c = mount(<PermissionsTab client={client} notify={vi.fn()} status={null} />);
    await replyStatus(server, null);
    expect(shieldChip(c).dataset.mode).toBe("workspace");
    expect(shieldChip(c).className).not.toContain("sel");
    expect(shieldChip(c).textContent).toContain("accept"); // 0.3.13: the the upstream format label for the default tier
    expect(c.querySelector("h3.set-title")?.textContent).toBe("权限档(新会话默认)");
    expect(c.textContent).toContain("当前会话档 = accept"); // status=null → modeLabel("workspace")
    expect(c.textContent).toContain("shift+tab");
  });

  it("a persisted ask reads back as the chip's value — NOT the live mode", async () => {
    const server = fakeServer();
    const client = connectedClient(server);
    // Live mode ask (status.mode) must NOT drive the chip — the two
    // entrances have distinct semantics (persisted vs live).
    const c = mount(<PermissionsTab client={client} notify={vi.fn()} status={{ ...STATUS_MODE, mode: "ask" }} />);
    await replyStatus(server, "workspace");
    expect(shieldChip(c).dataset.mode).toBe("workspace");
    expect(shieldChip(c).textContent).toContain("accept"); // persisted drives the chip
    expect(c.textContent).toContain("ask"); // live named in the hint only
  });

  it("选 auto:菜单两步确认 → settingsSet(permissions.defaultMode) op + 回执「新会话默认权限档 → auto」;本会话档不随动", async () => {
    const server = fakeServer();
    const client = connectedClient(server);
    const notify = vi.fn();
    const c = mount(<PermissionsTab client={client} notify={notify} status={null} />);
    await replyStatus(server, null);
    await act(async () => {
      shieldChip(c).click(); // open the popup menu
    });
    const auto = c.querySelector(".menu .mi[data-mode='auto']") as HTMLButtonElement;
    await act(async () => {
      auto.click(); // risky tier: the first click arms the inline confirm
    });
    expect(opsOf(server).some((o) => o.op.op === "settingsSet")).toBe(false); // nothing on the wire yet
    expect(auto.textContent).toContain("再点一次确认");
    await act(async () => {
      auto.click(); // the second click commits
    });
    // The persisted-default write — setMode is NOT fired from this tab.
    expect(opsOf(server).find((o) => o.op.op === "settingsSet")?.op).toMatchObject({
      op: "settingsSet", key: "permissions.defaultMode", value: "auto",
    });
    expect(opsOf(server).some((o) => o.op.op === "setMode")).toBe(false);
    await reply(server, "settingsSet", { ok: { key: "permissions.defaultMode", saved: true } });
    expect(notify).toHaveBeenCalledWith("新会话默认权限档 → auto(已持久化;本会话仍为 accept)");
    expect(shieldChip(c).dataset.mode).toBe("auto"); // local state lands immediately
  });

  it("settingsSet 失败 → notify ⚠️ 设置默认权限档失败：…(回执不静默)", async () => {
    const server = fakeServer();
    const client = connectedClient(server);
    const notify = vi.fn();
    const c = mount(<PermissionsTab client={client} notify={notify} status={null} />);
    await replyStatus(server, null);
    await act(async () => {
      shieldChip(c).click();
    });
    await act(async () => {
      (c.querySelector(".menu .mi[data-mode='ask']") as HTMLButtonElement).click(); // non-risky: one click commits
    });
    expect(opsOf(server).find((o) => o.op.op === "settingsSet")?.op).toMatchObject({ key: "permissions.defaultMode", value: "ask" });
    await reply(server, "settingsSet", { err: "driver busy" });
    expect(notify).toHaveBeenCalledWith("⚠️ 设置默认权限档失败：driver busy");
  });
});

describe("AppearanceTab", () => {
  it("主题点击 → documentElement 立即切 light + settingsSet(ui.theme) op;onAccentPicked 不触发", async () => {
    const server = fakeServer();
    const client = connectedClient(server);
    const notify = vi.fn();
    const onAccentPicked = vi.fn();
    const c = mount(<AppearanceTab client={client} notify={notify} onAccentPicked={onAccentPicked} />);
    expect(c.querySelector("h3.set-title")?.textContent).toBe("外观");
    await act(async () => {
      (c.querySelector("button[data-appearance-theme='light']") as HTMLButtonElement).click();
    });
    expect(readTheme()).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(opsOf(server).find((o) => o.op.op === "settingsSet")?.op).toMatchObject({ key: "ui.theme", value: "light" });
    expect(onAccentPicked).not.toHaveBeenCalled();
    await reply(server, "settingsSet", { ok: { key: "ui.theme", saved: true } });
    expect(notify).toHaveBeenCalledWith("主题 → 浅色 —— 已保存");
  });

  it("主色点击 → documentElement 立即切 blue + settingsSet(ui.accent) op + onAccentPicked 触发", async () => {
    const server = fakeServer();
    const client = connectedClient(server);
    const notify = vi.fn();
    const onAccentPicked = vi.fn();
    const c = mount(<AppearanceTab client={client} notify={notify} onAccentPicked={onAccentPicked} />);
    await act(async () => {
      (c.querySelector("button[data-appearance-accent='blue']") as HTMLButtonElement).click();
    });
    expect(readAccent()).toBe("blue");
    expect(document.documentElement.dataset.accent).toBe("blue");
    expect(opsOf(server).find((o) => o.op.op === "settingsSet")?.op).toMatchObject({ key: "ui.accent", value: "blue" });
    expect(onAccentPicked).toHaveBeenCalledTimes(1);
    await reply(server, "settingsSet", { ok: { key: "ui.accent", saved: true } });
    expect(notify).toHaveBeenCalledWith("主色 → 蓝 —— 已保存");
  });

  it("settingsSet 回 error → 应用值回滚(readTheme 复原)+ ⚠️ 回执", async () => {
    const server = fakeServer();
    const client = connectedClient(server);
    const notify = vi.fn();
    const c = mount(<AppearanceTab client={client} notify={notify} />);
    expect(readTheme()).toBe("dark"); // jsdom's fresh documentElement
    await act(async () => {
      (c.querySelector("button[data-appearance-theme='light']") as HTMLButtonElement).click();
    });
    expect(readTheme()).toBe("light"); // applied first
    await reply(server, "settingsSet", { err: "disk full" });
    expect(readTheme()).toBe("dark"); // reverted
    expect(notify).toHaveBeenCalledWith("⚠️ 主题未保存：disk full");
  });
});
