// M30 task tool tests: role resolution, frozen rejection, background
// spawn + collect, session param parsing, reasoning receipt, pilot nudge,
// reportSchema spawn gate, child isolation, worktree routing, and the
// registry tool triple (spec §A/§B/§C/§D) — against the real core registry.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { AssistantMessage, ModelClient, ModelInput, Tool } from "@wudao-org/core";
import { buildTool, createReadFileTool } from "@wudao-org/core";
import { createAgentsTaskTool, createRegistryTools, createSessionRegistry, parseSessionParam, parseReportSchema } from "../src/agents/index.js";
import { createFinalOutputTool, FINAL_OUTPUT_TOOL_NAME, FINAL_OUTPUT_OK } from "../src/agents/report-schema.js";
import { canonicalJson } from "../src/workflow/structured-output.js";
import type { JsonSchemaSubset } from "../src/workflow/structured-output.js";

const execFile = promisify(execFileCb);

/** Bounded wait for an async condition (child reaches its model call, …). */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "task-")); });
// 后台子代理的 session 持久化是 fire-and-forget(det-48 家族:busy=false ≠
// 落盘完成),负载下 afterEach 的单发 rm 会撞在途 append(macOS ENOTEMPTY;
// Node fs.rm 默认 maxRetries=0 直接冒)。maxRetries 让 Node 自带对
// ENOTEMPTY/EBUSY 的退避重试——同 532419a 轮询纪律的清理侧收口。
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });

function recordingModel(responses: readonly AssistantMessage[]): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: [...input.messages], tools: [...input.tools] });
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

/** A recording model that can PARK generate() calls: after `hold()`, every
 *  call records its request and then blocks until one `release()` — the child
 *  stays verifiably in flight (cancel/single-writer tests). */
function holdableModel(responses: readonly AssistantMessage[]): ModelClient & { inputs: ModelInput[]; hold: () => void; release: () => void } {
  const inputs: ModelInput[] = [];
  let i = 0;
  let holding = false;
  let releaseOne: (() => void) | undefined;
  return {
    inputs,
    hold: () => { holding = true; },
    release: () => { const r = releaseOne; releaseOne = undefined; r?.(); },
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: [...input.messages], tools: [...input.tools] });
      if (holding) await new Promise<void>((res) => { releaseOne = res; });
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

function stubTool(name: string): Tool {
  return buildTool({
    name,
    description: `stub ${name}`,
    parameters: { type: "object", properties: {} },
    async execute() { return { content: `${name} ok` }; },
  });
}

const ALL_TOOLS: readonly Tool[] = [
  stubTool("read_file"), stubTool("glob"), stubTool("grep"),
  stubTool("write_file"), stubTool("edit"), stubTool("shell"), stubTool("todo_write"),
];

interface Harness {
  readonly model: ReturnType<typeof recordingModel>;
  readonly registry: ReturnType<typeof createSessionRegistry>;
  readonly task: Tool;
  readonly tools: Record<string, Tool>;
}

function harness(model: ReturnType<typeof recordingModel>, extra?: { pilotProbe?: () => boolean; resolveModel?: never; defaultEffort?: string; pluginAgents?: readonly import("../src/agents/core-bind.js").RosterPluginAgent[] }): Harness {
  const registry = createSessionRegistry();
  const task = createAgentsTaskTool({
    model,
    allTools: ALL_TOOLS,
    registry,
    workspaceRoot: root,
    runId: "test-run",
    ...(extra?.pilotProbe ? { pilotProbe: extra.pilotProbe } : {}),
    ...(extra?.defaultEffort !== undefined ? { defaultEffort: extra.defaultEffort } : {}),
    ...(extra?.pluginAgents ? { pluginAgents: extra.pluginAgents } : {}),
  });
  const tools: Record<string, Tool> = { task };
  for (const t of createRegistryTools(registry)) tools[t.name] = t;
  return { model, registry, task, tools };
}

const WORKER_REPORT = (over: Record<string, unknown> = {}): string =>
  `[WORKER_REPORT] ${JSON.stringify({ units_done: 2, tokens_used: 1580, budget_limited: true, note: "budget exhausted — raise max_turns to continue", ...over })}`;

const REPORT_SCHEMA = JSON.stringify({
  type: "object",
  required: ["units_done", "tokens_used", "budget_limited"],
  properties: { units_done: { type: "number" }, tokens_used: { type: "number" }, budget_limited: { type: "boolean" }, note: { type: "string" } },
});

describe("parseSessionParam", () => {
  it("accepts new / resume:<id> / fork:<id> and JSON objects", () => {
    expect(parseSessionParam("new")).toEqual({ ok: true, session: { mode: "new" } });
    expect(parseSessionParam("resume:child-9")).toEqual({ ok: true, session: { mode: "resume", id: "child-9" } });
    expect(parseSessionParam("FORK:abc")).toEqual({ ok: true, session: { mode: "fork", id: "abc" } });
    expect(parseSessionParam({ mode: "resume", id: "x" })).toEqual({ ok: true, session: { mode: "resume", id: "x" } });
  });
  it("rejects unknown modes, missing ids, and junk", () => {
    expect(parseSessionParam("resume").ok).toBe(false);
    expect(parseSessionParam("fork").ok).toBe(false);
    expect(parseSessionParam("reborn:x").ok).toBe(false);
    expect(parseSessionParam(42).ok).toBe(false);
  });
});

describe("parseReportSchema (spawn gate)", () => {
  it("accepts a legal subset and a JSON-encoded string", () => {
    const ok = parseReportSchema(REPORT_SCHEMA);
    expect(ok.ok).toBe(true);
    expect(parseReportSchema({ type: "object", required: ["a"] }).ok).toBe(true);
  });
  it("rejects junk, non-object roots, and bad nodes", () => {
    expect(parseReportSchema("nope{").ok).toBe(false);
    expect(parseReportSchema({ type: "array", items: { type: "string" } }).ok).toBe(false); // report root must be object
    expect(parseReportSchema({ type: "object", properties: { x: { type: "wat" } } }).ok).toBe(false);
    expect(parseReportSchema({ type: "object", required: "a" }).ok).toBe(false);
  });
});

describe("task tool — roles and roster", () => {
  it("unknown role fails closed with the known-role list", async () => {
    const h = harness(recordingModel([]));
    const r = await h.task.execute({ description: "d", prompt: "p", role: "nope" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("unknown role");
    expect(r.content).toContain("consultant");
  });

  it("sync spawn: child request carries the role's systemPrompt + tool set; result carries the reasoning receipt", async () => {
    const model = recordingModel([{ role: "assistant", content: "consulted answer" }]);
    const h = harness(model, { defaultEffort: "low" });
    const r = await h.task.execute({ description: "advise", prompt: "weigh options", role: "consultant" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("consulted answer");
    expect(r.content).toContain("reasoning.requested=high"); // role default beats session low
    expect(r.content).toContain("role=consultant");
    // Request shape: consultant identity + read-only tools.
    const child = model.inputs[0]!;
    expect(child.systemPrompt).toContain("consultant");
    expect(child.tools.map((t) => t.name).sort()).toEqual(["glob", "grep", "read_file"]);
    expect(child.messages).toEqual([{ role: "user", content: "weigh options" }]);
  });

  it("workspace profile shadows the builtin (sentinel prompt + shadow note)", async () => {
    await mkdir(join(root, ".wudao", "agents"), { recursive: true });
    await writeFile(join(root, ".wudao", "agents", "coder.json"), JSON.stringify({
      description: "ws coder",
      systemPrompt: "WORKSPACE-CODER",
      toolNames: ["read_file"],
    }));
    const model = recordingModel([{ role: "assistant", content: "ws answer" }]);
    const h = harness(model);
    const r = await h.task.execute({ description: "d", prompt: "p", role: "coder" });
    expect(r.isError).toBeFalsy();
    // M64-B: every non-fork child gains its (default project-tier) memory
    // section after the role prompt — pin the role prompt as the PREFIX.
    expect(model.inputs[0]!.systemPrompt.startsWith("WORKSPACE-CODER")).toBe(true);
    expect(model.inputs[0]!.systemPrompt).toContain("# Your persistent memory (project tier)");
    expect(model.inputs[0]!.tools.map((t) => t.name)).toEqual(["read_file"]);
    expect(r.content).toContain("shadows the builtin role");
  });

  // M40 §2 — plugin agents thread into the task tool's roster: a fresh plugin
  // role dispatches; a plugin agent shadowing a builtin notes the shadow; a
  // workspace file reclaims the slot from the plugin (builtin < plugin < ws).
  it("plugin agents join the roster: dispatch, builtin shadowing, workspace reclaims", async () => {
    await mkdir(join(root, ".wudao", "agents"), { recursive: true });
    await writeFile(join(root, ".wudao", "agents", "coder.json"), JSON.stringify({
      description: "ws coder",
      systemPrompt: "WORKSPACE-CODER",
      toolNames: ["read_file"],
    }));
    const model = recordingModel([
      { role: "assistant", content: "guardian answer" },
      { role: "assistant", content: "ws coder answer" },
    ]);
    const h = harness(model, {
      pluginAgents: [
        { profile: { id: "guardian", description: "plugin guardian", systemPrompt: "PLUGIN-GUARDIAN", toolNames: ["grep"] }, source: "plugin demo: agents/guardian.md" },
        { profile: { id: "coder", description: "plugin coder", systemPrompt: "PLUGIN-CODER" }, source: "plugin demo: agents/coder.md" },
      ],
    });
    // Fresh plugin role: translated prompt + tools land in the child request.
    const g = await h.task.execute({ description: "d", prompt: "p", role: "guardian" });
    expect(g.isError).toBeFalsy();
    expect(model.inputs[0]!.systemPrompt.startsWith("PLUGIN-GUARDIAN")).toBe(true);
    expect(model.inputs[0]!.systemPrompt).toContain("# Your persistent memory (project tier)");
    expect(model.inputs[0]!.tools.map((t) => t.name)).toEqual(["grep"]);
    // The coder slot: the WORKSPACE file wins over the plugin agent.
    const c = await h.task.execute({ description: "d", prompt: "p", role: "coder" });
    expect(c.isError).toBeFalsy();
    expect(model.inputs[1]!.systemPrompt.startsWith("WORKSPACE-CODER")).toBe(true);
    expect(c.content).toContain("shadows the builtin role");
    // An unknown role lists the plugin role as known.
    const unknown = await h.task.execute({ description: "d", prompt: "p", role: "nope" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain("guardian");
  });

  it("frozen role rejects provider/model/effort overrides (fail-closed)", async () => {
    await mkdir(join(root, ".wudao", "agents"), { recursive: true });
    await writeFile(join(root, ".wudao", "agents", "reviewer.json"), JSON.stringify({
      description: "frozen reviewer",
      systemPrompt: "REVIEWER",
      model: "deepseek-chat",
      frozen: true,
    }));
    const h = harness(recordingModel([{ role: "assistant", content: "r" }]));
    const bad = await h.task.execute({ description: "d", prompt: "p", role: "reviewer", model: "glm-4.7" });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("frozen");
    expect(bad.content).toContain("model");
    // Without overrides the frozen role dispatches normally.
    const ok = await h.task.execute({ description: "d", prompt: "p", role: "reviewer" });
    expect(ok.isError).toBeFalsy();
    expect(ok.content).toContain("not applied in this context"); // role model pin, no resolver
  });

  it("caller overrides without a resolver fail closed; with a resolver they take effect", async () => {
    const model = recordingModel([{ role: "assistant", content: "m" }]);
    const h = harness(model);
    const bad = await h.task.execute({ description: "d", prompt: "p", role: "general-purpose", reasoningEffort: "high" });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("model resolver");

    const registry2 = createSessionRegistry();
    const childModel = recordingModel([{ role: "assistant", content: "over answer" }]);
    const task2 = createAgentsTaskTool({
      model, allTools: ALL_TOOLS, registry: registry2, workspaceRoot: root, runId: "r2",
      resolveModel: (o) => ({ ok: true, model: childModel, effectiveEffort: o.reasoningEffort ?? "off" }),
      defaultEffort: "off",
    });
    const r2 = await task2.execute({ description: "d", prompt: "p", role: "general-purpose", reasoningEffort: "high", model: "x-1" });
    expect(r2.isError).toBeFalsy();
    expect(childModel.inputs).toHaveLength(1);
    expect(r2.content).toContain("reasoning.requested=high");
    expect(r2.content).toContain("reasoning.effective=high");
  });

  it("fork mode keeps M24 semantics (shared context, byte-stable prompt)", async () => {
    const model = recordingModel([
      { role: "assistant", content: "fork child answer" },
    ]);
    const forkContext = {
      systemPrompt: "PARENT-SYS",
      tools: ALL_TOOLS,
      messages: [{ role: "user", content: "parent prompt" }] as import("@wudao-org/core").AgentMessage[],
    };
    const registry = createSessionRegistry();
    const task = createAgentsTaskTool({
      model,
      allTools: ALL_TOOLS,
      registry,
      workspaceRoot: root,
      runId: "fork-run",
      getForkContext: () => forkContext,
    });
    const r = await task.execute({ description: "d", prompt: "fork brief", shareContext: true });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("fork child answer");
    // The fork request extended the parent conversation verbatim.
    expect(model.inputs[0]!.systemPrompt).toBe("PARENT-SYS");
    expect(model.inputs[0]!.messages.map((m) => m.role)).toEqual(["user", "user"]);
  });

  it("fork without parent context keeps the exact M24 error", async () => {
    const h = harness(recordingModel([]));
    const r = await h.task.execute({ description: "d", prompt: "p", shareContext: true });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("requires the caller to expose the parent conversation");
  });
});

describe("task tool — background + registry tools", () => {
  it("background spawn returns bg-N immediately with the receipt; agent_await collects the WORKER_REPORT", async () => {
    const model = recordingModel([
      { role: "assistant", content: WORKER_REPORT({ note: "w1" }) },
      { role: "assistant", content: WORKER_REPORT({ note: "w2" }) },
    ]);
    const h = harness(model);
    const r1 = await h.task.execute({ description: "worker one", prompt: "p1", role: "coder", background: true, reportSchema: REPORT_SCHEMA });
    expect(r1.isError).toBeFalsy();
    expect(r1.content).toContain("bg-1");
    expect(r1.content).toContain('"role":"coder"');
    expect(r1.content).toContain('"state":"running"');
    expect(r1.content).toContain('"reportSchema":"attached"');
    expect(r1.content).toContain("agent_await");
    const r2 = await h.task.execute({ description: "worker two", prompt: "p2", role: "coder", background: true });
    expect(r2.content).toContain("bg-2");

    const status = await h.tools.agent_status.execute({});
    expect(status.isError).toBeFalsy();
    expect(status.content).toContain("bg-1");
    expect(status.content).toContain("bg-2");

    const collected = await h.tools.agent_await.execute({ ids: ["bg-1", "bg-2"], mode: "all" });
    expect(collected.isError).toBeFalsy();
    const rows = JSON.parse(collected.content) as Array<{ id: string; state: string; report: string; reasoning: { requested: string; effective: string } }>;
    expect(rows.map((x) => x.id)).toEqual(["bg-1", "bg-2"]);
    expect(rows.every((x) => x.state === "completed")).toBe(true);
    expect(rows[0]!.report).toContain("[WORKER_REPORT]");
    expect(rows[0]!.report).toContain("budget_limited");
    expect(rows[0]!.reasoning).toEqual({ requested: "off", effective: "off" });
  });

  it("agent_await: unknown id fails closed; bad mode/ids rejected", async () => {
    const h = harness(recordingModel([]));
    const unknown = await h.tools.agent_await.execute({ ids: ["bg-404"] });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain("bg-404");
    const badMode = await h.tools.agent_await.execute({ ids: ["bg-1"], mode: "sometimes" });
    expect(badMode.isError).toBe(true);
    expect(badMode.content).toContain("mode");
    const empty = await h.tools.agent_await.execute({ ids: [] });
    expect(empty.isError).toBe(true);
  });

  it("agent_await mode any collects the first success and skips a failure", async () => {
    const model = recordingModel([
      { role: "assistant", content: "" }, // worker 1: empty final answer still settles ok
      { role: "assistant", content: "winner report" },
    ]);
    const h = harness(model);
    await h.task.execute({ description: "a", prompt: "p", background: true });
    await h.task.execute({ description: "b", prompt: "p", background: true });
    const any = await h.tools.agent_await.execute({ ids: ["bg-1", "bg-2"], mode: "any" });
    expect(any.isError).toBeFalsy();
    const row = JSON.parse(any.content) as { report: string };
    expect(typeof row.report).toBe("string");
  });

  it("agent_cancel stops an in-flight agent and refuses settled/unknown ids", async () => {
    const model = holdableModel([{ role: "assistant", content: "slow answer" }]);
    const h = harness(model);
    model.hold();
    await h.task.execute({ description: "slow", prompt: "p", background: true });
    // The child parks inside its model call — verifiably in flight.
    await until(() => model.inputs.length === 1);
    const cancel = await h.tools.agent_cancel.execute({ id: "bg-1" });
    expect(cancel.isError).toBeFalsy();
    expect(cancel.content).toContain("bg-1");
    const again = await h.tools.agent_cancel.execute({ id: "bg-1" });
    expect(again.isError).toBe(true);
    const unknown = await h.tools.agent_cancel.execute({ id: "bg-9" });
    expect(unknown.isError).toBe(true);
    // Let the aborted child's parked call settle so nothing dangles.
    model.release();
  });

  it("single-writer: a second concurrent spawn on the same live session id fails in the child", async () => {
    const model = holdableModel([
      { role: "assistant", content: "first" },   // bg-1: creates sidechain child-1
      { role: "assistant", content: "second" },  // bg-2: resumes child-1, parks (in-flight writer)
    ]);
    const h = harness(model);
    const first = await h.task.execute({ description: "one", prompt: "p", background: true, session: "new:child-1" });
    expect(first.isError).toBeFalsy();
    await h.registry.awaitAgents({ ids: ["bg-1"], mode: "allSettled" }); // sidechain child-1 written

    model.hold();
    const second = await h.task.execute({ description: "two", prompt: "p", background: true, session: "resume:child-1" });
    expect(second.isError).toBeFalsy(); // the spawn itself is accepted…
    // …but the child now parks inside its model call holding the writer.
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(model.inputs.length).toBe(2);
    const third = await h.task.execute({ description: "three", prompt: "p", background: true, session: "resume:child-1" });
    expect(third.isError).toBeFalsy();
    const settled = await h.registry.awaitAgents({ ids: ["bg-3"], mode: "allSettled" });
    expect(settled[0]!.ok).toBe(false);
    expect(settled[0]!.error).toMatch(/single-writer/);
    model.release(); // unpark bg-2
    await h.registry.awaitAgents({ ids: ["bg-2"], mode: "allSettled" });
  });

  it("pilot nudge: first background spawn with no first-hand work prepends the advisory exactly once", async () => {
    const model = recordingModel([{ role: "assistant", content: "w1" }, { role: "assistant", content: "w2" }]);
    let firstHand = false;
    const h = harness(model, { pilotProbe: () => firstHand });
    const r1 = await h.task.execute({ description: "delegate first", prompt: "p", background: true });
    expect(r1.content.startsWith("pilot advisory")).toBe(true);
    // Parent does one unit of work; the second spawn does not nag.
    firstHand = true;
    const r2 = await h.task.execute({ description: "delegate again", prompt: "p", background: true });
    expect(r2.content.startsWith("pilot advisory")).toBe(false);
    expect(r2.content).toContain("bg-2");
  });

  it("worktree roles outside a git repo degrade to the main workspace with a note", async () => {
    await mkdir(join(root, ".wudao", "agents"), { recursive: true });
    await writeFile(join(root, ".wudao", "agents", "isolated.json"), JSON.stringify({
      description: "worktree role",
      worktree: true,
      toolNames: ["read_file"],
    }));
    const model = recordingModel([{ role: "assistant", content: "iso answer" }]);
    const h = harness(model);
    const r = await h.task.execute({ description: "d", prompt: "p", role: "isolated" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("worktree");
    expect(r.content).toContain("main workspace");
  });

  it("worktree roles in a git repo: child runs in .wudao/wt/<run>/<role>-1, its tools rooted at the worktree", async () => {
    const gitRoot = await mkdtemp(join(tmpdir(), "wtrepo-"));
    try {
      const git = (...args: string[]): ReturnType<typeof execFile> => execFile("git", ["-C", gitRoot, ...args]);
      await git("init", "-q");
      await git("config", "user.email", "t@example.com");
      await git("config", "user.name", "t");
      await writeFile(join(gitRoot, "marker.txt"), "worktree-marker\n");
      await git("add", "marker.txt");
      await git("commit", "-q", "-m", "init");
      // After the commit, make the MAIN tree's copy diverge — a child still
      // rooted at the main workspace would read "main-marker" instead.
      await writeFile(join(gitRoot, "marker.txt"), "main-marker\n");

      await mkdir(join(gitRoot, ".wudao", "agents"), { recursive: true });
      await writeFile(join(gitRoot, ".wudao", "agents", "isolated.json"), JSON.stringify({
        description: "worktree role",
        worktree: true,
        toolNames: ["read_file"],
      }));
      const model = recordingModel([{ role: "assistant", content: "iso answer" }]);
      const registry = createSessionRegistry();
      // Instrument the worktree seam: record the root the child's tools are
      // built for and return a real read_file rooted there.
      const builtRoots: string[] = [];
      const task = createAgentsTaskTool({
        model, allTools: ALL_TOOLS, registry, workspaceRoot: gitRoot, runId: "wt-run",
        childToolsFor: (root) => {
          builtRoots.push(root);
          return [createReadFileTool({ workspaceRoot: root })];
        },
      });
      const r = await task.execute({ description: "d", prompt: "p", role: "isolated" });
      expect(r.isError).toBeFalsy();
      const wtPath = join(gitRoot, ".wudao", "wt", "wt-run", "isolated-1");
      expect(r.content).toContain(wtPath);
      expect(r.content).toContain("wudao/wt-run/isolated-1"); // the branch
      expect(existsSync(wtPath)).toBe(true);
      // The child's tool set was built FOR the worktree, and a read_file
      // rooted there resolves the relative marker to the COMMITTED content —
      // not the main tree's post-commit edit.
      expect(builtRoots).toEqual([wtPath]);
      expect(model.inputs[0]!.tools.map((t) => t.name)).toEqual(["read_file"]);
      const out = await createReadFileTool({ workspaceRoot: builtRoots[0]! }).execute({ path: "marker.txt" });
      expect(out.isError).toBeFalsy();
      expect(out.content).toContain("worktree-marker");
    } finally {
      await rm(gitRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("buildToolSet integration (tools.ts wiring)", () => {
  it("registers task + the registry triple after the coding tools, and children stay isolated", async () => {
    const { buildToolSet } = await import("../src/tools.js");
    const model = recordingModel([
      { role: "assistant", content: "child answer" },
      { role: "assistant", content: "main answer" },
    ]);
    const seen: import("@wudao-org/core").AgentMessage[] = [];
    const tools = buildToolSet({
      workspaceRoot: root,
      model,
      canUseTool: async () => ({ behavior: "allow" }),
      contextWindowTokens: 64000,
      contextProbe: () => seen,
      agents: { runId: "it-run", defaultEffort: "off" },
    });
    const names = tools.map((t) => t.name);
    expect(names.indexOf("task")).toBeGreaterThan(names.indexOf("shell"));
    expect(names.indexOf("agent_await")).toBeGreaterThan(names.indexOf("task"));
    expect(names.slice(names.indexOf("task")).slice(0, 4)).toEqual(["task", "agent_await", "agent_status", "agent_cancel"]);
    // A coder child sees only the coding tools — never the orchestration set.
    const r = await tools.find((t) => t.name === "task")!.execute({ description: "d", prompt: "p", role: "coder" });
    expect(r.isError).toBeFalsy();
    const childNames = model.inputs[0]!.tools.map((t) => t.name);
    expect(childNames).not.toContain("task");
    expect(childNames).not.toContain("agent_await");
    expect(childNames).toContain("write_file");
  });
});

describe("task tool — 波次8 #47 (OH#6): background wall-clock timeout", () => {
  /** Receipt-only probe: a model that answers immediately, so the test pins
   *  the clamp + echo without waiting on any wall-clock firing (the firing
   *  semantics are pinned at the core registry layer). */
  const spawnReceipt = async (timeoutMs?: number): Promise<string> => {
    const model = recordingModel([{ role: "assistant", content: "quick report" }]);
    const h = harness(model);
    const r = await h.task.execute({ description: "quick", prompt: "p", background: true, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
    expect(r.isError).toBeFalsy();
    return r.content;
  };

  it("clamps the model-facing timeoutMs into the kernel range and echoes the effective cap on the receipt", async () => {
    // below the floor → clamped up
    expect(await spawnReceipt(5)).toContain(`"timeoutMs":30000`);
    // above the ceiling → clamped down
    expect(await spawnReceipt(72_000_000)).toContain(`"timeoutMs":3600000`);
    // in range → verbatim
    expect(await spawnReceipt(120_000)).toContain(`"timeoutMs":120000`);
  });

  it("no explicit timeout → the kernel default (30m) is the effective cap on the receipt", async () => {
    expect(await spawnReceipt()).toContain(`"timeoutMs":1800000`);
  });

  it("foreground children ignore the timeoutMs input (the parent's own run governs them)", async () => {
    const model = recordingModel([{ role: "assistant", content: "fg report" }]);
    const h = harness(model);
    const r = await h.task.execute({ description: "fg", prompt: "p", timeoutMs: 45_000 });
    expect(r.isError).toBeFalsy();
    // A foreground result is the child's report text, not a bg receipt —
    // no timeout echo anywhere.
    expect(r.content).toContain("fg report");
    expect(r.content).not.toContain("timeoutMs");
  });
});

// ---------------------------------------------------------------------------
// ω99-5b: the report contract — a schema'd dispatch injects a deterministic
// instruction line into the child brief (both spawn paths share the same
// assembly point), the child's tool set gains the final_output finishing tool,
// and the foreground run names finalTool so the captured tool_use becomes the
// canonical-JSON report.
// ---------------------------------------------------------------------------
describe("task tool — ω99-5b report contract + final_output", () => {
  const CONTRACT_PREFIX = "[report contract] Your FINAL message must be a single JSON object satisfying this schema (no prose, no code fences): ";

  it("injects the contract line with the canonical schema JSON; zero injection without a schema", async () => {
    const model = recordingModel([{ role: "assistant", content: "ok" }]);
    const h = harness(model);
    const r = await h.task.execute({ description: "d", prompt: "do it", reportSchema: REPORT_SCHEMA });
    expect(r.isError).toBeFalsy();
    const brief = model.inputs[0]!.messages[0]!;
    expect(brief.role).toBe("user");
    expect(brief.content.startsWith("do it\n\n")).toBe(true);
    expect(brief.content).toContain(CONTRACT_PREFIX + canonicalJson(JSON.parse(REPORT_SCHEMA)));
    // No schema → the brief stays byte-identical (no injection at all).
    const plain = recordingModel([{ role: "assistant", content: "ok" }]);
    await harness(plain).task.execute({ description: "d", prompt: "plain" });
    expect(plain.inputs[0]!.messages).toEqual([{ role: "user", content: "plain" }]);
  });

  it("final_output tool: legal args → the fixed receipt; violations → the error list + fix directive", async () => {
    const tool = createFinalOutputTool(JSON.parse(REPORT_SCHEMA) as JsonSchemaSubset);
    const ok = await tool.execute({ units_done: 1, tokens_used: 10, budget_limited: false });
    expect(ok.isError).toBeFalsy();
    expect(ok.content).toBe(FINAL_OUTPUT_OK);
    expect(ok.content).toBe("final output recorded ✓ — end your turn now (no more tool calls)");
    const bad = await tool.execute({ units_done: 1 });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("missing required property");
    expect(bad.content).toContain("fix and call final_output again");
  });

  it("a schema'd child's tool set contains final_output; a schema-less one does not", async () => {
    const model = recordingModel([{ role: "assistant", content: "ok" }]);
    await harness(model).task.execute({ description: "d", prompt: "p", reportSchema: REPORT_SCHEMA });
    expect(model.inputs[0]!.tools.map((t) => t.name)).toContain(FINAL_OUTPUT_TOOL_NAME);
    const plain = recordingModel([{ role: "assistant", content: "ok" }]);
    await harness(plain).task.execute({ description: "d", prompt: "p" });
    expect(plain.inputs[0]!.tools.map((t) => t.name)).not.toContain(FINAL_OUTPUT_TOOL_NAME);
  });

  it("foreground: the final_output tool_use becomes the canonical-JSON report (finalTool threading)", async () => {
    const model = recordingModel([
      { role: "assistant", content: "", toolCalls: [{ id: "f1", name: "final_output", arguments: { units_done: 3, tokens_used: 99, budget_limited: false } }] },
      { role: "assistant", content: "done" },
    ]);
    const h = harness(model);
    const r = await h.task.execute({ description: "d", prompt: "p", reportSchema: REPORT_SCHEMA, role: "coder" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain(canonicalJson({ units_done: 3, tokens_used: 99, budget_limited: false }));
  });
});

// ---------------------------------------------------------------------------
// ω99-23 T1 — honest dispatch annotations on the session-registered task
// tool (packages/cli/src/agents/task-tool.ts; core's createTaskTool is NOT
// registered by cli sessions). Dispatching a child is a metadata operation:
// the child's own tool calls each pass the SAME permission gate instance
// (M45: the REPL's buildTools gate is ALSO the task tool's child gate), so
// the fail-closed unannotated defaults {destructive:true, open_world:true}
// fed the sidecar classifier a false fact — it read every fan-out as this
// call being destructive.
// ---------------------------------------------------------------------------

describe("ω99-23 task tool honest annotations (T1)", () => {
  const FANOUT_ARGS = {
    description: "refactor many files",
    prompt: "Edit every file under src/ to fix the lint errors and run the tests",
    role: "coder",
  };
  it("dispatch is not destructive; open-world reach stays honestly true", () => {
    const { task } = harness(recordingModel([]));
    // Not destructive even for arguments that DESCRIBE destructive downstream
    // work — that work is classified at each child call, not here.
    expect(task.isDestructive?.(FANOUT_ARGS)).toBe(false);
    // Honest: a child can reach the network through its own gated calls.
    expect(task.isOpenWorld?.(FANOUT_ARGS)).toBe(true);
  });
  it("isReadOnly stays the fail-closed false default — the dispatch never claims read-class", () => {
    const { task } = harness(recordingModel([]));
    // buildTool's TOOL_DEFAULTS fill () => false (defined, false-valued — never
    // true): the dispatch stays in the sidecar's audit scope.
    expect(task.isReadOnly?.(FANOUT_ARGS)).toBe(false);
  });
});
