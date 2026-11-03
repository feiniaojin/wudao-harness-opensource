// @vitest-environment jsdom
// M75-ux1 §1/§2 — Task 1 of UX round 1. Two surfaces:
//
//   §2 the workspace switcher — the tree-top becomes [📁 dirname ▾] [⟳]:
//      ▾ opens the recents dropdown (basename labels, full-path tooltips,
//      capped at 5) + the「打开其他目录…」entry; a recent click fires
//      onSwitchWorkspace(path) (App: the 重启后生效 notice + the add-through-
//      the-same-op write), the other-dir click fires onOpenOtherWorkspace
//      (⚡ v1 is the CLI-restart notice — the Tauri dialog API needs the
//      dialog plugin, a tracked follow-up);
//   §1 the window drag region — the topbar carries data-tauri-drag-region
//      (Tauri v2 intercepts mousedown → native window drag) and the ◐/⚙
//      buttons do NOT (siblings, not children of the drag area).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WudaoClient } from "../src/protocol.js";
import { App } from "../src/components/App.js";
import { FileTree } from "../src/components/FileTree.js";
import { InputBox } from "../src/components/InputBox.js";
import { WorkspaceChip } from "../src/components/WorkspaceChip.js";
import type { FileOpsClient, RecentWorkspace } from "../src/file-ops.js";
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
const flush = async (): Promise<void> => {
  await act(async () => {});
};
const click = (el: Element | null | undefined): void => {
  act(() => {
    el?.dispatchEvent(new Event("click", { bubbles: true }));
  });
};

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  window.localStorage.removeItem("wudao.ui.v1"); // ui-review-r3 P2: reset the persisted layout between tests
  // workspace-ux A2: the drag-fallback test pins __TAURI_INTERNALS__.invoke.
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const ROOT = "~/xdev/github/wudao-harness";

/** A FileOpsClient with the recents op scripted (the structural port: the
 *  two file methods as plain vi.fn's, recentWorkspaces optional). */
function switcherHarness(recents: readonly RecentWorkspace[]): {
  client: FileOpsClient;
  recentWorkspaces: ReturnType<typeof vi.fn>;
} {
  const recentWorkspaces = vi.fn((): Promise<{ workspaces: readonly RecentWorkspace[] }> =>
    Promise.resolve({ workspaces: recents }),
  );
  const client: FileOpsClient = {
    fileTree: () => Promise.resolve({ entries: [] }),
    fileRead: () => Promise.reject(new Error("not used here")),
    recentWorkspaces,
  };
  return { client, recentWorkspaces };
}

describe("workspace switcher — FileTree (M75-ux1 §2)", () => {
  it("the tree-top renders [📁 dirname ▾] with the full path in the tooltip", async () => {
    const h = switcherHarness([]);
    const c = mount(
      <FileTree client={h.client} workspaceRoot={ROOT} selectedPath={null} onSelect={vi.fn()} onAtMention={vi.fn()} refreshKey={0} />,
    );
    await flush();
    const btn = c.querySelector<HTMLButtonElement>(".ws-switcher");
    expect(btn).not.toBeNull();
    // dirname = the last segment (spec §2), NOT the old …/last-2 form.
    expect(btn?.querySelector(".tree-root")?.textContent).toContain("wudao-harness");
    expect(btn?.getAttribute("title")).toBe(ROOT);
    // The ⟳ refresh stays beside it (spec §2's second control).
    expect(c.querySelector(".tree-refresh")).not.toBeNull();
  });

  it("▾ opens the dropdown: recents (basename label, full-path tooltip) capped at 5 + 打开其他目录…", async () => {
    const six = ["/w/one", "/w/two", "/w/three", "/w/four", "/w/five", "/w/six"].map((path, i) => ({
      path,
      lastUsed: `2026-01-0${i + 1}T00:00:00.000Z`,
    }));
    const h = switcherHarness(six);
    const c = mount(
      <FileTree client={h.client} workspaceRoot={ROOT} selectedPath={null} onSelect={vi.fn()} onAtMention={vi.fn()} refreshKey={0} />,
    );
    await flush();
    expect(c.querySelector(".ws-menu")).toBeNull(); // closed until clicked
    expect(h.recentWorkspaces).not.toHaveBeenCalled(); // lazy: fetch on open only
    click(c.querySelector(".ws-switcher"));
    await flush();
    const items = [...c.querySelectorAll(".ws-menu .ws-item")];
    // 5 recents + the 打开其他目录… entry — the 6th workspace fell off.
    expect(items).toHaveLength(6);
    const recents = items.slice(0, 5);
    expect(recents.map((n) => n.textContent)).toEqual(["one", "two", "three", "four", "five"]);
    expect(recents[0]?.getAttribute("title")).toBe("/w/one");
    const other = items[5];
    expect(other?.textContent).toContain("打开其他目录");
  });

  it("138：bootRoot 在场 → 「默认空间」钉项居首（basename 标签、全路径 tooltip、点击走同一条切换缝）；缺席 → 零渲染", async () => {
    const h = switcherHarness([{ path: "/w/proj-a", lastUsed: "t" }]);
    const onSwitchWorkspace = vi.fn();
    const base = { client: h.client, workspaceRoot: ROOT, selectedPath: null, onSelect: vi.fn(), onAtMention: vi.fn(), refreshKey: 0, onSwitchWorkspace };
    // 缺席：菜单第一项是 recent，不是钉项。
    const c1 = mount(<FileTree {...base} />);
    await flush();
    click(c1.querySelector(".ws-switcher"));
    await flush();
    expect(c1.querySelector(".ws-item.ws-default")).toBeNull();
    // 在场：钉项居首。
    const c2 = mount(<FileTree {...base} bootRoot="/w/desk-home" />);
    await flush();
    click(c2.querySelector(".ws-switcher"));
    await flush();
    const pin = c2.querySelector(".ws-item.ws-default") as HTMLButtonElement;
    expect(pin).not.toBeNull();
    expect(pin.textContent).toContain("默认空间");
    expect(pin.textContent).toContain("desk-home");
    expect(pin.getAttribute("title")).toBe("/w/desk-home");
    click(pin);
    expect(onSwitchWorkspace).toHaveBeenCalledWith("/w/desk-home");
    expect(c2.querySelector(".ws-menu")).toBeNull();
  });

  it("clicking a recent fires onSwitchWorkspace(path) and closes the menu", async () => {
    const h = switcherHarness([{ path: "/w/proj-a", lastUsed: "t" }]);
    const onSwitchWorkspace = vi.fn();
    const c = mount(
      <FileTree client={h.client} workspaceRoot={ROOT} selectedPath={null} onSelect={vi.fn()} onAtMention={vi.fn()} refreshKey={0} {...{ onSwitchWorkspace }} />,
    );
    await flush();
    click(c.querySelector(".ws-switcher"));
    await flush();
    click(c.querySelector(".ws-menu .ws-item"));
    expect(onSwitchWorkspace).toHaveBeenCalledWith("/w/proj-a");
    expect(c.querySelector(".ws-menu")).toBeNull();
  });

  it("clicking 打开其他目录… fires onOpenOtherWorkspace (⚡ Tauri dialog API = follow-up; v1 is the CLI notice)", async () => {
    const h = switcherHarness([]);
    const onOpenOtherWorkspace = vi.fn();
    const c = mount(
      <FileTree client={h.client} workspaceRoot={ROOT} selectedPath={null} onSelect={vi.fn()} onAtMention={vi.fn()} refreshKey={0} {...{ onOpenOtherWorkspace }} />,
    );
    await flush();
    click(c.querySelector(".ws-switcher"));
    await flush();
    click(c.querySelector(".ws-menu .ws-open-other"));
    expect(onOpenOtherWorkspace).toHaveBeenCalledTimes(1);
    expect(c.querySelector(".ws-menu")).toBeNull();
  });

  it("a client without the recents op degrades: the menu offers 打开其他目录… only", async () => {
    const client: FileOpsClient = {
      fileTree: () => Promise.resolve({ entries: [] }),
      fileRead: () => Promise.reject(new Error("not used")),
    };
    const c = mount(
      <FileTree client={client} workspaceRoot={ROOT} selectedPath={null} onSelect={vi.fn()} onAtMention={vi.fn()} refreshKey={0} />,
    );
    await flush();
    click(c.querySelector(".ws-switcher"));
    await flush();
    expect([...c.querySelectorAll(".ws-menu .ws-item")].map((n) => n.textContent)).toEqual(["打开其他目录…"]);
  });
});

// --- App-level wiring (§1 topbar drag region + §2 the switch notices) ------

interface AppHarness {
  container: HTMLElement;
  server: FakeServer;
  answered: Set<number>;
}

function mountedApp(): AppHarness {
  const server = fakeServer();
  const client = new WudaoClient({ url: "ws://127.0.0.1:1", token: "t", wsFactory: () => server.spawn(), reconnect: false });
  const container = mount(<App client={client} />);
  act(() => {
    client.connect();
    server.socket.serverOpen();
  });
  return { container, server, answered: new Set() };
}

type OpFrame = { id: number; op: { op: string; add?: string; path?: string } };

const opFrames = (h: AppHarness): OpFrame[] =>
  h.server
    .clientFrames()
    .filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f && "id" in f);

/** Answer pending ops: settingsStatus (advanced shell), fileTree (empty),
 *  recentWorkspaces (the scripted list), agentRootStatus (aligned at ROOT),
 *  panelRootSet (echo the path), everything else a bare ok. */
async function drain(h: AppHarness, recents: readonly { path: string; lastUsed: string }[] = [], uiMode: "advanced" | "simple" = "advanced"): Promise<void> {
  await act(async () => {
    for (const f of opFrames(h)) {
      if (h.answered.has(f.id)) continue;
      h.answered.add(f.id);
      let ok: unknown = [];
      if (f.op.op === "settingsStatus") {
        ok = {
          providers: [],
          credentials: { path: "/root/.wudao/credentials.json", keyCount: 0 },
          settings: { memoryEnabled: false, uiDefaultMode: uiMode, wizardCompletedVersion: 1, uiTheme: null, uiAccent: null },
          current: { provider: "deepseek", model: "deepseek-chat" },
          envKey: false,
          readiness: false,
          efforts: [],
        };
      } else if (f.op.op === "fileTree") {
        ok = { entries: [] };
      } else if (f.op.op === "recentWorkspaces") {
        ok = { workspaces: f.op.add !== undefined ? [{ path: f.op.add, lastUsed: "now" }, ...recents] : recents };
      } else if (f.op.op === "agentRootStatus") {
        ok = { panelRoot: ROOT, agentRoot: ROOT, aligned: true };
      } else if (f.op.op === "panelRootSet") {
        ok = { root: f.op.path };
      }
      h.server.socket.serverSend({ t: "result", id: f.id, ok });
    }
  });
}

async function connectedApp(recents: readonly { path: string; lastUsed: string }[] = []): Promise<AppHarness> {
  const h = mountedApp();
  await act(async () => {
    authOk(h.server.socket);
  });
  await drain(h, recents);
  await drain(h, recents); // the tree mounts behind the settingsStatus reply
  return h;
}

/** 极简工作空间切换（spec §3.4）：同 connectedApp，但 settingsStatus 落
 *  uiDefaultMode:"simple" —— SimpleMode shell 起来后 chip 在作曲家工具行。 */
async function connectedSimpleApp(recents: readonly { path: string; lastUsed: string }[] = []): Promise<AppHarness> {
  const h = mountedApp();
  await act(async () => {
    authOk(h.server.socket);
  });
  await drain(h, recents, "simple");
  await drain(h, recents, "simple");
  return h;
}

describe("App wiring (M75-ux1 §1/§2)", () => {
  it("§1: the topbar carries data-tauri-drag-region; the +/📋/◐/⚙ buttons (and only they) opt out", async () => {
    const h = await connectedApp();
    const topbar = h.container.querySelector(".topbar");
    expect(topbar).not.toBeNull();
    expect(topbar?.hasAttribute("data-tauri-drag-region")).toBe(true);
    // The empty-space spacer IS the drag surface at runtime (Tauri checks the
    // mousedown TARGET), so it carries the attribute too.
    expect(topbar?.querySelector(".sp")?.hasAttribute("data-tauri-drag-region")).toBe(true);
    // M75-ux3 §10 joins the strip: the + new-chat is an icobtn sibling of
    // ◐/⚙ — and M76-ux2 §3 adds the 📋 session picker — and 0.3.3 adds the
    // 审查专注 toggle — every topbar button opts out of the drag region.
    const buttons = [...(topbar?.querySelectorAll("button.icobtn") ?? [])];
    expect(buttons).toHaveLength(6); // 139：+监控（探针仪表盘入口）
    for (const b of buttons) expect(b.hasAttribute("data-tauri-drag-region")).toBe(false);
  });

  // workspace-ux A2: the JS drag fallback (macOS Overlay, where the attribute
  // alone may not fire) rides the shared tauriInvoke seam — the old
  // `__TAURI__.window.getCurrentWindow()` read was DEAD CODE (withGlobalTauri
  // injects a core-only global; spec A).
  it("§1: the mousedown fallback calls plugin:window|start_dragging through __TAURI_INTERNALS__; buttons opt out; no bridge → a silent no-op", async () => {
    const calls: { cmd: string; args: unknown }[] = [];
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args: unknown) => { calls.push({ cmd, args }); return Promise.resolve(); },
    };
    const h = await connectedApp();
    const topbar = h.container.querySelector(".topbar") as HTMLElement;
    act(() => {
      topbar.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await flush(); // tauriStartDrag's promise settles
    // ω99-280 同类钉演进（回滚重做 T2a）：275 主题广播在挂载期经同一桥发
    // wudao-pet-theme（boot + settings 重应用，同值两发，消费者幂等）——
    // drag 的意图不弱化：window 命令过滤后仍恰为这一发；桥上其余只许是
    // 已知形状的环境广播，不许出现第三类命令。
    const win = () => calls.filter((c) => c.cmd !== "plugin:event|emit").map((c) => c.cmd);
    expect(win()).toEqual(["plugin:window|start_dragging"]);
    for (const c of calls) {
      if (c.cmd !== "plugin:event|emit") continue;
      expect((c.args as { event?: unknown })?.event).toBe("wudao-pet-theme");
    }
    // A button child never drags (the same closest("button") opt-out as the
    // attribute).
    act(() => {
      topbar.querySelector(".new-chat")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await flush();
    expect(win()).toHaveLength(1);
    // No bridge (plain browser) → tauriStartDrag resolves false, a no-op.
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    act(() => {
      topbar.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await flush();
    expect(win()).toHaveLength(1);
  });

  // workspace-ux C1: 双击最大化 rides the SAME mousedown handler — the
  // second click of a double-click (detail===2) toggles instead of dragging.
  // Not a DOM dblclick handler: the drag session the first click starts can
  // swallow the dblclick event on macOS Overlay (Tauri core.js implements
  // zoom the same way, via mousedown detail). Buttons and the chat area
  // never toggle.
  it("§1b: mousedown detail===2 on the topbar calls toggle_maximize (no second drag); buttons/chat-area opt out", async () => {
    const calls: { cmd: string; args: unknown }[] = [];
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args: unknown) => { calls.push({ cmd, args }); return Promise.resolve(); },
    };
    const h = await connectedApp();
    const topbar = h.container.querySelector(".topbar") as HTMLElement;
    // First click of the pair: drag. Second (detail===2): toggle.
    act(() => {
      topbar.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, detail: 1 }));
    });
    act(() => {
      topbar.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, detail: 2 }));
    });
    await flush();
    // ω99-280 同类钉演进（回滚重做 T2a）：同 §1——环境广播（wudao-pet-theme）
    // 过滤后钉 window 命令序列，广播本身钉形状。
    const win = () => calls.filter((c) => c.cmd !== "plugin:event|emit").map((c) => c.cmd);
    expect(win()).toEqual(["plugin:window|start_dragging", "plugin:window|toggle_maximize"]);
    for (const c of calls) {
      if (c.cmd !== "plugin:event|emit") continue;
      expect((c.args as { event?: unknown })?.event).toBe("wudao-pet-theme");
    }
    // A button child never toggles (same closest("button") opt-out).
    act(() => {
      topbar.querySelector(".new-chat")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, detail: 2 }));
    });
    await flush();
    expect(win()).toHaveLength(2);
    // The chat area double-click (text selection etc.) never toggles.
    const chat = h.container.querySelector(".messages, .chat, .center") as HTMLElement | null;
    if (chat !== null) {
      act(() => {
        chat.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, detail: 2 }));
      });
      await flush();
      expect(win()).toHaveLength(2);
    }
  });

  // workspace-ux B1: a pick re-roots the file PANEL through panelRootSet —
  // instant and busy-safe (view root only; the run, the draft, and the
  // session keep their footing). The recents row is recorded DRIVER-side, so
  // the wire carries the ONE op; the receipt's root drives the switcher label
  // and the tree remounts under it.
  it("§2: picking a recent sends panelRootSet (no add-write op), the notice lands, label + tree re-root", async () => {
    const h = await connectedApp([{ path: "/w/proj-b", lastUsed: "t" }]);
    // The connect-time agentRootStatus resolved the label to the real root.
    expect(h.container.querySelector(".ws-switcher .tree-root")?.textContent).toContain("wudao-harness");
    click(h.container.querySelector(".ws-switcher"));
    await drain(h, [{ path: "/w/proj-b", lastUsed: "t" }]); // the open-time recents fetch
    click(h.container.querySelector(".ws-menu .ws-item"));
    await drain(h); // the panelRootSet reply + the remounted tree's root fetch
    // ONE op on the wire for the pick — the driver records the recents row.
    expect(opFrames(h).some((f) => f.op.op === "panelRootSet" && f.op.path === "/w/proj-b")).toBe(true);
    expect(opFrames(h).some((f) => f.op.op === "recentWorkspaces" && f.op.add !== undefined)).toBe(false);
    expect(opFrames(h).some((f) => f.op.op === "switchWorkspace")).toBe(false);
    // 137：agent 根跟随出线——只应答 agentRootSwitch（fileTree 重取留给本测
    // 自定义的 proj-b 目录应答，不能被 drain 的空 entries 吃掉）。
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        for (const f of opFrames(h)) {
          if (h.answered.has(f.id) || f.op.op !== "agentRootSwitch") continue;
          h.answered.add(f.id);
          h.server.socket.serverSend({ t: "result", id: f.id, ok: { applied: true, queued: false } });
        }
      });
    }
    expect(h.container.querySelector(".chat")?.textContent).toContain("工作区已切换（agent 工作目录已跟随）→ /w/proj-b");
    // The switcher follows the receipt: basename label, full-path tooltip.
    expect(h.container.querySelector(".ws-switcher .tree-root")?.textContent).toContain("proj-b");
    expect(h.container.querySelector(".ws-switcher")?.getAttribute("title")).toBe("/w/proj-b");
    // And the tree rendered the NEW root's content: the remount's root fetch
    // is answered with proj-b's listing and its rows are in the DOM.
    const refetch = opFrames(h).find((f) => f.op.op === "fileTree" && f.op.path === "" && !h.answered.has(f.id));
    await act(async () => {
      if (refetch !== undefined) {
        h.answered.add(refetch.id);
        h.server.socket.serverSend({
          t: "result",
          id: refetch.id,
          ok: { entries: [{ name: "proj-b.md", type: "file", size: 7 }] },
        });
      }
    });
    await flush();
    expect([...h.container.querySelectorAll(".tree-node .name")].map((n) => n.textContent)).toEqual(["proj-b.md"]);
  });

  it("§2: 打开其他目录… v1 shows the CLI-restart notice (⚡ dialog plugin follow-up)", async () => {
    const h = await connectedApp();
    click(h.container.querySelector(".ws-switcher"));
    await drain(h);
    click(h.container.querySelector(".ws-menu .ws-open-other"));
    await flush();
    expect(h.container.querySelector(".chat")?.textContent).toContain("浏览器模式无法选择目录");
    // Nothing was written — the other-dir path adds no recents row in v1.
    expect(opFrames(h).some((f) => f.op.op === "recentWorkspaces" && f.op.add !== undefined)).toBe(false);
  });
});

// 极简模式工作空间切换（spec §3.1/§3.2）—— InputBox 的 controlsLead 槽
// 与 WorkspaceChip 的菜单行为。树顶 switcher 的行为语义（打开时拉取、
// 失败保留、max 5、打开其他目录…）不在此重测——hook 是同一份代码，上面
// 的 §2 用例就是它的回归。
describe("WorkspaceChip + controlsLead（极简工作空间切换）", () => {
  const recentsClient = (): FileOpsClient => ({
    fileTree: vi.fn(),
    fileRead: vi.fn(),
    recentWorkspaces: vi.fn(async () => ({
      workspaces: [
        { path: "/a/b/alpha", lastUsed: "2026-08-26T00:00:00Z" },
        { path: "/a/b/beta", lastUsed: "2026-08-25T00:00:00Z" },
      ],
    })),
  });

  it("§3.1: controlsLead 渲染在 .composer-tools 首位、📎 之前；不传则 DOM 不含该槽", () => {
    const lead = <span data-testid="lead" />;
    const withLead = mount(
      <InputBox
        busy={false}
        mode="workspace"
        commands={[]}
        connected={true}
        onSubmit={vi.fn()}
        onInterrupt={vi.fn()}
        onCycleMode={vi.fn()}
        onShield={vi.fn()}
        controlsLead={lead}
      />,
    );
    const tools = withLead.querySelector(".composer-tools") as HTMLElement;
    const leadEl = withLead.querySelector("[data-testid='lead']") as HTMLElement;
    const attach = tools.querySelector("button.attach") as HTMLElement;
    expect(leadEl).not.toBeNull();
    // lead precedes 📎 in the DOM (compareDocumentPosition: FOLLOWING bit set)
    expect(leadEl.compareDocumentPosition(attach) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 不传：槽不渲染，行为与现状同构
    const bare = mount(
      <InputBox
        busy={false}
        mode="workspace"
        commands={[]}
        connected={true}
        onSubmit={vi.fn()}
        onInterrupt={vi.fn()}
        onCycleMode={vi.fn()}
        onShield={vi.fn()}
      />,
    );
    expect(bare.querySelector("[data-testid='lead']")).toBeNull();
  });

  it("§3.2: chip 标签=basename、title=全路径；点开菜单渲染 recents + 打开其他目录…；选择项路由 onPick 且菜单关闭", async () => {
    const onPick = vi.fn();
    const c = mount(
      <WorkspaceChip client={recentsClient()} root="/w/cur" connected={true} onPick={onPick} onOpenOther={vi.fn()} />,
    );
    const chip = c.querySelector("button.chip.work") as HTMLButtonElement;
    expect(chip.textContent).toContain("cur");
    expect(chip.getAttribute("title")).toBe("/w/cur");
    click(chip);
    await flush();
    const items = [...c.querySelectorAll(".ws-menu .ws-item")];
    expect(items.map((i) => i.textContent)).toEqual(["alpha", "beta", "打开其他目录…"]);
    expect(items[0]?.getAttribute("title")).toBe("/a/b/alpha"); // basename 标签 + 全路径 tooltip
    click(items[0]);
    await flush();
    expect(onPick).toHaveBeenCalledWith("/a/b/alpha");
    expect(c.querySelector(".ws-menu")).toBeNull(); // 选后菜单关
  });

  it("§3.2: recentWorkspaces 缺失 → 菜单仅 打开其他目录…；点击路由 onOpenOther", async () => {
    const onOpenOther = vi.fn();
    const bare: FileOpsClient = { fileTree: vi.fn(), fileRead: vi.fn() };
    const c = mount(
      <WorkspaceChip client={bare} root="/w/cur" connected={true} onPick={vi.fn()} onOpenOther={onOpenOther} />,
    );
    click(c.querySelector("button.chip.work"));
    await flush();
    const items = [...c.querySelectorAll(".ws-menu .ws-item")];
    expect(items.map((i) => i.textContent)).toEqual(["打开其他目录…"]);
    click(items[0]);
    await flush();
    expect(onOpenOther).toHaveBeenCalledTimes(1);
  });

  it("§3.2: 断连 chip disabled；backdrop 点击关菜单", async () => {
    const c = mount(
      <WorkspaceChip client={recentsClient()} root="/w/cur" connected={false} onPick={vi.fn()} onOpenOther={vi.fn()} />,
    );
    expect((c.querySelector("button.chip.work") as HTMLButtonElement).disabled).toBe(true);
    // 连上后可用，backdrop 是关闭面
    const c2 = mount(
      <WorkspaceChip client={recentsClient()} root="/w/cur" connected={true} onPick={vi.fn()} onOpenOther={vi.fn()} />,
    );
    click(c2.querySelector("button.chip.work"));
    await flush();
    expect(c2.querySelector(".ws-menu")).not.toBeNull();
    click(c2.querySelector(".ws-backdrop"));
    await flush();
    expect(c2.querySelector(".ws-menu")).toBeNull();
  });
});

// 极简工作空间切换（spec §3.4）—— App 级接线：chip 进极简作曲家、选择走
// panelRootSet、确认卡挂作曲家上方并路由 agentRootSwitch。
describe("simple-mode workspace switch（App wiring）", () => {
  const RECENTS = [{ path: "/w/proj-b", lastUsed: "2026-08-26T00:00:00Z" }];

  it("极简模式：chip 在 .composer-tools 内 📎 之前，标签=当前根 basename；选 recents → 两根一起切（137：无确认卡）", async () => {
    const h = await connectedSimpleApp(RECENTS);
    const chip = h.container.querySelector(".composer-tools button.chip.work") as HTMLButtonElement;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toContain("wudao-harness"); // agentRootStatus 回的 ROOT basename
    const attach = h.container.querySelector(".composer-tools button.attach") as HTMLElement;
    expect(chip.compareDocumentPosition(attach) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    click(chip);
    await drain(h, RECENTS, "simple"); // 菜单打开 → recentWorkspaces 应答
    click(h.container.querySelector(".ws-menu .ws-item"));
    // 137 两跳链：panelRootSet 回执后 agentRootSwitch 才出线——逐轮排空。
    for (let i = 0; i < 4 && opFrames(h).some((f) => !h.answered.has(f.id)); i += 1) {
      await drain(h, [], "simple");
    }
    expect(opFrames(h).some((f) => f.op.op === "panelRootSet" && f.op.path === "/w/proj-b")).toBe(true);
    expect(opFrames(h).some((f) => f.op.op === "agentRootSwitch" && f.op.path === "/w/proj-b")).toBe(true);
    // 确认卡退役：不再升起。
    expect(h.container.querySelector(".approval.agent-root")).toBeNull();
  });
});
