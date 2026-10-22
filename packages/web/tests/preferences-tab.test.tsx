// @vitest-environment jsdom
// settings-split T3 — the 偏好 tab mounted DIRECTLY (no SettingsPage shell
// and no settingsStatus round-trip: settings arrives as a prop, the fetch
// stays page-level): null uiDefaultMode highlights 高级 (M63 §D), the memory
// checkbox writes memoryEnabled through settingsSet with its byte-identical
// receipt, a mode chip writes ui.defaultMode AND reports back through
// onModeApplied the moment the write lands (ui-review-r2 I8 — the pick flips
// the live shell), and a failed write lands in notify with the ⚠️ prefix.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WudaoClient } from "../src/protocol.js";
import type { SettingsStatus } from "../src/protocol.js";
import { PreferencesTab } from "../src/components/PreferencesTab.js";
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

// The page-level fixture the tab receives as a prop — uiDefaultMode null is
// M63 §D's "never written" state (resolves 高级, existing users never flip).
const STATUS: SettingsStatus = {
  providers: [],
  credentials: { path: "/home/u/.wudao/.credentials.yaml", keyCount: 1 },
  settings: { memoryEnabled: true, uiDefaultMode: null, wizardCompletedVersion: 1, uiTheme: null, uiAccent: null },
  current: { provider: "deepseek", model: "deepseek-v4-flash", effort: "high" },
  envKey: false,
  readiness: true,
  efforts: [],
};

type Spy = ReturnType<typeof vi.fn>;

interface Harness {
  container: HTMLElement;
  server: FakeServer;
  notify: Spy;
  refresh: Spy;
  onModeApplied: Spy;
  replyTo: (opName: string, ok: unknown) => Promise<void>;
  lastOp: (opName: string) => Record<string, unknown> | undefined;
}

async function mountedTab(): Promise<Harness> {
  const server = fakeServer();
  const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
  act(() => {
    client.connect();
    server.socket.serverOpen();
  });
  act(() => {
    authOk(server.socket);
  });
  const notify = vi.fn();
  const refresh = vi.fn();
  const onModeApplied = vi.fn();
  const container = mount(
    <PreferencesTab client={client} settings={STATUS} notify={notify} refresh={refresh} onModeApplied={onModeApplied} />,
  );
  const ops = () =>
    server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } =>
      typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>),
    ) as { id: number; op: Record<string, unknown> }[];
  const lastOp = (opName: string): Record<string, unknown> | undefined =>
    [...ops()].reverse().find((o) => o.op.op === opName)?.op;
  const replyTo = async (opName: string, ok: unknown): Promise<void> => {
    await act(async () => {
      const op = [...ops()].reverse().find((o) => o.op.op === opName);
      server.socket.serverSend({ t: "result", id: op?.id, ok });
    });
  };
  return { container, server, notify, refresh, onModeApplied, replyTo, lastOp };
}

const modeChip = (c: HTMLElement, mode: string): HTMLButtonElement => {
  const b = c.querySelector(`button[data-default-mode='${mode}']`) as HTMLButtonElement | null;
  if (b === null) throw new Error(`mode chip ${mode} missing`);
  return b;
};

describe("PreferencesTab (direct mount)", () => {
  it("renders the moved section verbatim: labels in order, null → 高级 highlighted, memory on", async () => {
    const h = await mountedTab();
    const chips = [...h.container.querySelectorAll("button[data-default-mode]")] as HTMLButtonElement[];
    expect(chips.map((b) => b.textContent)).toEqual(["简洁模式", "Buddy 模式", "高级模式"]);
    expect(modeChip(h.container, "advanced").className).toContain("on"); // M63 §D: null resolves advanced
    expect(modeChip(h.container, "simple").className).not.toContain("on");
    expect((h.container.querySelector(".setrow input[type=checkbox]") as HTMLInputElement).checked).toBe(true);
    // 120 弧：hint 分行化——行说明各自随行，全局 hint 只留写入位置。
    expect(h.container.textContent).toContain("写入全局设置(~/.wudao/settings.json)");
  });

  it("the memory checkbox writes memoryEnabled=false with its receipt, then refreshes", async () => {
    const h = await mountedTab();
    const memory = h.container.querySelector(".setrow input[type=checkbox]") as HTMLInputElement;
    await act(async () => {
      memory.click();
    });
    expect(h.lastOp("settingsSet")).toMatchObject({ op: "settingsSet", key: "memoryEnabled", value: false });
    await h.replyTo("settingsSet", { key: "memoryEnabled", saved: true });
    expect(h.notify).toHaveBeenCalledWith("记忆已关闭 —— 下会话生效");
    expect(h.refresh).toHaveBeenCalled();
    expect(h.onModeApplied).not.toHaveBeenCalled(); // a memory flip never touches the shell
  });

  it("a mode chip writes ui.defaultMode, freezes the chips while pending, and reports onModeApplied (I8)", async () => {
    const h = await mountedTab();
    await act(async () => {
      modeChip(h.container, "simple").click();
    });
    // The write is in flight — all three mode chips freeze under the SAME
    // per-key pending (`set:ui.defaultMode`), not a cross-section freeze.
    for (const mode of ["simple", "buddy", "advanced"] as const) {
      expect(modeChip(h.container, mode).disabled).toBe(true);
    }
    expect(h.lastOp("settingsSet")).toMatchObject({ op: "settingsSet", key: "ui.defaultMode", value: "simple" });
    await h.replyTo("settingsSet", { key: "ui.defaultMode", saved: true });
    expect(h.notify).toHaveBeenCalledWith("默认界面 → 简洁模式 —— 已切换,重载后完全生效");
    expect(h.onModeApplied).toHaveBeenCalledWith("simple");
    expect(h.refresh).toHaveBeenCalled();
    expect(modeChip(h.container, "simple").disabled).toBe(false); // settled
  });

  it("a failed write lands in notify with the ⚠️ prefix and never fires onModeApplied", async () => {
    const h = await mountedTab();
    await act(async () => {
      modeChip(h.container, "simple").click();
    });
    await act(async () => {
      const frames = h.server.clientFrames().filter((f) => typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>)) as { id: number; op: Record<string, unknown> }[];
      const op = [...frames].reverse().find((o) => o.op.op === "settingsSet");
      h.server.socket.serverSend({ t: "result", id: op?.id, err: "写入失败" });
    });
    expect(h.notify).toHaveBeenCalledWith("⚠️ 写入失败");
    expect(h.onModeApplied).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
    expect(modeChip(h.container, "simple").disabled).toBe(false); // pending cleared in finally
  });
});

// 推理档三级配置 + 语言 chip S5 (spec 2026-08-28 §5) — the 默认推理档 row:
// chips over the settings snapshot's efforts, writing model.defaultEffort
// (the GLOBAL tier — a new session's boot fold; the per-session pick stays
// the composer's 强度 chip, the per-provider binding the detail panel's row).
describe("PreferencesTab 默认推理档 row (S5)", () => {
  const EFFORT_STATUS: SettingsStatus = {
    ...STATUS,
    efforts: ["low", "medium", "high", "max"],
    defaultEffort: "high",
  };

  const mountedEffortTab = async (): Promise<Harness> => {
    const server = fakeServer();
    const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
    act(() => {
      client.connect();
      server.socket.serverOpen();
    });
    act(() => {
      authOk(server.socket);
    });
    const notify = vi.fn();
    const refresh = vi.fn();
    const container = mount(
      <PreferencesTab client={client} settings={EFFORT_STATUS} notify={notify} refresh={refresh} />,
    );
    const ops = () =>
      server.clientFrames().filter((f): f is { id: number; op: Record<string, unknown> } =>
        typeof f === "object" && f !== null && "op" in (f as Record<string, unknown>),
      ) as { id: number; op: Record<string, unknown> }[];
    const lastOp = (opName: string): Record<string, unknown> | undefined =>
      [...ops()].reverse().find((o) => o.op.op === opName)?.op;
    const replyTo = async (opName: string, ok: unknown): Promise<void> => {
      await act(async () => {
        const op = [...ops()].reverse().find((o) => o.op.op === opName);
        server.socket.serverSend({ t: "result", id: op?.id, ok });
      });
    };
    return { container, server, notify, refresh, onModeApplied: vi.fn(), replyTo, lastOp };
  };

  it("renders one chip per effort; the stored default is .on", async () => {
    const h = await mountedEffortTab();
    const chips = [...h.container.querySelectorAll("button[data-default-effort]")] as HTMLButtonElement[];
    expect(chips.map((b) => b.textContent)).toEqual(["low", "medium", "high", "max"]);
    const on = h.container.querySelector("button[data-default-effort].on") as HTMLButtonElement | null;
    expect(on?.textContent).toBe("high");
  });

  it("a pick writes model.defaultEffort with the 新会话 receipt, then refreshes", async () => {
    const h = await mountedEffortTab();
    await act(async () => {
      (h.container.querySelector("button[data-default-effort='max']") as HTMLButtonElement).click();
    });
    expect(h.lastOp("settingsSet")).toMatchObject({ op: "settingsSet", key: "model.defaultEffort", value: "max" });
    await h.replyTo("settingsSet", { key: "model.defaultEffort", saved: true });
    expect(h.notify).toHaveBeenCalledWith("默认推理档 → max —— 新会话生效");
    expect(h.refresh).toHaveBeenCalled();
  });

  it("absent on an empty efforts list (the provider publishes no tiers)", async () => {
    const h = await mountedTab();
    expect(h.container.querySelector("button[data-default-effort]")).toBeNull();
  });
});
