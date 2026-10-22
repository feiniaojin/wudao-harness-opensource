// ω99-286: #7 — 断点续跑的 server op（"sessionContinue"）：sessionDelete/
// sessionRestore 同款三段门——typed 门（id 非 string 拒，driver 未被调）→
// driver 能力门（无该可选方法的干净拒答 + 连接存活）→ reply 直传结果联合
// （{started:true} 唯一成功形；false 收敛：id 不在 / 尾形 settled / busy）。
// 全 mock。
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

/** The minimal quiet driver port（283 scriptedDriver 同形）. */
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

describe("ω99-286 — sessionContinue op", () => {
  it("passes id to driver.continueSession verbatim; the verdict relays verbatim (both arms)", async () => {
    const calls: string[] = [];
    const outcomes = [{ started: true as const }, { started: false as const }];
    let n = 0;
    const driver = {
      ...scriptedDriver(),
      continueSession: async (id: string) => {
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
    c.ws.send(JSON.stringify({ t: "op", id: 91, op: { op: "sessionContinue", id: "o286-unfin-01" } }));
    await until(() => result(c, 91) !== undefined, "continue result 1");
    expect(result(c, 91)?.err).toBeUndefined();
    expect(result(c, 91)?.ok).toEqual({ started: true });
    // 第二发：settled/busy 拒答也原样回（web 侧按 started 分叉 toast）。
    c.ws.send(JSON.stringify({ t: "op", id: 92, op: { op: "sessionContinue", id: "o286-settled" } }));
    await until(() => result(c, 92) !== undefined, "continue result 2");
    expect(result(c, 92)?.ok).toEqual({ started: false });
    expect(calls).toEqual(["o286-unfin-01", "o286-settled"]); // id verbatim
    c.ws.close();
  });

  it("a non-string id is refused before the driver (typed shape gate)", async () => {
    const driver = { ...scriptedDriver(), continueSession: async () => { throw new Error("must not be called"); } };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 93, op: { op: "sessionContinue", id: 42 } }));
    await until(() => result(c, 93) !== undefined, "bad id result");
    const r = result(c, 93);
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
    c.ws.send(JSON.stringify({ t: "op", id: 94, op: { op: "sessionContinue", id: "o286-any-000001" } }));
    await until(() => result(c, 94) !== undefined, "unsupported result");
    expect(result(c, 94)?.err).toContain("not supported");
    // 连接活着（unsupported op 从不关连接）。
    c.ws.send(JSON.stringify({ t: "op", id: 95, op: { op: "listSlashCommands" } }));
    await until(() => result(c, 95) !== undefined, "still alive");
    c.ws.close();
  });
});
