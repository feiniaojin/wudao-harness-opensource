// ω99-57 — the CLI half of the child→parent mail arc: the parent-side lane,
// the task tool's wiring (tool drawn for children, one guidance line on the
// isolated child's own brief, sink threading for foreground AND background
// children), the buildToolSet registration (one global copy in the pool —
// coexisting with the M64-A peer send_message without name collisions), and
// the worktree child set.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient, ModelInput, Tool } from "@wudao/core";
import { buildTool, toModelToolDefinition, createParentMessageTool, PARENT_MESSAGE_TOOL_NAME, MAIL_NO_EDGE_ERROR } from "@wudao/core";
import { createAgentsTaskTool, createSessionRegistry } from "../src/agents/index.js";
import { createChildMailLane } from "../src/agents/child-mail.js";
import { buildToolSet } from "../src/tools.js";
import type { AgentDriverOptions } from "../src/driver/agent-driver.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "mail-cli-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });

/** Sequential scripted model — one call counter shared across every consumer
 * (the parent loop and its awaited children run strictly in sequence). */
function script(responses: readonly import("@wudao/core").AssistantMessage[]): { model: ModelClient; inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let call = 0;
  const model: ModelClient = {
    async generate(input: ModelInput) {
      inputs.push({ ...input, messages: [...input.messages], tools: [...input.tools] });
      const r = responses[call];
      call += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
  return { model, inputs };
}

function stubTool(name: string): Tool {
  return buildTool({
    name,
    description: `stub ${name}`,
    parameters: { type: "object", properties: {} },
    async execute() { return { content: `${name} ok` }; },
  });
}

const POOL: readonly Tool[] = [stubTool("read_file"), stubTool("glob"), stubTool("grep"), createParentMessageTool()];

// ---------------------------------------------------------------------------
// The lane
// ---------------------------------------------------------------------------

describe("ω99-57 child-mail lane", () => {
  it("is a FIFO: submit order preserved, take drains one at a time", () => {
    const lane = createChildMailLane();
    expect(lane.take()).toBeUndefined();
    lane.submit("one");
    lane.submit("two");
    expect(lane.size()).toBe(2);
    expect(lane.take()).toBe("one");
    expect(lane.take()).toBe("two");
    expect(lane.take()).toBeUndefined();
    expect(lane.size()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Task tool wiring
// ---------------------------------------------------------------------------

describe("ω99-57 task tool mail wiring", () => {
  it("a foreground session'd child with a live lane: tool drawn, guidance line on the brief, message delivered, meta unchanged in shape", async () => {
    const lane = createChildMailLane();
    const { model, inputs } = script([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: PARENT_MESSAGE_TOOL_NAME, arguments: { content: "mid-run finding" } }] },
      { role: "assistant", content: "child final" },
    ]);
    const registry = createSessionRegistry();
    const task = createAgentsTaskTool({
      model,
      allTools: POOL,
      registry,
      workspaceRoot: root,
      runId: "mail-run",
      childMail: lane,
    });
    const r = await task.execute({ description: "d", prompt: "work", role: "coder", session: "new" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("child final");
    // The child's first request drew the mail tool and carries the guidance
    // line on its OWN brief (never the system prompt, never the tool schema).
    const childInput = inputs[0]!;
    expect(childInput.tools.some((t) => t.name === PARENT_MESSAGE_TOOL_NAME)).toBe(true);
    const brief = childInput.messages[0] as { role: string; content: string };
    expect(brief.content).toContain("work");
    expect(brief.content).toContain("[mail] you may message your parent");
    // Delivery reached the lane with the sidechain-signed sender (the id is
    // the child session's uuid — assert the shape, not the uuid).
    const delivered = lane.take();
    expect(delivered).toMatch(/^\[message from subagent [0-9a-f-]{36} \(coder\)\]\nmid-run finding$/);
  });

  it("without a lane the child draws no mail tool and the brief carries no mail line", async () => {
    const { model, inputs } = script([
      { role: "assistant", content: "child final" },
    ]);
    const registry = createSessionRegistry();
    const task = createAgentsTaskTool({
      model,
      allTools: POOL,
      registry,
      workspaceRoot: root,
      runId: "no-lane",
    });
    const r = await task.execute({ description: "d", prompt: "work", role: "coder" });
    expect(r.isError).toBeFalsy();
    expect(inputs[0]!.tools.some((t) => t.name === PARENT_MESSAGE_TOOL_NAME)).toBe(false);
    expect((inputs[0]!.messages[0] as { content: string }).content).toBe("work");
  });

  it("a background child with a live lane sends through the registry", async () => {
    const lane = createChildMailLane();
    const { model } = script([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: PARENT_MESSAGE_TOOL_NAME, arguments: { content: "bg finding" } }] },
      { role: "assistant", content: "bg final" },
    ]);
    const registry = createSessionRegistry();
    const task = createAgentsTaskTool({
      model,
      allTools: POOL,
      registry,
      workspaceRoot: root,
      runId: "bg-mail",
      childMail: lane,
    });
    const r = await task.execute({ description: "d", prompt: "work", role: "coder", background: true });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("bg-1");
    const collected = await registry.awaitAgents({ ids: ["bg-1"], mode: "all" });
    expect(collected[0]!.ok).toBe(true);
    expect(lane.size()).toBe(1);
    const text = lane.take()!;
    expect(text.endsWith("\nbg finding")).toBe(true);
    expect(text.startsWith("[message from subagent ")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildToolSet registration (global, single copy, peer coexistence)
// ---------------------------------------------------------------------------

describe("ω99-57 buildToolSet registration", () => {
  function minimalSet(extra: Partial<Parameters<typeof buildToolSet>[0]> = {}): Tool[] {
    return buildToolSet({
      workspaceRoot: root,
      model: script([]).model,
      contextWindowTokens: 64_000,
      ...extra,
    });
  }

  it("the pool and the top-level set each carry message_parent exactly once", async () => {
    const tools = minimalSet();
    const names = tools.map((t) => t.name);
    expect(names.filter((n) => n === PARENT_MESSAGE_TOOL_NAME)).toHaveLength(1);
    // The peer send_message coexists — no shadowing in either direction.
    const peerSet = minimalSet({
      peer: { takeInjection: () => undefined, refusal: undefined } as unknown as AgentDriverOptions["peer"],
    });
    const peerNames = peerSet.map((t) => t.name);
    expect(peerNames.filter((n) => n === PARENT_MESSAGE_TOOL_NAME)).toHaveLength(1);
    expect(new Set(peerNames).size).toBe(peerNames.length); // globally unique names
    // The registered copy is the global face: no scope at top level → typed error.
    const tool = peerSet.find((t) => t.name === PARENT_MESSAGE_TOOL_NAME)!;
    const refusal = await tool.execute({ content: "top-level" });
    expect(refusal.isError).toBe(true);
    expect(refusal.content).toBe(MAIL_NO_EDGE_ERROR);
  });

  it("the fork path stays byte-identical: the fork's request tools == the parent serialization", async () => {
    const tools = minimalSet();
    // The request's tool segment applies the loop's defer partition: the base
    // tools plus ONE deterministic load_tools meta-tool naming the deferred
    // set (same bytes for a parent request over the same array). Compare the
    // base segment byte-exactly and the meta-tool by its deterministic shape.
    const base = tools.filter((t) => t.shouldDefer?.() !== true);
    const baseBytes = JSON.stringify(base.map(toModelToolDefinition));
    const { model, inputs } = script([{ role: "assistant", content: "fork done" }]);
    const registry = createSessionRegistry();
    const task = createAgentsTaskTool({
      model,
      allTools: tools,
      registry,
      workspaceRoot: root,
      runId: "fork-bytes",
      getForkContext: () => ({ systemPrompt: "PARENT-SYS", tools, messages: [{ role: "user", content: "p" }] }),
    });
    const r = await task.execute({ description: "d", prompt: "fork brief", shareContext: true });
    expect(r.isError).toBeFalsy();
    const actualBase = inputs[0]!.tools.filter((t) => t.name !== "load_tools");
    expect(JSON.stringify(actualBase)).toBe(baseBytes);
    if (inputs[0]!.tools.some((t) => t.name === "load_tools")) {
      // The meta-tool is the only extra entry (the defer partition's own).
      expect(inputs[0]!.tools.length).toBe(actualBase.length + 1);
    }
    // The mail tool is IN the fork's request (globally registered — the fork
    // child sees the same face the parent does; calling it refuses by core's
    // fork ruling).
    expect(inputs[0]!.tools.some((t) => t.name === PARENT_MESSAGE_TOOL_NAME)).toBe(true);
  });

  it("a worktree child (default factory) carries the mail tool and can send", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { writeFile, mkdir } = await import("node:fs/promises");
    const pExec = promisify(execFile);
    const exec = (...args: string[]): Promise<unknown> => pExec(args[0]!, args.slice(1));
    const gitRoot = await mkdtemp(join(tmpdir(), "mail-wt-"));
    try {
      await exec("git", "-C", gitRoot, "init", "-q");
      await writeFile(join(gitRoot, "marker.txt"), "m\n");
      await exec("git", "-C", gitRoot, "add", "marker.txt");
      await exec("git", "-C", gitRoot, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init");
      await mkdir(join(gitRoot, ".wudao", "agents"), { recursive: true });
      await writeFile(join(gitRoot, ".wudao", "agents", "wtr.json"), JSON.stringify({
        description: "worktree role",
        worktree: true,
        toolNames: ["read_file"],
      }));
      const lane = createChildMailLane();
      const { model, inputs } = script([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: PARENT_MESSAGE_TOOL_NAME, arguments: { content: "from the worktree" } }] },
        { role: "assistant", content: "wt final" },
      ]);
      const registry = createSessionRegistry();
      const task = createAgentsTaskTool({
        model,
        allTools: POOL,
        registry,
        workspaceRoot: gitRoot,
        runId: "mail-wt",
        childMail: lane,
      });
      const r = await task.execute({ description: "d", prompt: "p", role: "wtr" });
      expect(r.isError).toBeFalsy();
      expect(inputs[0]!.tools.some((t) => t.name === PARENT_MESSAGE_TOOL_NAME)).toBe(true);
      expect(lane.take()).toMatch(/\nfrom the worktree$/);
    } finally {
      await rm(gitRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});
