// ω99-277: #9 — 弹框全文搜索的 server op（"sessionSearch"）：{q} 直传
// driver.searchSessions、结果原样回；q 非 string typed 拒；driver 无该可选
// 方法的干净拒答（258/260 的 unsupported 形）。全 mock，零真文件零网络。
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

/** The minimal quiet driver port (server.test.ts's scriptedDriver shape). */
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

const HITS = [
  {
    sessionId: "sess-hit-0001",
    name: "修复登录页",
    firstUser: "帮我修复登录页面的 Bug",
    mtime: "2026-09-10T12:00:00.000Z",
    kind: "user",
    snippet: "…帮我修复登录页面的 Bug：空指针在 auth.ts…",
  },
  {
    sessionId: "sess-hit-0001",
    name: "修复登录页",
    firstUser: "帮我修复登录页面的 Bug",
    mtime: "2026-09-10T12:00:00.000Z",
    kind: "assistant",
    snippet: "…已修复 Bug：问题出在 auth.ts 的空指针…",
  },
];

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

describe("ω99-277 — sessionSearch op", () => {
  it("passes q to driver.searchSessions verbatim; the hits relay verbatim", async () => {
    const calls: string[] = [];
    const driver = {
      ...scriptedDriver(),
      searchSessions: async (q: string) => {
        calls.push(q);
        return HITS;
      },
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 61, op: { op: "sessionSearch", q: "登录页面" } }));
    await until(() => result(c, 61) !== undefined, "sessionSearch result");
    const r = result(c, 61);
    expect(r?.err).toBeUndefined();
    expect(r?.ok).toEqual(HITS);
    expect(calls).toEqual(["登录页面"]);
    c.ws.close();
  });

  it("a non-string q is refused before the driver (typed shape gate)", async () => {
    const driver = { ...scriptedDriver(), searchSessions: async () => { throw new Error("must not be called"); } };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 62, op: { op: "sessionSearch", q: 42 } }));
    await until(() => result(c, 62) !== undefined, "bad q result");
    const r = result(c, 62);
    expect(r?.err).toContain("q");
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
    c.ws.send(JSON.stringify({ t: "op", id: 63, op: { op: "sessionSearch", q: "任何词" } }));
    await until(() => result(c, 63) !== undefined, "unsupported result");
    const r = result(c, 63);
    expect(r?.err).toContain("not supported");
    // 连接活着（malformed/unsupported op 从不关连接）。
    c.ws.send(JSON.stringify({ t: "op", id: 64, op: { op: "listSlashCommands" } }));
    await until(() => result(c, 64) !== undefined, "still alive");
    c.ws.close();
  });
});
