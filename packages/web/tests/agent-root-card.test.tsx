// @vitest-environment jsdom
// 137（2026-11-02 用户报障「点击切换工作空间后没有真正切换过来」）——选
// 目录 = 一次点击两个根一起动：panelRootSet（文件面板）之后 agentRootSwitch
//（agent 工作目录）立即跟发。idle 立即生效；busy 由 driver 排队到本轮收束
//（排队态以通知说明，不中途换根）。B3 时代的两步确认卡退役：pick 不再 arm
// 任何卡，任何分支都不出现 .approval.agent-root。旧的 switchWorkspace 流程
// 维持退役：任何分支都不出线。
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WudaoClient } from "../src/protocol.js";
import { App } from "../src/components/App.js";
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
});

const ROOT = "/w/wudao-harness";
const PICK = "/w/proj-b";

interface Harness {
  container: HTMLElement;
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
  return { container, server, answered: new Set() };
}

type OpFrame = { id: number; op: { op: string; add?: string; path?: string } };

const opFrames = (h: Harness): OpFrame[] =>
  h.server
    .clientFrames()
    .filter((f): f is OpFrame => typeof f === "object" && f !== null && "op" in f && "id" in f);

/** What drain() answers the two scriptable ops with. */
interface Script {
  /** The agentRootSwitch reply (default: the idle land). */
  readonly switchResult?: { applied: boolean; queued: boolean };
}

/** Answer pending ops: settingsStatus (advanced shell), fileTree (empty),
 *  recentWorkspaces (the scripted list), agentRootStatus, panelRootSet (echo
 *  the path), agentRootSwitch (scripted), everything else a bare ok. */
async function drain(h: Harness, script: Script = {}, recents: readonly { path: string; lastUsed: string }[] = []): Promise<void> {
  await act(async () => {
    for (const f of opFrames(h)) {
      if (h.answered.has(f.id)) continue;
      h.answered.add(f.id);
      let ok: unknown = [];
      if (f.op.op === "settingsStatus") {
        ok = {
          providers: [],
          credentials: { path: "/root/.wudao/credentials.json", keyCount: 0 },
          settings: { memoryEnabled: false, uiDefaultMode: null, wizardCompletedVersion: 1, uiTheme: null, uiAccent: null },
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
      } else if (f.op.op === "agentRootSwitch") {
        ok = script.switchResult ?? { applied: true, queued: false };
      }
      h.server.socket.serverSend({ t: "result", id: f.id, ok });
    }
  });
}

/** A full state frame with overrides (the finish-notify harness shape) — a
 *  busy:true / busy:false pair drives the run lifecycle under test. */
function sendState(h: Harness, overrides: Record<string, unknown>): void {
  act(() => {
    h.server.socket.serverSend({
      t: "state",
      state: {
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
        sessionId: "wudao-test-0001",
        sidecar: null,
        ...overrides,
      },
    });
  });
}

async function connectedApp(script: Script = {}, recents: readonly { path: string; lastUsed: string }[] = []): Promise<Harness> {
  const h = mountedApp();
  await act(async () => {
    authOk(h.server.socket);
  });
  await drain(h, script, recents);
  await drain(h, script, recents); // the tree mounts behind the settingsStatus reply
  return h;
}

/** Pick PICK through the tree-top switcher (the recents dropdown). */
async function pickOther(h: Harness, script: Script = {}): Promise<void> {
  click(h.container.querySelector(".ws-switcher"));
  await drain(h, script, [{ path: PICK, lastUsed: "t" }]); // the open-time recents fetch
  click(h.container.querySelector(".ws-menu .ws-item"));
  // 137 的链是两跳（panelRootSet 回执后才发 agentRootSwitch）——逐轮排空，
  // 直到没有新帧（每轮 act 内解析上一轮回执触发的下一跳）。
  for (let i = 0; i < 4 && opFrames(h).some((f) => !h.answered.has(f.id)); i += 1) {
    await drain(h, script);
  }
}

const card = (h: Harness): Element | null => h.container.querySelector(".approval.agent-root");

describe("137 — 选目录一次切换两个根（workspace-ux B3 确认卡退役）", () => {
  it("idle pick → panelRootSet 与 agentRootSwitch 先后出线、同一路径；无确认卡；成功通知在场", async () => {
    const h = await connectedApp({}, [{ path: PICK, lastUsed: "t" }]);
    expect(card(h)).toBeNull(); // pick 前：无卡
    await pickOther(h);
    const panel = opFrames(h).find((f) => f.op.op === "panelRootSet");
    const agent = opFrames(h).find((f) => f.op.op === "agentRootSwitch");
    expect(panel?.op.path).toBe(PICK);
    expect(agent?.op.path).toBe(PICK); // 同一路径跟随，agent 根不再留在旧目录
    expect(card(h)).toBeNull(); // 两步确认卡不再 arm
    expect(h.container.querySelector(".chat")?.textContent).toContain("工作区已切换（agent 工作目录已跟随）");
    // 旧流程维持退役。
    expect(opFrames(h).some((f) => f.op.op === "switchWorkspace")).toBe(false);
  });

  it("busy pick → agentRootSwitch 回 {queued:true}：排队通知在场，无卡（driver 在轮界落地）", async () => {
    const h = await connectedApp();
    sendState(h, { busy: true });
    await flush();
    await pickOther(h, { switchResult: { applied: false, queued: true } });
    expect(opFrames(h).some((f) => f.op.op === "agentRootSwitch" && f.op.path === PICK)).toBe(true);
    expect(card(h)).toBeNull();
    expect(h.container.querySelector(".chat")?.textContent).toContain("工作区切换已排队——当前任务结束后生效");
    expect(opFrames(h).some((f) => f.op.op === "switchWorkspace")).toBe(false);
  });

  it("agentRootSwitch 失败 → 面板已切的失败通知（不静默），无卡可答", async () => {
    const h = await connectedApp();
    click(h.container.querySelector(".ws-switcher"));
    await drain(h, {}, [{ path: PICK, lastUsed: "t" }]);
    click(h.container.querySelector(".ws-menu .ws-item"));
    // panelRootSet 正常回，agentRootSwitch 以 driver 的类型化错误拒绝。
    for (let round = 0; round < 4; round += 1) {
      await act(async () => {
        for (const f of opFrames(h)) {
          if (h.answered.has(f.id)) continue;
          h.answered.add(f.id);
          const ok = f.op.op === "panelRootSet" ? { root: f.op.path } : [];
          if (f.op.op === "agentRootSwitch") {
            h.server.socket.serverSend({ t: "result", id: f.id, err: "no such directory: /w/proj-b" });
          } else {
            h.server.socket.serverSend({ t: "result", id: f.id, ok });
          }
        }
      });
    }
    await flush();
    expect(card(h)).toBeNull();
    expect(h.container.querySelector(".chat")?.textContent).toContain("agent 工作目录切换失败");
    expect(h.container.querySelector(".chat")?.textContent).toContain("文件面板已切到 /w/proj-b");
  });

  it("panelRootSet 失败 → 原失败通知，agentRootSwitch 不出线", async () => {
    const h = await connectedApp();
    click(h.container.querySelector(".ws-switcher"));
    await drain(h, {}, [{ path: PICK, lastUsed: "t" }]);
    click(h.container.querySelector(".ws-menu .ws-item"));
    for (let round = 0; round < 4; round += 1) {
      await act(async () => {
        for (const f of opFrames(h)) {
          if (h.answered.has(f.id)) continue;
          h.answered.add(f.id);
          if (f.op.op === "panelRootSet") {
            h.server.socket.serverSend({ t: "result", id: f.id, err: "no such directory: /w/proj-b" });
          } else {
            h.server.socket.serverSend({ t: "result", id: f.id, ok: [] });
          }
        }
      });
    }
    await flush();
    expect(opFrames(h).some((f) => f.op.op === "agentRootSwitch")).toBe(false);
    expect(h.container.querySelector(".chat")?.textContent).toContain("切换失败");
  });
});
