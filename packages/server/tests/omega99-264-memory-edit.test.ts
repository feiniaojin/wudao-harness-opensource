// ω99-264: #2 — memoryEdit op（server 半边）R 件：入 vault 表直证（同 cid 重放
// 收敛——恰一次 driver 调用 + 缓存回执复播，与 R1 的 driver 短路合成完整重放
// 收敛链）；unsupported 干净拒答（老 driver 降级不 close）；typed gates（id/
// content 非空 string——改写不得成空记忆，空串/纯空白/非 string 全拒）在
// driver 之前。全 mock（scripted driver 零真 store 零真模型零网络）；本包测试
// 不落任何文件（零删除原语，★红线）。
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

/** The minimal quiet driver port (260 R2 同形，inlined): every op the relay
 *  needs to boot, none of the run machinery. */
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

describe("ω99-264 R2 — memoryEdit op（改写，面二 server 半边）", () => {
  it("round-trips the {ok, message} verdict; the typed args reach the driver verbatim", async () => {
    const calls: { id: string; content: string }[] = [];
    const driver = {
      ...scriptedDriver(),
      memoryEdit: async (id: string, content: string) => {
        calls.push({ id, content });
        return { ok: true, message: "已改写一条记忆" };
      },
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 51, op: { op: "memoryEdit", id: "m-a", content: "称呼我用「您」" } }));
    await until(() => result(c, 51) !== undefined, "edit result");
    expect(result(c, 51)?.ok).toEqual({ ok: true, message: "已改写一条记忆" });
    expect(calls).toEqual([{ id: "m-a", content: "称呼我用「您」" }]); // content 原样（含全角/空白，不做 server 侧 trim 改写）
    c.ws.close();
  });

  it("shape-gates: empty/missing/non-string id 与 missing/empty/whitespace/non-string content → typed err，driver 绝不 reached", async () => {
    const calls: unknown[] = [];
    const driver = {
      ...scriptedDriver(),
      memoryEdit: async (id: string, content: string) => { calls.push([id, content]); return { ok: true, message: "x" }; },
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    // id gates
    c.ws.send(JSON.stringify({ t: "op", id: 61, op: { op: "memoryEdit", id: "", content: "c" } }));
    c.ws.send(JSON.stringify({ t: "op", id: 62, op: { op: "memoryEdit", content: "c" } }));
    c.ws.send(JSON.stringify({ t: "op", id: 63, op: { op: "memoryEdit", id: 7, content: "c" } }));
    // content gates（改写不得成空记忆：空串/纯空白同拒）
    c.ws.send(JSON.stringify({ t: "op", id: 64, op: { op: "memoryEdit", id: "m-a", content: "" } }));
    c.ws.send(JSON.stringify({ t: "op", id: 65, op: { op: "memoryEdit", id: "m-a" } }));
    c.ws.send(JSON.stringify({ t: "op", id: 66, op: { op: "memoryEdit", id: "m-a", content: "   " } }));
    c.ws.send(JSON.stringify({ t: "op", id: 67, op: { op: "memoryEdit", id: "m-a", content: 42 } }));
    await until(() => [61, 62, 63, 64, 65, 66, 67].every((id) => result(c, id) !== undefined), "all gate results");
    for (const id of [61, 62, 63]) expect(result(c, id)?.err).toContain("id");
    for (const id of [64, 65, 66, 67]) expect(result(c, id)?.err).toContain("content");
    expect(calls).toEqual([]); // typed rejects happen BEFORE the driver call
    expect(c.ws.readyState).toBe(WebSocket.OPEN); // an op error never closes
    c.ws.close();
  });

  it("a driver without the op errors cleanly (old server degradation)", async () => {
    const server = await createUiServer({ driver: scriptedDriver(), token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 71, op: { op: "memoryEdit", id: "m-a", content: "新内容" } }));
    await until(() => result(c, 71) !== undefined, "edit result");
    expect(result(c, 71)?.err).toBe("memoryEdit not supported by this driver");
    c.ws.close();
  });

  it("memoryEdit IS vaulted — 同 cid 重放恰一次 driver 调用 + 缓存回执复播（R1 短路的 server 半边合成链）", async () => {
    let calls = 0;
    const driver = {
      ...scriptedDriver(),
      memoryEdit: async () => { calls += 1; return { ok: true, message: "已改写一条记忆" }; },
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    expect(isVaultedMutation({ op: "memoryEdit", id: "m-a", content: "新内容" })).toBe(true);
    c.ws.send(JSON.stringify({ t: "op", id: 2, cid: "c1", op: { op: "memoryEdit", id: "m-a", content: "新内容" } }));
    await until(() => result(c, 2) !== undefined, "first edit result");
    // the mid-flap retry: same cid + same envelope id + same payload
    c.ws.send(JSON.stringify({ t: "op", id: 2, cid: "c1", op: { op: "memoryEdit", id: "m-a", content: "新内容" } }));
    await until(() => c.frames.filter((f) => (f as { t?: string; id?: number }).t === "result" && (f as { id?: number }).id === 2).length >= 2, "the replayed result");
    expect(calls).toBe(1); // exactly-once: the retry served the cached verdict
    const replies = c.frames.filter((f) => (f as { t?: string; id?: number }).t === "result" && (f as { id?: number }).id === 2);
    expect(replies.every((r) => (r as { ok?: unknown }).ok != null && (r as { err?: string }).err === undefined)).toBe(true);
    c.ws.close();
  });
});
