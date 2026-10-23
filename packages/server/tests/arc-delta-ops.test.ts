// 借鉴弧 δ（penguin-harness 367ab084 思想）— detachToolCall op 的三段门
// （arc-alpha-ops 同款形状）：
//   typed 门      (callId string|undefined) → driver 未被调
//   能力门        无该可选方法的 driver 干净拒答 + 连接存活
//   reply 直传    typed 裁决联合原样中继（ok / not_detachable / not_in_flight）
// 加 vaulted 镜像钉（isVaultedMutation 含 detachToolCall——mid-flap 重放对
// MOVED busy 行的错杀面，α2/α1 同律）。
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

function scriptedDriver(withOp: boolean): UiDriverPort & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    subscribe: () => () => {},
    getStatus: () => ({ live: { reasoning: "", answer: "", busyTools: [] }, busy: true, mode: "default" }),
    getHistory: () => [],
    onHistory: () => () => {},
    onLoopEvent: () => () => {},
    submit: () => "started",
    interrupt: () => {},
    setMode: () => {},
    answerPermission: () => false,
    listSlashCommands: () => [],
    sessions: async () => [],
    ...(withOp
      ? {
          detachToolCall: (callId?: string): unknown => {
            calls.push(callId);
            if (callId === "c-block") return { kind: "refused", reason: "not_detachable", toolName: "blocker" };
            if (callId === undefined) return { kind: "refused", reason: "not_in_flight" };
            return { kind: "ok", callId, toolName: "shell" };
          },
        }
      : {}),
  };
}

interface Client { ws: WebSocket; frames: unknown[]; open: Promise<void> }
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

const boot = async (driver: UiDriverPort): Promise<{ server: UiServer; client: Client }> => {
  const server = await createUiServer({ driver, token: "t" });
  servers.push(server);
  const client = connect(server.port);
  await client.open;
  client.ws.send(JSON.stringify({ t: "auth", token: "t" }));
  await until(() => client.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
  return { server, client };
};

describe("借鉴弧 δ — detachToolCall 三段门", () => {
  it("typed gate: a non-string callId refuses with an error and the driver is never called; good shapes pass the verdict verbatim", async () => {
    const driver = scriptedDriver(true);
    const { server, client } = await boot(driver);
    const send = (id: number, op: Record<string, unknown>): void => {
      client.ws.send(JSON.stringify({ t: "op", id, op }));
    };
    send(1, { op: "detachToolCall", callId: 42 });
    send(2, { op: "detachToolCall", callId: ["c1"] });
    send(3, { op: "detachToolCall", callId: "c1" });
    send(4, { op: "detachToolCall" });
    send(5, { op: "detachToolCall", callId: "c-block" });
    await until(() => result(client, 5) !== undefined, "replies land");
    expect(result(client, 1)?.err).toContain("callId must be a string");
    expect(result(client, 2)?.err).toContain("callId must be a string");
    // Verbatim verdict relay: ok / bare-refusal / the block family.
    expect(result(client, 3)?.ok).toEqual({ kind: "ok", callId: "c1", toolName: "shell" });
    expect(result(client, 4)?.ok).toEqual({ kind: "refused", reason: "not_in_flight" });
    expect(result(client, 5)?.ok).toEqual({ kind: "refused", reason: "not_detachable", toolName: "blocker" });
    // The bad shapes never reached the driver; the good ones did (in order).
    expect(driver.calls).toEqual(["c1", undefined, "c-block"]);
    await server.close();
  });

  it("capability gate: a driver without the op gets a clean refusal and the connection survives", async () => {
    const driver = scriptedDriver(false);
    const { server, client } = await boot(driver);
    client.ws.send(JSON.stringify({ t: "op", id: 1, op: { op: "detachToolCall", callId: "c1" } }));
    await until(() => result(client, 1) !== undefined, "the refusal lands");
    expect(result(client, 1)?.err).toContain("not supported by this driver");
    expect(driver.calls).toEqual([]);
    // The connection is still alive (a later op answers).
    client.ws.send(JSON.stringify({ t: "op", id: 2, op: { op: "listSlashCommands" } }));
    await until(() => result(client, 2) !== undefined, "connection survives");
    await server.close();
  });

  it("the vaulted mirror pin: detachToolCall is a vaulted mutation (the α2/α1 family law)", () => {
    expect(isVaultedMutation({ op: "detachToolCall" })).toBe(true);
    expect(isVaultedMutation({ op: "detachToolCall", callId: "c1" })).toBe(true);
  });
});
