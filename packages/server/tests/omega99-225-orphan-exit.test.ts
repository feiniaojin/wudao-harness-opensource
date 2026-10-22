// ω99-225: #R2 — 孤儿 sidecar 自退出 + resume 中继形。0.3.59 验装回执：app
// 崩溃/强退不走退出清理 → sidecar 孤儿化（ppid 重父到 1，持活租约）→ 用户点
// 历史会话被谎报「不存在」。本弧 server 侧两钉：
//   自退出  ppid=1 + 已 auth 连接归零 + 过宽限 → stderr 回执一行 + exit(0)；
//          ppid 活（父在）永不 exit；宽限内重连 disarm（再断重 arm 仍可退）；
//          父走但客户端在场 → 不 exit；boot 即零客户端（spawn 即崩窗）同退。
//   中继    resume 的 reply 原样传 outcome 对象（occupied 带 holderPid）。
// 注入缝全走 opts（getPpid/exit/orphanGraceMs/pingIntervalMs）——测试零真退
// 出、零真孤儿；driver 是最小结构 fake。
import { describe, it, expect, afterEach, vi } from "vitest";
import { createUiServer, type UiDriverPort, type UiServer, type ResumeOutcome } from "../src/index.js";
import WebSocket from "ws";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

/** 最小结构 driver：resume 返回可脚本化的 outcome（默认 ok）。 */
function fakeDriver(resumeValue: ResumeOutcome = { ok: true }): UiDriverPort {
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
    resume: async () => resumeValue,
    rewind: async () => "rewound",
    beginEdit: () => undefined,
    tree: async () => "tree",
    switchBranch: async () => "switched",
  };
}

interface Frame {
  t: string;
  id?: unknown;
  ok?: unknown;
  err?: string;
}

interface OrphanHarness {
  server: UiServer;
  exits: { code: number }[];
  stderrLines: string[];
  setPpid(p: number): void;
}

const servers: UiServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) await s.close();
});

/** 起 server（10ms sweep、注入 getPpid/exit + stderr 捕获）；grace 由用例给。 */
async function orphanServer(graceMs: number, initialPpid: number): Promise<OrphanHarness> {
  const exits: { code: number }[] = [];
  const stderrLines: string[] = [];
  let ppid = initialPpid;
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderrLines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  const server = await createUiServer({
    driver: fakeDriver(),
    token: "t",
    pingIntervalMs: 10,
    orphanGraceMs: graceMs,
    getPpid: () => ppid,
    exit: (code) => {
      exits.push({ code });
    },
  });
  servers.push(server);
  return { server, exits, stderrLines, setPpid: (p: number) => { ppid = p; } };
}

/** 连接 + 首帧 auth；返回 ws 与 open/closed promise。 */
function authedClient(port: number, token = "t"): { ws: WebSocket; open: Promise<void>; closed: Promise<{ code: number; reason: string }> } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const open = new Promise<void>((resolve) => ws.once("open", resolve));
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.once("close", (code, reason) => resolve({ code, reason: String(reason) })),
  );
  ws.on("open", () => ws.send(JSON.stringify({ t: "auth", token })));
  return { ws, open, closed };
}

describe("ω99-225 孤儿自退出（ppid + 客户端双条件）", () => {
  it("ppid=1 + 断连 + 过宽限 → stderr 回执一行 + exit(0)", async () => {
    const h = await orphanServer(30, 1);
    const c = authedClient(h.server.port);
    await c.open;
    c.ws.close();
    await c.closed;
    await until(() => h.exits.length === 1, "orphan self-exit after grace");
    expect(h.exits[0]?.code).toBe(0);
    expect(h.stderrLines.join("")).toContain("wudao-server: parent gone and no clients — orphan self-exit");
  });

  it("ppid=1000（父活）→ 过宽限亦永不 exit", async () => {
    const h = await orphanServer(30, 1000);
    const c = authedClient(h.server.port);
    await c.open;
    c.ws.close();
    await c.closed;
    await wait(150); // 远超 grace + 多个 sweep
    expect(h.exits).toHaveLength(0);
  });

  it("宽限内重连 → disarm；再断 → 重 arm 后仍自退出", async () => {
    const h = await orphanServer(80, 1);
    const c1 = authedClient(h.server.port);
    await c1.open;
    c1.ws.close();
    await c1.closed;
    await wait(20); // < grace：armed 但未到期
    const c2 = authedClient(h.server.port);
    await c2.open;
    await wait(150); // 远超原宽限——重连 disarm，在场不退
    expect(h.exits).toHaveLength(0);
    c2.ws.close();
    await c2.closed;
    await until(() => h.exits.length === 1, "re-armed self-exit after second drop");
    expect(h.exits[0]?.code).toBe(0);
  });

  it("父走（ppid=1）但客户端在场 → 不 exit", async () => {
    // 基准×探针弧发版门加固：负向断言对 auth 迟滞敏感——c.open 只证握手，
    // auth 帧服务端处理前 sweep 可见「ppid=1+零认证」误判孤儿（门负载下
    // 实红两次，solo 绿×2）。grace 放宽到 300ms 消竞态（语义不变：客户端
    // 在场永不退；观察窗相应放大）。
    const h = await orphanServer(300, 1);
    const c = authedClient(h.server.port);
    await c.open;
    await wait(600); // 远超 grace + 多个 sweep
    expect(h.exits).toHaveLength(0);
    c.ws.close();
    await c.closed;
  });

  it("boot 即零客户端 + ppid=1 → 过宽限自退出（spawn 即崩窗覆盖）", async () => {
    const h = await orphanServer(30, 1);
    await until(() => h.exits.length === 1, "boot-orphan self-exit");
    expect(h.exits[0]?.code).toBe(0);
  });
});

describe("ω99-225 resume 中继形（outcome 对象原样过线）", () => {
  it("occupied outcome（含 holderPid）reply 原样传", async () => {
    const frames: Frame[] = [];
    const exits: { code: number }[] = [];
    const server = await createUiServer({
      driver: fakeDriver({ ok: false, reason: "occupied", holderPid: 4242 }),
      token: "t",
      pingIntervalMs: 10,
      orphanGraceMs: 60_000, // 远大——本用例只钉中继
      getPpid: () => 1000,
      exit: (code) => {
        exits.push({ code });
      },
    });
    servers.push(server);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const open = new Promise<void>((resolve) => ws.once("open", resolve));
    ws.on("message", (data) => frames.push(JSON.parse(String(data)) as Frame));
    await open;
    ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await wait(20); // auth 处理 + state/history 帧
    ws.send(JSON.stringify({ t: "op", id: 41, op: { op: "resume", id: "occupied-1" } }));
    await until(() => frames.some((f) => f.t === "result" && f.id === 41), "resume result");
    const ok = frames.find((f) => f.t === "result" && f.id === 41)?.ok;
    expect(ok).toEqual({ ok: false, reason: "occupied", holderPid: 4242 });
    expect(exits).toHaveLength(0);
    ws.close();
    await new Promise<void>((resolve) => ws.once("close", resolve));
  });
});
