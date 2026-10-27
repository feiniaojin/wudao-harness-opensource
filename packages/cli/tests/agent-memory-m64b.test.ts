// M64-B §B — agent memory: the three tier routings, the default-on project
// tier, spawn-time injection with the deterministic 200-line/25KB bound and
// the MEMORY_PRUNED marker family (stale markers filtered on re-read),
// write-back through the ORDINARY file tools (project tier in-workspace,
// user tier outside it via the routing wrapper), the write-scope guard's
// memory-root admission for scoped roles, and the M62 lifecycle matrix
// (project expires with cleanupPeriodDays; local/user NEVER; purge never
// touches memory). Deterministic: tmpdirs, real file tools, scripted models.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, stat, utimes } from "node:fs/promises";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput, Tool } from "@wudao/core";
import { createEditTool, createReadFileTool, createWriteFileTool } from "@wudao/core";
import { createAgentsTaskTool, createSessionRegistry } from "../src/agents/index.js";
import {
  MEMORY_INJECTION_MAX_LINES,
  agentMemoryPaths,
  applyMemoryFileRouting,
  buildMemoryInjection,
  effectiveMemoryTier,
  formatMemoryPrunedMarker,
  memoryPromptSection,
  parseMemoryPrunedMarker,
} from "../src/agents/agent-memory.js";
import { applyWriteScopeGuard } from "../src/agents/write-scope-guard.js";
import { collectCleanableFiles, buildPurgePlan, runLifecycleSweep } from "../src/lifecycle.js";
import { parseAgentFrontmatter, loadPlugins } from "../src/plugins.js";

let root: string;
let home: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "m64b-"));
  home = await mkdtemp(join(tmpdir(), "m64b-home-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Routing + defaults (pure)
// ---------------------------------------------------------------------------

describe("M64-B tier routing", () => {
  it("three directory routings; unset defaults to project", () => {
    // The literal fixtures are /-spelled posix paths; on win32 path.join
    // emits \ — compare through the SAME join so both platforms assert the
    // routing logic, not the platform separator.
    const ws = "/ws";
    const gh = "/home/u/.wudao";
    expect(agentMemoryPaths("project", "coder", { workspaceRoot: ws, globalHome: gh })).toEqual({
      tier: "project",
      root: join("/ws/.wudao", "agent-memory"),
      file: join("/ws/.wudao", "agent-memory", "coder", "MEMORY.md"),
    });
    expect(agentMemoryPaths("local", "coder", { workspaceRoot: ws, globalHome: gh }).root).toBe(join("/ws/.wudao", "agent-memory-local"));
    expect(agentMemoryPaths("user", "coder", { workspaceRoot: ws, globalHome: gh }).root).toBe(join("/home/u/.wudao", "agent-memory"));
    expect(agentMemoryPaths("user", "coder", { workspaceRoot: ws, globalHome: gh }).file).toBe(join("/home/u/.wudao", "agent-memory", "coder", "MEMORY.md"));
    expect(effectiveMemoryTier(undefined)).toBe("project");
    expect(effectiveMemoryTier("user")).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// The deterministic injection bound + the marker family
// ---------------------------------------------------------------------------

describe("M64-B injection bound (first 200 lines / 25KB, whichever first)", () => {
  it("200 lines or fewer pass verbatim", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
    const r = buildMemoryInjection(text);
    expect(r.truncated).toBe(false);
    expect(r.body.split("\n").length).toBe(200);
    expect(r.droppedLines).toBe(0);
  });
  it("201+ lines truncate at exactly 200 (251-line file → 50 dropped)", () => {
    const text = Array.from({ length: 251 }, (_, i) => `line ${i + 1}`).join("\n");
    const r = buildMemoryInjection(text);
    expect(r.truncated).toBe(true);
    expect(r.body.split("\n").length).toBe(MEMORY_INJECTION_MAX_LINES);
    expect(r.body.endsWith("line 200")).toBe(true);
    expect(r.droppedLines).toBe(51);
  });
  it("the BYTE bound wins when lines are huge (a line that would cross 25KB ends the window whole)", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `${"x".repeat(2048)} ${i}`);
    const text = lines.join("\n");
    const r = buildMemoryInjection(text);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.body, "utf8")).toBeLessThanOrEqual(25 * 1024);
    expect(Buffer.byteLength(r.body, "utf8")).toBeGreaterThan(25 * 1024 - 2048);
    expect(r.body.split("\n").length).toBeLessThan(30);
  });
  it("stale MEMORY_PRUNED markers inside the file are FILTERED — appended notes never re-inject them", () => {
    const stale = formatMemoryPrunedMarker("coder", "/ws/.wudao/agent-memory/coder/MEMORY.md");
    const text = [`note one`, stale, `note two`].join("\n");
    const r = buildMemoryInjection(text);
    expect(r.body).toBe("note one\nnote two");
    expect(r.body).not.toContain("[MEMORY_PRUNED:");
    expect(r.droppedLines).toBe(1);
  });
  it("the marker family round-trips and rejects non-markers", () => {
    const marker = formatMemoryPrunedMarker("coder", "/abs/MEMORY.md");
    expect(marker.startsWith("[MEMORY_PRUNED:")).toBe(true);
    const parsed = parseMemoryPrunedMarker(marker);
    expect(parsed).toEqual({ role: "coder", path: "/abs/MEMORY.md" });
    expect(parseMemoryPrunedMarker("ordinary text")).toBeUndefined();
    expect(parseMemoryPrunedMarker("[MEMORY_PRUNED: no path here]")).toBeUndefined();
  });
  it("the prompt section names the file, the tier, and the create-it path", () => {
    const withContent = memoryPromptSection({ tier: "project", role: "coder", file: "/ws/.wudao/agent-memory/coder/MEMORY.md", content: "known facts", truncated: false, fileExists: true });
    expect(withContent).toContain("# Your persistent memory (project tier)");
    expect(withContent).toContain("/ws/.wudao/agent-memory/coder/MEMORY.md");
    expect(withContent).toContain("known facts");
    expect(withContent).toContain("ORDINARY file tools");
    expect(withContent).toContain("expires with the workspace's cleanupPeriodDays");
    expect(withContent).not.toContain("TRUNCATED");
    const empty = memoryPromptSection({ tier: "user", role: "coder", file: "/h/agent-memory/coder/MEMORY.md", content: "", truncated: false, fileExists: false });
    expect(empty).toContain("no memory yet");
    expect(empty).toContain("never auto-cleaned");
    const truncated = memoryPromptSection({ tier: "local", role: "coder", file: "/f", content: "x", truncated: true, fileExists: true });
    expect(truncated).toContain("TRUNCATED");
  });
  it("fix round: exactly 200 content lines + trailing newline is NOT truncated; a >25KB first line yields the too-large note, never the create suggestion", () => {
    const exact = Array.from({ length: 200 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
    const r = buildMemoryInjection(exact);
    expect(r.truncated).toBe(false);
    expect(r.droppedLines).toBe(0);
    expect(r.body.split("\n").length).toBe(200);

    const hugeFirst = `${"z".repeat(26 * 1024)}\nsecond line`;
    const r2 = buildMemoryInjection(hugeFirst);
    expect(r2.truncated).toBe(true);
    expect(r2.body).toBe("");
    // an EXISTING file with an empty window: too-large note, no creation hint
    const section = memoryPromptSection({ tier: "project", role: "coder", file: "/f/MEMORY.md", content: r2.body, truncated: r2.truncated, fileExists: true });
    expect(section).toContain("EXISTS but its first line alone exceeds");
    expect(section).toContain("do NOT overwrite it");
    expect(section).not.toContain("no memory yet");
    // pre-item fix: an EXISTING but EMPTY file renders its own note
    const emptyFile = memoryPromptSection({ tier: "project", role: "coder", file: "/f/MEMORY.md", content: "", truncated: false, fileExists: true, fileEmpty: true });
    expect(emptyFile).toContain("exists but is empty");
    expect(emptyFile).not.toContain("too large");
    expect(emptyFile).not.toContain("no memory yet");
  });
});

// ---------------------------------------------------------------------------
// Roster + plugin frontmatter
// ---------------------------------------------------------------------------

describe("M64-B roster surfaces", () => {
  it("a workspace profile's memory tier loads; a junk tier skips the file (unit of trust)", async () => {
    await mkdir(join(root, ".wudao", "agents"), { recursive: true });
    await writeFile(join(root, ".wudao", "agents", "librarian.json"), JSON.stringify({ description: "mem", memory: "local" }), "utf8");
    await writeFile(join(root, ".wudao", "agents", "broken.json"), JSON.stringify({ description: "bad", memory: "cloud" }), "utf8");
    const warnings: string[] = [];
    const { loadRoleProfiles } = await import("../src/agents/core-bind.js");
    const roster = await loadRoleProfiles(root, { onWarning: (m) => warnings.push(m) });
    expect(roster.profiles.get("librarian")?.memory).toBe("local");
    expect(roster.profiles.has("broken")).toBe(false);
    expect(warnings.join(" ")).toContain("broken.json");
  });
  it("CC agents/*.md frontmatter: memory project|local|user parses; junk warns via loadPlugins", () => {
    const fm = parseAgentFrontmatter("---\nname: mem-agent\ndescription: has memory\nmemory: user\n---\nbody text");
    expect(fm.memory).toBe("user");
    expect(fm.unknownFields).toEqual([]);
    expect(parseAgentFrontmatter("---\nname: x\ndescription: d\n---\nb").memory).toBeUndefined();

    // through a real plugin load: the tier reaches the profile; junk warns.
    const ws = mkdtempSync(join(tmpdir(), "m64b-plug-"));
    try {
      const pluginDir = join(ws, ".wudao", "plugins", "p", ".claude-plugin");
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({ name: "p", version: "1.0.0" }));
      mkdirSync(join(pluginDir, "..", "..", "agents"), { recursive: true });
      const agentsDir = join(ws, ".wudao", "plugins", "p", "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, "good.md"), "---\nname: good\ndescription: d\nmemory: local\n---\nbody");
      writeFileSync(join(agentsDir, "junk.md"), "---\nname: junk\ndescription: d\nmemory: cloud\n---\nbody");
      const warnings: string[] = [];
      const plugins = loadPlugins(ws, [], (m) => warnings.push(m));
      const agent = plugins[0]?.agents.find((a) => a.profile.id === "good");
      expect(agent?.profile.memory).toBe("local");
      expect(warnings.join(" ")).toContain('memory "cloud"');
    } finally {
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

// ---------------------------------------------------------------------------
// Spawn injection + write-back (real task tool, real file tools)
// ---------------------------------------------------------------------------

function recordingModel(responses: readonly AssistantMessage[], inputs: ModelInput[]): ModelClient {
  let i = 0;
  return {
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: [...input.messages], tools: [...input.tools] });
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

/** REAL builtin file tools rooted at the test workspace (write-back must ride
 *  the ordinary tools, not stubs). */
function realTools(): readonly Tool[] {
  return [
    createReadFileTool({ workspaceRoot: root }),
    createWriteFileTool({ workspaceRoot: root }),
    createEditTool({ workspaceRoot: root }),
  ];
}

function taskToolWith(model: ModelClient): Tool {
  return createAgentsTaskTool({
    model,
    allTools: realTools(),
    registry: createSessionRegistry(),
    workspaceRoot: root,
    runId: "m64b-run",
  });
}

describe("M64-B spawn injection", () => {
  it("a role's memory rides the child system prompt, bounded (250-line file → first 200 + marker in section)", async () => {
    const memFile = join(root, ".wudao", "agent-memory", "librarian", "MEMORY.md");
    await mkdir(join(root, ".wudao", "agents"), { recursive: true });
    await writeFile(join(root, ".wudao", "agents", "librarian.json"), JSON.stringify({ description: "keeps notes" }), "utf8");
    await mkdir(join(root, ".wudao", "agent-memory", "librarian"), { recursive: true });
    await writeFile(memFile, Array.from({ length: 250 }, (_, i) => `fact ${i + 1}`).join("\n"), "utf8");

    const inputs: ModelInput[] = [];
    const model = recordingModel([{ role: "assistant", content: "done" }], inputs);
    const task = taskToolWith(model);
    const r = await task.execute({ description: "d", prompt: "work", role: "librarian" });
    expect(r.isError).toBeFalsy();
    const sys = inputs[0]!.systemPrompt;
    expect(sys).toContain("# Your persistent memory (project tier)");
    expect(sys).toContain("fact 1");
    expect(sys).toContain("fact 200");
    expect(sys).not.toContain("fact 201"); // bounded: the tail never rides
    expect(sys).toContain("TRUNCATED"); // the section notes the truncation
    expect(sys).toContain(memFile); // the exact file path for read_file
  }, 12_000);

  it("default-on: a role WITHOUT the memory field still gets project-tier memory; fork skips it", async () => {
    // no memory file yet → the bootstrap section names the path to create
    const inputs: ModelInput[] = [];
    const model = recordingModel([{ role: "assistant", content: "done" }], inputs);
    const task = taskToolWith(model);
    await task.execute({ description: "d", prompt: "work", role: "general-purpose" });
    expect(inputs[0]!.systemPrompt).toContain("# Your persistent memory (project tier)");
    expect(inputs[0]!.systemPrompt).toContain(join(root, ".wudao", "agent-memory", "general-purpose", "MEMORY.md"));
    expect(inputs[0]!.systemPrompt).toContain("no memory yet");

    // fork shares the parent prompt — no memory section
    const forkInputs: ModelInput[] = [];
    const forkModel = recordingModel([{ role: "assistant", content: "done" }], forkInputs);
    const forkTask = createAgentsTaskTool({
      model: forkModel,
      allTools: realTools(),
      registry: createSessionRegistry(),
      workspaceRoot: root,
      runId: "m64b-run2",
      getForkContext: () => ({ messages: [], systemPrompt: "parent", tools: [] }) as never,
    });
    await forkTask.execute({ description: "d", prompt: "work", shareContext: true });
    expect(forkInputs[0]!.systemPrompt).not.toContain("# Your persistent memory");
  }, 12_000);

  it("write-back through the ORDINARY file tools lands on disk and re-injects next spawn", async () => {
    await mkdir(join(root, ".wudao", "agents"), { recursive: true });
    await writeFile(join(root, ".wudao", "agents", "scribe.json"), JSON.stringify({ description: "writes notes", toolNames: ["read_file", "write_file"] }), "utf8");

    const relPath = ".wudao/agent-memory/scribe/MEMORY.md";
    const inputs: ModelInput[] = [];
    const model = recordingModel(
      [
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: { path: relPath, content: "2026-08-21: the build lives in packages/" } }] },
        { role: "assistant", content: "noted" },
      ],
      inputs,
    );
    const task = taskToolWith(model);
    await task.execute({ description: "d", prompt: "remember where the build lives", role: "scribe" });
    // the write landed via the ordinary tool
    const written = await readFileText(join(root, relPath));
    expect(written).toContain("packages/");

    // the SECOND spawn of the same role sees the note in its prompt
    const inputs2: ModelInput[] = [];
    const model2 = recordingModel([{ role: "assistant", content: "done" }], inputs2);
    const task2 = taskToolWith(model2);
    await task2.execute({ description: "d", prompt: "again", role: "scribe" });
    expect(inputs2[0]!.systemPrompt).toContain("the build lives in packages/");
  }, 12_000);

  it("the USER tier lives outside the workspace and the ordinary tools still reach it (routing)", async () => {
    await mkdir(join(root, ".wudao", "agents"), { recursive: true });
    await writeFile(join(root, ".wudao", "agents", "globe.json"), JSON.stringify({ description: "global", memory: "user", toolNames: ["read_file", "write_file"] }), "utf8");
    process.env.WUDAO_GLOBAL_HOME = home;
    try {
      const absMem = join(home, "agent-memory", "globe", "MEMORY.md");
      const inputs: ModelInput[] = [];
      const model = recordingModel(
        [
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: { path: absMem, content: "user-tier note" } }] },
          { role: "assistant", content: "saved" },
        ],
        inputs,
      );
      const task = taskToolWith(model);
      await task.execute({ description: "d", prompt: "remember globally", role: "globe" });
      // the section advertised the USER-tier path under the global home
      expect(inputs[0]!.systemPrompt).toContain(absMem);
      expect(inputs[0]!.systemPrompt).toContain("user tier");
      // the out-of-workspace write landed through the routing wrapper
      expect(await readFileText(absMem)).toContain("user-tier note");
      // and an out-of-workspace write OUTSIDE the memory root is still refused
      const inputs2: ModelInput[] = [];
      const model2 = recordingModel(
        [
          { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "write_file", arguments: { path: join(home, "elsewhere.txt"), content: "x" } }] },
          { role: "assistant", content: "done" },
        ],
        inputs2,
      );
      const task2 = taskToolWith(model2);
      await task2.execute({ description: "d", prompt: "try escaping", role: "globe" });
      const refused = inputs2.map((i) => i.messages.some((m) => m.role === "tool" && String((m as { result?: unknown }).result ?? "").includes("escapes workspace")));
      expect(refused.some(Boolean) || (await exists(join(home, "elsewhere.txt"))) === false).toBe(true);
      expect(await exists(join(home, "elsewhere.txt"))).toBe(false);
    } finally {
      delete process.env.WUDAO_GLOBAL_HOME;
    }
  }, 15_000);

  it("a SCOPED role can still write its memory (guard admission) but not outside its scope", async () => {
    const memFile = join(root, ".wudao", "agent-memory", "bound", "MEMORY.md");
    const tools = applyWriteScopeGuard(realTools(), {
      workspaceRoot: root,
      scope: { roots: ["src/"] },
      allowShell: false,
      alwaysAllowAbs: [join(root, ".wudao", "agent-memory")],
    });
    // memory file (absolute path inside the admitted root) passes
    const ok = await tools.find((t) => t.name === "write_file")!.execute({ path: memFile, content: "scoped note" });
    expect(ok.isError).toBeFalsy();
    expect(await readFileText(memFile)).toBe("scoped note");
    // an in-scope path passes
    const inScope = await tools.find((t) => t.name === "write_file")!.execute({ path: "src/a.ts", content: "x" });
    expect(inScope.isError).toBeFalsy();
    // an out-of-scope, non-memory path still refuses (the guard is real)
    const out = await tools.find((t) => t.name === "write_file")!.execute({ path: "docs/other.md", content: "x" });
    expect(out.isError).toBe(true);
    expect(String(out.content)).toContain("outside this role's write scope");
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Lifecycle matrix (M62 §2 × M64-B §B)
// ---------------------------------------------------------------------------

describe("M64-B lifecycle matrix", () => {
  it("project-tier memory expires with cleanupPeriodDays; local-tier NEVER; purge never touches memory", async () => {
    const now = Date.now();
    const projFile = join(root, ".wudao", "agent-memory", "coder", "MEMORY.md");
    const freshProj = join(root, ".wudao", "agent-memory", "newbie", "MEMORY.md");
    const localFile = join(root, ".wudao", "agent-memory-local", "coder", "MEMORY.md");
    for (const f of [projFile, freshProj, localFile]) {
      await mkdir(join(f, ".."), { recursive: true });
      await writeFile(f, "note", "utf8");
    }
    // age the project + local files past the retention window
    await utimes(projFile, new Date(now - 60 * DAY), new Date(now - 60 * DAY));
    await utimes(localFile, new Date(now - 60 * DAY), new Date(now - 60 * DAY));

    // the sweep: expired project memory soft-deletes; local NEVER (not walked)
    const sweep = await runLifecycleSweep(root, { cleanupPeriodDays: 30, softDeletePeriodDays: 7 }, now);
    expect(sweep.softDeleted.map((e) => e.relPath)).toContain("agent-memory/coder/MEMORY.md");
    expect(await exists(localFile)).toBe(true);
    expect(await exists(freshProj)).toBe(true);

    // the purge plan: agent memory NEVER rides it (never-memory contract)
    const plan = await buildPurgePlan(root);
    expect(plan.entries.some((e) => e.relPath.startsWith("agent-memory"))).toBe(false);
    // while the sweep's collector DOES include it (time expiry only)
    const all = await collectCleanableFiles(root);
    expect(all.some((e) => e.relPath.startsWith("agent-memory"))).toBe(true);
    // and the local tier is structurally never collected
    expect(all.some((e) => e.relPath.startsWith("agent-memory-local"))).toBe(false);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Fix round 1 — the child reaches ONLY its own memory directory
// ---------------------------------------------------------------------------

describe("M64-B fix round — own-dir admission (not the tier root)", () => {
  it("a SCOPED role writes its own memory file but a tier-mate's is refused (project + local tiers)", async () => {
    for (const tier of ["project", "local"] as const) {
      const base = tier === "project" ? join(root, ".wudao", "agent-memory") : join(root, ".wudao", "agent-memory-local");
      const ownDir = join(base, "bound");
      const ownFile = join(ownDir, "MEMORY.md");
      const sibling = join(base, "victim", "MEMORY.md");
      await mkdir(join(base, "victim"), { recursive: true });
      const tools = applyWriteScopeGuard(realTools(), {
        workspaceRoot: root,
        scope: { roots: ["src/"] },
        allowShell: false,
        alwaysAllowAbs: [ownDir], // what the task tool passes: dirname(file)
      });
      const ok = await tools.find((t) => t.name === "write_file")!.execute({ path: ownFile, content: "own note" });
      expect(ok.isError).toBeFalsy();
      const poison = await tools.find((t) => t.name === "write_file")!.execute({ path: sibling, content: "poison" });
      expect(poison.isError).toBe(true);
      expect(String(poison.content)).toContain("outside this role's write scope");
      expect(await exists(sibling)).toBe(false);
    }
  }, 10_000);

  it("the USER tier routes ONLY the role's own dir — a sibling role's file under the global home is refused", async () => {
    const ownDir = join(home, "agent-memory", "globe");
    await mkdir(ownDir, { recursive: true }); // the task tool pre-creates this
    const tools = applyMemoryFileRouting(realTools(), { workspaceRoot: root, memoryDir: ownDir });
    const own = await tools.find((t) => t.name === "write_file")!.execute({ path: join(ownDir, "MEMORY.md"), content: "own" });
    expect(own.isError).toBeFalsy();
    expect(await readFileText(join(ownDir, "MEMORY.md"))).toBe("own");
    // sibling role under the same tier root: outside the role dir → falls
    // through to the SESSION tool, which refuses by containment
    const sibling = await tools.find((t) => t.name === "write_file")!.execute({ path: join(home, "agent-memory", "victim", "MEMORY.md"), content: "poison" });
    expect(sibling.isError).toBe(true);
    expect(await exists(join(home, "agent-memory", "victim"))).toBe(false);
    // the tier ROOT itself is not a write target either
    const rootWrite = await tools.find((t) => t.name === "write_file")!.execute({ path: join(home, "agent-memory", "OTHER.md"), content: "x" });
    expect(rootWrite.isError).toBe(true);
  }, 10_000);

  it("in-workspace memory targets keep the SESSION tools (the staleness/history/write-verify machinery stays in the loop)", async () => {
    const ownDir = join(root, ".wudao", "agent-memory", "scribe");
    await mkdir(ownDir, { recursive: true });
    let sessionCalls = 0;
    const markerTool = (name: string): Tool => ({
      name,
      description: "fake session tool",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        sessionCalls += 1;
        return { content: "SESSION-TOOL-CALLED" };
      },
    });
    const wrapped = applyMemoryFileRouting([markerTool("read_file"), markerTool("write_file")], { workspaceRoot: root, memoryDir: ownDir });
    // in-workspace memory target → the SESSION tool answers
    const inWs = await wrapped.find((t) => t.name === "write_file")!.execute({ path: ".wudao/agent-memory/scribe/MEMORY.md", content: "n" });
    expect(inWs.content).toBe("SESSION-TOOL-CALLED");
    expect(sessionCalls).toBe(1);
    // out-of-workspace memory target (the user tier) → the routed instance
    const userDir = join(home, "agent-memory", "u");
    await mkdir(userDir, { recursive: true });
    const wrappedUser = applyMemoryFileRouting([markerTool("write_file")], { workspaceRoot: root, memoryDir: userDir });
    const out = await wrappedUser.find((t) => t.name === "write_file")!.execute({ path: join(userDir, "MEMORY.md"), content: "routed" });
    expect(out.isError).toBeFalsy();
    expect(await readFileText(join(userDir, "MEMORY.md"))).toBe("routed");
    expect(sessionCalls).toBe(1); // the session tool was NOT used out there
    // routeInWorkspace forces routing (worktree children) when asked
    const forced = applyMemoryFileRouting([markerTool("write_file")], { workspaceRoot: root, memoryDir: ownDir, routeInWorkspace: true });
    const forcedResult = await forced.find((t) => t.name === "write_file")!.execute({ path: ".wudao/agent-memory/scribe/MEMORY.md", content: "direct" });
    expect(forcedResult.isError).toBeFalsy();
    expect(await readFileText(join(ownDir, "MEMORY.md"))).toBe("direct");
    expect(sessionCalls).toBe(1);
  }, 10_000);

  it("path-shaped role names are refused at the boundary and at plugin load", async () => {
    expect(() => agentMemoryPaths("project", "../evil", { workspaceRoot: root, globalHome: home })).toThrow(/plain path segment/);
    expect(() => agentMemoryPaths("user", "a/b", { workspaceRoot: root, globalHome: home })).toThrow(/plain path segment/);
    expect(agentMemoryPaths("project", "plain-name_1", { workspaceRoot: root, globalHome: home }).file).toContain("plain-name_1");

    const ws = mkdtempSync(join(tmpdir(), "m64b-name-"));
    try {
      const pluginDir = join(ws, ".wudao", "plugins", "p", ".claude-plugin");
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({ name: "p", version: "1.0.0" }));
      const agentsDir = join(ws, ".wudao", "plugins", "p", "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, "evil.md"), "---\nname: ../evil\ndescription: d\nmemory: user\n---\nbody");
      const warnings: string[] = [];
      const plugins = loadPlugins(ws, [], (m) => warnings.push(m));
      expect(plugins[0]?.agents.some((a) => a.profile.id === "../evil")).toBe(false);
      expect(warnings.join(" ")).toContain("no path separators or dots");
    } finally {
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 10_000);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function readFileText(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
