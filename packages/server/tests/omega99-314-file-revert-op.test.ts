// ω99-314: #R — fileRevert 的 server op（文件级时光机的恢复面）。三段门
// （sessionContinue 同款）+ vaulting 分类：
//   typed 门   path 非 string / sha 非 64 位 hex → 拒，driver 未被调；
//   能力门     无该可选方法的 driver → 干净拒答「not supported」，连接存活；
//   直传       driver 的 FileRevertResult 联合原样回（ok:true 唯一成功形带
//              stale；false 四因 busy/evicted/bad-path/no-store）；
//   vaulting   fileRevert 是写面 op 必进 vault（isVaultedMutation true——
//              vaulted-mirror 双侧钉的 server 半边）。
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

const SHA_OK = "a".repeat(64);

describe("ω99-314 — fileRevert op", () => {
  it("passes path+sha to driver.fileRevert verbatim; the verdict relays verbatim (all arms)", async () => {
    const calls: [string, string][] = [];
    const outcomes = [
      { ok: true as const, stale: false, message: "已恢复 a.ts" },
      { ok: true as const, stale: true, message: "已恢复 a.ts（文件在快照之后被改过…）" },
      { ok: false as const, reason: "busy" as const, message: "任务正在跑，等它停下来再恢复" },
      { ok: false as const, reason: "evicted" as const, message: "快照已被清理，无法恢复" },
    ];
    let n = 0;
    const driver = {
      ...scriptedDriver(),
      fileRevert: async (path: string, sha: string) => {
        calls.push([path, sha]);
        return outcomes[n++]!;
      },
    };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 71, op: { op: "fileRevert", path: "a.ts", sha: SHA_OK } }));
    await until(() => result(c, 71) !== undefined, "result 1");
    expect(result(c, 71)?.ok).toEqual({ ok: true, stale: false, message: "已恢复 a.ts" });
    c.ws.send(JSON.stringify({ t: "op", id: 72, op: { op: "fileRevert", path: "a.ts", sha: SHA_OK } }));
    await until(() => result(c, 72) !== undefined, "result 2");
    expect(result(c, 72)?.ok).toEqual({ ok: true, stale: true, message: expect.stringContaining("改过") });
    c.ws.send(JSON.stringify({ t: "op", id: 73, op: { op: "fileRevert", path: "a.ts", sha: SHA_OK } }));
    await until(() => result(c, 73) !== undefined, "result 3");
    expect(result(c, 73)?.ok).toEqual({ ok: false, reason: "busy", message: expect.any(String) });
    c.ws.send(JSON.stringify({ t: "op", id: 74, op: { op: "fileRevert", path: "a.ts", sha: SHA_OK } }));
    await until(() => result(c, 74) !== undefined, "result 4");
    expect(result(c, 74)?.ok).toEqual({ ok: false, reason: "evicted", message: expect.stringContaining("快照已被清理") });
    expect(calls).toEqual([["a.ts", SHA_OK], ["a.ts", SHA_OK], ["a.ts", SHA_OK], ["a.ts", SHA_OK]]);
    c.ws.close();
  });

  it("typed shape gates: non-string path / non-hex64 sha refused before the driver", async () => {
    const driver = { ...scriptedDriver(), fileRevert: async () => { throw new Error("must not be called"); } };
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 81, op: { op: "fileRevert", path: 42, sha: SHA_OK } }));
    await until(() => result(c, 81) !== undefined, "bad path result");
    expect(result(c, 81)?.err).toContain("path");
    c.ws.send(JSON.stringify({ t: "op", id: 82, op: { op: "fileRevert", path: "a.ts", sha: "not-hex" } }));
    await until(() => result(c, 82) !== undefined, "bad sha result");
    expect(result(c, 82)?.err).toContain("sha");
    c.ws.close();
  });

  it("a driver without the op errors cleanly (old driver degradation, never a close)", async () => {
    const server = await createUiServer({ driver: scriptedDriver(), token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await until(() => c.frames.some((f) => (f as { t?: string }).t === "history"), "initial replay");
    c.ws.send(JSON.stringify({ t: "op", id: 83, op: { op: "fileRevert", path: "a.ts", sha: SHA_OK } }));
    await until(() => result(c, 83) !== undefined, "unsupported result");
    expect(result(c, 83)?.err).toContain("not supported");
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });

  it("fileRevert is a vaulted mutation (写面 op 必进 vault)", () => {
    expect(isVaultedMutation({ op: "fileRevert", path: "a.ts", sha: SHA_OK })).toBe(true);
  });
});
