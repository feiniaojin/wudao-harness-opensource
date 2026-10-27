// Integration tests for the useAgent hook: scripted model + stub tools driven
// through a tiny probe component rendered by ink-testing-library (no
// @testing-library/react — the hook's output is stashed in a box the test reads).
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool, createScriptedModel, estimateTokens, toModelToolDefinition } from "@wudao/core";
import type { AgentMessage, AssistantMessage, ModelClient, ModelInput, Tool } from "@wudao/core";
import { summarizeToolCall } from "../src/log.js";
import { useAgent } from "../src/tui/use-agent.js";
import type { UseAgentOptions, UseAgentResult } from "../src/tui/use-agent.js";
import { stripProjectedNotes } from "./projected-notes.js";

// M53 §1: strip the branch-node metadata (uuid/parentUuid) — shape pins
// compare roles/contents, not the random node ids.
function stripBranch<T extends { uuid?: unknown; parentUuid?: unknown }>(m: T): T {
  const rest = { ...m } as Partial<T>;
  delete (rest as { uuid?: unknown }).uuid;
  delete (rest as { parentUuid?: unknown }).parentUuid;
  return rest as T;
}
const plainBranch = (ms: readonly unknown[]): unknown[] => ms.map((m) => stripBranch(m as { uuid?: unknown; parentUuid?: unknown }));


const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// 回滚重做 T2b：useAgent 的会话写入器与拆除 rm 的竞态（写入器在 rm 枚举
// 目录后又落了新文件 → ENOTEMPTY）在全量套件的暖机盒上连续两轮复现
// （solo 全绿）。Node 内建 rimraf 的 maxRetries 覆盖 ENOTEMPTY；外层再
// 兜一层显式回退，两处都治本于「迟到的写入」而非弱化断言。
async function rmRetry(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code !== "ENOTEMPTY" && code !== "EBUSY") || attempt >= 5) throw e;
      await wait(150);
    }
  }
}

// Poll until cond() holds; ALWAYS yields a macrotask before the first check so
// React 19 flushes the batched state updates from submit()/interrupt() first
// (busy starts as false — checking too early would pass trivially).
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

// The probe: renders the hook and stashes its API object in a box. Re-renders
// (triggered by the hook's own setState) refresh the stashed snapshot.
const apiBox: { current: UseAgentResult | null } = { current: null };

function Probe({ opts }: { opts: UseAgentOptions }): React.JSX.Element {
  const api = useAgent(opts);
  apiBox.current = api;
  return <Text>{api.busy ? "busy" : "idle"} | {api.history.length} entries</Text>;
}

function mount(opts: UseAgentOptions): { unmount: () => void } {
  apiBox.current = null;
  const inst = render(React.createElement(Probe, { opts }));
  return { unmount: () => inst.unmount() };
}

const readOnlyParams = {
  type: "object" as const,
  properties: { path: { type: "string" as const } },
  required: ["path"],
  additionalProperties: false,
};

function stubReadTool(content = "STUB FILE CONTENT"): Tool {
  return buildTool({
    name: "read_file",
    description: "stub read",
    parameters: readOnlyParams,
    execute: async () => ({ content }),
  });
}

// A tool whose execution parks on an externally-resolved promise, so a test can
// hold the loop mid-tool-phase (unmount / queue / interrupt scenarios).
function gatedTool<T>(gate: Promise<T>): Tool {
  return buildTool({
    name: "read_file",
    description: "gated read",
    parameters: readOnlyParams,
    execute: async () => { await gate; return { content: "GATED RESULT" }; },
  });
}

// Stub write_file: same shape the real tool exposes (the loop dispatches by
// name, so only name+parameters matter for the history-mapping under test).
function stubWriteTool(): Tool {
  return buildTool({
    name: "write_file",
    description: "stub write",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    execute: async () => ({ content: "wrote" }),
  });
}

const allow = vi.fn(async () => ({ kind: "allow" as const }));

describe("useAgent", () => {
  it("maps a full run to history: user → tool (with result preview) → assistant", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
      { role: "assistant", content: "ALL DONE" },
    ]);
    const { unmount } = mount({
      model,
      tools: [stubReadTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
    });
    await wait();

    apiBox.current?.submit("hi");
    await until(() => apiBox.current?.busy === false, "run to finish");

    const history = apiBox.current?.history ?? [];
    expect(history[0]).toEqual({ kind: "user", text: "hi" });
    expect(history[1]).toMatchObject({
      kind: "tool",
      name: "read_file",
      summary: "a.txt",
      isError: false,
      resultPreview: "STUB FILE CONTENT",
    });
    expect(history[2]).toEqual({ kind: "assistant", text: "ALL DONE" });

    // live state resets once the run settles
    expect(apiBox.current?.live).toEqual({ reasoning: "", answer: "", busyTools: [] });
    // the permission ask was wired with the tool name + summarized input
    // M45: onPermissionAsk gained the optional ctx (sidecar reason) param.
    expect(allow).toHaveBeenCalledWith("read_file", "a.txt", { path: "a.txt" }, undefined);
    unmount();
  });

  it("tool entry enters history only at completion (Ink <Static> renders once)", async () => {
    // Ink 7's <Static> never re-renders flushed items, so a tool entry pushed
    // at tool_call_started could never gain its resultPreview afterwards in a
    // real terminal. The history entry must be pushed at tool_call_finished,
    // with the preview already set; the in-flight phase is live.busyTools.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const slowTool = buildTool({
      name: "read_file",
      description: "slow read",
      parameters: readOnlyParams,
      execute: async () => { await gate; return { content: "SLOW RESULT" }; },
    });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "slow.txt" } }] },
      { role: "assistant", content: "AFTER TOOL" },
    ]);
    const { unmount } = mount({
      model,
      tools: [slowTool],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
    });
    await wait();

    apiBox.current?.submit("go");
    await until(() => (apiBox.current?.live.busyTools.length ?? 0) === 1, "tool phase");
    // In flight: covered by live.busyTools, NOT by a (mutation-doomed) history entry.
    expect(apiBox.current?.history).toEqual([{ kind: "user", text: "go" }]);

    release?.();
    await until(() => apiBox.current?.busy === false, "run to finish");

    const history = apiBox.current?.history ?? [];
    expect(history).toHaveLength(4);
    expect(history[0]).toEqual({ kind: "user", text: "go" });
    expect(history[1]).toMatchObject({
      kind: "tool",
      name: "read_file",
      summary: "slow.txt",
      isError: false,
      resultPreview: "SLOW RESULT",
    });
    expect(history[2]).toEqual({ kind: "assistant", text: "AFTER TOOL" });
    // 0.3.15: every settled run closes with the 耗时 receipt notice.
    expect(history[3]).toEqual({ kind: "notice", text: expect.stringMatching(/^耗时 /) });
    unmount();
  });

  it("interrupt() during the tool phase emits a notice and settles busy=false", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const slowTool = buildTool({
      name: "read_file",
      description: "slow read",
      parameters: readOnlyParams,
      execute: async () => { await gate; return { content: "late" }; },
    });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "slow.txt" } }] },
      { role: "assistant", content: "NEVER SEEN" },
    ]);
    const { unmount } = mount({
      model,
      tools: [slowTool],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
    });
    await wait();

    apiBox.current?.submit("go");
    await until(() => (apiBox.current?.live.busyTools.length ?? 0) === 1, "tool phase");
    expect(apiBox.current?.live.busyTools[0]).toEqual({ name: "read_file", summary: "slow.txt", callId: "c1" });
    expect(apiBox.current?.busy).toBe(true);

    apiBox.current?.interrupt();
    release?.();
    await until(() => apiBox.current?.busy === false, "interrupt to settle");

    const history = apiBox.current?.history ?? [];
    expect(history.some((e) => e.kind === "notice" && e.text.includes("已中断"))).toBe(true); // ω99-166c-ii: 裸串钉演进 interrupted→已中断。
    expect(history.some((e) => e.kind === "assistant" && e.text === "NEVER SEEN")).toBe(false);
    expect(apiBox.current?.live.busyTools).toEqual([]);
    unmount();
  });

  it("next run after a tool-phase abort is provider-legal (orphaned toolCalls repaired)", async () => {
    const gate = new Promise<void>(() => { /* never resolves; abort races it */ });
    const slowTool = buildTool({
      name: "read_file",
      description: "slow read",
      parameters: readOnlyParams,
      execute: async () => { await gate; return { content: "late" }; },
    });
    const scripted = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "slow.txt" } }] },
      { role: "assistant", content: "SECOND ANSWER" },
    ]);
    const inputs: AgentMessage[][] = [];
    const model: ModelClient = {
      generate: async (input) => { inputs.push([...input.messages]); return scripted.generate(input); },
    };
    const { unmount } = mount({
      model,
      tools: [slowTool],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
    });
    await wait();

    apiBox.current?.submit("go");
    await until(() => (apiBox.current?.live.busyTools.length ?? 0) === 1, "tool phase");
    apiBox.current?.interrupt();
    await until(() => apiBox.current?.busy === false, "interrupt to settle");

    apiBox.current?.submit("again");
    await until(() => (apiBox.current?.history ?? []).some((e) => e.kind === "assistant" && e.text === "SECOND ANSWER"), "second run answer");

    // The second ModelInput must contain a tool result for the orphaned c1.
    const second = inputs[1] ?? [];
    expect(second.some((m) => m.role === "tool" && m.toolCallId === "c1")).toBe(true);
    unmount();
  });

  it("unmount while a run is in flight: no unhandled rejection, later setstates are ignored", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "slow.txt" } }] },
      { role: "assistant", content: "AFTER UNMOUNT" },
    ]);
    const { unmount } = mount({
      model,
      tools: [gatedTool(gate)],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
    });
    await wait();

    apiBox.current?.submit("go");
    await until(() => (apiBox.current?.live.busyTools.length ?? 0) === 1, "tool phase");

    unmount();
    release?.();
    await wait(50);
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);

    // A fresh mount still works after the dead one (the hook didn't wedge).
    const fresh = createScriptedModel([{ role: "assistant", content: "FRESH-OK" }]);
    const second = mount({
      model: fresh,
      tools: [],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
    });
    await wait();
    apiBox.current?.submit("again");
    await until(() => apiBox.current?.busy === false, "fresh run to finish");
    expect(apiBox.current?.history.at(-2)).toEqual({ kind: "assistant", text: "FRESH-OK" });
    second.unmount();
  });

  it("submit while busy steers INTO the current run: injected before the next model call, no second run", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const scripted = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "slow.txt" } }] },
      { role: "assistant", content: "A-ANSWER" },
      { role: "assistant", content: "NEVER-A-THIRD-CALL" },
    ]);
    const inputs: AgentMessage[][] = [];
    const model: ModelClient = {
      generate: async (input) => { inputs.push([...input.messages]); return scripted.generate(input); },
    };
    const { unmount } = mount({
      model,
      tools: [gatedTool(gate)],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
    });
    await wait();

    apiBox.current?.submit("a");
    await until(() => (apiBox.current?.live.busyTools.length ?? 0) === 1, "tool phase");
    apiBox.current?.submit("b");
    await wait(); // let the setQueued render flush into the apiBox snapshot

    // Parked in the steering queue, surfaced in the hook snapshot, NOT yet a
    // history user entry (it is injected mid-run, not started as a new run).
    expect(apiBox.current?.queued).toEqual(["b"]);
    expect(apiBox.current?.history.some((e) => e.kind === "user" && e.text === "b")).toBe(false);

    release?.();
    await until(() => apiBox.current?.busy === false, "steered run to finish");

    // The steer landed in the CURRENT run: the second model call saw "b" as a
    // trailing user message, the run finished on A-ANSWER, and no third model
    // call ever happened (the third scripted answer was never consumed).
    expect(inputs.length).toBe(2);
    expect(inputs[1]?.at(-1)).toEqual({ role: "user", content: "b" });
    const history = apiBox.current?.history ?? [];
    expect(history.map((e) => e.kind === "user" || e.kind === "assistant" ? `${e.kind}:${e.text}` : e.kind)).toEqual([
      "user:a",
      "tool", // run a's gated read_file
      "notice", // ↳ steering applied
      "assistant:A-ANSWER",
      "notice", // 耗时 run receipt (0.3.15)
    ]);
    expect(history.some((e) => e.kind === "notice" && e.text.includes("steering applied"))).toBe(true);
    expect(history.some((e) => e.kind === "assistant" && e.text === "NEVER-A-THIRD-CALL")).toBe(false);
    expect(apiBox.current?.queued).toEqual([]);
    unmount();
  });

  it("a steer submitted during the FINAL model call falls back to a fresh run", async () => {
    // The steer lands while the run's last generation is already in flight —
    // after the pre-call drain — so the queue survives run end and the M14
    // auto-start seam submits it as a new run.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const model: ModelClient = {
      generate: async (input) => {
        calls += 1;
        if (calls === 1) {
          return { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "x" } }] };
        }
        if (calls === 2) await gate; // the final generation, held mid-call
        return { role: "assistant", content: calls === 2 ? "A-DONE" : "B-DONE" };
      },
    };
    const { unmount } = mount({
      model,
      tools: [stubReadTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
    });
    await wait();

    apiBox.current?.submit("a");
    await until(() => calls === 2, "final model call in flight");
    apiBox.current?.submit("b");
    await wait();
    expect(apiBox.current?.queued).toEqual(["b"]);

    release?.();
    await until(() => apiBox.current?.busy === false, "fallback run to finish");

    const history = apiBox.current?.history ?? [];
    expect(history.some((e) => e.kind === "assistant" && e.text === "A-DONE")).toBe(true);
    // Fallback: "b" started as its own run (user entry at start time).
    expect(history.some((e) => e.kind === "user" && e.text === "b")).toBe(true);
    expect(history.at(-2)).toEqual({ kind: "assistant", text: "B-DONE" });
    expect(apiBox.current?.queued).toEqual([]);
    unmount();
  });

  it("interrupt ends only the current run; the queued follow-up still runs", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "slow.txt" } }] },
      { role: "assistant", content: "B-ANSWER" },
    ]);
    const { unmount } = mount({
      model,
      tools: [gatedTool(gate)],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
    });
    await wait();

    apiBox.current?.submit("a");
    await until(() => (apiBox.current?.live.busyTools.length ?? 0) === 1, "tool phase");
    apiBox.current?.submit("b");
    await wait(); // let the setQueued render flush into the apiBox snapshot
    expect(apiBox.current?.queued).toEqual(["b"]);

    apiBox.current?.interrupt();
    release?.();
    await until(() => apiBox.current?.busy === false, "queued run to finish");

    const history = apiBox.current?.history ?? [];
    expect(history.some((e) => e.kind === "notice" && e.text.includes("已中断"))).toBe(true); // ω99-166c-ii: 裸串钉演进 interrupted→已中断。
    expect(history.some((e) => e.kind === "user" && e.text === "b")).toBe(true);
    expect(history.at(-2)).toEqual({ kind: "assistant", text: "B-ANSWER" });
    unmount();
  });

  it("clear() drops queued follow-ups", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "slow.txt" } }] },
      { role: "assistant", content: "SHOULD NOT RUN" },
    ]);
    const { unmount } = mount({
      model,
      tools: [gatedTool(gate)],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
    });
    await wait();

    apiBox.current?.submit("a");
    await until(() => (apiBox.current?.live.busyTools.length ?? 0) === 1, "tool phase");
    apiBox.current?.submit("b");
    await wait(); // let the setQueued render flush into the apiBox snapshot
    expect(apiBox.current?.queued).toEqual(["b"]);

    // Esc ends the current run; clear() drops the queued follow-up before it
    // ever auto-starts, so the second scripted answer is never consumed.
    apiBox.current?.interrupt();
    apiBox.current?.clear();
    await wait(); // let the setQueued([]) render flush into the snapshot
    expect(apiBox.current?.queued).toEqual([]);
    release?.();
    await until(() => apiBox.current?.busy === false, "interrupted run to settle");

    const history = apiBox.current?.history ?? [];
    expect(history.some((e) => e.kind === "user" && e.text === "b")).toBe(false);
    expect(history.some((e) => e.kind === "assistant" && e.text === "SHOULD NOT RUN")).toBe(false);
    unmount();
  });

  it("a throwing loop is isolated: error entry + synthetic (error: …) assistant on state", async () => {
    const seen: AgentMessage[][] = [];
    const model: ModelClient = {
      async generate(input: ModelInput): Promise<AssistantMessage> {
        seen.push([...input.messages]);
        if (seen.length === 1) throw new Error("boom-api");
        return { role: "assistant", content: "recovered" };
      },
    };
    const { unmount } = mount({
      model,
      tools: [],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
    });
    await wait();

    apiBox.current?.submit("go");
    await until(() => apiBox.current?.busy === false, "failed run to settle");
    expect(apiBox.current?.history.some((e) => e.kind === "error" && e.text.includes("boom-api"))).toBe(true);

    // M12 rule: the failed turn appended a synthetic assistant message so the
    // next submit does not produce two consecutive user messages.
    apiBox.current?.submit("more");
    await until(() => apiBox.current?.busy === false, "second run to settle");
    const second = stripProjectedNotes(seen[1] ?? []);
    expect(stripBranch(second.at(-1) as { role: string })).toEqual({ role: "user", content: "more" });
    expect(second.at(-2)).toEqual({ role: "assistant", content: "(error: boom-api)" });
    expect(apiBox.current?.history.at(-2)).toEqual({ kind: "assistant", text: "recovered" });
    unmount();
  });

  it("edit tool_call_started pushes an edit entry (path/old/new), not a tool entry", async () => {
    const editTool = buildTool({
      name: "edit",
      description: "stub edit",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
        additionalProperties: false,
      },
      execute: async () => ({ content: "ok" }),
    });
    const model = createScriptedModel([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "edit", arguments: { path: "a.ts", old_string: "x", new_string: "y" } }],
      },
      { role: "assistant", content: "edited" },
    ]);
    const { unmount } = mount({
      model,
      tools: [editTool],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
      // This test pins history mapping, not the M23 verify gate (which would
      // demand a shell after the successful edit before finishing).
      gates: { verify: false },
    });
    await wait();

    apiBox.current?.submit("fix it");
    await until(() => apiBox.current?.busy === false, "edit run to finish");

    const history = apiBox.current?.history ?? [];
    expect(history).toContainEqual({ kind: "edit", path: "a.ts", oldString: "x", newString: "y" });
    expect(history.some((e) => e.kind === "tool" && e.name === "edit")).toBe(false);
    expect(history.at(-2)).toEqual({ kind: "assistant", text: "edited" });
    unmount();
  });

  it("write_file over an existing file renders an edit entry diffed against disk content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-tui-diff-"));
    try {
      const target = join(dir, "f.txt");
      await writeFile(target, "old", "utf8");
      const model = createScriptedModel([
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "write_file", arguments: { path: target, content: "new" } }],
        },
        { role: "assistant", content: "wrote it" },
      ]);
      const { unmount } = mount({
        model,
        tools: [stubWriteTool()],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        onPermissionAsk: allow,
        workspaceRoot: dir,
        gates: { verify: false }, // pins diff rendering, not the M23 verify gate
      });
      await wait();

      apiBox.current?.submit("write");
      await until(() => apiBox.current?.busy === false, "write run to finish");

      const history = apiBox.current?.history ?? [];
      expect(history).toContainEqual({ kind: "edit", path: target, oldString: "old", newString: "new" });
      // Diffed shape replaces the plain tool entry (same contract as edit).
      expect(history.some((e) => e.kind === "tool" && e.name === "write_file")).toBe(false);
      expect(history.at(-2)).toEqual({ kind: "assistant", text: "wrote it" });
      unmount();
    } finally {
      await rmRetry(dir);
    }
  });

  it("write_file to a non-existing path keeps the plain tool entry (new-file preview)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-tui-new-"));
    try {
      const target = join(dir, "does-not-exist.txt");
      const model = createScriptedModel([
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "write_file", arguments: { path: target, content: "new" } }],
        },
        { role: "assistant", content: "created" },
      ]);
      const { unmount } = mount({
        model,
        tools: [stubWriteTool()],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        onPermissionAsk: allow,
        workspaceRoot: dir,
        gates: { verify: false }, // pins preview rendering, not the M23 verify gate
      });
      await wait();

      apiBox.current?.submit("write");
      await until(() => apiBox.current?.busy === false, "write run to finish");

      const history = apiBox.current?.history ?? [];
      expect(history.some((e) => e.kind === "edit")).toBe(false);
      expect(history[1]).toMatchObject({
        kind: "tool",
        name: "write_file",
        summary: target,
        isError: false,
        resultPreview: "wrote",
      });
      expect(history.at(-2)).toEqual({ kind: "assistant", text: "created" });
      unmount();
    } finally {
      await rmRetry(dir);
    }
  });

  it("write_file over existing file: diff entry shown, error surfaced when write fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-tui-diff-error-"));
    try {
      const target = join(dir, "f.txt");
      await writeFile(target, "old content", "utf8");
      // Stub write_file that simulates a failure (e.g., permission denied)
      const failingWriteTool = buildTool({
        name: "write_file",
        description: "stub write that fails",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
          additionalProperties: false,
        },
        execute: async () => ({ content: "permission denied", isError: true }),
      });
      const model = createScriptedModel([
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "write_file", arguments: { path: target, content: "new content" } }],
        },
        { role: "assistant", content: "tried to write" },
      ]);
      const { unmount } = mount({
        model,
        tools: [failingWriteTool],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        onPermissionAsk: allow,
        workspaceRoot: dir,
      });
      await wait();

      apiBox.current?.submit("write");
      await until(() => apiBox.current?.busy === false, "write run to finish");

      const history = apiBox.current?.history ?? [];
      // Must show the diff entry (old → new)
      expect(history).toContainEqual({ kind: "edit", path: target, oldString: "old content", newString: "new content" });
      // Must also show an error entry for the failure
      expect(history.some((e) =>
        e.kind === "error" && e.text.includes("write_file") && e.text.includes("permission denied")
      )).toBe(true);
      unmount();
    } finally {
      await rmRetry(dir);
    }
  });

  it("clear() empties history and the persistent message list", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "quick" }]);
    const { unmount } = mount({
      model,
      tools: [],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
    });
    await wait();

    apiBox.current?.submit("hi");
    await until(() => apiBox.current?.busy === false, "run to finish");
    expect((apiBox.current?.history.length ?? 0)).toBeGreaterThan(0);

    apiBox.current?.clear();
    await wait();
    expect(apiBox.current?.history).toEqual([]);

    // state.messages was cleared too: the next run's model input starts fresh.
    const inputs: AgentMessage[][] = [];
    const before = model.generate;
    model.generate = async (input) => { inputs.push([...input.messages]); return before(input); };
    apiBox.current?.submit("fresh");
    await until(() => apiBox.current?.busy === false, "post-clear run to finish");
    expect(plainBranch(stripProjectedNotes(inputs[0] as readonly AgentMessage[]) as readonly unknown[])).toEqual([{ role: "user", content: "fresh" }]);
    unmount();
  });

  it("interrupt() aborts a hung model call via the run's AbortSignal and settles without a release", async () => {
    const seen: AgentMessage[][] = [];
    let calls = 0;
    const model: ModelClient = {
      generate(input: ModelInput): Promise<AssistantMessage> {
        if (calls++ > 0) {
          seen.push([...input.messages]);
          return Promise.resolve({ role: "assistant", content: "NEXT-OK" });
        }
        // First call hangs forever; rejects ONLY on the loop-forwarded signal.
        return new Promise((_resolve, reject) => {
          input.signal?.addEventListener(
            "abort",
            () => {
              reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
            },
            { once: true },
          );
        });
      },
    };
    const { unmount } = mount({
      model,
      tools: [],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
    });
    await wait();

    apiBox.current?.submit("hang");
    await until(() => apiBox.current?.busy === true, "hung run to start");
    apiBox.current?.interrupt();
    // No external release: the AbortSignal alone must settle the hung call.
    await until(() => apiBox.current?.busy === false, "abort to settle the hung model call");

    const history = apiBox.current?.history ?? [];
    expect(history.some((e) => e.kind === "notice" && e.text.includes("已中断"))).toBe(true); // ω99-166c-ii: 裸串钉演进 interrupted→已中断。
    expect(history.some((e) => e.kind === "error")).toBe(false);
    // No partial assistant answer was rendered (loop guarantee: aborted model
    // call → no assistant message appended for that turn).
    expect(history.some((e) => e.kind === "assistant")).toBe(false);

    // Session consistency: the aborted run left exactly one synthetic
    // "(interrupted)" assistant after the user message, so the next run's
    // model input alternates user/assistant (M12/M14 rule).
    apiBox.current?.submit("next");
    await until(() => apiBox.current?.busy === false, "follow-up run to finish");
    const second = stripProjectedNotes(seen[0] ?? []);
    expect(plainBranch(second)).toEqual([
      { role: "user", content: "hang" },
      { role: "assistant", content: "(interrupted)" },
      { role: "user", content: "next" },
    ]);
    expect(apiBox.current?.history.at(-2)).toEqual({ kind: "assistant", text: "NEXT-OK" });
    unmount();
  });

  it("interrupt during a hung tool aborts the tool race; the queued follow-up still auto-runs", async () => {
    // The gate NEVER settles: only the loop's abort race can end the run.
    const gate = new Promise<void>(() => {});
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "slow.txt" } }] },
      { role: "assistant", content: "B-ANSWER" },
    ]);
    const { unmount } = mount({
      model,
      tools: [gatedTool(gate)],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
    });
    await wait();

    apiBox.current?.submit("a");
    await until(() => (apiBox.current?.live.busyTools.length ?? 0) === 1, "tool phase");
    apiBox.current?.submit("b");
    await wait(); // let the setQueued render flush into the apiBox snapshot
    expect(apiBox.current?.queued).toEqual(["b"]);

    apiBox.current?.interrupt();
    await until(() => apiBox.current?.busy === false, "queued follow-up to finish");

    const history = apiBox.current?.history ?? [];
    expect(history.some((e) => e.kind === "notice" && e.text.includes("已中断"))).toBe(true); // ω99-166c-ii: 裸串钉演进 interrupted→已中断。
    // #41 (4991397) 契约反转（f1817e1 补漏的 useAgent 平行钉）：中断不再
    // 无痕——永不结算的 in-flight 工具以 isError 工具卡配对落账
    // （[已中断] preview），不再是"history 无 tool 条目"。
    expect(history.some((e) => e.kind === "tool" && e.isError === true && e.name === "read_file")).toBe(true);
    expect(history.some((e) => e.kind === "user" && e.text === "b")).toBe(true);
    expect(history.at(-2)).toEqual({ kind: "assistant", text: "B-ANSWER" });
    unmount();
  });

  it("canUseTool allow decision short-circuits; onPermissionAsk never called", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "auto.txt" } }] },
      { role: "assistant", content: "done" },
    ]);
    const askSpy = vi.fn(async () => ({ kind: "deny" as const }));
    const { unmount } = mount({
      model,
      tools: [stubReadTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: askSpy,
      canUseTool: async () => ({ behavior: "allow" as const }),
    });
    await wait();

    apiBox.current?.submit("go");
    await until(() => apiBox.current?.busy === false, "run to finish");

    // Tool should execute (allow decision short-circuited)
    const history = apiBox.current?.history ?? [];
    expect(history[1]).toMatchObject({
      kind: "tool",
      name: "read_file",
      summary: "auto.txt",
      isError: false,
    });
    expect(history[2]).toEqual({ kind: "assistant", text: "done" });

    // onPermissionAsk was NEVER called (allow short-circuited)
    expect(askSpy).not.toHaveBeenCalled();
    unmount();
  });
});

// ---------------------------------------------------------------------------
// M23: long-task board rendering + gate notices
// ---------------------------------------------------------------------------

const BOARD_2_3 = "[todo board 2/3 done]\n☑ read the spec\n☑ write the code\n◐ verify it";

function stubTodoTool(content = BOARD_2_3): Tool {
  return buildTool({
    name: "todo_write",
    description: "stub board",
    parameters: {
      type: "object",
      properties: { todos: { type: "array" } },
      required: ["todos"],
      additionalProperties: false,
    },
    execute: async () => ({ content }),
  });
}

describe("useAgent — todo board (M23)", () => {
  it("renders a board tool result as a board entry (marks + counts), not a plain tool entry", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "todo_write", arguments: { todos: [] } }] },
      { role: "assistant", content: "planned" },
    ]);
    const { unmount } = mount({
      model,
      tools: [stubTodoTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
      gates: { verify: false },
    });
    await wait();

    apiBox.current?.submit("plan it");
    await until(() => apiBox.current?.busy === false, "board run to finish");

    const history = apiBox.current?.history ?? [];
    expect(history.some((e) => e.kind === "tool" && e.name === "todo_write")).toBe(false);
    expect(history).toContainEqual({
      kind: "board",
      done: 2,
      total: 3,
      lines: ["☑ read the spec", "☑ write the code", "◐ verify it"],
    });
    unmount();
  });

  it("tracks live board progress (▣ N/M source) while busy", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const parkedRead = buildTool({
      name: "read_file",
      description: "parked",
      parameters: readOnlyParams,
      execute: async () => { await gate; return { content: "late" }; },
    });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "todo_write", arguments: { todos: [] } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "read_file", arguments: { path: "x" } }] },
    ]);
    const { unmount } = mount({
      model,
      tools: [stubTodoTool(), parkedRead],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
    });
    await wait();

    apiBox.current?.submit("work");
    await until(() => apiBox.current?.boardProgress?.done === 2, "board progress to update");
    expect(apiBox.current?.busy).toBe(true);
    expect(apiBox.current?.boardProgress).toEqual({ done: 2, total: 3 });
    release?.();
    await until(() => apiBox.current?.busy === false, "run to finish");
    unmount();
  });

  it("surfaces a gate injection as a notice entry (no Markdown pass)", async () => {
    // write → answer (verify gate fires) → shell → answer (clean stop)
    const writeStub = stubWriteTool();
    const runStub = buildTool({
      name: "shell",
      description: "stub run",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
      execute: async () => ({ content: "[exit 0]" }),
    });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "a.txt", content: "x" } }] },
      { role: "assistant", content: "premature answer" },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "shell", arguments: { command: "ls" } }] },
      { role: "assistant", content: "verified answer" },
    ]);
    const { unmount } = mount({
      model,
      tools: [writeStub, runStub],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
    });
    await wait();

    apiBox.current?.submit("write and verify");
    await until(() => apiBox.current?.busy === false, "gated run to finish");

    const history = apiBox.current?.history ?? [];
    const notice = history.find((e) => e.kind === "notice" && e.text.startsWith("[system note:"));
    expect(notice).toBeDefined();
    expect(notice?.kind === "notice" && notice.text).toContain("code changes were made but nothing was run");
    expect(history.at(-2)).toEqual({ kind: "assistant", text: "verified answer" });
    unmount();
  });
});

// ---------------------------------------------------------------------------
// M25 §A1: resumed sessions open on the projected history index
// ---------------------------------------------------------------------------

describe("useAgent — resume (M25)", () => {
  it("initial history = resumeEntries(initialMessages, sessionId); runs append after it", async () => {
    const initialMessages: AgentMessage[] = [
      { role: "user", content: "earlier prompt" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a" } }] },
      { role: "tool", toolCallId: "c1", name: "read_file", content: "earlier result" },
      { role: "assistant", content: "earlier answer" },
    ];
    const model = createScriptedModel([{ role: "assistant", content: "new answer" }]);
    const { unmount } = mount({
      model,
      tools: [stubReadTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
      initialMessages,
      sessionId: "wudao-mfoobar-abcdef12",
    });
    await wait();

    // Before any submit: the divider + folded index of the loaded history.
    expect(apiBox.current?.history).toEqual([
      { kind: "divider", text: "已恢复 wudao-mf · 4 条消息" }, // ω99-172: 钉随源演进（漏判钉——brief §二未列，全量红集定位）
      { kind: "user", text: "earlier prompt" },
      { kind: "tool", name: "read_file", summary: "1 个工具：read_file", resultPreview: "earlier result" }, // ω99-176: 钉随源演进（resume summary 宿主钉——brief §五.3 预案）
      { kind: "assistant", text: "earlier answer" },
    ]);

    // The model-side seeding is unchanged: the new run's input carries the
    // resumed messages ahead of the fresh prompt.
    const inputs: AgentMessage[][] = [];
    const before = model.generate;
    model.generate = async (input) => { inputs.push([...input.messages]); return before(input); };
    apiBox.current?.submit("continue");
    await until(() => apiBox.current?.busy === false, "resumed run to finish");

    expect(stripProjectedNotes(inputs[0] ?? []).slice(0, 4)).toEqual(initialMessages);
    expect(apiBox.current?.history.at(-3)).toEqual({ kind: "user", text: "continue" });
    expect(apiBox.current?.history.at(-2)).toEqual({ kind: "assistant", text: "new answer" });
    unmount();
  });

  it("without initialMessages the history starts empty (fresh session, no divider)", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "ok" }]);
    const { unmount } = mount({
      model,
      tools: [],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
      sessionId: "wudao-mfoobar-abcdef12",
    });
    await wait();
    expect(apiBox.current?.history).toEqual([]);
    unmount();
  });

  it("compacted event renders the M25 transparency notice (magnitudes · tier · trigger)", async () => {
    // Seed 8 messages with a huge OLD tool result at index 2, then submit: at
    // the pre-call check occupancy (~10k tokens) ≥ threshold+8k with a tiny
    // window → immediate compaction. M34: a 40k-char result is tier-0 fodder —
    // the free clear fits it back under the threshold, so the notice reads
    // "clear" (tier 0), not micro-compact. One `compacted` event.
    const big = "R".repeat(40_000);
    const initialMessages: AgentMessage[] = [
      { role: "user", content: "seed" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "big.txt" } }] },
      { role: "tool", toolCallId: "c1", name: "read_file", content: big },
      { role: "assistant", content: "ok1" },
      { role: "user", content: "more" },
      { role: "assistant", content: "ok2" },
      { role: "user", content: "again" },
      { role: "assistant", content: "ok3" },
    ];
    const model = createScriptedModel([{ role: "assistant", content: "done" }]);
    const { unmount } = mount({
      model,
      tools: [stubReadTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
      initialMessages,
      compaction: { contextWindowTokens: 1000 },
    });
    await wait();

    apiBox.current?.submit("continue");
    await until(() => apiBox.current?.busy === false, "compacting run to finish");

    const history = apiBox.current?.history ?? [];
    const notices = history.filter((e) => e.kind === "notice" && e.text.startsWith("♻️"));
    expect(notices).toHaveLength(1);
    const text = notices[0]?.kind === "notice" ? notices[0].text : "";
    // Composed shape (exact composition pinned in log.test.ts): magnitudes
    // shrank, tier word clear (M34 tier 0), trigger word overflow (immediate).
    expect(text).toMatch(/^♻️ 上下文已压缩 [\d.]+k → [\d.]+k · 清理 · 溢出（继续中…）$/); // ω99-192: 钉随源演进
    const m = /^♻️ 上下文已压缩 ([\d.]+)k → ([\d.]+)k/.exec(text); // ω99-192: 钉随源演进
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThan(Number(m?.[2]));
    expect(history.at(-2)).toEqual({ kind: "assistant", text: "done" });
    unmount();
  });
});

// ---------------------------------------------------------------------------
// M25 §A5: context watermark — used = max(estimate, last usage.promptTokens),
// window = compaction?.contextWindowTokens ?? 64000, nearLimit ≥ 0.8×window
// ---------------------------------------------------------------------------

// A model that reports a fixed prompt-token usage through the loop's
// onUsage channel (the provider's only usage path).
function usageModel(promptTokens: number, content = "ok"): ModelClient {
  return {
    generate: async (input: ModelInput): Promise<AssistantMessage> => {
      input.onUsage?.({ promptTokens, cacheHitTokens: 0, cacheMissTokens: promptTokens });
      return { role: "assistant", content };
    },
  };
}

describe("useAgent — ctxTokens watermark (M25)", () => {
  it("estimate-only (no usage events): used = estimateTokens(system, tools, messages), window from opts", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "ok" }]);
    const tools = [stubReadTool()];
    const { unmount } = mount({
      model,
      tools,
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
      compaction: { contextWindowTokens: 12_000 },
    });
    await wait();
    // null before the first model call.
    expect(apiBox.current?.ctxTokens).toBeNull();

    apiBox.current?.submit("hello");
    await until(() => apiBox.current?.busy === false, "run to finish");

    // Last update sits at model_call_finished: messages = [user, assistant].
    const expected = estimateTokens("s", tools.map(toModelToolDefinition), [
      { role: "user", content: "hello" },
      { role: "assistant", content: "ok" },
    ]);
    expect(apiBox.current?.ctxTokens).toEqual({ used: expected, window: 12_000, nearLimit: false });
    unmount();
  });

  it("real usage beats the estimate (used = usage.promptTokens)", async () => {
    const { unmount } = mount({
      model: usageModel(9_999),
      tools: [],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
    });
    await wait();
    apiBox.current?.submit("hi");
    await until(() => apiBox.current?.busy === false, "run to finish");
    // 9999 dwarfs the tiny estimate; default window (no compaction opt).
    expect(apiBox.current?.ctxTokens).toEqual({ used: 9_999, window: 64_000, nearLimit: false });
    unmount();
  });

  it("nearLimit at exactly 0.8×window, clear below it", async () => {
    const at = mount({
      model: usageModel(51_200), // 0.8 × 64000
      tools: [],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
    });
    await wait();
    apiBox.current?.submit("hi");
    await until(() => apiBox.current?.busy === false, "boundary run to finish");
    expect(apiBox.current?.ctxTokens).toEqual({ used: 51_200, window: 64_000, nearLimit: true });
    at.unmount();

    const below = mount({
      model: usageModel(51_199),
      tools: [],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
    });
    await wait();
    apiBox.current?.submit("hi");
    await until(() => apiBox.current?.busy === false, "below-boundary run to finish");
    expect(apiBox.current?.ctxTokens).toEqual({ used: 51_199, window: 64_000, nearLimit: false });
    below.unmount();
  });

  it("clear() resets the watermark (fresh session starts unmeasured)", async () => {
    const { unmount } = mount({
      model: usageModel(60_000),
      tools: [],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
    });
    await wait();
    apiBox.current?.submit("hi");
    await until(() => apiBox.current?.busy === false, "run to finish");
    expect(apiBox.current?.ctxTokens?.nearLimit).toBe(true);

    apiBox.current?.clear();
    await wait();
    expect(apiBox.current?.ctxTokens).toBeNull();
    unmount();
  });

// ---------------------------------------------------------------------------
// M33 §3: loadHistory — the /resume picker's load seam.
// ---------------------------------------------------------------------------

describe("useAgent loadHistory (M33 /resume)", () => {
  it("swaps the conversation: rendered history is the resumed index, and the next run builds on the loaded messages", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "ON-LOADED" }]);
    const completed: AgentMessage[][] = [];
    const { unmount } = mount({
      model,
      tools: [],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: allow,
      onRunComplete: (messages) => completed.push([...messages]),
    });
    await wait();

    // A first turn creates some throwaway history.
    apiBox.current?.submit("throwaway");
    await until(() => apiBox.current?.busy === false, "first run to finish");

    // The picker's load: 2-message resumed history under session id zzz.
    const loaded: AgentMessage[] = [
      { role: "user", content: "Fix the login bug" },
      { role: "assistant", content: "fixed it" },
    ];
    apiBox.current?.loadHistory(loaded, "zzz11111");
    await until(() => (apiBox.current?.history[0]?.kind === "divider"), "resumed divider to render");
    const history = apiBox.current?.history ?? [];
    expect(history[0]).toMatchObject({ kind: "divider", text: "已恢复 zzz11111 · 2 条消息" }); // ω99-172: 钉随源演进（漏判钉——brief §二未列，全量红集定位）
    expect(history.some((e) => e.kind === "user" && e.text === "Fix the login bug")).toBe(true);
    expect(history.some((e) => e.kind === "user" && e.text === "throwaway")).toBe(false);
    expect(apiBox.current?.busy).toBe(false);
    expect(apiBox.current?.ctxTokens).toBeNull();

    // The next run builds ON the loaded messages (they flow to onRunComplete).
    apiBox.current?.submit("thanks");
    await until(() => apiBox.current?.busy === false && completed.length > 0, "second run to finish");
    const messages = completed.at(-1) ?? [];
    expect(messages[0]).toMatchObject({ role: "user", content: "Fix the login bug" });
    expect(messages.some((m) => m.role === "user" && m.content === "throwaway")).toBe(false);
    expect(messages.some((m) => m.role === "user" && m.content === "thanks")).toBe(true);
    unmount();
  }, 10000);
});

});
