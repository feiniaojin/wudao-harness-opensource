// ω99-56 — the file-edits approval gate (deslop): invoking a skill whose
// frontmatter declares `approval-gate: file-edits` arms a per-path human
// approval posture for the session's edit/write_file calls. Unapproved-path
// edits ASK (never a silent allow), a session-scoped `a` answer records a
// path-scoped receipt (no re-ask on that exact tool+path), other paths keep
// asking (independent decisions, never bundled), deny outcomes stay honored,
// and an unarmed session behaves exactly as today. Driver-level, scripted.
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool, createScriptedModel } from "@wudao-org/core";
import type { Tool, PermissionDecision } from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { loadSkills } from "../src/skills.js";
import type { LoadedSkill } from "../src/skills.js";

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

function editTool(flag: { runs: number }): Tool {
  return buildTool({
    name: "edit",
    description: "d",
    parameters: params,
    execute: async () => {
      flag.runs += 1;
      return { content: "edited" };
    },
  });
}

function readTool(): Tool {
  return buildTool({ name: "read_file", description: "d", parameters: params, execute: async () => ({ content: "C" }) });
}

const SKILL_MD = [
  "---",
  "name: deslop",
  "description: simplify completed work under a per-path approval gate",
  "approval-gate: file-edits",
  "---",
  "",
  "# deslop",
  "",
  "Simplify; every significant deletion needs per-path human approval.",
].join("\n");

async function gateWorkspace(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), "wudao-deslop-"));
  await mkdir(join(ws, ".wudao", "sessions"), { recursive: true });
  await mkdir(join(ws, ".wudao", "skills", "deslop"), { recursive: true });
  await writeFile(join(ws, ".wudao", "skills", "deslop", "SKILL.md"), SKILL_MD, "utf8");
  return ws;
}

type Gate = (toolName: string, input: Record<string, unknown>) => Promise<PermissionDecision | "ask"> | PermissionDecision | "ask";

/** A driver with the deslop skill ALREADY invoked (the gate armed), plus a
 *  fresh scripted model for the follow-up tool run. */
async function armedDriver(
  ws: string,
  flag: { runs: number },
  canUseTool: Gate,
  followUp: { role: "assistant"; content: string; toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[] }[],
): Promise<{ driver: AgentDriver; skill: LoadedSkill }> {
  const [skill] = loadSkills(ws, () => {});
  expect(skill?.name).toBe("deslop");
  const model = createScriptedModel([{ role: "assistant", content: "skill invoked" }]);
  const driver = createAgentDriver({
    model,
    tools: [editTool(flag), readTool()],
    systemPrompt: "s",
    summarize: summarizeToolCall,
    sessionId: "s-deslop",
    workspaceRoot: ws,
    skills: [skill!],
    canUseTool,
  });
  driver.submit("/skill:deslop");
  await until(() => !driver.getStatus().busy, "skill invocation run settled");
  driver.setOptions({
    model: createScriptedModel(followUp),
    tools: [editTool(flag), readTool()],
    systemPrompt: "s",
    summarize: summarizeToolCall,
    sessionId: "s-deslop",
    workspaceRoot: ws,
    skills: [skill!],
    canUseTool,
  });
  return { driver, skill };
}

const allowGate: Gate = () => ({ behavior: "allow" as const });
const editCall = (path: string) => [
  { role: "assistant" as const, content: "", toolCalls: [{ id: "c1", name: "edit", arguments: { path } }] },
  { role: "assistant" as const, content: "done" },
];

describe("ω99-56 — file-edits approval gate (deslop)", () => {
  it("bites: an edit on an unapproved path ASKS while armed (no silent pass), then executes after approval", async () => {
    const ws = await gateWorkspace();
    const flag = { runs: 0 };
    try {
      const { driver } = await armedDriver(ws, flag, allowGate, editCall("src/a.ts"));
      driver.submit("simplify now");
      await until(() => driver.getStatus().pendingPermission !== null, "the unapproved-path edit to ask");
      // The ask names the gated tool — the human sees what would change.
      expect(driver.getStatus().pendingPermission?.toolName).toBe("edit");
      expect(driver.getStatus().pendingPermission?.input).toMatchObject({ path: "src/a.ts" });
      expect(flag.runs).toBe(0); // nothing executed before the human answered
      expect(driver.answerPermission(true, undefined, "session")).toBe(true);
      await until(() => !driver.getStatus().busy, "run settled after approval");
      expect(flag.runs).toBe(1); // approved → the edit ran
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 15_000);

  it("receipt: a session `a` covers exactly that path+tool — same path runs clean, another path asks again", async () => {
    const ws = await gateWorkspace();
    const flag = { runs: 0 };
    try {
      const { driver } = await armedDriver(ws, flag, allowGate, editCall("src/a.ts"));
      driver.submit("simplify now");
      await until(() => driver.getStatus().pendingPermission !== null, "first ask (path A)");
      driver.answerPermission(true, undefined, "session");
      await until(() => !driver.getStatus().busy, "approved edit settled");
      expect(flag.runs).toBe(1);

      // Same path, same tool: the receipt answers — NO new ask (the run would
      // park forever if it asked, so settling IS the no-ask proof).
      driver.setOptions({
        model: createScriptedModel(editCall("src/a.ts")),
        tools: [editTool(flag), readTool()],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        sessionId: "s-deslop",
        workspaceRoot: ws,
        canUseTool: allowGate,
      });
      driver.submit("one more touch on the same file");
      await until(() => !driver.getStatus().busy, "same-path run settled with no ask");
      expect(flag.runs).toBe(2);

      // A DIFFERENT path: asks again — independent decisions, never bundled.
      driver.setOptions({
        model: createScriptedModel(editCall("src/b.ts")),
        tools: [editTool(flag), readTool()],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        sessionId: "s-deslop",
        workspaceRoot: ws,
        canUseTool: allowGate,
      });
      driver.submit("and the sibling file");
      await until(() => driver.getStatus().pendingPermission !== null, "path B asks independently");
      expect(driver.getStatus().pendingPermission?.input).toMatchObject({ path: "src/b.ts" });
      driver.answerPermission(false); // deny ends the run without executing
      await until(() => !driver.getStatus().busy, "denied edit settled");
      expect(flag.runs).toBe(2); // b.ts never executed
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 20_000);

  it("unarmed session: the same edit call goes straight through — behavior unchanged from today", async () => {
    const ws = await gateWorkspace();
    const flag = { runs: 0 };
    try {
      const [skill] = loadSkills(ws, () => {});
      const driver = createAgentDriver({
        model: createScriptedModel(editCall("src/a.ts")),
        tools: [editTool(flag), readTool()],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        sessionId: "s-deslop",
        workspaceRoot: ws,
        skills: [skill!],
        canUseTool: allowGate,
      });
      driver.submit("plain edit, no deslop");
      await until(() => !driver.getStatus().busy, "unarmed edit settled");
      expect(flag.runs).toBe(1); // allowed by the mode rules, exactly as before
      expect(driver.getStatus().pendingPermission).toBeNull();
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 15_000);

  it("a frontend DENY stays honored while armed — the gate never widens a denial into an ask", async () => {
    const ws = await gateWorkspace();
    const flag = { runs: 0 };
    const denyGate: Gate = () => ({ behavior: "deny" as const, reason: "no edits here" });
    try {
      const { driver } = await armedDriver(ws, flag, denyGate, editCall("src/a.ts"));
      driver.submit("simplify now");
      await until(() => !driver.getStatus().busy, "denied run settled without parking an ask");
      expect(flag.runs).toBe(0);
      expect(driver.getStatus().pendingPermission).toBeNull();
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 15_000);

  it("a frontend ASK outcome (the protected-file class) composes: the gate asks, exactly once, and a plain `y` does not mint a receipt", async () => {
    const ws = await gateWorkspace();
    const flag = { runs: 0 };
    let gateCalls = 0;
    const askGate: Gate = (_t, _i) => {
      gateCalls += 1;
      return "ask" as const; // e.g. decideRichPermission's protected-write layer
    };
    try {
      const { driver } = await armedDriver(ws, flag, askGate, editCall(".wudao/settings.json"));
      driver.submit("simplify now");
      await until(() => driver.getStatus().pendingPermission !== null, "the ask-shaped edit parks an ask");
      expect(gateCalls).toBe(1); // consulted once, not doubled by the wrapper
      driver.answerPermission(true); // plain `y` — allow-once, no rule
      await until(() => !driver.getStatus().busy, "run settled after the one-off allow");
      expect(flag.runs).toBe(1);
      // No receipt from a bare y: the next edit on the same path asks again.
      driver.setOptions({
        model: createScriptedModel(editCall(".wudao/settings.json")),
        tools: [editTool(flag), readTool()],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        sessionId: "s-deslop",
        workspaceRoot: ws,
        canUseTool: askGate,
      });
      driver.submit("again");
      await until(() => driver.getStatus().pendingPermission !== null, "no receipt from y — asks again");
      driver.answerPermission(false);
      await until(() => !driver.getStatus().busy, "settled");
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 15_000);

  it("read-class calls pass untouched while armed, and /clear disarms the posture", async () => {
    const ws = await gateWorkspace();
    const flag = { runs: 0 };
    try {
      const { driver } = await armedDriver(ws, flag, allowGate, [
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "src/a.ts" } }] },
        { role: "assistant", content: "done" },
      ]);
      driver.submit("look first");
      await until(() => !driver.getStatus().busy, "read run settled with no ask");
      expect(driver.getStatus().pendingPermission).toBeNull();

      driver.clear(); // the session boundary ends the approval posture
      driver.setOptions({
        model: createScriptedModel(editCall("src/a.ts")),
        tools: [editTool(flag), readTool()],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        sessionId: "s-deslop",
        workspaceRoot: ws,
        canUseTool: allowGate,
      });
      driver.submit("edit after clear");
      await until(() => !driver.getStatus().busy, "post-clear edit settled with no ask");
      expect(flag.runs).toBe(1);
      expect(driver.getStatus().pendingPermission).toBeNull();
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 15_000);
});
