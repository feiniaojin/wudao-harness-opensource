// 借鉴弧 α2/α1 — the two new ops' three gates (the 317 schedules-ops shape):
//   typed 门      (recallSteer: index 非负整数 / text string；answerAskUser:
//                 answer string|undefined) → driver 未被调
//   能力门        无该可选方法的 driver 干净拒答 + 连接存活
//   reply 直传    结果 boolean 原样中继
// 加 vaulted 镜像钉（isVaultedMutation 含两 op——重放对 MOVED 队列的错杀面）。
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

/** The minimal quiet driver port WITHOUT the two optional ops (the capability
 *  gate's negative); recallDriver() adds them with scripted results. */
function scriptedDriver(withOps: boolean): UiDriverPort {
  const calls: unknown[] = [];
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
    ...(withOps
      ? {
          recallSteer: (i: number, t: string): boolean => {
            calls.push(["recallSteer", i, t]);
            return i === 0 && t === "hit";
          },
          answerAskUser: (a?: string): boolean => {
            calls.push(["answerAskUser", a]);
            return a !== undefined;
          },
        }
      : {}),
  } as UiDriverPort & { readonly __calls?: unknown[] };
  void calls;
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

describe("借鉴弧 α2/α1 — recallSteer / answerAskUser 三段门", () => {
  it("typed gate: bad shapes refuse with an error and the driver is never called; good shapes pass the boolean verbatim", async () => {
    let recalls = 0;
    let asks = 0;
    const driver = scriptedDriver(false);
    (driver as unknown as { recallSteer?: unknown }).recallSteer = () => { recalls += 1; return true; };
    (driver as unknown as { answerAskUser?: unknown }).answerAskUser = () => { asks += 1; return true; };
    const { server, client } = await boot(driver);
    const send = (id: number, op: Record<string, unknown>): void => {
      client.ws.send(JSON.stringify({ t: "op", id, op }));
    };
    send(1, { op: "recallSteer", index: -1, text: "x" });
    send(2, { op: "recallSteer", index: 1.5, text: "x" });
    send(3, { op: "recallSteer", index: 0 });
    send(4, { op: "recallSteer", index: 0, text: 7 });
    send(5, { op: "answerAskUser", answer: 42 });
    send(6, { op: "recallSteer", index: 0, text: "ok" });
    send(7, { op: "answerAskUser" });
    send(8, { op: "answerAskUser", answer: "选 B" });
    await until(() => result(client, 8) !== undefined, "replies land");
    expect(result(client, 1)?.err).toContain("index");
    expect(result(client, 2)?.err).toContain("index");
    expect(result(client, 3)?.err).toContain("text");
    expect(result(client, 4)?.err).toContain("text");
    expect(result(client, 5)?.err).toContain("answer");
    expect(result(client, 6)?.ok).toBe(true);
    expect(result(client, 7)?.ok).toBe(true);
    expect(result(client, 8)?.ok).toBe(true);
    expect(recalls).toBe(1); // the five refusals never reached the driver
    expect(asks).toBe(2);
    await server.close();
  });

  it("capability gate: a driver without the ops answers a clean unsupported error and the connection stays alive", async () => {
    const { server, client } = await boot(scriptedDriver(false));
    client.ws.send(JSON.stringify({ t: "op", id: 1, op: { op: "recallSteer", index: 0, text: "x" } }));
    client.ws.send(JSON.stringify({ t: "op", id: 2, op: { op: "answerAskUser" } }));
    client.ws.send(JSON.stringify({ t: "op", id: 3, op: { op: "interrupt" } }));
    await until(() => result(client, 3) !== undefined, "the follow-up op proves the socket lives");
    expect(result(client, 1)?.err).toContain("not supported");
    expect(result(client, 2)?.err).toContain("not supported");
    expect(result(client, 3)?.ok).toBe(true);
    await server.close();
  });

  it("both ops are vaulted mutations (a mid-flap replay must not re-execute against a moved queue)", () => {
    expect(isVaultedMutation({ op: "recallSteer" })).toBe(true);
    expect(isVaultedMutation({ op: "answerAskUser" })).toBe(true);
    expect(isVaultedMutation({ op: "listSlashCommands" })).toBe(false);
  });
});
