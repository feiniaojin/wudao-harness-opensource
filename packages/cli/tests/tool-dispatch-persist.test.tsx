// 波次 8 #45 (dsh session-checkpoint-policy) — pre-dispatch durability
// barrier at the CLI layer. The gap: persistence ran ONLY at run-complete —
// a crash mid-tool left NO trace that a side-effecting call was dispatched
// (the entire run's messages were still in memory), so resume lost the
// side-effect fact entirely: the model would happily re-issue a write over
// a file it may already have changed. The fix threads the loop's
// onBeforeToolDispatch barrier through the driver into session-engine,
// which appends the ORDERED PREFIX (user turn + each tool-carrying
// assistant, plus anything still unpersisted before it) before any tool
// body runs. A crash then leaves a durable unmatched tool_use — exactly
// what repairOrphanedToolCalls answers with the UNKNOWN-outcome text.
//
//   ① driver      a rejected barrier fails CLOSED end-to-end: the tool body
//                 never runs, the model sees PERSIST_FAILED_TOOL_RESULT;
//   ② engine      mid-tool — the tool hanging, run busy — the assistant's
//                 tool_use row is ALREADY on disk; after settle, exactly
//                 once (identity dedup), tool result + final answer land;
//   ③ TUI         the same mid-tool durability contract through the full ink
//                 render (the App-level onBeforeToolDispatch wiring).
import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, ModelClient, ModelInput, Tool } from "@wudao-org/core";
import { PERSIST_FAILED_TOOL_RESULT } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { createDriverSession } from "../src/driver/session-engine.js";
import type { DriverSession } from "../src/driver/session-engine.js";
import { WudaoApp } from "../src/tui/app.js";
import { summarizeToolCall } from "../src/log.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

/** Tool-call then final-answer model (no hang — the barrier fires between). */
function toolThenAnswerModel(): ModelClient & { calls: number } {
  let calls = 0;
  return {
    get calls() { return calls; },
    async generate(_input: ModelInput): Promise<AgentMessage> {
      calls += 1;
      if (calls === 1) {
        return { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "todo_write", arguments: {} }] };
      }
      return { role: "assistant", content: "all done", stopReason: "end_turn" };
    },
  } as ModelClient & { calls: number };
}

/** A read-only probe whose body hangs on an external gate — the mid-tool
 *  crash-window stand-in. isReadOnly keeps it past the ask seam (sleep-tool
 *  precedent: READ_TOOLS auto-allow), so no frontend approval is needed. */
function gatedProbe(): { tool: Tool; releaseTool: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const tool: Tool = {
    name: "todo_write",
    description: "hangs until released (READ_TOOLS name — no ask seam)",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => true,
    async execute() {
      // Bounded hang: releaseTool normally settles it; the bound keeps a
      // RED (no barrier → never released) from wedging the worker.
      await Promise.race([gate, new Promise<void>((r) => setTimeout(r, 8000))]);
      return { content: "probe ran" };
    },
  };
  return { tool, releaseTool: () => open() };
}

const roots: string[] = [];
const sessions: DriverSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const sessionFile = (ws: string, sessionId: string): string => join(ws, ".wudao", "sessions", `${sessionId}.jsonl`);

const countToolUseLines = (path: string, toolCallId: string): number => {
  try {
    return readFileSync(path, "utf8").split("\n").filter((l) => {
      if (l.trim() === "") return false;
      try {
        const m = JSON.parse(l) as AgentMessage;
        return m.role === "assistant" && (m as { toolCalls?: { id?: string }[] }).toolCalls?.some((c) => c.id === toolCallId) === true;
      } catch { return false; }
    }).length;
  } catch { return 0; }
};

describe("波次8 #45 — pre-dispatch durability barrier (dsh session-checkpoint-policy)", () => {
  it("① driver: a rejected barrier fails closed end-to-end — no tool body, PERSIST_FAILED synthetic reaches history", async () => {
    let execs = 0;
    const probe: Tool = {
      name: "todo_write", description: "must not run",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      isReadOnly: () => true,
      async execute() { execs += 1; return { content: "side effect" }; },
    };
    const completed: AgentMessage[][] = [];
    const model = toolThenAnswerModel();
    const d: AgentDriver = createAgentDriver({
      systemPrompt: "s",
      summarize: summarizeToolCall,
      model,
      tools: [probe],
      // A bare driver has no permission layer — inject an allow-all gate so
      // the test exercises the barrier, not the ask seam.
      canUseTool: async () => ({ behavior: "allow" }),
      onBeforeToolDispatch: async () => { throw new Error("store down"); },
      onRunComplete: (ms) => completed.push([...ms]),
    });
    d.submit("do it");
    await until(() => completed.length === 1, "run settles");
    expect(execs).toBe(0);
    const toolMsg = completed[0]!.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect((toolMsg as { content?: string }).content).toBe(PERSIST_FAILED_TOOL_RESULT);
  });

  it("② session-engine: the tool_use row is on disk WHILE the tool hangs; after settle exactly once + the tool result lands", async () => {
    const ws = mkdtempSync(join(tmpdir(), "night45-engine-"));
    roots.push(ws);
    const sessionId = "wudao-night45-engine";
    const model = toolThenAnswerModel();
    const { tool, releaseTool } = gatedProbe();
    const session = await createDriverSession({
      config,
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: model,
      tools: [tool],
      sessionId,
    });
    sessions.push(session);
    session.driver.submit("run the probe");
    // MID-TOOL: the probe body is hanging (the crash window). The assistant's
    // tool_use record must ALREADY be durable — that is the whole feature.
    await until(() => countToolUseLines(sessionFile(ws, sessionId), "t1") === 1, "tool_use row on disk mid-tool");
    releaseTool();
    await until(() => session.driver.getStatus().busy === false, "run settles");
    await until(() => {
      try { return readFileSync(sessionFile(ws, sessionId), "utf8").includes("all done"); } catch { return false; }
    }, "final answer persisted");
    // Identity dedup: the tool_use row persisted at the barrier is NOT
    // re-appended by run-complete — exactly one line.
    expect(countToolUseLines(sessionFile(ws, sessionId), "t1")).toBe(1);
    // The tool result row landed after settle (run-complete tail).
    const disk = readFileSync(sessionFile(ws, sessionId), "utf8");
    expect(disk.includes("probe ran")).toBe(true);
  });

  it("③ TUI: the tool_use row is on disk mid-tool through the full ink render; exactly once after settle", async () => {
    const root = mkdtempSync(join(tmpdir(), "night45-tui-"));
    roots.push(root);
    const model = toolThenAnswerModel();
    const { tool, releaseTool } = gatedProbe();
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[tool]} />,
    );
    await wait();
    for (const ch of "run the probe\r") {
      inst.stdin.write(ch);
      await wait(15);
    }
    const sessDir = join(root, ".wudao", "sessions");
    const toolUseLines = (): number => {
      try {
        return readdirSync(sessDir).filter((f) => f.endsWith(".jsonl"))
          .reduce((n, f) => n + countToolUseLines(join(sessDir, f), "t1"), 0);
      } catch { return 0; }
    };
    // MID-TOOL: the probe body is hanging — the App-level barrier must have
    // already made the assistant's tool_use row durable.
    await until(() => toolUseLines() === 1, "tool_use row on disk mid-tool (TUI)");
    releaseTool();
    await until(() => (inst.lastFrame() ?? "").includes("all done"), "answer rendered");
    inst.unmount();
    await wait(50);
    // Identity dedup through the App's loadedRef: exactly one line survives.
    expect(toolUseLines()).toBe(1);
    // The tool result landed too (run-complete tail).
    const disk = readdirSync(sessDir).filter((f) => f.endsWith(".jsonl"))
      .map((f) => readFileSync(join(sessDir, f), "utf8")).join("\n");
    expect(disk.includes("probe ran")).toBe(true);
  });
});
