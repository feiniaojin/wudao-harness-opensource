// ω99-260: #2 — 面二（server 两 op）R 件：memoryList 读形（UiDriverPort 可选
// + unsupported 干净拒答 + 不进 vault 直证——258 branchLeaves 同形）与
// memoryDecide 决定形（入 vault 表直证——ok/del 幂等，重放二次 ok:false 不破；
// 入口校验 id 非空 string + action enum typed 拒）。全 mock（scripted driver
// 零真 store 零真模型零网络）；本包测试不落任何文件（★红线）。
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { createUiServer, isVaultedMutation, type UiDriverPort, type UiServer } from "../src/index.js";

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

/** The minimal quiet driver port (server.test.ts's scriptedDriver shape,
 *  inlined — that file exports nothing): every op the relay needs to boot,
 *  none of the run machinery. */
function scriptedDriver(): UiDriverPort {
  return {
    subscribe: () => () => {},
    getStatus: () => ({ live: { reasoning: "", answer: "", busyTools: [] }, busy: false, mode: "default" }),
    getHistory: () => [],
    onHistory: () => () => {},
    onLoopEvent: () => () => {},
    submit: () => "started",
    interrupt: () => {},
    setMode: () => {},
    answerPermission: () => false,
    listSlashCommands: () => [],
    sessions: async () => [],
    resume: async () => ({ ok: true }),
    rewind: async () => "rewound",
    beginEdit: () => undefined,
    tree: async () => "(tree)",
    switchBranch: async () => "(branches)",
  };
}

const ENTRIES = {
  entries: [
    {
      id: "m-a",
      kind: "preference",
      content: "称呼我用「老板」",
      scope: "user",
      tags: [],
      created: "2026-09-01T00:00:00.000Z",
      hits: 0,
      status: "pending",
      surfaced: true,
      seq: 1,
      version: 1,
    },
  ],
};

interface Client {
  ws: WebSocket;
  frames: unknown[];
  open: Promise<void>;
}
const connect = (port: number): Client => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames: unknown[] = [];
  const open = new Promise<void>((resolve) => ws.once("open", resolve));
  ws.on("message", (m) => frames.push(JSON.parse(String(m))));
  return { ws, frames, open };
};
const result = (c: Client, id: number): { ok?: unknown; err?: string } | undefined =>
  (c.frames.find((f) => (f as { t?: string; id?: number }).t === "result" && (f as { id?: number }).id === id) ?? undefined) as
    | { ok?: unknown; err?: string }
    | undefined;

describe("ω99-260 R2 — memoryList 读 op（面二）", () => {
  it("round-trips the driver's structured table verbatim", async () => {
    const driver = { ...scriptedDriver(), memoryList: async () => ENTRIES };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 41, op: { op: "memoryList" } }));
    await until(() => result(c, 41) !== undefined, "memoryList result");
    const r = result(c, 41);
    expect(r?.err).toBeUndefined();
    expect(r?.ok).toEqual(ENTRIES);
    c.ws.close();
  });

  it("a driver without the op errors cleanly (old server degradation, never a close)", async () => {
    const server = await createUiServer({ driver: scriptedDriver(), token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 42, op: { op: "memoryList" } }));
    await until(() => result(c, 42) !== undefined, "memoryList result");
    const r = result(c, 42);
    expect(r?.ok).toBeUndefined();
    expect(r?.err).toBe("memoryList not supported by this driver");
    expect(c.ws.readyState).toBe(WebSocket.OPEN); // an op error never closes
    c.ws.close();
  });

  it("memoryList is a READ — never vaulted (two identical cid frames execute twice)", async () => {
    let calls = 0;
    const driver = { ...scriptedDriver(), memoryList: async () => { calls += 1; return ENTRIES; } };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 1, cid: "c1", op: { op: "memoryList" } }));
    c.ws.send(JSON.stringify({ t: "op", id: 1, cid: "c1", op: { op: "memoryList" } }));
    await until(() => c.frames.filter((f) => (f as { t?: string }).t === "result").length >= 2, "both results");
    expect(calls).toBe(2); // a cached read would serve stale data — reads never vault
    expect(isVaultedMutation({ op: "memoryList" })).toBe(false);
    c.ws.close();
  });
});

describe("ω99-260 R2 — memoryDecide 决定 op（面二）", () => {
  it("round-trips the {ok, message} verdict; the typed args reach the driver verbatim", async () => {
    const calls: { id: string; action: string }[] = [];
    const driver = {
      ...scriptedDriver(),
      memoryDecide: async (id: string, action: "ok" | "del") => {
        calls.push({ id, action });
        return { ok: true, message: "已确认一条记忆" };
      },
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 51, op: { op: "memoryDecide", id: "m-a", action: "ok" } }));
    await until(() => result(c, 51) !== undefined, "decide result");
    expect(result(c, 51)?.ok).toEqual({ ok: true, message: "已确认一条记忆" });
    expect(calls).toEqual([{ id: "m-a", action: "ok" }]);
    c.ws.close();
  });

  it("shape-gates: empty/missing id and non-enum action → typed err, the driver is never reached", async () => {
    const calls: unknown[] = [];
    const driver = {
      ...scriptedDriver(),
      memoryDecide: async (id: string, action: "ok" | "del") => { calls.push([id, action]); return { ok: true, message: "x" }; },
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 61, op: { op: "memoryDecide", id: "", action: "ok" } }));
    c.ws.send(JSON.stringify({ t: "op", id: 62, op: { op: "memoryDecide", action: "ok" } }));
    c.ws.send(JSON.stringify({ t: "op", id: 63, op: { op: "memoryDecide", id: "m-a", action: "keep" } }));
    c.ws.send(JSON.stringify({ t: "op", id: 64, op: { op: "memoryDecide", id: "m-a" } }));
    c.ws.send(JSON.stringify({ t: "op", id: 65, op: { op: "memoryDecide", id: 7, action: "ok" } }));
    await until(() => [61, 62, 63, 64, 65].every((id) => result(c, id) !== undefined), "all gate results");
    for (const id of [61, 62, 65]) expect(result(c, id)?.err).toContain("id"); // 65: a non-string id fails the id gate first
    for (const id of [63, 64]) expect(result(c, id)?.err).toContain("action");
    expect(calls).toEqual([]); // typed rejects happen BEFORE the driver call
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });

  it("memoryDecide IS vaulted — a same-cid retry replays the cached verdict, never re-executes", async () => {
    let calls = 0;
    const driver = {
      ...scriptedDriver(),
      memoryDecide: async () => { calls += 1; return { ok: true, message: "已确认一条记忆" }; },
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    expect(isVaultedMutation({ op: "memoryDecide", id: "m-a", action: "ok" })).toBe(true);
    c.ws.send(JSON.stringify({ t: "op", id: 2, cid: "c1", op: { op: "memoryDecide", id: "m-a", action: "ok" } }));
    await until(() => result(c, 2) !== undefined, "first decide result");
    // the mid-flap retry: same cid + same envelope id + same payload
    c.ws.send(JSON.stringify({ t: "op", id: 2, cid: "c1", op: { op: "memoryDecide", id: "m-a", action: "ok" } }));
    await until(() => c.frames.filter((f) => (f as { t?: string; id?: number }).t === "result" && (f as { id?: number }).id === 2).length >= 2, "the replayed result");
    expect(calls).toBe(1); // exactly-once: the retry served the cached verdict
    const replies = c.frames.filter((f) => (f as { t?: string; id?: number }).t === "result" && (f as { id?: number }).id === 2);
    expect(replies.every((r) => (r as { ok?: unknown }).ok != null && (r as { err?: string }).err === undefined)).toBe(true);
    c.ws.close();
  });

  it("a driver without the op errors cleanly (old server degradation)", async () => {
    const server = await createUiServer({ driver: scriptedDriver(), token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 71, op: { op: "memoryDecide", id: "m-a", action: "ok" } }));
    await until(() => result(c, 71) !== undefined, "decide result");
    expect(result(c, 71)?.err).toBe("memoryDecide not supported by this driver");
    c.ws.close();
  });
});
