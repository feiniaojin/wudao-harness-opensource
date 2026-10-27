// 小精灵会话弧（会话体验：基于会话追问）—— server 侧 relay 钉件：resume 携
// fork:true 的三段门（typed 形状门 → sid 组合 v1 拒 → optional port → relay）。
// forkSession 是可选驱动面：缺席干净拒答（老 driver 降级）；在场时 id 直传、
// 回执联合原样回（sessionDelete/sessionContinue 的同款 relay 范式）；无 fork
// 字段的 resume 原样走既有路径（字节不变钉——forkSession 零调用）。
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

interface ForkMainMock extends UiDriverPort {
  readonly calls: string[];
}

/** 主车道 mock：forkSession/resume 都记录（隔离断言=未走的面零调用）。 */
function mainMock(withFork: boolean): ForkMainMock {
  const calls: string[] = [];
  const base: UiDriverPort = {
    subscribe: () => () => {},
    getStatus: () => ({ live: { reasoning: "", answer: "", busyTools: [] }, busy: false, mode: "workspace", sessionId: "wudao-main-1" }),
    getHistory: () => [],
    onHistory: () => () => {},
    onLoopEvent: () => () => {},
    submit: () => "started",
    interrupt: () => {},
    setMode: () => {},
    answerPermission: () => true,
    listSlashCommands: () => [],
    sessions: async () => [],
    resume: async (id) => (calls.push(`resume:${id}`), { ok: true }),
    rewind: async () => "rewound",
    beginEdit: () => undefined,
    tree: async () => "",
    switchBranch: async () => "",
  };
  return withFork
    ? { ...base, calls, forkSession: async (id) => (calls.push(`forkSession:${id}`), { ok: true, forkedId: "wudao-fork-0007" }) }
    : { ...base, calls };
}

interface Frame {
  t: string;
  id?: unknown;
  ok?: unknown;
  err?: string;
}

function connect(server: UiServer): { ws: WebSocket; frames: Frame[]; open: Promise<void> } {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const frames: Frame[] = [];
  const open = new Promise<void>((resolve) => ws.once("open", resolve));
  ws.on("message", (data) => frames.push(JSON.parse(String(data)) as Frame));
  return { ws, frames, open };
}

async function boot(withFork: boolean): Promise<{ server: UiServer; c: ReturnType<typeof connect>; main: ForkMainMock }> {
  const main = mainMock(withFork);
  const server = await createUiServer({ driver: main });
  servers.push(server);
  const c = connect(server);
  await c.open;
  c.ws.send(JSON.stringify({ t: "auth", token: server.token }));
  await until(() => c.frames.some((f) => f.t === "history"), "initial replay");
  return { server, c, main };
}

const sendOp = (ws: WebSocket, id: number, op: Record<string, unknown>): void => {
  ws.send(JSON.stringify({ t: "op", id, op }));
};
const result = (frames: Frame[], id: unknown): Frame | undefined =>
  frames.find((f) => f.t === "result" && f.id === id);

describe("小精灵会话弧 — resume 的 fork 形 relay", () => {
  it("fork:true → id 直传 driver.forkSession、回执联合原样回、既有 resume 面零调用（换血由 wrapper 内完成）", async () => {
    const { c, main } = await boot(true);
    sendOp(c.ws, 101, { op: "resume", id: "wudao-old-0001", fork: true });
    await until(() => result(c.frames, 101) !== undefined, "the fork reply");
    expect(result(c.frames, 101)?.ok).toEqual({ ok: true, forkedId: "wudao-fork-0007" });
    expect(main.calls).toEqual(["forkSession:wudao-old-0001"]); // resume 未被 server 直呼
  });

  it("无 fork 字段 → 既有路径字节不变（forkSession 零调用，resume 照常）", async () => {
    const { c, main } = await boot(true);
    sendOp(c.ws, 102, { op: "resume", id: "wudao-old-0001" });
    await until(() => result(c.frames, 102) !== undefined, "the resume reply");
    expect(result(c.frames, 102)?.ok).toEqual({ ok: true });
    expect(main.calls).toEqual(["resume:wudao-old-0001"]);
  });

  it("fork+sid 组合 v1 干净拒（车道工厂按原始 id 开车道——对 fork 是错的目标）", async () => {
    const { c, main } = await boot(true);
    sendOp(c.ws, 103, { op: "resume", id: "wudao-old-0001", fork: true, sid: "lane-x1" });
    await until(() => result(c.frames, 103) !== undefined, "the refusal");
    expect(result(c.frames, 103)?.err).toContain("sid");
    expect(main.calls).toEqual([]); // 拒在 port 之前，零驱动调用
  });

  it("驱动面缺席 → 干净拒答（老 driver 降级，不崩不误答）", async () => {
    const { c } = await boot(false);
    sendOp(c.ws, 104, { op: "resume", id: "wudao-old-0001", fork: true });
    await until(() => result(c.frames, 104) !== undefined, "the unsupported refusal");
    expect(result(c.frames, 104)?.err).toContain("fork not supported");
  });

  it("形状门：fork:true 但 id 非字符串 → 既有形状拒答", async () => {
    const { c } = await boot(true);
    sendOp(c.ws, 105, { op: "resume", id: 42, fork: true });
    await until(() => result(c.frames, 105) !== undefined, "the shape refusal");
    expect(result(c.frames, 105)?.err).toContain("resume needs an id string");
  });
});
