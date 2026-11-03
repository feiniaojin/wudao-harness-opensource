// 137 — 监督者模式三件之 core 侧钉：LoopOptions.sessionId → agent.* 与
// tool.* 探针事件盖 sessionId 章（多会话/多车道并发时监督者可归并）。
// 挂载点吃进程级默认总线（probe.ts 的 probeBus() 单例）——同文件内先订阅
// 再跑 loop，取同一单例。server 侧 {t:"event"} 帧的 at 时间戳由 server 包
// 的测试钉。
import { describe, it, expect, afterEach } from "vitest";
import { createScriptedModel, runAgentLoop, probeBus, probeEnabled, PROBE_ENV, type ProbeEvent, type Tool } from "../src/index.js";

const ORIGINAL = process.env[PROBE_ENV];
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[PROBE_ENV];
  else process.env[PROBE_ENV] = ORIGINAL;
});

const drain = async (gen: AsyncGenerator<unknown, unknown>): Promise<void> => {
  for (;;) {
    const r = await gen.next();
    if (r.done === true) return;
  }
};

const noopTool: Tool = {
  name: "noop",
  description: "d",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  async execute() { return { content: "ok" }; },
};

describe("137 — 探针事件带会话身份", () => {
  it("sessionId 下发：agent.turn 与 tool.start/finish 都盖 sessionId 章", async () => {
    process.env[PROBE_ENV] = "on";
    expect(probeEnabled()).toBe(true);
    const bus = probeBus(); // 进程单例——loop 挂载点用的同一条
    const events: ProbeEvent[] = [];
    const off = bus.subscribe("*", (e) => events.push(e));
    try {
      const model = createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "noop", arguments: {} }] },
        { role: "assistant", content: "fin" },
      ]);
      const state = { systemPrompt: "s", messages: [{ role: "user" as const, content: "go" }], tools: [noopTool], status: "idle" as const };
      await drain(runAgentLoop(state, model, { sessionId: "sess-137" }));
      const names = new Set(events.map((e) => e.name));
      expect(names.has("agent.turn")).toBe(true);
      expect(names.has("tool.start")).toBe(true);
      expect(names.has("tool.finish")).toBe(true);
      // 章只认下发值：凡带 sessionId 的事件必是 sess-137（缺省调用方零字段）。
      for (const e of events) expect(e.sessionId === undefined || e.sessionId === "sess-137").toBe(true);
      expect(events.some((e) => e.sessionId === "sess-137")).toBe(true);
    } finally {
      off();
    }
  });

  it("缺省（无 sessionId）：事件不带该字段——既有调用方零变化", async () => {
    process.env[PROBE_ENV] = "on";
    const bus = probeBus();
    const events: ProbeEvent[] = [];
    const off = bus.subscribe("*", (e) => events.push(e));
    try {
      const model = createScriptedModel([{ role: "assistant", content: "fin" }]);
      const state = { systemPrompt: "s", messages: [{ role: "user" as const, content: "go" }], tools: [], status: "idle" as const };
      await drain(runAgentLoop(state, model, {}));
      for (const e of events) expect(e.sessionId).toBeUndefined();
    } finally {
      off();
    }
  });
});
