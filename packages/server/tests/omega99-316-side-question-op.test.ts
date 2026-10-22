// ω99-316: /btw 侧问的 server op（PROTOCOL "sideQuestion"）。三段门
// （fileRevert/recap 同款）+ vaulting 分类：
//   typed 门   sessionId/text 非 string（或空文本）→ 拒，driver 未被调；
//   能力门     无该可选方法的 driver → 干净拒答「not supported」，连接存活；
//   直传       sessionId+text 原样达 driver.sideQuestion，
//              {answer, rounds} 原样回；
//   vaulting   sideQuestion 是读面 op（旁路 detached loop，绝不写
//              session JSONL/store——重放=重新问一次，无副作用可补偿），
//              不进 vault（isVaultedMutation false——vaulted-mirror 双侧钉
//              的 server 半边）。
// 全 mock，零文件系统。
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

describe("ω99-316 — sideQuestion op", () => {
  it("passes sessionId+text to driver.sideQuestion verbatim; {answer, rounds} relays verbatim", async () => {
    const calls: [string, string][] = [];
    const driver = {
      ...scriptedDriver(),
      sideQuestion: async (sessionId: string, text: string) => {
        calls.push([sessionId, text]);
        return { answer: "旁答：这是那个报错的含义。", rounds: 2 };
      },
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 91, op: { op: "sideQuestion", sessionId: "sess-x", text: "这个报错什么意思？" } }));
    await until(() => result(c, 91) !== undefined, "result");
    expect(result(c, 91)?.ok).toEqual({ answer: "旁答：这是那个报错的含义。", rounds: 2 });
    expect(calls).toEqual([["sess-x", "这个报错什么意思？"]]);
    c.ws.close();
  });

  it("driver errors surface on the err channel (e.g. session mismatch / model failure)", async () => {
    const driver = {
      ...scriptedDriver(),
      sideQuestion: async () => {
        throw new Error("旁问失败：会话不匹配");
      },
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 92, op: { op: "sideQuestion", sessionId: "sess-x", text: "问" } }));
    await until(() => result(c, 92) !== undefined, "err result");
    expect(result(c, 92)?.err).toContain("旁问失败");
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });

  it("typed shape gates: non-string sessionId/text refused before the driver", async () => {
    const driver = { ...scriptedDriver(), sideQuestion: async () => { throw new Error("must not be called"); } };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 93, op: { op: "sideQuestion", sessionId: 42, text: "问" } }));
    await until(() => result(c, 93) !== undefined, "bad sessionId result");
    expect(result(c, 93)?.err).toContain("sessionId");
    c.ws.send(JSON.stringify({ t: "op", id: 94, op: { op: "sideQuestion", sessionId: "sess-x", text: 7 } }));
    await until(() => result(c, 94) !== undefined, "bad text result");
    expect(result(c, 94)?.err).toContain("text");
    c.ws.close();
  });

  it("a driver without the op errors cleanly (old driver degradation, never a close)", async () => {
    const server = await createUiServer({ driver: scriptedDriver(), token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 95, op: { op: "sideQuestion", sessionId: "sess-x", text: "问" } }));
    await until(() => result(c, 95) !== undefined, "unsupported result");
    expect(result(c, 95)?.err).toContain("not supported");
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });

  it("sideQuestion is NOT a vaulted mutation (read lane: detached loop, zero session writes)", () => {
    expect(isVaultedMutation({ op: "sideQuestion", sessionId: "sess-x", text: "问" })).toBe(false);
  });
});
