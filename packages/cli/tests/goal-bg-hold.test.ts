// 113-B2（prime-agent #2465 形）— goal 续跑在 /bg（detach lane）有活任务时挂起：
//   • /bg 活任务 → 本轮 goal 续跑谓词 hold（不烧续跑轮、评估器零调用、
//     "evaluation skipped" 通知落史）；
//   • settle → 恢复信号复用既有机制：landed 注入的 startRun 开新 run，
//     其 stop 缝上 goal 评估器照常裁决（无新轮询面）；
//   • 无 /bg 任务 → 行为与旧版一致（not-yet 阻塞续跑 → met 收口，逐字节
//     同 M61 语义——本文件的 B 场景即旧路径回归钉）。
// 挂起是确定性 stop-hook 判定（零模型调用参与），用户提示永不被门。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao/core";
import { buildTool } from "@wudao/core";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

/** A scripted model that RECORDS every ModelInput (the wire is the truth:
 *  evaluator calls are identified by their strict-evaluator system prompt). */
function recordingScripted(responses: readonly AssistantMessage[]): { model: ModelClient; inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    model: {
      generate: async (input: ModelInput) => {
        inputs.push(input);
        const r = responses[i];
        i += 1;
        if (!r) throw new Error("scripted responses exhausted");
        return r;
      },
    },
  };
}

const EVALUATOR_PROMPT_HEAD = "You are a strict goal evaluator";

/** Isolate the provider matrix: no priced/flash model may resolve, so the
 *  evaluator falls back to the scripted session model (the m61 discipline). */
function scrubMatrixEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("WUDAO_PRICE_") || k.endsWith("_API_KEY")) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  return saved;
}

/** The slow detachable tool (the δ driver-test fixture shape). */
function slowReleaseTool(): {
  readonly tool: ReturnType<typeof buildTool>;
  release(content: string): void;
} {
  let releaseFn: ((r: { content: string }) => void) | undefined;
  const tool = buildTool({
    name: "slowtool",
    description: "slow",
    parameters: { type: "object", properties: {} },
    async execute() {
      return new Promise<{ content: string }>((resolve) => { releaseFn = resolve; });
    },
  });
  return { tool, release: (content) => { releaseFn?.({ content }); releaseFn = undefined; } };
}

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "goal-bg-hold-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

describe("113-B2 — /bg 活任务挂起 goal 续跑轮", () => {
  it("a live /bg task holds the goal round (no evaluator call); the landed settle resumes it through startRun(landed)", async () => {
    const saved = scrubMatrixEnv();
    // Interleaved: run1 tool-call → (detach close, hooks skipped) → run2
    // final answer → [HOLD: no evaluator] → settle → run3 final answer →
    // evaluator met.
    const { model, inputs } = recordingScripted([
      { role: "assistant", content: "working on it", toolCalls: [{ id: "call_1", name: "slowtool", arguments: {} }] },
      { role: "assistant", content: "still waiting for the background build" },
      { role: "assistant", content: "the build finished, tests are green" },
      { role: "assistant", content: "VERDICT: met\neverything passes" },
    ]);
    const slow = slowReleaseTool();
    const driver: AgentDriver = createAgentDriver({
      model,
      tools: [slow.tool],
      systemPrompt: "sp",
      summarize: summarizeToolCall,
      onPermissionAsk: async () => ({ kind: "allow" }),
      workspaceRoot: ws,
      goal: true,
      gates: { todo: false, verify: false },
      statusline: { model: "test-model", version: "0" },
    });
    try {
      // Run 1: the goal's opening round calls the slow tool, then the user
      // detaches it — the run closes backgrounded (its stop seam is skipped
      // by design; the /bg task stays live).
      driver.submit("/goal tests pass");
      await until(() => (driver.getStatus().live.busyTools[0]?.callId ?? undefined) !== undefined, "the busy row carries its callId");
      const callId = driver.getStatus().live.busyTools[0]!.callId;
      expect(driver.detachToolCall(callId)).toEqual({ kind: "ok", callId, toolName: "slowtool" });
      await until(() => driver.getStatus().busy === false, "the detached run closes");
      expect(inputs).toHaveLength(1); // the backgrounded close never calls the model again

      // Run 2 while the /bg task is LIVE: the goal's stop hook must HOLD —
      // no evaluator call, no continuation round, an honest skip notice.
      driver.submit("status update");
      await until(() => driver.getStatus().busy === false, "run 2 settles");
      expect(inputs).toHaveLength(2); // exactly the loop answer — the evaluator never fired
      expect(inputs.some((x) => (x.systemPrompt ?? "").startsWith(EVALUATOR_PROMPT_HEAD))).toBe(false);
      const history = JSON.stringify(driver.getHistory());
      expect(history).toContain("evaluation skipped this round");

      // Settle: the landed result rides the lane's existing machinery —
      // startRun(landed) opens run 3, and ITS stop seam re-evaluates the goal.
      slow.release("BUILD OK [exit 0]");
      await until(() => inputs.length >= 4, "the landed run + the goal evaluator both fire");
      await until(() => driver.getStatus().busy === false, "the landed run settles");
      // The landed injection rode run 3's context (turn-tail, M24).
      expect(JSON.stringify(inputs[2]!.messages)).toContain("后台工具完成");
      // The evaluator finally ran — on run 3's stop seam — and the goal MET.
      expect((inputs[3]!.systemPrompt ?? "").startsWith(EVALUATOR_PROMPT_HEAD)).toBe(true);
      expect(JSON.stringify(driver.getHistory())).toContain("goal MET");
    } finally {
      driver.dispose();
      for (const [k, v] of Object.entries(saved)) {
        if (v !== undefined) process.env[k] = v;
      }
    }
  }, 20_000);

  it("no /bg work: the goal continuation path is untouched (not-yet blocks → met closes, the M61 semantics)", async () => {
    const saved = scrubMatrixEnv();
    const { model, inputs } = recordingScripted([
      { role: "assistant", content: "first attempt done" },
      { role: "assistant", content: "VERDICT: not-yet\nthe failing test is still red" },
      { role: "assistant", content: "second attempt done, all green" },
      { role: "assistant", content: "VERDICT: met\nshipped" },
    ]);
    const driver: AgentDriver = createAgentDriver({
      model,
      tools: [],
      systemPrompt: "sp",
      summarize: summarizeToolCall,
      onPermissionAsk: async () => ({ kind: "allow" }),
      workspaceRoot: ws,
      goal: true,
      gates: { todo: false, verify: false },
      statusline: { model: "test-model", version: "0" },
    });
    try {
      driver.submit("/goal ship it");
      await until(() => driver.getStatus().busy === false, "the goal settles");
      // The old sequence verbatim: loop → evaluator not-yet (blocks, one
      // continuation round) → loop → evaluator met (closes). No skips.
      expect(inputs).toHaveLength(4);
      expect((inputs[1]!.systemPrompt ?? "").startsWith(EVALUATOR_PROMPT_HEAD)).toBe(true);
      expect((inputs[3]!.systemPrompt ?? "").startsWith(EVALUATOR_PROMPT_HEAD)).toBe(true);
      expect(JSON.stringify(inputs[2]!.messages)).toContain("[stop blocked]");
      const history = JSON.stringify(driver.getHistory());
      expect(history).toContain("goal MET");
      expect(history).not.toContain("evaluation skipped this round");
    } finally {
      driver.dispose();
      for (const [k, v] of Object.entries(saved)) {
        if (v !== undefined) process.env[k] = v;
      }
    }
  }, 20_000);
});
