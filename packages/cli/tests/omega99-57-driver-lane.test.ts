// ω99-57 — the driver half of the child→parent mail arc: the lane's position
// in the steering drain order (user → cron → peer → CHILD MAIL → monitor),
// mid-run delivery through the REAL driver + REAL task tool (acceptance 1:
// the parent's first ModelInput after the task settlement carries the
// message, in order, with source attribution), and the fire-on-idle wake.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool, createScriptedModel, PARENT_MESSAGE_TOOL_NAME, createParentMessageTool } from "@wudao/core";
import type { Tool, ModelClient, ModelInput, AssistantMessage } from "@wudao/core";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriverOptions, AgentDriver } from "../src/driver/agent-driver.js";
import { createAgentsTaskTool, createSessionRegistry } from "../src/agents/index.js";
import { createChildMailLane } from "../src/agents/child-mail.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const allow = async () => ({ kind: "allow" as const });

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "mail-drv-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });

function makeDriver(opts: Partial<AgentDriverOptions> & Pick<AgentDriverOptions, "model" | "tools">): AgentDriver {
  return createAgentDriver({
    systemPrompt: "s",
    summarize: (_n: string, i: Record<string, unknown>) => JSON.stringify(i).slice(0, 60),
    ...opts,
  });
}

function inputsOf(model: ModelClient & { inputs?: ModelInput[] }): ModelInput[] {
  return (model as { inputs: ModelInput[] }).inputs;
}

function recording(responses: readonly AssistantMessage[]): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let call = 0;
  const model: ModelClient & { inputs: ModelInput[] } = {
    inputs,
    async generate(input: ModelInput) {
      inputs.push({ ...input, messages: [...input.messages], tools: [...input.tools] });
      const r = responses[call];
      call += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
  return model;
}

const readParams = {
  type: "object" as const,
  properties: { path: { type: "string" as const } },
  required: ["path"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// The drain order (T0-2): user → cron → peer → CHILD MAIL → monitor
// ---------------------------------------------------------------------------

describe("ω99-57 driver lane order", () => {
  it("drains the child-mail lane after peer and before monitor, in one pre-model drain", async () => {
    const lane = createChildMailLane();
    const cronQueue: string[] = [];
    const peerQueue: string[] = [];
    const monitorQueue: string[] = [];
    let arm: (() => void) | undefined;
    const gatingTool: Tool = buildTool({
      name: "read_file",
      description: "gated read",
      parameters: readParams,
      execute: async () => {
        arm?.();
        return { content: "GATED RESULT" };
      },
    });
    const model = recording([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a" } }] },
      { role: "assistant", content: "DONE" },
    ]);
    const driver = makeDriver({
      model,
      tools: [gatingTool],
      onPermissionAsk: allow,
      childMail: lane,
      cron: { takeInjection: () => cronQueue.shift() } as unknown as AgentDriverOptions["cron"],
      peer: { takeInjection: () => peerQueue.shift(), approvalSink: { current: undefined }, stop: async () => {} } as unknown as AgentDriverOptions["peer"],
      monitor: { takeInjection: () => monitorQueue.shift(), stop: () => {} } as unknown as AgentDriverOptions["monitor"],
    });
    // Arm everything while the tool (mid-run) executes; the user steer parks
    // in the user queue via a submit during the busy run.
    arm = () => {
      cronQueue.push("[cron due] run the backup");
      peerQueue.push("[peer message from web-a7 — test]\nhello");
      lane.submit("[message from subagent side-1 (coder)]\nchild finding");
      monitorQueue.push("[monitor] command exited 1");
      driver.submit("USER STEER");
    };
    driver.submit("go");
    await until(() => driver.getStatus().busy === false, "run to finish");
    const tail = inputsOf(model)[1]!.messages.map((m) => (m.role === "user" ? m.content : `(${m.role})`));
    const idxUser = tail.findIndex((c) => c === "USER STEER");
    const idxCron = tail.findIndex((c) => c === "[cron due] run the backup");
    const idxPeer = tail.findIndex((c) => c.startsWith("[peer message from web-a7"));
    const idxChild = tail.findIndex((c) => c.startsWith("[message from subagent side-1"));
    const idxMonitor = tail.findIndex((c) => c === "[monitor] command exited 1");
    for (const [label, idx] of [["user", idxUser], ["cron", idxCron], ["peer", idxPeer], ["child-mail", idxChild], ["monitor", idxMonitor]] as const) {
      expect(idx, `${label} message drained`).toBeGreaterThanOrEqual(0);
    }
    expect(idxUser).toBeLessThan(idxCron);
    expect(idxCron).toBeLessThan(idxPeer);
    expect(idxPeer).toBeLessThan(idxChild);
    expect(idxChild).toBeLessThan(idxMonitor);
    driver.dispose();
  });
});

// ---------------------------------------------------------------------------
// Acceptance 1 — mid-run arrival through the real driver + task tool
// ---------------------------------------------------------------------------

describe("ω99-57 driver mid-run delivery (acceptance 1)", () => {
  it("the parent's first ModelInput after the task settlement carries the child message, in order, attributed", async () => {
    const lane = createChildMailLane();
    const registry = createSessionRegistry();
    const stubRead = buildTool({
      name: "read_file",
      description: "stub read",
      parameters: readParams,
      execute: async () => ({ content: "ok" }),
    });
    // One scripted model for the whole session: the parent's task dispatch,
    // the awaited child's two turns, then the parent's final answer.
    const model = recording([
      { role: "assistant", content: "", toolCalls: [{ id: "p1", name: "task", arguments: { description: "d", prompt: "work", role: "coder", session: "new" } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: PARENT_MESSAGE_TOOL_NAME, arguments: { content: "mid-run finding: fixture leaks" } }] },
      { role: "assistant", content: "child final answer" },
      { role: "assistant", content: "PARENT DONE" },
    ]);
    const drvTask = createAgentsTaskTool({
      model,
      allTools: [stubRead, createParentMessageTool()],
      registry,
      workspaceRoot: root,
      runId: "drv-mail",
      childMail: lane,
    });
    const driver = makeDriver({ model, tools: [drvTask], onPermissionAsk: allow, childMail: lane });
    driver.submit("delegate please");
    await until(() => driver.getStatus().busy === false, "run to finish");
    // The lane fully drained (the message became part of the conversation).
    expect(lane.size()).toBe(0);
    const inputs = inputsOf(model);
    // inputs[0]=parent dispatch, [1]/[2]=child turns, [3]=parent final.
    const last = inputs[3]!;
    const contents = last.messages.map((m) => (m.role === "user" ? m.content : `(${m.role})`));
    const taskResult = last.messages.findIndex((m) => m.role === "tool");
    const childMsg = contents.findIndex((c) => c.startsWith("[message from subagent "));
    expect(taskResult).toBeGreaterThanOrEqual(0);
    expect(childMsg).toBeGreaterThan(taskResult);
    expect(contents[childMsg]).toContain("mid-run finding: fixture leaks");
    expect(contents[childMsg]).toContain("(coder)");
    // The message is the conversation's tail: nothing sits between it and the
    // model call that reads it (the settlement precedes, the drain is complete).
    expect(last.messages.at(-1)?.content.startsWith("[message from subagent ")).toBe(true);
    // The visible receipt: the drained child message surfaces through the
    // SAME dim steering notice a user steer does (the existing persistence
    // and display shape — nothing new invented for child mail).
    const notices = driver.getHistory().filter((h) => h.kind === "notice").map((h) => (h as { text: string }).text);
    expect(notices.some((t) => t.includes("steering applied") && t.includes("[message from subagent "))).toBe(true);
    driver.dispose();
  });
});

// ---------------------------------------------------------------------------
// The fire-on-idle wake (a background child messaging an idle parent)
// ---------------------------------------------------------------------------

describe("ω99-57 driver idle wake", () => {
  it("a lane submit while idle starts a run carrying the message", async () => {
    const lane = createChildMailLane();
    const model = recording([{ role: "assistant", content: "NOTED" }]);
    const driver = makeDriver({ model, tools: [], onPermissionAsk: allow, childMail: lane });
    await until(() => !driver.getStatus().busy, "driver idle");
    lane.submit("[message from subagent bg-1 (coder)]\nlate finding");
    await until(() => !driver.getStatus().busy && inputsOf(model).length > 0, "wake run to finish", 3500);
    expect(inputsOf(model)[0]!.messages[0]).toMatchObject({
      role: "user",
      content: "[message from subagent bg-1 (coder)]\nlate finding",
    });
    driver.dispose();
  });
});
