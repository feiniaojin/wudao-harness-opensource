// M63-C — the skill-position hooks: frontmatter `hooks:` arms at /skill
// invocation, composes over the configured hooks for the session's remainder,
// and clears on /clear and on compaction. Driver-level, deterministic.
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTool, createScriptedModel } from "@wudao-org/core";
import type { Tool } from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { loadSkills } from "../src/skills.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const params = {
  type: "object" as const,
  properties: { path: { type: "string" as const } },
  required: ["path"],
  additionalProperties: false,
};

function readTool(): Tool {
  return buildTool({ name: "read_file", description: "d", parameters: params, execute: async () => ({ content: "C" }) });
}

describe("M63-C R1 — prompt_id minting", () => {
  it("the driver mints ONE id per submitted prompt into the box", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-pid-"));
    await mkdir(join(ws, ".wudao", "sessions"), { recursive: true });
    try {
      const model = createScriptedModel([
        { role: "assistant", content: "one" },
        { role: "assistant", content: "two" },
      ]);
      const promptId: { current?: string } = {};
      const d = createAgentDriver({
        model,
        tools: [readTool()],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        sessionId: "s-pid",
        workspaceRoot: ws,
        promptIdBox: promptId,
      });
      expect(promptId.current).toBeUndefined(); // nothing before a submit
      d.submit("first prompt");
      await until(() => !d.getStatus().busy, "first run");
      const first = promptId.current;
      expect(typeof first).toBe("string");
      expect(first!.length).toBeGreaterThan(10);
      d.setOptions({ model: createScriptedModel([{ role: "assistant", content: "two" }]), tools: [readTool()], systemPrompt: "s", summarize: summarizeToolCall, sessionId: "s-pid", workspaceRoot: ws, promptIdBox: promptId });
      d.submit("second prompt");
      await until(() => !d.getStatus().busy, "second run");
      expect(promptId.current).not.toBe(first); // a FRESH id per prompt
      d.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 10_000);
});

describe("R6-I1 — the hook warn sink routes to the user's history", () => {
  it("a driver installs a working notice sink at construction", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-warnsink-"));
    try {
      await mkdir(join(ws, ".wudao", "sessions"), { recursive: true });
      const sink: { current?: (m: string) => void } = {};
      const d = createAgentDriver({
        model: createScriptedModel([{ role: "assistant", content: "ok" }]),
        tools: [],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        hookWarnSink: sink,
      });
      expect(typeof sink.current).toBe("function");
      sink.current!("\u{1F4AC} hook says hi");
      expect(d.getHistory().some((e) => e.kind === "notice" && e.text.includes("hook says hi"))).toBe(true);
      d.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 10_000);
});

describe("M63-C R1 follow-up — the LIVE session id box", () => {
  it("seeds at construction and follows the /clear rotation (hook payloads never go stale)", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-sidbox-"));
    try {
      await mkdir(join(ws, ".wudao", "sessions"), { recursive: true });
      const sessionId: { current?: string } = {};
      const d = createAgentDriver({
        model: createScriptedModel([{ role: "assistant", content: "ok" }]),
        tools: [],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        sessionId: "s-live-1",
        workspaceRoot: ws,
        sessionIdBox: sessionId,
      });
      expect(sessionId.current).toBe("s-live-1"); // seeded at construction
      d.setOptions({ model: createScriptedModel([{ role: "assistant", content: "ok" }]), tools: [], systemPrompt: "s", summarize: summarizeToolCall, sessionId: "s-live-1", workspaceRoot: ws, sessionIdBox: sessionId });
      expect(d.submit("/clear")).toBe("cleared");
      expect(sessionId.current).not.toBe("s-live-1"); // followed the rotation
      expect(typeof sessionId.current).toBe("string");
      d.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 10_000);
});

describe("M63-C skill-position hooks", () => {
  async function skillWorkspace(): Promise<string> {
    const ws = await mkdtemp(join(tmpdir(), "wudao-skillhook-"));
    await mkdir(join(ws, ".wudao", "sessions"), { recursive: true });
    await mkdir(join(ws, ".wudao", "skills", "auditor"), { recursive: true });
    await writeFile(
      join(ws, ".wudao", "skills", "auditor", "SKILL.md"),
      [
        "---",
        "name: auditor",
        "description: audit tool calls",
        // JSON.stringify escapes win32 backslash path separators — a raw
        // interpolation would produce invalid JSON on that platform.
        `hooks: ${JSON.stringify({ onPostToolUse: [{ command: join(dirname(fileURLToPath(import.meta.url)), "fixtures", "skill-log.sh"), matcher: "read_file" }] })}`,
        "---",
        "",
        "# Auditor skill",
        "",
        "Audit every tool call.",
      ].join("\n"),
      "utf8",
    );
    return ws;
  }

  it("arms at /skill invocation, fires for the session's remainder, clears on /clear", async () => {
    const ws = await skillWorkspace();
    try {
      const [skill] = loadSkills(ws, () => {});
      expect(skill?.name).toBe("auditor");
      expect(skill?.hooks?.onPostToolUse).toBeDefined();

      // Two runs: run 1 invokes the skill; run 2 does the tool call whose
      // post-hook must fire (the position outlives the invoking run).
      const model = createScriptedModel([
        { role: "assistant", content: "skill invoked" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
        { role: "assistant", content: "done" },
      ]);
      const d: AgentDriver = createAgentDriver({
        model,
        tools: [readTool()],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        sessionId: "s-skill",
        workspaceRoot: ws,
        skills: [skill!],
        canUseTool: () => ({ behavior: "allow" as const }),
      });
      d.submit("/skill:auditor");
      await until(() => !d.getStatus().busy, "skill run settled");
      // BEFORE the skill: no hook has fired (no log file yet).
      await expect(readFile(join(ws, "skill-hook.log"))).rejects.toThrow();

      d.submit("now read something");
      await until(() => !d.getStatus().busy, "tool run settled");
      await wait(150);
      expect(await readFile(join(ws, "skill-hook.log"), "utf8")).toBe("hook-ran\n");

      // /clear ends the position: another tool run fires nothing more.
      d.clear();
      const model2 = createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "read_file", arguments: { path: "b.txt" } }] },
        { role: "assistant", content: "done" },
      ]);
      d.setOptions({ model: model2, tools: [readTool()], systemPrompt: "s", summarize: summarizeToolCall, sessionId: "s-skill", workspaceRoot: ws, skills: [skill!], canUseTool: () => ({ behavior: "allow" as const }) });
      d.submit("read again");
      await until(() => !d.getStatus().busy, "post-clear run settled");
      await wait(150);
      expect(await readFile(join(ws, "skill-hook.log"), "utf8")).toBe("hook-ran\n"); // still exactly one fire
      d.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 15_000);
});
