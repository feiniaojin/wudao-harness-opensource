// 133 top1 — resume 位的缓存时钟集成收据：冷+价+大前缀 → 轮转 offer 通知
// 且跳过自动预热；冷+无价 → 闲置通知（无 $）照常预热；暖 → 沉默 + 预热；
// 身份变化 → 独立通知 + 照常预热。零请求字节改动（M24——决策层独走）。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient, ModelInput, AgentMessage } from "@wudao/core";
import { buildTool } from "@wudao/core";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";
import { RESUME_PREWARM_QUERY_SOURCE } from "../src/resume-prewarm.js";

let ws = "";
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "arc133-clock-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  delete process.env.WUDAO_GLOBAL_HOME;
});

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const HOURS = 3_600_000;

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

/** Seed a session file + backdate its mtime (the cache clock's tick). */
async function seedSession(id: string, lines: string[], idleHours = 0): Promise<void> {
  await mkdir(join(ws, ".wudao", "sessions"), { recursive: true });
  const file = join(ws, ".wudao", "sessions", `${id}.jsonl`);
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  if (idleHours > 0) {
    const t = new Date(Date.now() - idleHours * HOURS);
    await utimes(file, t, t);
  }
}

/** Pin a price for `model` under the glm-code profile in a temp global home
 * (the registry read is per-path memoized — a fresh tmp path reads fresh). */
async function pinPrice(model: string): Promise<void> {
  const home = join(ws, "global-home");
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "providers.json"),
    JSON.stringify({
      version: 1,
      providers: {
        "glm-code": { models: [{ name: model, prices: { inputPerM: 0.27, cacheReadPerM: 0.07, outputPerM: 1.1 } }] },
      },
    }),
    "utf8",
  );
  process.env.WUDAO_GLOBAL_HOME = home;
}

const BIG = "调查 ".repeat(30_000); // ≫8192 tokens by any estimator

const modelChange = (model: string, provider = "glm-code") => ({
  type: "model_change",
  model,
  provider,
  at: "2026-09-01T00:00:00.000Z",
});

interface Notice {
  readonly kind: string;
  readonly text: string;
}

async function resumeAndCollect(
  id: string,
  sessionMeta: { provider?: string; model?: string },
): Promise<{ notices: Notice[]; prewarms: number }> {
  const calls: ModelInput[] = [];
  const notices: Notice[] = [];
  const driver = createAgentDriver({
    model: recordingModel(calls),
    tools: [stubReadTool()],
    systemPrompt: "sys",
    summarize: summarizeToolCall,
    workspaceRoot: ws,
    sessionId: "fresharc133",
    sessionMeta,
  });
  try {
    driver.onHistory((entries) => {
      for (const e of entries as Notice[]) if (e.kind === "notice") notices.push({ kind: e.kind, text: e.text });
    });
    expect(await driver.resume(id)).toEqual({ ok: true });
    await wait(50);
    return { notices, prewarms: calls.filter((c) => c.querySource === RESUME_PREWARM_QUERY_SOURCE).length };
  } finally {
    driver.dispose();
  }
}

const bigHistory = (): AgentMessage[] => [
  { role: "user", content: BIG },
  { role: "assistant", content: "完成了。" },
];

describe("133 top1 — resume 缓存时钟决策点（集成）", () => {
  it("冷(4h) + 目录价 + 大前缀 → 带价轮转 offer 通知，且自动预热被跳过", async () => {
    await pinPrice("clockpin1");
    await seedSession("clockcold1", [modelChange("clockpin1"), ...bigHistory()], 4);
    const { notices, prewarms } = await resumeAndCollect("clockcold1", { provider: "glm-code", model: "clockpin1" });
    const clock = notices.filter((n) => n.text.includes("闲置"));
    expect(clock.length).toBe(1);
    expect(clock[0]!.text).toContain("$");
    expect(clock[0]!.text).toContain("归纳");
    // offer 成立 → 预热跳过（轮转决定悬置，冷读不白烧）
    expect(prewarms).toBe(0);
  });

  it("冷(4h) + 无价（目录没这档）→ 闲置通知不带 $，照常预热", async () => {
    await seedSession("clockcold2", [modelChange("nopin-model"), ...bigHistory()], 4);
    const { notices, prewarms } = await resumeAndCollect("clockcold2", { provider: "glm-code", model: "nopin-model" });
    const clock = notices.filter((n) => n.text.includes("闲置"));
    expect(clock.length).toBe(1);
    expect(clock[0]!.text).not.toContain("$");
    expect(prewarms).toBe(1);
  });

  it("暖（mtime 刚写）→ 时钟沉默，照常预热（128-2 行为不变）", async () => {
    await seedSession("clockwarm1", [modelChange("nopin-model"), { role: "user", content: "小会话" }, { role: "assistant", content: "好" }]);
    const { notices, prewarms } = await resumeAndCollect("clockwarm1", { provider: "glm-code", model: "nopin-model" });
    expect(notices.filter((n) => n.text.includes("闲置") || n.text.includes("推理档")).length).toBe(0);
    expect(prewarms).toBe(1);
  });

  it("身份变化（台账 glm-5.3 vs 进程 deepseek-chat）→ 独立通知，照常预热", async () => {
    await seedSession("clockident1", [modelChange("glm-5.3"), ...bigHistory()], 4);
    const { notices, prewarms } = await resumeAndCollect("clockident1", { provider: "deepseek", model: "deepseek-chat" });
    const ident = notices.filter((n) => n.text.includes("推理档"));
    expect(ident.length).toBe(1);
    expect(ident[0]!.text).toContain("deepseek/deepseek-chat");
    expect(prewarms).toBe(1); // identity 不并入 offer——预热不受影响
  });
});
