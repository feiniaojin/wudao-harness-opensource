// 128-2（the upstream project20 引进，变体）— resume 暖前缀收据。
// 恰一次 max_tokens:1 同前缀请求 / querySource 溯源 / kill switch / 失败静默 /
// 空历史不预热 / usage 的 goal 排除（querySource 过滤纪律）。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient, ModelInput, AgentMessage } from "@wudao/core";
import { buildTool } from "@wudao/core";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";
import {
  fireResumePrewarm,
  resumePrewarmDisabled,
  RESUME_PREWARM_DISABLE_ENV,
  RESUME_PREWARM_QUERY_SOURCE,
} from "../src/resume-prewarm.js";

let ws = "";
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "arc128-prewarm-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  delete process.env[RESUME_PREWARM_DISABLE_ENV];
});

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** A recording model: every generate call lands in the log. */
function recordingModel(log: ModelInput[]): ModelClient {
  return {
    async generate(input) {
      log.push(input);
      return { role: "assistant", content: "ok" };
    },
  };
}

const stubReadTool = () =>
  buildTool({
    name: "read_file",
    description: "stub",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    isOpenWorld: () => false,
    async execute() {
      return { content: "ok" };
    },
  });

/** Seed a session file the driver can resume. */
async function seedSession(id: string, messages: AgentMessage[]): Promise<void> {
  await mkdir(join(ws, ".wudao", "sessions"), { recursive: true });
  await writeFile(
    join(ws, ".wudao", "sessions", `${id}.jsonl`),
    messages.map((m) => JSON.stringify(m)).join("\n") + "\n",
    "utf8",
  );
}

describe("128-2 — 纯层", () => {
  it("kill switch 形状（=1 关，其它开）", () => {
    expect(resumePrewarmDisabled({ [RESUME_PREWARM_DISABLE_ENV]: "1" })).toBe(true);
    expect(resumePrewarmDisabled({})).toBe(false);
    expect(resumePrewarmDisabled({ [RESUME_PREWARM_DISABLE_ENV]: "0" })).toBe(false);
  });

  it("空历史不预热（没有可暖的恢复面）", async () => {
    const calls: ModelInput[] = [];
    fireResumePrewarm(recordingModel(calls), { systemPrompt: "s", tools: [], messages: [] });
    await wait();
    expect(calls.length).toBe(0);
  });

  it("失败静默：model 抛错不冒泡", async () => {
    const throwing: ModelClient = {
      async generate() {
        throw new Error("provider down");
      },
    };
    fireResumePrewarm(throwing, { systemPrompt: "s", tools: [], messages: [{ role: "user", content: "hi" }] });
    await wait();
    // 到这里没抛 = 通过（fire-and-forget + .catch 吞）。
  });

  it("请求形：maxTokens 1 + querySource prewarm + 原样前缀", async () => {
    const calls: ModelInput[] = [];
    const msgs: AgentMessage[] = [{ role: "user", content: "第一问" }, { role: "assistant", content: "答" }];
    fireResumePrewarm(recordingModel(calls), { systemPrompt: "sys", tools: [stubReadTool()], messages: msgs });
    await wait();
    expect(calls.length).toBe(1);
    expect(calls[0]!.maxTokens).toBe(1);
    expect(calls[0]!.querySource).toBe(RESUME_PREWARM_QUERY_SOURCE);
    expect(calls[0]!.systemPrompt).toBe("sys");
    expect(calls[0]!.messages).toEqual(msgs);
  });

  it("kill switch 开时不发", async () => {
    const calls: ModelInput[] = [];
    process.env[RESUME_PREWARM_DISABLE_ENV] = "1";
    fireResumePrewarm(recordingModel(calls), { systemPrompt: "s", tools: [], messages: [{ role: "user", content: "x" }] });
    await wait();
    expect(calls.length).toBe(0);
  });
});

describe("128-2 — 集成：resume() 落定即暖", () => {
  it("resume 一个既有会话 → 恰一次 prewarm 请求（与真实 run 分离）", async () => {
    const calls: ModelInput[] = [];
    await seedSession("prewarm01", [
      { role: "user", content: "把 utils 重构" },
      { role: "assistant", content: "完成了。" },
    ]);
    const driver = createAgentDriver({
      model: recordingModel(calls),
      tools: [stubReadTool()],
      systemPrompt: "sys",
      summarize: summarizeToolCall,
      workspaceRoot: ws,
      sessionId: "freshchild",
    });
    try {
      expect(await driver.resume("prewarm01")).toEqual({ ok: true });
      await wait(50);
      const prewarms = calls.filter((c) => c.querySource === RESUME_PREWARM_QUERY_SOURCE);
      expect(prewarms.length).toBe(1); // 恰一次
      expect(prewarms[0]!.maxTokens).toBe(1);
      expect(prewarms[0]!.messages.length).toBe(2); // 恢复的历史原样
    } finally {
      driver.dispose();
    }
  });

  it("resume 失败（会话不存在）→ 零 prewarm", async () => {
    const calls: ModelInput[] = [];
    const driver = createAgentDriver({
      model: recordingModel(calls),
      tools: [stubReadTool()],
      systemPrompt: "sys",
      summarize: summarizeToolCall,
      workspaceRoot: ws,
      sessionId: "freshchild2",
    });
    try {
      expect(await driver.resume("ghostid1")).toEqual({ ok: false, reason: "not_found" });
      await wait(50);
      expect(calls.filter((c) => c.querySource === RESUME_PREWARM_QUERY_SOURCE).length).toBe(0);
    } finally {
      driver.dispose();
    }
  });
});
