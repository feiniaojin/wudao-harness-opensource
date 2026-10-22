// ω99-279: #14 — 回收站式删除的 server op（"sessionDelete"）：{id} 直传
// driver.deleteSession、结果原样回；id 非 string typed 拒（driver 未被调）；
// driver 无该可选方法的干净拒答（277 #9 同形：unsupported 形 + 连接存活）。
// 全 mock，零真文件零网络。
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { createUiServer, type UiDriverPort, type UiServer } from "../src/index.js";

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

/** The minimal quiet driver port (277 #9's scriptedDriver shape). */
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

describe("ω99-279 — sessionDelete op", () => {
  it("passes id to driver.deleteSession verbatim; the result relays verbatim (all three refusal reasons too)", async () => {
    const calls: string[] = [];
    const outcomes = [
      { deleted: true as const },
      { deleted: false as const, reason: "active" as const },
    ];
    let n = 0;
    const driver = {
      ...scriptedDriver(),
      deleteSession: async (id: string) => {
        calls.push(id);
        return outcomes[n++]!;
      },
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 71, op: { op: "sessionDelete", id: "sess-del-0001" } }));
    await until(() => result(c, 71) !== undefined, "delete result 1");
    const r1 = result(c, 71);
    expect(r1?.err).toBeUndefined();
    expect(r1?.ok).toEqual({ deleted: true });
    // 第二发：active 拒答也原样回（web 侧按 reason 分叉 toast）。
    c.ws.send(JSON.stringify({ t: "op", id: 72, op: { op: "sessionDelete", id: "sess-live-0001" } }));
    await until(() => result(c, 72) !== undefined, "delete result 2");
    expect(result(c, 72)?.ok).toEqual({ deleted: false, reason: "active" });
    expect(calls).toEqual(["sess-del-0001", "sess-live-0001"]); // id verbatim
    c.ws.close();
  });

  it("a non-string id is refused before the driver (typed shape gate)", async () => {
    const driver = { ...scriptedDriver(), deleteSession: async () => { throw new Error("must not be called"); } };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 73, op: { op: "sessionDelete", id: 42 } }));
    await until(() => result(c, 73) !== undefined, "bad id result");
    const r = result(c, 73);
    expect(r?.err).toContain("id");
    expect((r as { ok?: unknown })?.ok).toBeUndefined();
    c.ws.close();
  });

  it("a driver without the op errors cleanly (old driver degradation, never a close)", async () => {
    const server = await createUiServer({ driver: scriptedDriver(), token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 74, op: { op: "sessionDelete", id: "sess-any-00001" } }));
    await until(() => result(c, 74) !== undefined, "unsupported result");
    const r = result(c, 74);
    expect(r?.err).toContain("not supported");
    // 连接活着（malformed/unsupported op 从不关连接）。
    c.ws.send(JSON.stringify({ t: "op", id: 75, op: { op: "listSlashCommands" } }));
    await until(() => result(c, 75) !== undefined, "still alive");
    c.ws.close();
  });
});
