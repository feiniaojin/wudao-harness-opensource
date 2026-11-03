// design 70 §4 Phase 1 wiring — funnel 3 (the driver's askPermission: the
// parked PendingPermission + the relayed onPermissionAsk ctx) and funnel 4
// (the TUI App callback + PermissionPrompt), plus the M24 zero-byte pin at
// the driver level (the reviewer's existence changes NO main-run request
// bytes). Deterministic: scripted routing models (querySource-keyed), no
// network, no TTY.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool } from "@wudao-org/core";
import type { AgentMessage, AssistantMessage, ModelClient, ModelInput, PermissionDecision, Tool } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver, AgentDriverOptions } from "../src/driver/agent-driver.js";
import { PermissionPrompt } from "../src/tui/permission.js";
import { WudaoApp } from "../src/tui/app.js";
import { decorateChildGate } from "../src/ask-evidence.js";
import { resetAskReviewBreaker } from "../src/ask-reviewer.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const ASKER = { kind: "child" as const, role: "coder", brief: "run the integration suite and fix failures" };

const ROOT_MESSAGES: readonly AgentMessage[] = [
  { role: "user", content: "only touch files under packages/core, never run migrations" },
  { role: "assistant", content: "Understood — starting with the test suite." },
  { role: "user", content: "run the integration suite and fix failures" },
];

/** Run `fn` with the ALS asker context live (a child's ask fires inside this). */
async function inChildContext<T>(fn: () => Promise<T>): Promise<T> {
  const box: { value?: T; done: boolean } = { done: false };
  const gate = async (): Promise<PermissionDecision> => {
    box.value = await fn();
    box.done = true;
    return { behavior: "allow" };
  };
  await decorateChildGate(gate, ASKER, () => ROOT_MESSAGES)("shell", {});
  if (!box.done) throw new Error("child gate never ran");
  return box.value as T;
}

/** Routes generate by querySource: the ask-reviewer branch answers the
 *  review; every other call walks the main-loop script. Both sides record. */
function routingModel(opts: {
  readonly review: string | { readonly throwMessage: string };
  readonly main: readonly AssistantMessage[];
}): ModelClient & { mainInputs: ModelInput[]; reviewInputs: ModelInput[] } {
  const mainInputs: ModelInput[] = [];
  const reviewInputs: ModelInput[] = [];
  let mainI = 0;
  return {
    mainInputs,
    reviewInputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      if (input.querySource === "ask-reviewer") {
        reviewInputs.push(input);
        if (typeof opts.review === "object") throw new Error(opts.review.throwMessage);
        return { role: "assistant", content: opts.review };
      }
      mainInputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
      const r = opts.main[mainI];
      mainI += 1;
      if (r === undefined) throw new Error("main script exhausted");
      return r;
    },
  };
}

const MAIN_SCRIPT: readonly AssistantMessage[] = [
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "echo hi" } }] },
  { role: "assistant", content: "DONE" },
];

function stubRunCommandTool(): Tool {
  return buildTool({
    name: "shell",
    description: "stub command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
    execute: async () => ({ content: "ran" }),
  });
}

function makeDriver(opts: Partial<AgentDriverOptions> & Pick<AgentDriverOptions, "model" | "tools">): AgentDriver {
  return createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, ...opts });
}

beforeEach(() => {
  resetAskReviewBreaker();
  delete process.env.WUDAO_ASK_REVIEWER;
  delete process.env.WUDAO_NO_ASK_REVIEWER;
});

afterEach(() => {
  delete process.env.WUDAO_ASK_REVIEWER;
  delete process.env.WUDAO_NO_ASK_REVIEWER;
});

// ---------------------------------------------------------------------------
// R7 — driver wiring (funnel 3)
// ---------------------------------------------------------------------------

describe("driver askPermission (funnel 3)", () => {
  it("a child-originated ask with a verdict parks PendingPermission with askDigest + askReview", async () => {
    process.env.WUDAO_ASK_REVIEWER = "1";
    const model = routingModel({ review: "VERDICT: covered\nREASON: user asked for tests", main: MAIN_SCRIPT });
    const driver = makeDriver({ model, tools: [stubRunCommandTool()] });
    await wait();
    await inChildContext(async () => {
      driver.submit("go");
      await until(() => driver.getStatus().pendingPermission !== null, "ask to park");
    });
    const pending = driver.getStatus().pendingPermission;
    expect(pending?.toolName).toBe("shell");
    expect(pending?.askDigest).toContain("asked by: subagent coder");
    expect(pending?.askDigest).toContain("user: only touch files under packages/core");
    expect(pending?.askReview).toBe("🛡 ask-review (advisory): covered — user asked for tests");
    expect(model.reviewInputs).toHaveLength(1);
    expect(driver.answerPermission(true)).toBe(true);
    await until(() => driver.getStatus().busy === false, "run to finish");
    driver.dispose();
  });

  it("the relay path carries askDigest + askReview on the onPermissionAsk ctx", async () => {
    process.env.WUDAO_ASK_REVIEWER = "1";
    const model = routingModel({ review: "VERDICT: uncovered\nREASON: migrations were forbidden", main: MAIN_SCRIPT });
    const asks: unknown[][] = [];
    const driver = makeDriver({
      model,
      tools: [stubRunCommandTool()],
      onPermissionAsk: async (toolName, summary, input, ctx) => {
        asks.push([toolName, summary, input, ctx]);
        return { kind: "allow" as const };
      },
    });
    await wait();
    await inChildContext(async () => {
      driver.submit("go");
      await until(() => driver.getStatus().busy === false, "run to finish");
    });
    expect(asks).toHaveLength(1);
    const [toolName, summary, input, ctx] = asks[0] as [string, string, Record<string, unknown>, { askDigest?: string; askReview?: string }];
    expect(toolName).toBe("shell");
    expect(summary).toBe(summarizeToolCall("shell", { command: "echo hi" }));
    expect(input).toEqual({ command: "echo hi" });
    expect(ctx.askDigest).toContain("asked by: subagent coder");
    expect(ctx.askReview).toBe("🛡 ask-review (advisory): not covered — migrations were forbidden");
    driver.dispose();
  });

  it("unarmed / top-level: the parked object and the relayed ctx are OBSERVATIONALLY IDENTICAL to today", async () => {
    // Unarmed + child context (the digest still rides ω-4e; the review does not).
    const model = routingModel({ review: "VERDICT: covered\nREASON: r", main: MAIN_SCRIPT });
    const driver = makeDriver({ model, tools: [stubRunCommandTool()] });
    await wait();
    await inChildContext(async () => {
      driver.submit("go");
      await until(() => driver.getStatus().pendingPermission !== null, "ask to park");
    });
    const pending = driver.getStatus().pendingPermission;
    expect(pending).toStrictEqual({
      toolName: "shell",
      summary: summarizeToolCall("shell", { command: "echo hi" }),
      input: { command: "echo hi" },
      askDigest: expect.any(String) as unknown as string,
    });
    expect("askReview" in (pending ?? {})).toBe(false);
    expect(model.reviewInputs).toHaveLength(0); // no review call
    expect(driver.answerPermission(true)).toBe(true);
    await until(() => driver.getStatus().busy === false, "run to finish");
    driver.dispose();

    // Armed but TOP-LEVEL: the 4th arg stays undefined (the existing pin).
    process.env.WUDAO_ASK_REVIEWER = "1";
    const model2 = routingModel({ review: "VERDICT: covered", main: MAIN_SCRIPT });
    const asks: unknown[][] = [];
    const driver2 = makeDriver({
      model: model2,
      tools: [stubRunCommandTool()],
      onPermissionAsk: async (toolName, summary, input, ctx) => {
        asks.push([toolName, summary, input, ctx]);
        return { kind: "allow" as const };
      },
    });
    await wait();
    driver2.submit("go");
    await until(() => driver2.getStatus().busy === false, "run to finish");
    expect(asks[0]?.[3]).toBeUndefined();
    expect(model2.reviewInputs).toHaveLength(0);
    driver2.dispose();
  });

  it("a reviewer failure fails closed: no askReview anywhere, the ask still parks and answers", async () => {
    process.env.WUDAO_ASK_REVIEWER = "1";
    const model = routingModel({ review: { throwMessage: "reviewer backend down" }, main: MAIN_SCRIPT });
    const driver = makeDriver({ model, tools: [stubRunCommandTool()] });
    await wait();
    await inChildContext(async () => {
      driver.submit("go");
      await until(() => driver.getStatus().pendingPermission !== null, "ask to park");
    });
    const pending = driver.getStatus().pendingPermission;
    expect("askReview" in (pending ?? {})).toBe(false);
    expect(pending?.askDigest).toContain("asked by: subagent coder");
    // exactly one receipt notice in the history
    const receipts = driver.getHistory().filter((e) => e.kind === "notice" && e.text.includes("ask-reviewer 不可用")); // ω99-166d-ii: 表外泛标记钉随 #31
    expect(receipts).toHaveLength(1);
    expect(driver.answerPermission(true)).toBe(true);
    await until(() => driver.getStatus().busy === false, "run to finish");
    driver.dispose();
  });

  it("M24: the reviewer's existence changes ZERO main-run request bytes (armed vs unarmed, uuid-stripped)", async () => {
    // Model-visible bytes = what the provider serializes (role/content/
    // toolCalls); uuid/parentUuid are harness-internal, per-run, and never
    // reach the wire — strip them, then compare the FULL request arrays.
    const norm = (inputs: readonly ModelInput[]): string =>
      JSON.stringify(
        inputs.map((i) => ({
          ...i,
          messages: i.messages.map((m) => {
            const { uuid: _u, parentUuid: _p, ...rest } = m as Record<string, unknown> & { uuid?: string; parentUuid?: string };
            return rest;
          }),
        })),
      );

    const runOnce = async (armed: boolean): Promise<string> => {
      if (armed) process.env.WUDAO_ASK_REVIEWER = "1";
      else delete process.env.WUDAO_ASK_REVIEWER;
      const model = routingModel({ review: "VERDICT: covered\nREASON: r", main: MAIN_SCRIPT });
      const driver = makeDriver({ model, tools: [stubRunCommandTool()] });
      await wait();
      await inChildContext(async () => {
        driver.submit("go");
        await until(() => driver.getStatus().pendingPermission !== null, "ask to park");
        expect(driver.answerPermission(true)).toBe(true);
        await until(() => driver.getStatus().busy === false, "run to finish");
      });
      driver.dispose();
      expect(model.reviewInputs.length).toBe(armed ? 1 : 0);
      return norm(model.mainInputs);
    };

    const unarmedBytes = await runOnce(false);
    const armedBytes = await runOnce(true);
    expect(armedBytes).toBe(unarmedBytes);
  });
});

// ---------------------------------------------------------------------------
// R8 — PermissionPrompt (funnel 4 render) + the App callback e2e
// ---------------------------------------------------------------------------

describe("PermissionPrompt ask-review line", () => {
  const DIGEST = "↳ asked by: subagent coder · task: run the integration suite and fix failures\n↳ latest genuine user instructions:\n    user: only touch files under packages/core, never run migrations";
  const REVIEW = "🛡 ask-review (advisory): covered — user asked for tests";

  const lines = (frame: string): string[] =>
    frame.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l !== "");

  it("renders the digest + review lines and changes NOTHING else (additive-only pin)", () => {
    const withLines = render(
      <PermissionPrompt toolName="shell" summary="echo hi" askDigest={DIGEST} askReview={REVIEW} onChoose={() => {}} />,
    );
    const without = render(<PermissionPrompt toolName="shell" summary="echo hi" onChoose={() => {}} />);
    const withArr = lines(withLines.lastFrame() ?? "");
    const withoutArr = lines(without.lastFrame() ?? "");
    const digestArr = DIGEST.split("\n");
    expect(withArr).toEqual([...digestArr, REVIEW, ...withoutArr]);
    expect(without.lastFrame() ?? "").not.toContain("ask-review");
  });

  it("the protected-settings variant renders both blocks too", () => {
    const r = render(
      <PermissionPrompt
        toolName="write_file"
        summary=".wudao/settings.json"
        settingsFile="/w/.wudao/settings.json"
        askDigest={DIGEST}
        askReview={REVIEW}
        onChoose={() => {}}
      />,
    );
    const frame = r.lastFrame() ?? "";
    expect(frame).toContain("asked by: subagent coder");
    expect(frame).toContain(REVIEW);
    expect(frame).toContain("[y/N]");
  });
});

// ---------------------------------------------------------------------------
// The App e2e — a REAL task-tool child ask rides funnel 4 (subagentGate →
// onPermissionAsk → PermissionPrompt). Armed → digest + review line; unarmed
// → digest only (the ω-4e deferred hunk retired), never an ask-review line.
// ---------------------------------------------------------------------------

const tuiConfig: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

function appModel(review: string): ModelClient & { reviewCalls: number } {
  const main: readonly AssistantMessage[] = [
    { role: "assistant", content: "", toolCalls: [{ id: "p1", name: "task", arguments: { description: "run echo", prompt: "run the echo command and report", role: "coder" } }] },
    { role: "assistant", content: "", toolCalls: [{ id: "k1", name: "shell", arguments: { command: "echo wudao-child-cmd" } }] },
    { role: "assistant", content: "CHILD-DONE" },
    { role: "assistant", content: "PARENT-DONE" },
  ];
  let mainI = 0;
  let reviewCalls = 0;
  return {
    get reviewCalls() { return reviewCalls; },
    async generate(input: ModelInput): Promise<AssistantMessage> {
      if (input.querySource === "ask-reviewer") {
        reviewCalls += 1;
        return { role: "assistant", content: review };
      }
      const r = main[mainI];
      mainI += 1;
      if (r === undefined) throw new Error("app main script exhausted");
      return r;
    },
  };
}

async function type(stdin: { write(s: string): void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await wait(15);
  }
}

/** Approve a pending ask. The settle delay is load-bearing: a keystroke
 *  delivered in the same tick the PermissionPrompt mounts can race the
 *  useInput registration (an ink-testing-library synchronous-stdin artifact
 *  — real stdin events are async); 100ms lets the hook arm first. */
async function approve(stdin: { write(s: string): void }): Promise<void> {
  await wait(100);
  stdin.write("y");
  await wait(50);
}

describe("WudaoApp funnel-4 child ask (design 70 §4)", () => {
  it("armed: a task-tool child's shell ask renders digest + the advisory review line, then allows", { timeout: 60_000 }, async () => {
    process.env.WUDAO_ASK_REVIEWER = "1";
    process.env.WUDAO_DEFER_TOOLS = "off";
    const model = appModel("VERDICT: covered\nREASON: the user asked to run the echo command");
    const root = mkdtempSync(join(tmpdir(), "wudao-ask-rev-"));
    const inst = render(
      <WudaoApp config={tuiConfig} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} gates={{ verify: false }} />,
    );
    try {
      await wait();
      await type(inst.stdin, "dispatch\r");
      // Default mode: the PARENT's task call asks first — approve it so the
      // child spawns and its shell ask surfaces.
      await until(() => (inst.lastFrame() ?? "").includes("🔑 允许 task"), "parent task ask", 30000);
      await approve(inst.stdin);
      await until(() => (inst.lastFrame() ?? "").includes("asked by: subagent"), "child ask to surface", 30000);
      await until(() => (inst.lastFrame() ?? "").includes("ask-review (advisory): covered"), "review line to render", 30000);
      const frame = inst.lastFrame() ?? "";
      expect(frame).toContain("🔑 允许 shell");
      expect(model.reviewCalls).toBe(1);
      await approve(inst.stdin);
      await until(() => (inst.lastFrame() ?? "").includes("PARENT-DONE"), "run to finish", 30000);
    } finally {
      inst.unmount();
      rmSync(root, { recursive: true, force: true });
      delete process.env.WUDAO_DEFER_TOOLS;
    }
  });

  it("unarmed: the digest renders (ω-4e debt retired) but NO ask-review line, and no review model call", { timeout: 60_000 }, async () => {
    process.env.WUDAO_DEFER_TOOLS = "off";
    const model = appModel("VERDICT: covered\nREASON: r");
    const root = mkdtempSync(join(tmpdir(), "wudao-ask-rev-"));
    const inst = render(
      <WudaoApp config={tuiConfig} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} gates={{ verify: false }} />,
    );
    try {
      await wait();
      await type(inst.stdin, "dispatch\r");
      await until(() => (inst.lastFrame() ?? "").includes("🔑 允许 task"), "parent task ask", 30000);
      await approve(inst.stdin);
      await until(() => (inst.lastFrame() ?? "").includes("asked by: subagent"), "child ask to surface", 30000);
      const frame = inst.lastFrame() ?? "";
      expect(frame).toContain("🔑 允许 shell");
      expect(frame).not.toContain("ask-review");
      expect(model.reviewCalls).toBe(0);
      await approve(inst.stdin);
      await until(() => (inst.lastFrame() ?? "").includes("PARENT-DONE"), "run to finish", 30000);
    } finally {
      inst.unmount();
      rmSync(root, { recursive: true, force: true });
      delete process.env.WUDAO_DEFER_TOOLS;
    }
  });
});
