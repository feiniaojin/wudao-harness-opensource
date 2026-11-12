// 0.5.10 — 状态帧发送路径零 await 的回归钉（Windows 报障「提问后不流式、
// 等很久一次性出现」的 server 侧隐患根因：旧形每帧 await pet.agentRootStatus
// realpath、串行链排队——慢 realpath 机器上 UI 生命线被 workspace 读拖住）。
// 新形：发送时刻只读 TTL 缓存（同步），旁路 fire-and-forget 刷新。
//
// 三个钉：
//   1) agentRootStatus 慢/卡（500ms 仍未 resolve）——状态帧照发、pet 字段无
//      workspaceName/workspacePath（缓缺席边界），帧流不被等；
//   2) 缓存 TTL（2s）——工作区切换后帧带新的 workspaceName（不陈旧）；
//   3) 无 agentRootStatus 面（降级旧 driver）——帧照常、字段缺席。
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { createUiServer, type UiServer } from "../src/index.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const servers: UiServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

interface Frame { t: string; pet?: Record<string, unknown> }

/** The 0.5.10 harness shape: main + pet lane; pet's agentRootStatus controllable
 *  (a defer gate for the slow-read test, a swapable root for the TTL test). */
function petDriverHarness(opts: { slowAgentRootStatus?: boolean } = {}) {
  let petStatusCbs = new Set<() => void>();
  const petStatus = { live: { reasoning: "", answer: "", busyTools: [] }, busy: false };
  let root = "/w/initial";
  let agentRootResolve: (() => void) | null = null;
  const mainDriver = {
    subscribe: (cb: () => void) => () => { void cb; },
    getStatus: () => ({ live: { reasoning: "", answer: "", busyTools: [] }, busy: false }),
    getHistory: () => [],
    onHistory: () => () => {},
    onLoopEvent: () => () => {},
    interrupt: () => {},
    submit: () => "started",
    answerPermission: () => false,
    sessions: async () => [],
    resume: async () => ({ ok: true }),
    rewind: async () => "rewound",
    listSlashCommands: () => [],
  };
  const petDriver = {
    subscribe: (cb: () => void) => (petStatusCbs.add(cb), () => petStatusCbs.delete(cb)),
    getStatus: () => petStatus,
    getHistory: () => [],
    interrupt: () => {},
    submit: () => "started",
    ...(opts.slowAgentRootStatus
      ? {
          agentRootStatus: () =>
            new Promise<{ agentRoot: string }>((resolve) => {
              agentRootResolve = () => resolve({ agentRoot: root });
            }),
        }
      : {
          agentRootStatus: async () => ({ agentRoot: root }),
        }),
  };
  return {
    mainDriver,
    petDriver,
    setRoot(r: string): void {
      root = r;
    },
    pokePet(): void {
      for (const cb of [...petStatusCbs]) cb();
    },
    releaseAgentRoot(): void {
      const r = agentRootResolve;
      agentRootResolve = null;
      r?.();
    },
  };
}

function connect(port: number): { ws: WebSocket; frames: Frame[]; open: Promise<void> } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: Frame[] = [];
  let onOpen: () => void;
  const open = new Promise<void>((resolve) => (onOpen = resolve));
  ws.on("open", () => onOpen());
  ws.on("message", (d) => {
    try {
      frames.push(JSON.parse(d.toString()));
    } catch {
      /* bad frame — the test would time out honestly */
    }
  });
  return { ws, frames, open };
}

const auth = (ws: WebSocket, token: string): void => {
  ws.send(JSON.stringify({ t: "auth", token }));
};

describe("0.5.10 — state frames never await the workspace read (pet workspace TTL cache)", () => {
  it("a hung agentRootStatus never delays a state frame — the frame ships without the workspace pair", async () => {
    const h = petDriverHarness({ slowAgentRootStatus: true });
    const server = await createUiServer({ driver: h.mainDriver, petDriver: h.petDriver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    auth(c.ws, "t");
    // Prime the cache path: poke → pushState fires → frames flow. With the
    // read gated, the FIRST frame has no workspace pair (cache absent), the
    // ping interval is off-scale for the test — poke explicitly.
    h.pokePet();
    await until(() => c.frames.filter((f) => f.t === "state").length >= 1, "first state frame");
    const first = c.frames.filter((f) => f.t === "state").at(-1)!;
    expect(first.pet).toBeDefined();
    expect(first.pet?.workspaceName).toBeUndefined();
    expect(first.pet?.workspacePath).toBeUndefined();
    // Keep poking while the read stays gated: frames must keep coming (the
    // old serial chain would backlog these behind the pending realpath).
    for (let i = 0; i < 5; i += 1) {
      h.pokePet();
      await wait(15);
    }
    const states = c.frames.filter((f) => f.t === "state");
    expect(states.length).toBeGreaterThanOrEqual(3);
    // Now release the read; the NEXT poke refreshes the cache and the frame
    // carries the workspace pair (path → basename).
    h.releaseAgentRoot();
    await until(() => c.frames.some((f) => f.t === "state" && f.pet?.workspaceName === "initial"), "cache primed frame");
  });

  it("the TTL refresh picks up a workspace root change within one refresh window", async () => {
    const h = petDriverHarness();
    const server = await createUiServer({ driver: h.mainDriver, petDriver: h.petDriver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    auth(c.ws, "t");
    // Prime the cache with the initial root.
    h.pokePet();
    await until(() => c.frames.some((f) => f.t === "state" && f.pet?.workspaceName === "initial"), "initial workspace frame");
    // Switch the root; past the 2s TTL a subsequent poke must reflect it.
    h.setRoot("/w/switched");
    await wait(2100);
    h.pokePet();
    await until(() => c.frames.some((f) => f.t === "state" && f.pet?.workspaceName === "switched"), "switched workspace frame");
    const last = c.frames.filter((f) => f.t === "state" && f.pet?.workspaceName === "switched").at(-1)!;
    expect(last.pet?.workspacePath).toBe("/w/switched");
  });
});
