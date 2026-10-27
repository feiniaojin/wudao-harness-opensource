// ω99-283: #6 — 回收站恢复的 server ops（"sessionTrashList" / "sessionRestore"）：
// 279 sessionDelete 同款三段门——typed 门（id 非 string 拒，driver 未被调）→
// driver 能力门（无该可选方法的干净拒答 + 连接存活）→ reply 直传结果联合。
// sessionTrashList 零参数直通；sessionRestore 的 id verbatim。全 mock。
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

/** The minimal quiet driver port (279 #14's scriptedDriver shape). */
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

describe("ω99-283 — sessionTrashList op", () => {
  it("passes through to driver.trashSessions verbatim; rows relay verbatim", async () => {
    const rows = [{ id: "t-1", mtime: "2026-09-08T00:00:00.000Z", messages: 2, firstUser: "删错的会话", model: "" }];
    let calls = 0;
    const driver = { ...scriptedDriver(), trashSessions: async () => { calls++; return rows; } };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 81, op: { op: "sessionTrashList" } }));
    await until(() => result(c, 81) !== undefined, "trash list result");
    expect(result(c, 81)?.err).toBeUndefined();
    expect(result(c, 81)?.ok).toEqual(rows);
    expect(calls).toBe(1);
    c.ws.close();
  });

  it("a driver without the op errors cleanly (old driver degradation, never a close)", async () => {
    const server = await createUiServer({ driver: scriptedDriver(), token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 82, op: { op: "sessionTrashList" } }));
    await until(() => result(c, 82) !== undefined, "unsupported result");
    expect(result(c, 82)?.err).toContain("not supported");
    // 连接活着（unsupported op 从不关连接）。
    c.ws.send(JSON.stringify({ t: "op", id: 83, op: { op: "listSlashCommands" } }));
    await until(() => result(c, 83) !== undefined, "still alive");
    c.ws.close();
  });
});

describe("ω99-283 — sessionRestore op", () => {
  it("passes id to driver.restoreSession verbatim; the verdict relays verbatim (all three refusal reasons too)", async () => {
    const calls: string[] = [];
    const outcomes = [
      { restored: true as const },
      { restored: false as const, reason: "target-exists" as const },
    ];
    let n = 0;
    const driver = {
      ...scriptedDriver(),
      restoreSession: async (id: string) => {
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
    c.ws.send(JSON.stringify({ t: "op", id: 84, op: { op: "sessionRestore", id: "t-restore-0001" } }));
    await until(() => result(c, 84) !== undefined, "restore result 1");
    expect(result(c, 84)?.err).toBeUndefined();
    expect(result(c, 84)?.ok).toEqual({ restored: true });
    // 第二发：target-exists 拒答也原样回（web 侧按 reason 分叉 toast）。
    c.ws.send(JSON.stringify({ t: "op", id: 85, op: { op: "sessionRestore", id: "t-clash-00001" } }));
    await until(() => result(c, 85) !== undefined, "restore result 2");
    expect(result(c, 85)?.ok).toEqual({ restored: false, reason: "target-exists" });
    expect(calls).toEqual(["t-restore-0001", "t-clash-00001"]); // id verbatim
    c.ws.close();
  });

  it("a non-string id is refused before the driver (typed shape gate)", async () => {
    const driver = { ...scriptedDriver(), restoreSession: async () => { throw new Error("must not be called"); } };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 86, op: { op: "sessionRestore", id: 42 } }));
    await until(() => result(c, 86) !== undefined, "bad id result");
    const r = result(c, 86);
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
    c.ws.send(JSON.stringify({ t: "op", id: 87, op: { op: "sessionRestore", id: "t-any-0000001" } }));
    await until(() => result(c, 87) !== undefined, "unsupported result");
    expect(result(c, 87)?.err).toContain("not supported");
    c.ws.send(JSON.stringify({ t: "op", id: 88, op: { op: "listSlashCommands" } }));
    await until(() => result(c, 88) !== undefined, "still alive");
    c.ws.close();
  });
});
