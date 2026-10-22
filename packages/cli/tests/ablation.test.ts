// M53 §5 — the ablation flag matrix: parsing, the env bridge, and each
// feature's off-state at its real seam.
import { afterEach, describe, expect, it } from "vitest";
import {
  ABLATION_FEATURES,
  ablationEnvVar,
  applyAblationFlagsToEnv,
  isFeatureAblated,
  parseAblationFlags,
  type AblationFeature,
} from "../src/args.js";
import { resolveLanguageBlockMode, languageBlockFor } from "../src/language.js";
import { backgroundReviewEnabled } from "../src/memory/review.js";
import { createScriptedModel } from "@wudao/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriverOptions } from "../src/driver/agent-driver.js";
import { buildTool } from "@wudao/core";
import type { Tool } from "@wudao/core";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

// Clean the bridge vars between tests (isFeatureAblated reads process.env).
// ω-4d: "clean" is the ENVIRONMENT's baseline, not all-features-on — the
// global setup (setup-global-home.ts) presets WUDAO_NO_LOGIN_SHELL=1 for the
// whole cli test env (a live frontend under test must not spawn the
// developer's real login shell). Forcing it off here would re-arm that spawn
// for any later test file sharing this worker process, so record the
// baseline at load and restore it, deleting only what the tests set.
const ablationBaseline: Partial<Record<AblationFeature, string | undefined>> = {};
for (const f of ABLATION_FEATURES) ablationBaseline[f] = process.env[ablationEnvVar(f)];
const resetAblationEnv = (): void => {
  for (const f of ABLATION_FEATURES) {
    const v = ablationBaseline[f];
    if (v === undefined) delete process.env[ablationEnvVar(f)];
    else process.env[ablationEnvVar(f)] = v;
  }
};
resetAblationEnv();
afterEach(resetAblationEnv);

describe("ablation flag parsing (M53 §5)", () => {
  it("no flags = every feature enabled (byte-equivalent to the default run)", () => {
    const flags = parseAblationFlags(["wudao", "hello world"]);
    for (const f of ABLATION_FEATURES) expect(flags[f]).toBe(false);
  });

  it("every --no-<feature> parses (both dash forms); unknown --no- flags are ignored", () => {
    const argv = [
      "--no-sidecar", "-no-verify", "--no-diagnostics", "--no-language", "--no-review-fork",
      "--no-steering", "-no-gates", "--no-loop-safety", "--no-loop-reflection", "--no-elision", "--no-login-shell",
      "--no-cold-cache-warning", "--no-ask-reviewer", "--no-cache-waste-notice", "--no-something-else",
    ];
    const flags = parseAblationFlags(argv);
    for (const f of ABLATION_FEATURES) expect(flags[f], f).toBe(true);
  });

  it("underscore form matches dashed feature names", () => {
    expect(parseAblationFlags(["--no_loop_safety"])["loop-safety"]).toBe(true);
    expect(parseAblationFlags(["--no_review_fork"])["review-fork"]).toBe(true);
  });

  it("the env bridge round-trips through isFeatureAblated (and never unsets)", () => {
    const flags = parseAblationFlags(["--no-elision"]);
    const env: NodeJS.ProcessEnv = {};
    applyAblationFlagsToEnv(flags, env);
    expect(env["WUDAO_NO_ELISION"]).toBe("1");
    expect(env.WUDAO_NO_SIDECAR).toBeUndefined();
    expect(isFeatureAblated("elision", env)).toBe(true);
    expect(isFeatureAblated("sidecar", env)).toBe(false);
  });
});

describe("ablated feature seams (M53 §5)", () => {
  it("--no-language: resolveLanguageBlockMode returns off (no block for a Chinese prompt)", () => {
    process.env.WUDAO_NO_LANGUAGE = "1";
    expect(resolveLanguageBlockMode()).toBe("off");
    expect(languageBlockFor("请总结这个项目", resolveLanguageBlockMode())).toBeUndefined();
    delete process.env.WUDAO_NO_LANGUAGE;
    expect(languageBlockFor("请总结这个项目", resolveLanguageBlockMode())).toBeTruthy();
  });

  it("--no-review-fork: backgroundReviewEnabled is false regardless of the env switch", () => {
    process.env.WUDAO_NO_REVIEW_FORK = "1";
    expect(backgroundReviewEnabled({ WUDAO_BG_REVIEW: "on", WUDAO_NO_REVIEW_FORK: "1" })).toBe(false);
    delete process.env.WUDAO_NO_REVIEW_FORK;
    expect(backgroundReviewEnabled({})).toBe(true);
  });

  it("--no-steering: a busy submit is refused with a notice instead of queueing", async () => {
    process.env.WUDAO_NO_STEERING = "1";
    let release!: (v: unknown) => void;
    const gate = new Promise<unknown>((r) => { release = r; });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "s1", name: "read_file", arguments: { path: "slow.txt" } }] },
      { role: "assistant", content: "done" },
    ]);
    const slow: Tool = buildTool({
      name: "read_file",
      description: "d",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async () => { await gate; return { content: "late" }; },
    });
    const allow = async () => ({ kind: "allow" as const });
    const driver = createAgentDriver({
      model, tools: [slow], systemPrompt: "s", summarize: summarizeToolCall, onPermissionAsk: allow,
    } as Partial<AgentDriverOptions> & Pick<AgentDriverOptions, "model" | "tools">);
    driver.submit("go");
    await until(() => (driver.getStatus().live.busyTools.length > 0), "gated tool");
    const outcome = driver.submit("a steer");
    expect(outcome).toBe("notice");
    expect(driver.getStatus().queued).toEqual([]);
    release(undefined);
    await until(() => driver.getStatus().busy === false, "run settles");
    driver.dispose();
  });
});

// ---------------------------------------------------------------------------
// M53 review fixes — argv-scoped ablation parsing (prompt words don't ablate)
// and --no-gates' LOOP behavior (the flag must disable the stop gates, not
// hand the loop an undefined it defaults back to on).
// ---------------------------------------------------------------------------
import { runAgentLoop, createTodoTool } from "@wudao/core";
import type { AgentMessage, LoopEvent, LoopGates, Terminal } from "@wudao/core";
import { applyGatesAblation, resolveLongTaskRuntime, DEFAULT_LONG_TASK } from "../src/long-task-config.js";

describe("ablation argv scoping (M53 review fix)", () => {
  it("prompt words never ablate: --no-X counts only BEFORE the first non-flag argument", () => {
    const oneShot = parseAblationFlags(["fix", "the", "--no-gates", "bug"]);
    for (const f of ABLATION_FEATURES) expect(oneShot[f], f).toBe(false);
    // leading flags still parse, and value-taking flags don't break the scan
    const leading = parseAblationFlags(["--resume", "sess1", "--no-gates", "continue"]);
    expect(leading["gates"]).toBe(true);
    // a flag after the prompt starts is a prompt word, full stop
    const mid = parseAblationFlags(["--no-gates", "fix", "--no-verify", "it"]);
    expect(mid["gates"]).toBe(true);
    expect(mid["verify"]).toBe(false);
  });
});

describe("--no-gates loop behavior (M53 review fix)", () => {
  // Drive the generator manually to capture the Terminal return value.
  async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<Terminal> {
    while (true) {
      const { done, value } = await gen.next();
      if (done) return value;
    }
  }

  // One gated run: the model writes a pending todo board, then answers
  // empty-handed. Returns how many [system note: …] gate injections landed
  // in the conversation and how many model calls were made.
  async function gatedRun(gates: LoopGates | undefined): Promise<{ injections: number; calls: number }> {
    const script: AgentMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "g1", name: "todo_write", arguments: { todos: [{ content: "step", status: "pending" }] } }] },
      { role: "assistant", content: "stopping anyway" },
      { role: "assistant", content: "still stopping" },
      { role: "assistant", content: "truly stopping" },
      { role: "assistant", content: "final" },
    ];
    let calls = 0;
    let i = 0;
    const model = {
      async generate(input: { messages: AgentMessage[] }) {
        calls += 1;
        void input;
        const next = script[i];
        i += 1;
        if (!next) throw new Error("script exhausted");
        return next;
      },
    };
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" } as AgentMessage],
      tools: [createTodoTool({})],
      status: "idle" as const,
    };
    const terminal = await drain(runAgentLoop(state, model, { maxTurns: 10, ...(gates !== undefined ? { gates } : {}) }));
    void terminal;
    const injections = state.messages.filter((m) => m.role === "user" && m.content.startsWith("[system note:")).length;
    return { injections, calls };
  }

  it("--no-gates yields ZERO gate injections through the real loop (not just parse)", async () => {
    const env: NodeJS.ProcessEnv = {};
    applyAblationFlagsToEnv(parseAblationFlags(["--no-gates"]), env);
    const rt = applyGatesAblation(resolveLongTaskRuntime(DEFAULT_LONG_TASK, env), env);
    // the runtime shape the CLI threads — explicitly OFF, not undefined
    expect(rt.gates?.todo).toBe(false);
    expect(rt.gates?.verify).toBe(false);
    const run = await gatedRun(rt.gates);
    expect(run.injections).toBe(0);
    expect(run.calls).toBe(2); // board write + the final answer — no gate round-trips
  });

  it("contrast: gates:undefined (the pre-fix shape) still gates — the loop defaults it back on", async () => {
    const run = await gatedRun(undefined);
    expect(run.injections).toBeGreaterThan(0); // why --no-gates must set false/false
  });
});
