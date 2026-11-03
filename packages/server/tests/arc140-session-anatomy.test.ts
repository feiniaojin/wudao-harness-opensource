// 140 — sessionAnatomy op：系统提示词 + 消息链全量直通；无方法的 driver 拒答。
import { describe, expect, it, afterEach } from "vitest";
import { createUiServer } from "../src/index.js";
import type { UiServer } from "../src/index.js";
import WebSocket from "ws";

const servers: UiServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });

const baseDriver = (extra: Record<string, unknown>) => ({
  subscribe: () => () => {},
  getStatus: () => ({ busy: false, live: { reasoning: "", answer: "", busyTools: [] }, queued: [] }),
  getHistory: () => [],
  onHistory: () => () => {},
  onLoopEvent: () => () => {},
  submit: () => {},
  interrupt: () => {},
  resume: async () => ({ ok: true }),
  setMode: () => {},
  answerPermission: () => true,
  listSlashCommands: () => [],
  sessions: async () => [],
  ...extra,
});

function connect(port: number): { ws: WebSocket; frames: Array<Record<string, unknown>> } {
  const frames: Array<Record<string, unknown>> = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { host: "127.0.0.1" } });
  ws.on("message", (d: WebSocket.RawData) => { frames.push(JSON.parse(String(d)) as Record<string, unknown>); });
  return { ws, frames };
}

describe("140 — sessionAnatomy op", () => {
  it("直通：systemPrompt + messages 原样回（含 reasoning/toolCalls/isError）", async () => {
    const driver = baseDriver({
      sessionAnatomy: async () => ({
        systemPrompt: "You are wudao.",
        messages: [
          { role: "user", content: "读 a.txt" },
          { role: "assistant", content: "", reasoning: "先读文件", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
          { role: "tool", toolCallId: "c1", name: "read_file", content: "FILE", isError: false },
        ],
      }),
    });
    const server = await createUiServer({ driver, token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await new Promise<void>((r) => { c.ws.on("open", () => r()); });
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await new Promise((r) => setTimeout(r, 150));
    c.ws.send(JSON.stringify({ t: "op", id: 1, op: { op: "sessionAnatomy" } }));
    await new Promise((r) => setTimeout(r, 200));
    const res = c.frames.find((f) => f.t === "result" && f.id === 1) as { ok?: { systemPrompt?: string; messages?: unknown[] } } | undefined;
    expect(res?.ok?.systemPrompt).toBe("You are wudao.");
    expect(res?.ok?.messages?.length).toBe(3);
    expect(JSON.stringify(res?.ok?.messages)).toContain("先读文件");
    c.ws.close();
  });

  it("无方法的 driver → 类型化拒答", async () => {
    const server = await createUiServer({ driver: baseDriver({}), token: "t" });
    servers.push(server);
    const c = connect(server.port);
    await new Promise<void>((r) => { c.ws.on("open", () => r()); });
    c.ws.send(JSON.stringify({ t: "auth", token: "t" }));
    await new Promise((r) => setTimeout(r, 150));
    c.ws.send(JSON.stringify({ t: "op", id: 1, op: { op: "sessionAnatomy" } }));
    await new Promise((r) => setTimeout(r, 200));
    const res = c.frames.find((f) => f.t === "result" && f.id === 1) as { err?: string } | undefined;
    expect(res?.err).toContain("session anatomy not supported");
    c.ws.close();
  });
});
