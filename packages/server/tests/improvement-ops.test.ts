// 永续 v6 wave2（the upstream project C1）——improvementFace op 的 server 件：list 读形
// （UiDriverPort 可选 + unsupported 干净拒答 + 不进 vault 直证）+ 决策形
// （入 vault 表直证——五决策恰一次；形状门：action 枚举 + 决策必带非空 id
// typed 拒）。全 mock（scripted driver 零真 store 零真模型零子进程零网络）；
// 本包测试不落任何文件（★红线）。
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

const RECORDS = {
  ok: true,
  message: "",
  records: [
    {
      id: "p1-a1b2c3d4",
      fingerprint: "a".repeat(64),
      subject: "npm test",
      stage: "gate",
      count: 3,
      streak: 3,
      status: "offered",
      attempts: 0,
      preview: "npm test exited 1",
      createdAt: "2026-09-15T00:00:00.000Z",
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

describe("永续 v6 wave2 — improvementFace list 读形", () => {
  it("round-trips the driver's structured rows verbatim; never vaulted", async () => {
    let calls = 0;
    const driver = { ...scriptedDriver(), improvementFace: async () => { calls += 1; return RECORDS; } };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 1, cid: "c1", op: { op: "improvementFace", action: "list" } }));
    c.ws.send(JSON.stringify({ t: "op", id: 1, cid: "c1", op: { op: "improvementFace", action: "list" } }));
    await until(() => c.frames.filter((f) => (f as { t?: string }).t === "result").length >= 2, "both results");
    expect(calls).toBe(2); // a read never vaults — a cached list would serve stale rows
    expect(result(c, 1)?.ok).toEqual(RECORDS);
    expect(isVaultedMutation({ op: "improvementFace", action: "list" })).toBe(false);
    c.ws.close();
  });

  it("a driver without the op errors cleanly (old server degradation, never a close)", async () => {
    const server = await createUiServer({ driver: scriptedDriver(), token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 2, op: { op: "improvementFace", action: "list" } }));
    await until(() => result(c, 2) !== undefined, "result");
    expect(result(c, 2)?.err).toBe("improvementFace not supported by this driver");
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });
});

describe("永续 v6 wave2 — improvementFace 决策形（两道人工门的 server 半边）", () => {
  it("consent reaches the driver verbatim; VAULTED — a mid-flap replay executes exactly once", async () => {
    const calls: { action: string; id: string | undefined }[] = [];
    const driver = {
      ...scriptedDriver(),
      improvementFace: async (action: string, id?: string) => {
        calls.push({ action, id });
        return { ok: true, message: "已开始生成改进提案" };
      },
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 3, cid: "c2", op: { op: "improvementFace", action: "consent", id: "p1-a1b2c3d4" } }));
    c.ws.send(JSON.stringify({ t: "op", id: 3, cid: "c2", op: { op: "improvementFace", action: "consent", id: "p1-a1b2c3d4" } }));
    await until(() => c.frames.filter((f) => (f as { t?: string }).t === "result").length >= 2, "both results");
    expect(calls.length).toBe(1); // consent 起子代理+模型调用——恰一次
    expect(calls[0]).toEqual({ action: "consent", id: "p1-a1b2c3d4" });
    expect(isVaultedMutation({ op: "improvementFace", action: "consent", id: "x" })).toBe(true);
    expect(isVaultedMutation({ op: "improvementFace", action: "undo", id: "x" })).toBe(true);
    c.ws.close();
  });

  it("形状门：非法 action / 决策缺 id 在到达驱动之前拒", async () => {
    const driver = { ...scriptedDriver(), improvementFace: async () => ({ ok: true, message: "" }) };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 4, op: { op: "improvementFace", action: "nonsense" } }));
    c.ws.send(JSON.stringify({ t: "op", id: 5, op: { op: "improvementFace", action: "activate" } }));
    c.ws.send(JSON.stringify({ t: "op", id: 6, op: { op: "improvementFace", action: "activate", id: "  " } }));
    await until(() => result(c, 6) !== undefined, "all three results");
    expect(result(c, 4)?.err).toContain("action must be");
    expect(result(c, 5)?.err).toContain("non-empty id");
    expect(result(c, 6)?.err).toContain("non-empty id");
    c.ws.close();
  });
});
