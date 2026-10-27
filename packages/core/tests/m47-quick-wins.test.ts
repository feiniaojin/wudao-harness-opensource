// M47 quick-wins — core-side pins:
//  §4 (A1) the summary END marker: every tier-2 summary message ends with the
//          frozen boundary line, exactly once, across re-injection.
//  §5 (A2) the static tier-2 fallback: a failing summarizer call degrades to
//          the deterministic compact instead of killing the run; the event
//          names the fallback.
//  §6 (A4) tool-argument normalization: schema-driven fixes between schema
//          fetch and validation, auditable first line, did-you-mean intact.
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop } from "../src/loop.js";
import { buildTool, createScriptedModel } from "../src/index.js";
import {
  tier2Compact,
  staticTier2Compact,
  staticFallbackSummary,
  applySummaryMarkers,
  SUMMARY_MARKER,
  SUMMARY_END_MARKER,
  withSummaryEndMarker,
  stripSummaryEndMarker,
} from "../src/compaction.js";
import { normalizeToolArguments, formatArgsNormalizedLine } from "../src/tool.js";
import type { AgentMessage, AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput, Terminal, Tool } from "../src/index.js";

const drain = async (gen: AsyncGenerator<LoopEvent, Terminal>): Promise<{ events: LoopEvent[]; terminal: Terminal }> => {
  const events: LoopEvent[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) return { events, terminal: r.value };
    events.push(r.value);
  }
};

const toolCallTurn = (id: string, name: string, args: Record<string, unknown>): AssistantMessage =>
  ({ role: "assistant", content: "", toolCalls: [{ id, name, arguments: args }] });

// ---------------------------------------------------------------------------
// §4 — the summary end marker
// ---------------------------------------------------------------------------

const summarizeModel = (content: string): ModelClient => ({
  async generate(): Promise<AssistantMessage> { return { role: "assistant", content }; },
});

const tier2History = (): AgentMessage[] => [
  { role: "user", content: "task one " + "x".repeat(200) },
  { role: "assistant", content: "did work " + "y".repeat(200) },
  { role: "user", content: "keep going" },
];

describe("tier2Compact — summary end marker (M47 §4)", () => {
  it("ends the summary message with the frozen boundary line", async () => {
    const r = await tier2Compact(tier2History(), summarizeModel("SUMMARY-TEXT"), { keepRecent: 1, zeroLlmDigest: false }); // #38: asserts the LLM body bytes
    expect(r).not.toBeNull();
    // ω-5b (I22) re-record: the derived task line (the span's first user
    // message, capped at 200 chars) rides between the marker and the body.
    const derivedTask = "task one " + "x".repeat(191);
    expect(r!.summaryMessage.content).toBe(
      `${SUMMARY_MARKER} Task: ${derivedTask}\nSUMMARY-TEXT\n` +
      "[system note: context was compacted to fit — delegate any remaining exploration to task subagents and answer from their reports]\n" +
      // 113-B1：权威行常驻 rider，随 summary message 落（新契约重钉）。
      "保留的消息权威于本摘要\n" +
      SUMMARY_END_MARKER,
    );
  });

  it("never carries two copies even when the model echoes the boundary line", async () => {
    const echo = `SUMMARY-TEXT\n${SUMMARY_END_MARKER}`;
    const r = await tier2Compact(tier2History(), summarizeModel(echo), { keepRecent: 1, zeroLlmDigest: false }); // #38: the echo premise is an LLM call
    const occurrences = r!.summaryMessage.content.split(SUMMARY_END_MARKER).length - 1;
    expect(occurrences).toBe(1);
    expect(r!.summaryMessage.content.endsWith(SUMMARY_END_MARKER)).toBe(true);
  });

  it("withSummaryEndMarker is idempotent; strip removes the tail", () => {
    const once = withSummaryEndMarker("body");
    expect(once).toBe(`body\n${SUMMARY_END_MARKER}`);
    expect(withSummaryEndMarker(once)).toBe(once);
    expect(stripSummaryEndMarker(once)).toBe("body");
  });

  it("re-injection (applySummaryMarkers) keeps the marked bytes verbatim", () => {
    const marked: AgentMessage = { role: "user", content: `${SUMMARY_MARKER} s\n${SUMMARY_END_MARKER}` };
    // Checkpoint semantics: the marker (and everything after it) survives
    // with bytes untouched — a second marker resets to ITSELF, still intact.
    expect(applySummaryMarkers([marked, { role: "user", content: "new" }])).toEqual([marked, { role: "user", content: "new" }]);
    expect(applySummaryMarkers([marked, { role: "user", content: "new" }, marked])).toEqual([marked]);
  });
});

// ---------------------------------------------------------------------------
// §5 — the static fallback summary
// ---------------------------------------------------------------------------

describe("staticFallbackSummary / staticTier2Compact (M47 §5)", () => {
  it("is pure and deterministic: first user message + recent role counts", () => {
    const span: AgentMessage[] = [
      { role: "user", content: "ORIGINAL REQUEST SENTINEL" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read_file", arguments: {} }] },
      { role: "tool", toolCallId: "t1", name: "read_file", content: "r1" },
      { role: "assistant", content: "a2" },
    ];
    const s1 = staticFallbackSummary(span);
    expect(s1).toBe(staticFallbackSummary(span));
    expect(s1).toContain("ORIGINAL REQUEST SENTINEL");
    expect(s1).toContain("5 messages");
    expect(s1).toMatch(/1 user/);
    expect(s1).toMatch(/3 assistant/);
    expect(s1).toMatch(/1 tool/);
  });

  it("caps the first-user quote and survives a span with no user message", () => {
    const long: AgentMessage[] = [
      { role: "user", content: "z".repeat(1000) },
      { role: "assistant", content: "ok" },
    ];
    expect(staticFallbackSummary(long).length).toBeLessThan(1000);
    const noUser = staticFallbackSummary([{ role: "assistant", content: "only" }]);
    expect(noUser).toContain("(no user message in the compacted span)");
  });

  it("staticTier2Compact: same span/null contract, marker + end marker + board survival", () => {
    const board = "[todo board 1/2 done]\n☑ first\n☐ second";
    // ω-3b hand-check: the board result used to end the exchange unseen —
    // spanning it was the over-stub the floor closes. The ack makes it SEEN.
    const msgs: AgentMessage[] = [
      { role: "user", content: "u1 " + "x".repeat(100) },
      { role: "assistant", content: "", toolCalls: [{ id: "b0", name: "todo_write", arguments: {} }] },
      { role: "tool", toolCallId: "b0", name: "todo_write", content: board },
      { role: "assistant", content: "board written" },
      { role: "user", content: "continue" },
    ];
    const r = staticTier2Compact(msgs, { keepRecent: 1 });
    expect(r).not.toBeNull();
    expect(r!.messages[0]!.content.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(r!.messages[0]!.content.endsWith(SUMMARY_END_MARKER)).toBe(true);
    expect(r!.messages[1]!.content.startsWith(`${board.split("\n")[0]}(restored)`)).toBe(true);
    // Nothing to compact → null (same contract as tier2Compact).
    expect(staticTier2Compact([{ role: "user", content: "only" }], { keepRecent: 6 })).toBeNull();
  });
});

describe("loop — tier2 failure degrades to the static fallback (M47 §5)", () => {
  it("a summarizer throw no longer kills the run; the compacted event names static-fallback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "m47-static-"));
    await writeFile(join(dir, "note.txt"), "note\n", "utf8");
    let calls = 0;
    const model: ModelClient = {
      async generate(input: ModelInput): Promise<AssistantMessage> {
        calls += 1;
        // Call 1: the conversation's first turn (a tool call, so the deferred
        // boundary compaction has tool results to sit behind). Call 2: the
        // tier-2 summarizer — this one FAILS. Call 3: the post-compaction
        // final answer.
        if (calls === 1) return toolCallTurn("r1", "read_file", { path: "note.txt" });
        if (calls === 2) throw new Error("provider request failed: 500 summarizer down");
        return { role: "assistant", content: "RECOVERED-AFTER-STATIC-FALLBACK" };
      },
    };
    const readTool: Tool = {
      name: "read_file",
      description: "read",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      execute: async () => ({ content: "file content" }),
    };
    const big = "payload ".repeat(600);
    const state: AgentState = {
      systemPrompt: "sys",
      messages: [
        { role: "user", content: `ORIGINAL REQUEST ${big}` },
        { role: "assistant", content: `worked ${big}` },
        { role: "user", content: "continue" },
      ],
      tools: [readTool],
      status: "running",
    };
    const { events, terminal } = await drain(runAgentLoop(state, model, {
      maxTurns: 4,
      gates: { todo: false, verify: false },
      compaction: { contextWindowTokens: 300, keepRecent: 1, minChars: 100_000 },
    }));
    expect(terminal.reason).toBe("completed");
    expect(terminal.finalMessage?.content).toBe("RECOVERED-AFTER-STATIC-FALLBACK");
    const compacted = events.find((e): e is Extract<LoopEvent, { type: "compacted" }> => e.type === "compacted" && e.summaryMessage !== undefined);
    expect(compacted).toBeDefined();
    expect(compacted!.trigger).toBe("static-fallback");
    expect(compacted!.summaryMessage!.content.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(compacted!.summaryMessage!.content.endsWith(SUMMARY_END_MARKER)).toBe(true);
    expect(compacted!.summaryMessage!.content).toContain("ORIGINAL REQUEST");
    expect(compacted!.afterTokens).toBeLessThan(compacted!.beforeTokens);
    // The rebuilt history leads with the static summary message.
    expect(state.messages[0]!.content.startsWith(SUMMARY_MARKER)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §6 — tool-argument normalization
// ---------------------------------------------------------------------------

const PROBE_SCHEMA = {
  type: "object" as const,
  properties: {
    flag: { type: "boolean" as const },
    count: { type: "number" as const },
    path: { type: "string" as const },
    mode: { type: "string" as const, enum: ["strict", "loose"] },
    label: { type: "string" as const },
  },
  required: ["flag", "count", "path", "mode"],
  additionalProperties: false,
};

describe("normalizeToolArguments (M47 §6)", () => {
  it("coerces booleans, numbers, paths, and unique enum folds", () => {
    const { args, normalized } = normalizeToolArguments(PROBE_SCHEMA, {
      flag: "true",
      count: "3",
      path: "  \"a.txt\" ",
      mode: "STRICT",
      label: "untouched",
    });
    expect(args).toEqual({ flag: true, count: 3, path: "a.txt", mode: "strict", label: "untouched" });
    expect(normalized).toEqual(["count", "flag", "mode", "path"]); // sorted
  });

  it("false / decimals / single quotes / case-exact enums fold too", () => {
    const { args, normalized } = normalizeToolArguments(PROBE_SCHEMA, {
      flag: "FALSE",
      count: " 3.50 ",
      path: "'b.txt'",
      mode: "strict",
    });
    expect(args).toEqual({ flag: false, count: 3.5, path: "b.txt", mode: "strict" });
    expect(normalized).toEqual(["count", "flag", "path"]); // mode was already exact
  });

  it("never touches correct values, unknown keys, or unfixable ones", () => {
    const { args, normalized } = normalizeToolArguments(PROBE_SCHEMA, {
      flag: true,
      count: 3,
      path: "a.txt",
      mode: "loose",
      junk: "keep me",
    });
    expect(args).toEqual({ flag: true, count: 3, path: "a.txt", mode: "loose", junk: "keep me" });
    expect(normalized).toEqual([]);
    const bad = normalizeToolArguments(PROBE_SCHEMA, { flag: "maybe", count: "abc", path: "a.txt", mode: "nope" });
    expect(bad.args).toEqual({ flag: "maybe", count: "abc", path: "a.txt", mode: "nope" });
    expect(bad.normalized).toEqual([]);
  });

  it("ambiguous enum case-folds NEVER fold (unique hit only)", () => {
    const schema = { type: "object" as const, properties: { m: { type: "string" as const, enum: ["Mode", "mode"] } } };
    const { args, normalized } = normalizeToolArguments(schema, { m: "MODE" });
    expect(args).toEqual({ m: "MODE" });
    expect(normalized).toEqual([]);
  });

  it("is top-level only — nested values are untouched (v1)", () => {
    const schema = { type: "object" as const, properties: { items: { type: "array" as const } } };
    const input = { items: [{ n: "3", flag: "true" }] };
    expect(normalizeToolArguments(schema, input)).toEqual({ args: input, normalized: [] });
  });

  it("the audit line renders sorted keys", () => {
    expect(formatArgsNormalizedLine(["count", "flag"])).toBe("[args normalized: count,flag]");
  });
});

describe("loop — normalized dispatch end to end (M47 §6)", () => {
  const probeTool = (received: { args: Record<string, unknown> | undefined }): Tool =>
    buildTool({
      name: "probe",
      description: "echoes the args it actually received",
      parameters: PROBE_SCHEMA,
      execute: async (args) => {
        received.args = args;
        return { content: `GOT ${JSON.stringify(args)}` };
      },
    });

  it("fixes almost-right arguments before execution and audits the first line", async () => {
    const received: { args: Record<string, unknown> | undefined } = { args: undefined };
    const model = createScriptedModel([
      toolCallTurn("c1", "probe", { flag: "true", count: "3", path: "  \"a.txt\" ", mode: "STRICT" }),
      { role: "assistant", content: "done" },
    ]);
    const state: AgentState = { systemPrompt: "s", messages: [{ role: "user", content: "run the probe" }], tools: [probeTool(received)], status: "running" };
    const { events, terminal } = await drain(runAgentLoop(state, model, { maxTurns: 3, gates: { todo: false, verify: false } }));
    expect(terminal.reason).toBe("completed");
    expect(received.args).toEqual({ flag: true, count: 3, path: "a.txt", mode: "strict" });
    const finished = events.find((e): e is Extract<LoopEvent, { type: "tool_call_finished" }> => e.type === "tool_call_finished");
    expect(finished?.result.split("\n")[0]).toBe("[args normalized: count,flag,mode,path]");
    expect(finished?.result.split("\n")[1]).toBe('GOT {"flag":true,"count":3,"path":"a.txt","mode":"strict"}');
    expect(finished?.isError).toBe(false);
  });

  it("unfixable values still take the did-you-mean validation error", async () => {
    const received: { args: Record<string, unknown> | undefined } = { args: undefined };
    const model = createScriptedModel([
      toolCallTurn("c1", "probe", { flag: "maybe", count: "abc", path: "a.txt", mode: "nope" }),
      { role: "assistant", content: "recovered" },
    ]);
    const state: AgentState = { systemPrompt: "s", messages: [{ role: "user", content: "run the probe badly" }], tools: [probeTool(received)], status: "running" };
    const { events, terminal } = await drain(runAgentLoop(state, model, { maxTurns: 3, gates: { todo: false, verify: false } }));
    expect(terminal.reason).toBe("completed");
    expect(received.args).toBeUndefined(); // never executed
    const finished = events.find((e): e is Extract<LoopEvent, { type: "tool_call_finished" }> => e.type === "tool_call_finished");
    expect(finished?.isError).toBe(true);
    expect(finished?.result).toMatch(/invalid arguments: argument "flag" must be a boolean/);
    expect(finished?.result).not.toContain("[args normalized");
  });
});
