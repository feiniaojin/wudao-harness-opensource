// @vitest-environment jsdom
// workspace-ux B3 (spec B·Web 交互流) — the agent-root confirm card: a
// successful directory pick (panelRootSet) arms a TRANSIENT action card in
// the composition area (the permission-ask slot's form — never
// history-embedded buttons). Two answers, both ALWAYS clickable:
//
//   切换 agent 目录 — idle → agentRootSwitch lands now ({applied:true}); the
//     receipt is the DRIVER's history notice (「agent 工作目录已切换 → …」) —
//     the web never re-appends it. busy → {queued:true}, the card parks in the
//     「将在当前任务结束后切换」 state (buttons hidden — the pending switch is
//     locked server-side, there is no un-park op); the busy→idle settle
//     refreshes via agentRootStatus and dismisses the card once aligned.
//   保持现状 — the card dismisses with a WEB notice (the existing notify
//     channel); no agentRootSwitch op ever fires.
//
// The old switchWorkspace flow stays retired: no op crosses the wire in any
// branch (B1 removed the call sites; B3 keeps them removed).
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
const SWITCH_NOTICE = `agent 工作目录已切换 → proj-b (${PICK})`;

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

/** What drain() answers the two B2/B3-scriptable ops with. */
interface Script {
  /** The agentRootSwitch reply (default: the idle land). */
  readonly switchResult?: { applied: boolean; queued: boolean };
  /** The agentRootStatus reply (default: aligned at ROOT). */
  readonly rootStatus?: { panelRoot: string; agentRoot: string; aligned: boolean };
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
        ok = script.rootStatus ?? { panelRoot: ROOT, agentRoot: ROOT, aligned: true };
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

/** The driver's history-channel notice — what a real server pushes when the
 *  switch lands (idle apply or settle seam). */
function pushNotice(h: Harness, text: string): void {
  act(() => {
    h.server.socket.serverSend({ t: "history", entries: [{ kind: "notice", text }], reset: false });
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

/** Pick PICK through the tree-top switcher (the recents dropdown) — the
 *  panelRootSet flow under test, ending with the card armed. */
async function pickOther(h: Harness, script: Script = {}): Promise<void> {
  click(h.container.querySelector(".ws-switcher"));
  await drain(h, script, [{ path: PICK, lastUsed: "t" }]); // the open-time recents fetch
  click(h.container.querySelector(".ws-menu .ws-item"));
  await drain(h, script); // the panelRootSet reply + the remounted tree's root fetch
}

const card = (h: Harness): Element | null => h.container.querySelector(".approval.agent-root");
const cardButton = (h: Harness, cls: string): HTMLButtonElement | null =>
  card(h)?.querySelector<HTMLButtonElement>(`.btns button.${cls}`) ?? null;

describe("agent-root confirm card (workspace-ux B3)", () => {
  it("a pick arms the card in the composition area with BOTH basenames and both buttons; no switchWorkspace op", async () => {
    const h = await connectedApp({}, [{ path: PICK, lastUsed: "t" }]);
    expect(card(h)).toBeNull(); // closed until a pick
    await pickOther(h);
    const c = card(h);
    expect(c).not.toBeNull();
    // Spec §B.46 copy: the new panel basename AND the old agent basename.
    expect(c?.textContent).toContain("文件面板已切换到 proj-b");
    expect(c?.textContent).toContain("agent 的工作目录仍为 wudao-harness");
    expect(cardButton(h, "deny")?.textContent).toBe("保持现状");
    expect(cardButton(h, "allow")?.textContent).toBe("切换 agent 目录");
    // The retired flow never crosses the wire.
    expect(opFrames(h).some((f) => f.op.op === "switchWorkspace")).toBe(false);
  });

  it("idle 切换 → the agentRootSwitch op carries the picked path; the DRIVER notice renders exactly once; the card dismisses", async () => {
    const h = await connectedApp();
    await pickOther(h);
    click(cardButton(h, "allow"));
    await drain(h); // {applied:true, queued:false}
    expect(opFrames(h).some((f) => f.op.op === "agentRootSwitch" && f.op.path === PICK)).toBe(true);
    // The card is gone — no local receipt copy; the driver's notice is the one
    // landing (pushed here as the real server would).
    expect(card(h)).toBeNull();
    pushNotice(h, SWITCH_NOTICE);
    await flush();
    expect(h.container.textContent).toContain(SWITCH_NOTICE);
    // No web-side duplicate: the switch text appears exactly once in the DOM.
    expect((h.container.textContent ?? "").split(SWITCH_NOTICE).length - 1).toBe(1);
    expect(opFrames(h).some((f) => f.op.op === "switchWorkspace")).toBe(false);
  });

  it("busy 切换 → the button stays clickable, the card parks in the queued state; busy→idle settles → aligned → dismissed + notice", async () => {
    const h = await connectedApp();
    await pickOther(h);
    sendState(h, { busy: true });
    await flush();
    const btn = cardButton(h, "allow");
    expect(btn?.disabled).toBe(false); // ALWAYS clickable — run-busy is the op's business
    click(btn);
    await drain(h, { switchResult: { applied: false, queued: true } });
    expect(opFrames(h).some((f) => f.op.op === "agentRootSwitch" && f.op.path === PICK)).toBe(true);
    // The parked state: the queued copy, buttons hidden (no un-park op exists).
    const c = card(h);
    expect(c?.textContent).toContain("将在当前任务结束后切换");
    expect(c?.querySelector("button")).toBeNull();
    // The run settles: busy→idle re-checks via agentRootStatus; aligned dismisses.
    sendState(h, { busy: false });
    await drain(h, { rootStatus: { panelRoot: PICK, agentRoot: PICK, aligned: true } });
    expect(card(h)).toBeNull();
    pushNotice(h, SWITCH_NOTICE); // the driver's settle-seam notice
    await flush();
    expect(h.container.textContent).toContain(SWITCH_NOTICE);
    expect(opFrames(h).some((f) => f.op.op === "switchWorkspace")).toBe(false);
  });

  it("queued settle RACE: a not-yet-aligned first reply keeps the card; the seam's own status frame re-checks and dismisses", async () => {
    const h = await connectedApp();
    await pickOther(h);
    sendState(h, { busy: true });
    await flush();
    click(cardButton(h, "allow"));
    await drain(h, { switchResult: { applied: false, queued: true } });
    expect(card(h)?.textContent).toContain("将在当前任务结束后切换");
    // busy→idle, but the frame RACED the settle seam — the roots do not align
    // yet. The card stays queued (no buttons resurrect, no dismissal).
    sendState(h, { busy: false });
    await drain(h, { rootStatus: { panelRoot: PICK, agentRoot: ROOT, aligned: false } });
    expect(card(h)).not.toBeNull();
    expect(card(h)?.querySelector("button")).toBeNull();
    // The seam applies the root and pokes the status channel: that idle frame
    // re-checks, reads aligned, and dismisses.
    sendState(h, { busy: false });
    await drain(h, { rootStatus: { panelRoot: PICK, agentRoot: PICK, aligned: true } });
    expect(card(h)).toBeNull();
  });

  it("保持现状 → a web notice lands, the card dismisses, and NO agentRootSwitch op fires", async () => {
    const h = await connectedApp();
    await pickOther(h);
    click(cardButton(h, "deny"));
    await flush();
    expect(card(h)).toBeNull();
    expect(h.container.querySelector(".chat")?.textContent).toContain(`agent 工作目录保持不变 → wudao-harness (${ROOT})`);
    expect(opFrames(h).some((f) => f.op.op === "agentRootSwitch")).toBe(false);
    expect(opFrames(h).some((f) => f.op.op === "switchWorkspace")).toBe(false);
  });

  it("a failed switch keeps the card answerable with the error notice (no silent dismissal)", async () => {
    const h = await connectedApp();
    await pickOther(h);
    click(cardButton(h, "allow"));
    // Reject the op the way a real server would (typed error from the driver).
    await act(async () => {
      const f = opFrames(h).find((x) => x.op.op === "agentRootSwitch" && !h.answered.has(x.id));
      if (f !== undefined) {
        h.answered.add(f.id);
        h.server.socket.serverSend({ t: "result", id: f.id, err: "no such directory: /w/proj-b" });
      }
    });
    await flush();
    expect(card(h)).not.toBeNull(); // still armed, still answerable
    expect(h.container.querySelector(".chat")?.textContent).toContain("切换 agent 工作目录失败");
  });
});
