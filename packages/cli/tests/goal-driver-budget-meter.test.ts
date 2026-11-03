// ω99-13b — driver（TUI/desktop）面的 /goal --budget 计量接线。ω99-13 落了
// --budget/--gate 并接了 repl（replGoalBox）/index（headlessGoalBox）两个
// seam；driver 路径的 /goal set 通知会打印 "budget: N tokens"，但 session
// engine 的 usage 观察缝从不调 recordMainUsage —— 桌面端预算静默不计量。
// 本文件钉死第三处接线的两个行为（形态抄 subagent-cost-attribution.test.ts
// 的 "session-engine wiring" describe + session-engine-keypool.test.ts 的
// 离线 boot / WUDAO_GLOBAL_HOME 沙箱）：
//   D1 主调用计量 — 未打标的主模型调用的 usage 行恰一次到达 goalBox 里
//      controller 的 recordMainUsage(usage, undefined)；且创建时 driver 已
//      把真 controller 填进 box（agent-driver 的填充点）。
//   D2 subagent 跳过 — 同 client 子代理调用（core 的 querySource="subagent"
//      stamp）在 seam 的 return 处被跳过、先于 recordMainUsage（零到达）。
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentState, AssistantMessage, ModelClient, ModelInput, ModelUsage } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";
import { createDriverSession } from "../src/driver/session-engine.js";
import type { DriverSession } from "../src/driver/session-engine.js";
import type { GoalController } from "../src/goal.js";

// Offline boot (unreachable baseURL is fine — the scripted model never dials).
const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

const sessions: DriverSession[] = [];
const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["WUDAO_GLOBAL_HOME", "WUDAO_DEFER_TOOLS", "WUDAO_API_KEY", "WUDAO_API_KEYS", "OPENAI_API_KEY"] as const;

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close().catch(() => {});
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
    delete savedEnv[k];
  }
  for (const r of roots.splice(0)) {
    for (let i = 0; i < 10; i += 1) {
      try {
        rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
        await new Promise((res) => setTimeout(res, 50));
      }
    }
  }
});

const wait = (ms = 10) => new Promise((res) => setTimeout(res, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

/** Sandbox the global home (credentials/settings/registry reads stay in a
 * temp dir — never the developer's real ~/.wudao). */
function sandboxHome(): string {
  const home = mkdtempSync(join(tmpdir(), "goal-meter-home-"));
  roots.push(home);
  mkdirSync(home, { recursive: true });
  process.env.WUDAO_GLOBAL_HOME = home;
  return home;
}

/** A spy controller — records every recordMainUsage(usage, src) pair; the
 * rest of the interface is inert no-ops (the seam only calls this method;
 * the driver's stop hook captured the REAL controller at creation, so the
 * spy's other faces never fire). */
interface UsageCall {
  readonly usage: { readonly promptTokens: number; readonly completionTokens?: number };
  readonly querySource: string | undefined;
}
function spyController(): GoalController & { readonly calls: readonly UsageCall[] } {
  const calls: UsageCall[] = [];
  return {
    calls,
    set: async () => "goal set (spy)",
    status: () => "goal status (spy)",
    clear: () => "goal cleared (spy)",
    onStop: async (_state: AgentState) => "allow" as const,
    onRunEnd: () => {},
    onUserPrompt: () => {},
    recordMainUsage: (usage, querySource) => {
      calls.push({ usage: { promptTokens: usage.promptTokens, ...(usage.completionTokens !== undefined ? { completionTokens: usage.completionTokens } : {}) }, querySource });
    },
    active: () => false,
    snapshot: () => undefined,
    restoreFromEntries: () => false,
  };
}

/** A scripted model that records every input and reports a usage row when
 * `report(input)` returns one (BEFORE consuming the scripted response — the
 * provider's only usage channel is input.onUsage). */
function usageModel(
  responses: readonly AssistantMessage[],
  report: (input: ModelInput) => ModelUsage | undefined,
): ModelClient & { readonly inputs: readonly ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push(input);
      const row = report(input);
      if (row !== undefined) input.onUsage?.(row);
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

describe("ω99-13b D1 — 主调用 usage 恰一次到达 driver goalBox 的 controller", () => {
  it("an untagged main call meters exactly once via recordMainUsage(usage, undefined); the driver filled the box at creation", async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    sandboxHome();
    const ws = mkdtempSync(join(tmpdir(), "goal-meter-d1-"));
    roots.push(ws);
    const spy = spyController();
    // Report ONLY on the untagged main call (side calls — auto-title — carry
    // tags; the wrapper's onUsage sees every row, the spy must hear one).
    const model = usageModel(
      [{ role: "assistant", content: "DONE" }, { role: "assistant", content: "TITLE-OK" }],
      (input) => (input.querySource === undefined ? { promptTokens: 1000, cacheHitTokens: 0, cacheMissTokens: 1000, completionTokens: 50 } : undefined),
    );
    const session = await createDriverSession({
      config,
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      tools: [],
      sessionId: "goal-meter-d1",
      modelOverride: model,
      noPeer: true,
    });
    sessions.push(session);
    // The driver filled the box with its REAL controller at creation (the
    // agent-driver fill point); the test then swaps in the spy.
    expect(session.goalBox.current).toBeDefined();
    session.goalBox.current = spy;
    session.driver.submit("hi");
    await until(() => session.driver.getStatus().busy === false, "the run to settle");
    expect(model.inputs.some((x) => x.querySource === undefined)).toBe(true); // a main call really happened
    expect(spy.calls).toEqual([{ usage: { promptTokens: 1000, completionTokens: 50 }, querySource: undefined }]);
  });
});

describe("ω99-13b D2 — subagent 行在 seam 处跳过（先于 recordMainUsage）", () => {
  it("a querySource='subagent' child call reports usage yet the controller's box records NOTHING", async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    sandboxHome();
    const ws = mkdtempSync(join(tmpdir(), "goal-meter-d2-"));
    roots.push(ws);
    const spy = spyController();
    // One scripted model serves parent AND child (unpinned role → the session
    // model): parent dispatches `task`, the child (stamped by core) reports a
    // usage row, the parent finishes. Auto-title may consume a 4th generate.
    const model = usageModel(
      [
        { role: "assistant", content: "", toolCalls: [{ id: "p1", name: "task", arguments: { description: "run child", prompt: "child brief" } }] },
        { role: "assistant", content: "CHILD-DONE" },
        { role: "assistant", content: "PARENT-DONE" },
      ],
      (input) => (input.querySource === "subagent" ? { promptTokens: 700, cacheHitTokens: 0, cacheMissTokens: 700, completionTokens: 30 } : undefined),
    );
    const origArgv = process.argv;
    process.argv = [...origArgv, "--auto"]; // auto mode: the task tool runs without a parked ask
    process.env.WUDAO_DEFER_TOOLS = "off"; // the task tool callable without load_tools
    let session: DriverSession;
    try {
      session = await createDriverSession({
        config,
        workspaceRoot: ws,
        contextWindowTokens: 64_000,
        sessionId: "goal-meter-d2",
        modelOverride: model,
        noPeer: true,
      });
    } finally {
      process.argv = origArgv;
    }
    sessions.push(session);
    expect(session.goalBox.current).toBeDefined();
    session.goalBox.current = spy;
    session.driver.submit("dispatch the child");
    await until(
      () => session.driver.getStatus().busy === false && session.driver.getHistory().some((h) => h.kind === "assistant" && h.text === "PARENT-DONE"),
      "the fleet run to finish",
    );
    // Non-vacuous: the tagged child call really flowed through the shared
    // client (core's withChildQuerySource stamp), and its row was reported.
    expect(model.inputs.some((x) => x.querySource === "subagent")).toBe(true);
    // The seam returned BEFORE recordMainUsage — zero rows reach the box.
    expect(spy.calls).toHaveLength(0);
  });
});
