// ω99-60 — the CLI half of the parent→child steer arc: buildToolSet
// registration (one global copy bound to the session's registry — the SAME
// instance its task tool spawns through), the isolated child's name-draw
// gate (a pool without message_child draws none — byte-identical children
// for embedders), the default worktree factory's no-registry gate, and the
// M30 §A fork byte-invariant with the new tool in the array.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient, ModelInput, Tool } from "@wudao/core";
import { buildTool, toModelToolDefinition } from "@wudao/core";
import {
  createParentMessageTool,
  PARENT_MESSAGE_TOOL_NAME,
  CHILD_MESSAGE_TOOL_NAME,
  STEER_FROM_PARENT_PREFIX,
} from "@wudao/core";
import { createAgentsTaskTool, createSessionRegistry } from "../src/agents/index.js";
import { createChildMailLane } from "../src/agents/child-mail.js";
import { buildToolSet } from "../src/tools.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "steer-cli-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });

/** Bounded wait — registry children run async; tests park them mid-run. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 2));
  if (!cond()) throw new Error("condition never became true");
}

/** A model whose every call PARKS until released — the background child is
 *  observably running while the test drives the steer tool. `served` counts
 *  returned responses (completion signal for a fire-and-forget child). */
function gated(responses: readonly import("@wudao/core").AssistantMessage[]): {
  model: ModelClient;
  inputs: ModelInput[];
  served: () => number;
  release: () => void;
} {
  const inputs: ModelInput[] = [];
  const parked: Array<() => void> = [];
  let call = 0;
  let served = 0;
  const model: ModelClient = {
    async generate(input: ModelInput) {
      inputs.push({ ...input, messages: [...input.messages], tools: [...input.tools] });
      await new Promise<void>((resolve) => { parked.push(resolve); });
      const r = responses[call];
      call += 1;
      if (!r) throw new Error("scripted responses exhausted");
      served += 1;
      return r;
    },
  };
  return { model, inputs, served: () => served, release: () => { parked.shift()?.(); } };
}

/** Immediate scripted model — for foreground children (the task tool AWAITS
 *  them, so parking would deadlock; only background children can park). */
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

const POOL_WITHOUT_STEER: readonly Tool[] = [
  stubTool("read_file"),
  stubTool("glob"),
  stubTool("grep"),
  createParentMessageTool(),
];

// ---------------------------------------------------------------------------
// buildToolSet registration + the registry closure (acceptance: §1.3 wiring)
// ---------------------------------------------------------------------------

describe("ω99-60 buildToolSet registration", () => {
  it("the top-level set carries message_child exactly once, names globally unique", () => {
    const tools = buildToolSet({
      workspaceRoot: root,
      model: gated([]).model,
      contextWindowTokens: 64_000,
    });
    const names = tools.map((t) => t.name);
    expect(names.filter((n) => n === CHILD_MESSAGE_TOOL_NAME)).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
  });

  it("the registered copy is BOUND: it steers a background child spawned through the same tool set, and the isolated child drew it", async () => {
    await writeFile(join(root, "note.txt"), "n\n");
    const g = gated([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "note.txt" } }] },
      { role: "assistant", content: "bg final" },
    ]);
    const tools = buildToolSet({
      workspaceRoot: root,
      model: g.model,
      contextWindowTokens: 64_000,
    });
    const task = tools.find((t) => t.name === "task")!;
    const steerTool = tools.find((t) => t.name === CHILD_MESSAGE_TOOL_NAME)!;
    expect(steerTool).toBeDefined();
    const r = await task.execute({ description: "d", prompt: "work", role: "coder", background: true });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("bg-1");
    await until(() => g.inputs.length === 1);
    // The isolated child drew message_child (the name-draw gate: the session
    // pool carries it — grandchild symmetry, fixed tail position).
    expect(g.inputs[0]!.tools.some((t) => t.name === CHILD_MESSAGE_TOOL_NAME)).toBe(true);
    const sr = await steerTool.execute({ id: "bg-1", content: "pivot: read note.txt twice" });
    expect(sr.isError).toBeFalsy();
    expect(sr.content).toContain("bg-1");
    g.release();
    await until(() => g.inputs.length === 2);
    const steered = g.inputs[1]!.messages.filter((m) => m.role === "user" && m.content.startsWith(STEER_FROM_PARENT_PREFIX));
    expect(steered).toHaveLength(1);
    expect(steered[0]).toEqual({ role: "user", content: `${STEER_FROM_PARENT_PREFIX}\npivot: read note.txt twice` });
    expect(g.inputs[1]!.messages.at(-1)).toBe(steered[0]);
    g.release();
    await until(() => g.served() === 2);
  });

  it("the gate: a pool WITHOUT message_child draws no message_child for its children (embedder bytes unchanged)", async () => {
    const g = script([{ role: "assistant", content: "child final" }]);
    const task = createAgentsTaskTool({
      model: g.model,
      allTools: POOL_WITHOUT_STEER,
      registry: createSessionRegistry(),
      workspaceRoot: root,
      runId: "steer-gate",
    });
    const r = await task.execute({ description: "d", prompt: "work", role: "coder" });
    expect(r.isError).toBeFalsy();
    expect(g.inputs[0]!.tools.some((t) => t.name === CHILD_MESSAGE_TOOL_NAME)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The default worktree factory gate + the fork byte-invariant
// ---------------------------------------------------------------------------

describe("ω99-60 worktree default factory + fork bytes", () => {
  it("the default child factory (no registry at that assembly) appends NO message_child — while message_parent still rides", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const pExec = promisify(execFile);
    const exec = (...args: string[]): Promise<unknown> => pExec(args[0]!, args.slice(1));
    const gitRoot = await mkdtemp(join(tmpdir(), "steer-wt-"));
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
      const g = script([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "marker.txt" } }] },
        { role: "assistant", content: "wt final" },
      ]);
      const task = createAgentsTaskTool({
        model: g.model,
        allTools: POOL_WITHOUT_STEER,
        registry: createSessionRegistry(),
        workspaceRoot: gitRoot,
        runId: "steer-wt",
        childMail: createChildMailLane(),
      });
      const r = await task.execute({ description: "d", prompt: "p", role: "wtr" });
      expect(r.isError).toBeFalsy();
      // The mail tool rides the default factory (57's context-free ruling);
      // the steer tool does NOT — no registry is bound at that assembly.
      expect(g.inputs[0]!.tools.some((t) => t.name === PARENT_MESSAGE_TOOL_NAME)).toBe(true);
      expect(g.inputs[0]!.tools.some((t) => t.name === CHILD_MESSAGE_TOOL_NAME)).toBe(false);
    } finally {
      await rm(gitRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it("the fork path stays byte-identical: the fork's request tools == the parent serialization (message_child included)", async () => {
    const tools = buildToolSet({
      workspaceRoot: root,
      model: gated([]).model,
      contextWindowTokens: 64_000,
    });
    const base = tools.filter((t) => t.shouldDefer?.() !== true);
    const baseBytes = JSON.stringify(base.map(toModelToolDefinition));
    const g = script([{ role: "assistant", content: "fork done" }]);
    const task = createAgentsTaskTool({
      model: g.model,
      allTools: tools,
      registry: createSessionRegistry(),
      workspaceRoot: root,
      runId: "fork-bytes-60",
      getForkContext: () => ({ systemPrompt: "PARENT-SYS", tools, messages: [{ role: "user", content: "p" }] }),
    });
    const r = await task.execute({ description: "d", prompt: "fork brief", shareContext: true });
    expect(r.isError).toBeFalsy();
    const actualBase = g.inputs[0]!.tools.filter((t) => t.name !== "load_tools");
    expect(JSON.stringify(actualBase)).toBe(baseBytes);
    if (g.inputs[0]!.tools.some((t) => t.name === "load_tools")) {
      expect(g.inputs[0]!.tools.length).toBe(actualBase.length + 1);
    }
    // The steer tool is IN the fork's request (globally registered — the fork
    // child sees the same face the parent does).
    expect(g.inputs[0]!.tools.some((t) => t.name === CHILD_MESSAGE_TOOL_NAME)).toBe(true);
  });
});
