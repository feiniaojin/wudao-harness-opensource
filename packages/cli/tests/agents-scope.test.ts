// M31 §1 — write-scope enforcement at the task tool: scoped roles get their
// write-semantics tools (write_file/edit/shell) wrapped fail-closed at
// CHILD TOOL-SET construction (never globally), task-level narrowing refuses
// escalation, and receipts/TUI notices carry the scope + overlap warnings.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { AssistantMessage, ModelClient, ModelInput, Tool } from "@wudao-org/core";
import { createAgentRegistry, createReadFileTool, createWriteFileTool, createEditTool, createShellTool } from "@wudao-org/core";
import { createAgentsTaskTool, createRegistryTools, createSessionRegistry } from "../src/agents/index.js";
import type { AgentRegistry } from "../src/agents/index.js";
import { applyWriteScopeGuard } from "../src/agents/write-scope-guard.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "scope-")); });
// dispose 的 sessionEnd 迟到落盘会在 rm 走完后重建文件（ENOTEMPTY，
// 门级负载下翻红过）——maxRetries 等它落定（turn-diff-faces 先例）。
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

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

const turn = (id: string, name: string, args: Record<string, unknown>): AssistantMessage =>
  ({ role: "assistant", content: "", toolCalls: [{ id, name, arguments: args }] });
const answer = (text: string): AssistantMessage => ({ role: "assistant", content: text });
/** The M23 verify gate nudges a post-write stop up to 3 times before letting
 *  it through — a scripted child that writes needs 4 identical finals. */
const finals = (n: number, text: string): AssistantMessage[] => Array.from({ length: n }, () => answer(text));

/** A model that parks its FIRST generate() until released — keeps a
 *  background child verifiably in flight for overlap tests. Later calls
 *  answer immediately. */
function gatedModel(): { model: ModelClient & { inputs: ModelInput[] }; release: () => void } {
  const inputs: ModelInput[] = [];
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  let parked = false;
  const model: ModelClient & { inputs: ModelInput[] } = {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: [...input.messages], tools: [...input.tools] });
      if (!parked) {
        parked = true;
        await gate;
      }
      return answer("gated child done");
    },
  };
  return { model, release };
}

function realTools(): readonly Tool[] {
  return [
    createReadFileTool({ workspaceRoot: root }),
    createWriteFileTool({ workspaceRoot: root }),
    createEditTool({ workspaceRoot: root }),
    createShellTool({ workspaceRoot: root }),
  ];
}

async function writeRole(name: string, body: Record<string, unknown>): Promise<void> {
  await mkdir(join(root, ".wudao", "agents"), { recursive: true });
  await writeFile(join(root, ".wudao", "agents", `${name}.json`), JSON.stringify(body));
}

function scopedTask(model: ModelClient, registry: AgentRegistry, over: Record<string, unknown> = {}): Tool {
  return createAgentsTaskTool({
    model,
    allTools: realTools(),
    registry,
    workspaceRoot: root,
    runId: "scope-test",
    defaultEffort: "off",
    ...over,
  });
}

const SCOPED_ROLE = {
  description: "writes only inside its scope",
  toolNames: ["read_file", "write_file", "edit", "shell"],
  writeScope: { roots: ["area/"] },
};

async function readIfPresent(p: string): Promise<string | undefined> {
  try { return await readFile(p, "utf8"); } catch { return undefined; }
}

// ---------------------------------------------------------------------------
// Guard unit level (applyWriteScopeGuard wraps a concrete tool array)
// ---------------------------------------------------------------------------

describe("applyWriteScopeGuard (tool wrapping)", () => {
  it("passes in-scope writes through and refuses out-of-scope writes fail-closed", async () => {
    const tools = realTools();
    const guarded = applyWriteScopeGuard(tools, { workspaceRoot: root, scope: { roots: ["area/"] }, allowShell: false });
    const byName = new Map(guarded.map((t) => [t.name, t]));
    const ok = await byName.get("write_file")!.execute({ path: "area/inside.txt", content: "in" });
    expect(ok.isError).toBeFalsy();
    expect(await readIfPresent(join(root, "area/inside.txt"))).toBe("in");
    const refused = await byName.get("write_file")!.execute({ path: "outside.txt", content: "nope" });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("write scope");
    expect(existsSync(join(root, "outside.txt"))).toBe(false);
    // Segment boundary: area2 is NOT under area/.
    const sibling = await byName.get("write_file")!.execute({ path: "area2/x.txt", content: "nope" });
    expect(sibling.isError).toBe(true);
    // Read tools pass through untouched (same object reference).
    expect(byName.get("read_file")).toBe(tools[0] as Tool);
  });

  it("resolves absolute and ../-laden paths before matching (lexical collapse)", async () => {
    const guarded = applyWriteScopeGuard(realTools(), { workspaceRoot: root, scope: { roots: ["area/"] }, allowShell: false });
    const w = guarded.find((t) => t.name === "write_file")!;
    const absOk = await w.execute({ path: join(root, "area/abs.txt"), content: "abs" });
    expect(absOk.isError).toBeFalsy();
    const escape = await w.execute({ path: "area/../../escape.txt", content: "no" });
    expect(escape.isError).toBe(true);
    expect(existsSync(join(root, "escape.txt"))).toBe(false);
  });

  it("shell: refused without an exemption, message points at worktree roles", async () => {
    const guarded = applyWriteScopeGuard(realTools(), { workspaceRoot: root, scope: { roots: ["area/"] }, allowShell: false });
    const run = guarded.find((t) => t.name === "shell")!;
    const r = await run.execute({ command: "echo hi" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("worktree");
  });

  it("shell: allowShell exemption runs the command", async () => {
    const guarded = applyWriteScopeGuard(realTools(), { workspaceRoot: root, scope: { roots: ["area/"] }, allowShell: true });
    const r = await guarded.find((t) => t.name === "shell")!.execute({ command: "echo hi" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("hi");
  });
});

// ---------------------------------------------------------------------------
// Task-tool integration: the guard wraps the CHILD tool set
// ---------------------------------------------------------------------------

describe("task tool — write-scope guards", () => {
  it("a scoped role's child writes land inside the scope; out-of-scope writes are refused", async () => {
    await writeRole("area-writer", SCOPED_ROLE);
    await mkdir(join(root, "area"), { recursive: true });
    await writeFile(join(root, "area", "seed.txt"), "seed\n");
    const model = recordingModel([
      turn("c1", "read_file", { path: "area/seed.txt" }),
      turn("c2", "write_file", { path: "area/new.txt", content: "written\n" }),
      turn("c3", "write_file", { path: "elsewhere.txt", content: "denied\n" }),
      turn("c4", "edit", { path: "area/seed.txt", old_string: "seed", new_string: "edited" }),
      turn("c5", "edit", { path: "top.txt", old_string: "x", new_string: "y" }),
      ...finals(4, "done writing in scope"),
    ]);
    const registry = createSessionRegistry();
    const task = scopedTask(model, registry);
    const result = await task.execute({ description: "write", prompt: "write in area/", role: "area-writer" });
    expect(result.isError).toBeFalsy();
    // In-scope effects landed.
    expect(await readIfPresent(join(root, "area/new.txt"))).toBe("written\n");
    expect(await readIfPresent(join(root, "area/seed.txt"))).toBe("edited\n");
    // Out-of-scope effects never happened.
    expect(existsSync(join(root, "elsewhere.txt"))).toBe(false);
    expect(existsSync(join(root, "top.txt"))).toBe(false);
    // The receipt names the effective scope.
    expect(result.content).toContain("write-scope: roots area");
    // The child SAW the refusals as error tool results (last request carries
    // the full child transcript).
    const childTranscript = model.inputs.at(-1)?.messages ?? [];
    const toolResults = childTranscript.filter((m) => m.role === "tool").map((m) => m.content);
    expect(toolResults.some((t) => t.includes("write scope"))).toBe(true);
  });

  it("exactFiles scope: the declared file is writable, siblings are not", async () => {
    await writeRole("doc-writer", {
      description: "writes only docs.md exactly",
      toolNames: ["read_file", "write_file"],
      writeScope: { exactFiles: ["docs.md"] },
    });
    const model = recordingModel([
      turn("c1", "write_file", { path: "docs.md", content: "ok\n" }),
      turn("c2", "write_file", { path: "docs.md.bak", content: "no\n" }),
      ...finals(4, "done"),
    ]);
    const task = scopedTask(model, createSessionRegistry());
    await task.execute({ description: "doc", prompt: "edit docs.md only", role: "doc-writer" });
    expect(await readIfPresent(join(root, "docs.md"))).toBe("ok\n");
    expect(existsSync(join(root, "docs.md.bak"))).toBe(false);
  });

  it("unscoped roles keep writing freely (no guard, no scope line)", async () => {
    await writeRole("free-writer", { description: "no scope", toolNames: ["write_file"] });
    const model = recordingModel([
      turn("c1", "write_file", { path: "anywhere.txt", content: "free\n" }),
      ...finals(4, "done"),
    ]);
    const task = scopedTask(model, createSessionRegistry());
    const result = await task.execute({ description: "free", prompt: "write", role: "free-writer" });
    expect(await readIfPresent(join(root, "anywhere.txt"))).toBe("free\n");
    expect(result.content).not.toContain("write-scope:");
  });

  it("taskWriteScope narrows the role scope; escalation fails closed", async () => {
    await writeRole("src-writer", {
      description: "writes src/",
      toolNames: ["write_file"],
      writeScope: { roots: ["src/"] },
    });
    // Narrowed to src/lib/ → a src/other write is refused.
    const m1 = recordingModel([
      turn("c1", "write_file", { path: "src/lib/a.ts", content: "ok" }),
      turn("c2", "write_file", { path: "src/other.ts", content: "no" }),
      ...finals(4, "done"),
    ]);
    const task = scopedTask(m1, createSessionRegistry());
    const r1 = await task.execute({
      description: "narrow", prompt: "p", role: "src-writer",
      taskWriteScope: { roots: ["src/lib/"] },
    });
    expect(await readIfPresent(join(root, "src/lib/a.ts"))).toBe("ok");
    expect(existsSync(join(root, "src/other.ts"))).toBe(false);
    expect(r1.content).toContain("write-scope: roots src/lib");
    // Widening beyond the role scope is refused before anything spawns.
    const m2 = recordingModel([]);
    const r2 = await scopedTask(m2, createSessionRegistry()).execute({
      description: "widen", prompt: "p", role: "src-writer",
      taskWriteScope: { roots: ["tests/"] },
    });
    expect(r2.isError).toBe(true);
    expect(r2.content).toContain("escalation");
    expect(m2.inputs.length).toBe(0);
  });

  it("taskWriteScope on an unscoped role applies as an ad-hoc narrowing", async () => {
    await writeRole("loose", { description: "unscoped", toolNames: ["write_file"] });
    const model = recordingModel([
      turn("c1", "write_file", { path: "one/a.txt", content: "1" }),
      turn("c2", "write_file", { path: "two/b.txt", content: "2" }),
      ...finals(4, "done"),
    ]);
    const task = scopedTask(model, createSessionRegistry());
    await task.execute({
      description: "ad hoc", prompt: "p", role: "loose",
      taskWriteScope: { roots: ["one/"] },
    });
    expect(await readIfPresent(join(root, "one/a.txt"))).toBe("1");
    expect(existsSync(join(root, "two/b.txt"))).toBe(false);
  });

  it("malformed taskWriteScope fails closed", async () => {
    await writeRole("src-writer", SCOPED_ROLE);
    const model = recordingModel([]);
    const r = await scopedTask(model, createSessionRegistry()).execute({
      description: "bad", prompt: "p", role: "src-writer",
      taskWriteScope: { roots: "not-an-array" },
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("taskWriteScope");
  });

  it("shell guard: refused for a plain scoped role, exempt via role allowShell or a sandboxed session", async () => {
    await writeRole("plain-writer", SCOPED_ROLE);
    await writeRole("shell-writer", { ...SCOPED_ROLE, allowShell: true });
    // Plain scoped role: the command is refused (child gets an error result
    // and carries on — one tool turn + one final turn).
    const m0 = recordingModel([turn("c1", "shell", { command: "echo nope" }), answer("done")]);
    await scopedTask(m0, createSessionRegistry()).execute({ description: "sh", prompt: "p", role: "plain-writer" });
    expect(m0.inputs.length).toBe(2);
    expect(m0.inputs[1]!.messages.some((m) => m.role === "tool" && m.content.includes("worktree"))).toBe(true);
    // allowShell on the role exempts it.
    const m1 = recordingModel([turn("c1", "shell", { command: "echo shell-ok" }), answer("done")]);
    await scopedTask(m1, createSessionRegistry()).execute({ description: "sh", prompt: "p", role: "shell-writer" });
    expect(m1.inputs.length).toBe(2);
    expect(m1.inputs[1]!.messages.some((m) => m.role === "tool" && m.content.includes("shell-ok"))).toBe(true);
    // A sandboxed session exempts it too.
    const m2 = recordingModel([turn("c1", "shell", { command: "echo sandbox-ok" }), answer("done")]);
    await scopedTask(m2, createSessionRegistry(), { sandboxedRunCommand: true })
      .execute({ description: "sh", prompt: "p", role: "plain-writer" });
    expect(m2.inputs.length).toBe(2);
    expect(m2.inputs[1]!.messages.some((m) => m.role === "tool" && m.content.includes("sandbox-ok"))).toBe(true);
  });

  it("fork children never get the guard (parent tool array stays byte-identical)", async () => {
    await writeRole("scoped-fork", { description: "scoped fork", writeScope: { roots: ["area/"] } });
    const model = recordingModel([answer("forked report")]);
    const task = scopedTask(model, createSessionRegistry(), {
      getForkContext: () => ({
        systemPrompt: "parent prompt",
        tools: realTools(),
        messages: [{ role: "user", content: "parent turn" }],
      }),
    });
    const r = await task.execute({ description: "fork", prompt: "p", shareContext: true, role: "scoped-fork" });
    expect(r.isError).toBeFalsy();
    expect(r.content).not.toContain("write-scope:");
  });
});

// ---------------------------------------------------------------------------
// Overlap detection receipts + TUI notices + strict mode
// ---------------------------------------------------------------------------

describe("task tool — overlap warnings, notices, strict refusal", () => {
  it("background spawn of an overlapping scoped role warns on the receipt and fires onNotice (TUI)", async () => {
    await writeRole("scope-a", { ...SCOPED_ROLE, writeScope: { roots: ["src/"] } });
    await writeRole("scope-b", { ...SCOPED_ROLE, writeScope: { roots: ["src/lib/"] } });
    const registry = createSessionRegistry();
    const first = gatedModel();
    const notices: string[] = [];
    const task = scopedTask(first.model, registry, { onNotice: (t: string) => void notices.push(t) });
    const s1 = await task.execute({ description: "a", prompt: "p", role: "scope-a", background: true, session: "new" });
    expect(s1.isError).toBeFalsy();
    expect(s1.content).toContain("write-scope: roots src");
    // bg-1 is parked in flight; bg-2's scope overlaps src/ → warning.
    const s2 = await task.execute({ description: "b", prompt: "p", role: "scope-b", background: true });
    expect(s2.isError).toBeFalsy();
    expect(s2.content).toContain("overlap");
    expect(s2.content).toContain("bg-1");
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain("write-scope overlap with bg-1");
    first.release();
    await registry.awaitAgents({ ids: ["bg-1", "bg-2"], mode: "allSettled" });
  });

  it("disjoint scoped spawns produce no warning", async () => {
    await writeRole("scope-a", { ...SCOPED_ROLE, writeScope: { roots: ["a/"] } });
    await writeRole("scope-c", { ...SCOPED_ROLE, writeScope: { roots: ["c/"] } });
    const registry = createSessionRegistry();
    const first = gatedModel();
    const task = scopedTask(first.model, registry);
    await task.execute({ description: "a", prompt: "p", role: "scope-a", background: true });
    const s2 = await task.execute({ description: "c", prompt: "p", role: "scope-c", background: true });
    expect(s2.isError).toBeFalsy();
    expect(s2.content).not.toContain("overlap");
    first.release();
    await registry.awaitAgents({ ids: ["bg-1", "bg-2"], mode: "allSettled" });
  });

  it("strictOverlaps registry refuses the overlapping spawn (task failed, nothing spawned)", async () => {
    await writeRole("scope-a", { ...SCOPED_ROLE, writeScope: { roots: ["src/"] } });
    await writeRole("scope-b", { ...SCOPED_ROLE, writeScope: { roots: ["src/lib/"] } });
    const registry = createAgentRegistry({ maxConcurrent: 3, hardCap: 16, childTurns: 20, graceTools: ["todo_write"], strictOverlaps: true });
    const first = gatedModel();
    const task = scopedTask(first.model, registry);
    await task.execute({ description: "a", prompt: "p", role: "scope-a", background: true });
    const s2 = await task.execute({ description: "b", prompt: "p", role: "scope-b", background: true });
    expect(s2.isError).toBe(true);
    expect(s2.content).toContain("write-scope overlap");
    expect(registry.status()).toHaveLength(1);
    first.release();
    await registry.awaitAgents({ ids: ["bg-1"], mode: "all" });
  });

  it("agent_await receipts keep BOTH overlapping candidates with their scopes (fan-in)", async () => {
    await writeRole("scope-a", { ...SCOPED_ROLE, writeScope: { roots: ["src/"] } });
    await writeRole("scope-b", { ...SCOPED_ROLE, writeScope: { roots: ["src/lib/"] } });
    const registry = createSessionRegistry();
    const first = gatedModel();
    const task = scopedTask(first.model, registry);
    await task.execute({ description: "a", prompt: "p", role: "scope-a", background: true, session: "new" });
    await task.execute({ description: "b", prompt: "p", role: "scope-b", background: true, session: "new" });
    first.release();
    const registryTools = createRegistryTools(registry);
    const awaitTool = registryTools[0]!;
    const rows = await awaitTool.execute({ ids: ["bg-1", "bg-2"], mode: "allSettled" });
    const parsed = JSON.parse(rows.content) as Array<Record<string, unknown>>;
    expect(parsed.length).toBe(2);
    expect(parsed[0]!.writeScope).toBe("roots src");
    expect(parsed[1]!.writeScope).toBe("roots src/lib");
    expect(parsed[1]!.overlapWith).toEqual(["bg-1"]);
  });
});
