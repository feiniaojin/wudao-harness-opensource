// ω99-317 — 定时任务管理面的三个 server op（"schedulesSetEnabled" /
// "schedulesRemove" / "schedulesRunNow"）：fileRevert/sessionContinue 同款
// 三段门——typed 门（id 非 string / enabled 非 bool / resetBreaker 非 bool
// 拒，driver 未被调）→ driver 能力门（无该可选方法的干净拒答 + 连接存活）
// → reply 直传结果联合 {ok,message}（守护中文回执原样中继）。全 mock。
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

/** The minimal quiet driver port（286 scriptedDriver 同形）. */
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

interface Harness {
  server: UiServer;
  client: Client;
}
const boot = async (driver: UiDriverPort): Promise<Harness> => {
  const server = await createUiServer({ driver, token: "t" });
  servers.push(server);
  const client = connect(server.port);
  await client.open;
  client.ws.send(JSON.stringify({ t: "auth", token: "t" }));
  await until(() => client.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
  return { server, client };
};

const send = (h: Harness, id: number, op: Record<string, unknown>): void => {
  h.client.ws.send(JSON.stringify({ t: "op", id, op }));
};

describe("ω99-317 — schedulesSetEnabled op", () => {
  it("relays {id, enabled} verbatim; the {ok,message} union relays verbatim (both arms)", async () => {
    const calls: [string, boolean][] = [];
    const outcomes = [
      { ok: true, message: "⏸ abcd0001 已暂停（错过的触发不补跑）" },
      { ok: false, message: "⚠️ abcd0002 绑定的会话正在跑——等当前对话结束再试" },
    ];
    let n = 0;
    const h = await boot({
      ...scriptedDriver(),
      schedulesSetEnabled: async (id: string, enabled: boolean) => {
        calls.push([id, enabled]);
        return outcomes[n++]!;
      },
    });
    send(h, 91, { op: "schedulesSetEnabled", id: "abcd0001", enabled: false });
    await until(() => result(h.client, 91) !== undefined, "pause result");
    expect(result(h.client, 91)?.err).toBeUndefined();
    expect(result(h.client, 91)?.ok).toEqual(outcomes[0]);
    send(h, 92, { op: "schedulesSetEnabled", id: "abcd0002", enabled: true });
    await until(() => result(h.client, 92) !== undefined, "resume result");
    expect(result(h.client, 92)?.ok).toEqual(outcomes[1]);
    expect(calls).toEqual([["abcd0001", false], ["abcd0002", true]]); // args verbatim
    h.client.ws.close();
  });

  it("typed gates: non-string id / non-bool enabled refuse BEFORE the driver", async () => {
    let called = 0;
    const h = await boot({
      ...scriptedDriver(),
      schedulesSetEnabled: async () => {
        called += 1;
        throw new Error("must not be called");
      },
    });
    send(h, 93, { op: "schedulesSetEnabled", id: 42, enabled: false });
    await until(() => result(h.client, 93) !== undefined, "bad id");
    send(h, 94, { op: "schedulesSetEnabled", id: "abcd0001", enabled: "yes" });
    await until(() => result(h.client, 94) !== undefined, "bad enabled");
    expect(result(h.client, 93)?.err).toContain("id");
    expect(result(h.client, 94)?.err).toContain("enabled");
    expect(called).toBe(0);
    h.client.ws.close();
  });
});

describe("ω99-317 — schedulesRemove op", () => {
  it("relays id verbatim; the union relays verbatim", async () => {
    const calls: string[] = [];
    const h = await boot({
      ...scriptedDriver(),
      schedulesRemove: async (id: string) => {
        calls.push(id);
        return { ok: true, message: "已移除持久任务 abcd0001" };
      },
    });
    send(h, 95, { op: "schedulesRemove", id: "abcd0001" });
    await until(() => result(h.client, 95) !== undefined, "remove result");
    expect(result(h.client, 95)?.ok).toEqual({ ok: true, message: "已移除持久任务 abcd0001" });
    expect(calls).toEqual(["abcd0001"]);
    h.client.ws.close();
  });

  it("typed gate: non-string id refuses before the driver", async () => {
    const h = await boot({
      ...scriptedDriver(),
      schedulesRemove: async () => {
        throw new Error("must not be called");
      },
    });
    send(h, 96, { op: "schedulesRemove", id: null });
    await until(() => result(h.client, 96) !== undefined, "bad id");
    expect(result(h.client, 96)?.err).toContain("id");
    h.client.ws.close();
  });
});

describe("ω99-317 — schedulesRunNow op", () => {
  it("relays {id, resetBreaker} verbatim (flag absent → undefined; present → passed through)", async () => {
    const calls: [string, { resetBreaker?: boolean } | undefined][] = [];
    const outcomes = [
      { ok: true, message: "▶ abcd0001 已立即启动（手动运行——计划不变）" },
      { ok: true, message: "▶ abcd0002 已重新打开并立即试跑（连败计数清零——计划不变）" },
    ];
    let n = 0;
    const h = await boot({
      ...scriptedDriver(),
      schedulesRunNow: async (id: string, opts?: { resetBreaker?: boolean }) => {
        calls.push([id, opts]);
        return outcomes[n++]!;
      },
    });
    send(h, 97, { op: "schedulesRunNow", id: "abcd0001" });
    await until(() => result(h.client, 97) !== undefined, "run result 1");
    expect(result(h.client, 97)?.ok).toEqual(outcomes[0]);
    send(h, 98, { op: "schedulesRunNow", id: "abcd0002", resetBreaker: true });
    await until(() => result(h.client, 98) !== undefined, "run result 2");
    expect(result(h.client, 98)?.ok).toEqual(outcomes[1]);
    expect(calls).toEqual([["abcd0001", undefined], ["abcd0002", { resetBreaker: true }]]); // flag passthrough verbatim
    h.client.ws.close();
  });

  it("typed gates: non-string id / non-bool resetBreaker refuse before the driver", async () => {
    let called = 0;
    const h = await boot({
      ...scriptedDriver(),
      schedulesRunNow: async () => {
        called += 1;
        throw new Error("must not be called");
      },
    });
    send(h, 99, { op: "schedulesRunNow", id: ["x"] });
    await until(() => result(h.client, 99) !== undefined, "bad id");
    send(h, 100, { op: "schedulesRunNow", id: "abcd0001", resetBreaker: 1 });
    await until(() => result(h.client, 100) !== undefined, "bad flag");
    expect(result(h.client, 99)?.err).toContain("id");
    expect(result(h.client, 100)?.err).toContain("resetBreaker");
    expect(called).toBe(0);
    h.client.ws.close();
  });
});

describe("ω99-317 — 三个 op 的能力门（old driver 软降级，连接不断）", () => {
  it("a driver without the ops errors cleanly (not supported × 3, connection alive)", async () => {
    const h = await boot(scriptedDriver());
    send(h, 101, { op: "schedulesSetEnabled", id: "abcd0001", enabled: false });
    send(h, 102, { op: "schedulesRemove", id: "abcd0001" });
    send(h, 103, { op: "schedulesRunNow", id: "abcd0001" });
    await until(() => result(h.client, 103) !== undefined, "unsupported results");
    expect(result(h.client, 101)?.err).toContain("not supported");
    expect(result(h.client, 102)?.err).toContain("not supported");
    expect(result(h.client, 103)?.err).toContain("not supported");
    // 连接活着（unsupported op 从不关连接）。
    send(h, 104, { op: "listSlashCommands" });
    await until(() => result(h.client, 104) !== undefined, "still alive");
    h.client.ws.close();
  });
});

describe("ω99-317 — vault 分类（与 web 侧 isRetryableMutation 双镜像）", () => {
  it("setEnabled/runNow 是 vaulted mutations（mid-flap 重放恰好一次）；remove 入读表（删除收敛）", () => {
    expect(isVaultedMutation({ op: "schedulesSetEnabled", id: "abcd0001", enabled: false })).toBe(true);
    expect(isVaultedMutation({ op: "schedulesRunNow", id: "abcd0001" })).toBe(true);
    expect(isVaultedMutation({ op: "schedulesRunNow", id: "abcd0001", resetBreaker: true })).toBe(true);
    // 删除收敛：absent 即 goal state（sessionDelete/settingsDeleteProvider 先例）。
    expect(isVaultedMutation({ op: "schedulesRemove", id: "abcd0001" })).toBe(false);
    expect(isVaultedMutation({ op: "schedulesList" })).toBe(false); // 313 既有钉
  });
});
