import { describe, it, expect } from "vitest";
import {
  tier2Compact, staticTier2Compact,
  formatVerifiedWork,
  SUMMARY_MARKER, runAgentLoop,
  type AgentMessage, type AgentState, type LoopEvent, type Tool, type ModelClient, type ModelInput,
} from "../src/index.js";
import { parseVerifiedWorkFromSummary, VERIFIED_WORK_CAP, VERIFIED_WORK_TAG } from "../src/compaction.js";
import { createScriptedModel } from "../src/model-client.js";

// 波次 7 #39 (OH B1): the compaction carryover buckets OH rides as compact
// attachments — "recent verified work" (already-verified facts survive the
// boundary so the model never re-does finished work) and the plan-mode
// restatement (post-compaction the model still knows execution is locked).
// Wudao deltas over OH: ① zero new state — entries re-parse from the prior
// frozen summary's tags (the 夜移030 file-ledger discipline), and the loop
// derives them mechanically (a successful shell AFTER writes clears
// the verify gate's trail — that flip IS a verified fact); ② both riders
// compose under the SAME frozen-summary seam, so LLM, digest (#38), and
// static fallback paths carry them identically.

describe("formatVerifiedWork / parseVerifiedWorkFromSummary (pure)", () => {
  it("empty entries → \"\" (zero-change witness: no block, status-quo bytes)", () => {
    expect(formatVerifiedWork([])).toBe("");
  });
  it("block shape: \\n\\n lead + tag + '- ' lines (夜移030 family)", () => {
    expect(formatVerifiedWork(["ran npm test — ok"])).toBe(
      `\n\n<${VERIFIED_WORK_TAG}>\n- ran npm test — ok\n</${VERIFIED_WORK_TAG}>`,
    );
  });
  it("cap keeps the LAST entries with the omission line, and the block round-trips", () => {
    const entries = Array.from({ length: VERIFIED_WORK_CAP + 2 }, (_, i) => `ran cmd${i} — ok`);
    const block = formatVerifiedWork(entries);
    expect(block).toContain(`[... 2 older entries omitted]`);
    expect(block).not.toContain("cmd0");
    expect(block).toContain(`cmd${VERIFIED_WORK_CAP + 1}`);
    expect(parseVerifiedWorkFromSummary(block)).toEqual(entries.slice(2));
  });
  it("parse: absent block → undefined; torn tag → undefined", () => {
    expect(parseVerifiedWorkFromSummary("no block here")).toBeUndefined();
    expect(parseVerifiedWorkFromSummary(`<${VERIFIED_WORK_TAG}>\n- x\n`)).toBeUndefined();
  });
});

/** Narrative-dense span → deterministic LLM path (over the #38 digest caps). */
const dense = (): AgentMessage[] => [
  { role: "user", content: "task 1 " + "x".repeat(2000) },
  { role: "assistant", content: "answer 1 " + "y".repeat(2000) },
  { role: "user", content: "recent" },
];

describe("tier2Compact — verified-work carryover", () => {
  it("caller entries ride the summary as the tag block", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "S" }]);
    const out = await tier2Compact(dense(), model, { keepRecent: 1, verifiedWork: ["ran npm test — ok"] });
    expect(out!.messages[0]!.content).toContain(`<${VERIFIED_WORK_TAG}>`);
    expect(out!.messages[0]!.content).toContain("- ran npm test — ok");
  });

  it("chained compaction re-parses the prior block from the span and merges new entries", async () => {
    // The previous chain summary (with its verified block) sits INSIDE the
    // span being re-summarized — the chained-carryover shape.
    const prevSummary: AgentMessage = {
      role: "user",
      content: `${SUMMARY_MARKER} Task: t\nprior S\n\n<${VERIFIED_WORK_TAG}>\n- ran old check — ok\n</${VERIFIED_WORK_TAG}>`,
    };
    const msgs: AgentMessage[] = [prevSummary, ...dense()];
    const model = createScriptedModel([{ role: "assistant", content: "S" }]);
    const out = await tier2Compact(msgs, model, { keepRecent: 1, verifiedWork: ["ran new test — ok"] });
    // The prior chain summary stays untouched at the head; the NEW summary
    // (the one carrying the system note) is where the merged block rides.
    const fresh = out!.messages.find((m) => m.content.includes("[system note: context was compacted"));
    expect(fresh?.content).toContain("- ran old check — ok");
    expect(fresh?.content).toContain("- ran new test — ok");
  });

  it("no entries anywhere → no block (status-quo bytes)", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "S" }]);
    const out = await tier2Compact(dense(), model, { keepRecent: 1 });
    expect(out!.messages[0]!.content.includes(VERIFIED_WORK_TAG)).toBe(false);
  });

  it("the static fallback path carries the block too (shared seam)", async () => {
    const out = await staticTier2Compact(dense(), { keepRecent: 1, verifiedWork: ["ran build — ok"] });
    expect(out!.messages[0]!.content).toContain("- ran build — ok");
  });
});

describe("tier2Compact — plan-mode restatement", () => {
  it("planMode:true → the restatement line rides the summary", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "S" }]);
    const out = await tier2Compact(dense(), model, { keepRecent: 1, planMode: true });
    expect(out!.messages[0]!.content).toContain("[plan mode still active");
  });
  it("absent → no line (zero-change witness)", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "S" }]);
    const out = await tier2Compact(dense(), model, { keepRecent: 1 });
    expect(out!.messages[0]!.content.includes("plan mode still active")).toBe(false);
  });
});

// -------------------------------------------------------------------------
// Loop-level: the buckets feed themselves — no config surface.
// -------------------------------------------------------------------------

const trivialTool = (name: string): Tool => ({
  name,
  description: "trivial",
  parameters: { type: "object", properties: { command: { type: "string" } }, required: [] },
  execute: () => Promise.resolve({ content: "ok" }),
});

describe("runAgentLoop — the loop feeds both buckets", () => {
  const drain = async (gen: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> => {
    const events: LoopEvent[] = [];
    for (;;) {
      const r = await gen.next();
      if (r.done) return events;
      events.push(r.value);
    }
  };

  it("write → successful shell after writes → the tier-2 summary carries the verified entry", async () => {
    const inputs: ModelInput[] = [];
    let n = 0;
    const model: ModelClient = {
      async generate(input: ModelInput) {
        inputs.push(input);
        n += 1;
        // Turn 1 batches the write AND the verifying run (in-call order) —
        // whatever boundary the threshold fires on, the trail is already
        // recorded before the summarizer consumes the next script slot.
        if (n === 1) return { role: "assistant", content: "", toolCalls: [
          { id: "w1", name: "write_file", arguments: { path: "/w/a.ts" } },
          { id: "r1", name: "shell", arguments: { command: "npm test" } },
        ] };
        if (n === 2) return { role: "assistant", content: "SUMMARY" };
        return { role: "assistant", content: "done" };
      },
    };
    const state: AgentState = {
      systemPrompt: "s",
      messages: [
        { role: "user", content: "task 0 " + "x".repeat(2000) },
        { role: "assistant", content: "answer 0 " + "y".repeat(2000) },
        { role: "user", content: "task 1 " + "x".repeat(2000) },
        { role: "assistant", content: "answer 1 " + "y".repeat(2000) },
        { role: "user", content: "go" },
      ],
      tools: [trivialTool("write_file"), trivialTool("shell")],
      status: "idle",
    };
    const events = await drain(runAgentLoop(state, model, {
      maxTurns: 6,
      gates: { todo: false, verify: false },
      compaction: { contextWindowTokens: 1_500, keepRecent: 1, zeroLlmDigest: false },
    }));
    const compacted = events.find((e): e is Extract<LoopEvent, { type: "compacted" }> => e.type === "compacted" && e.tier === 2);
    if (compacted === undefined) throw new Error("test premise failed: no tier-2 compaction");
    // The verified fact rode the summary: what ran, that it was ok, after writes.
    const summary = state.messages.find((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER));
    expect(summary?.content).toContain(`<${VERIFIED_WORK_TAG}>`);
    expect(summary?.content).toContain("npm test");
    expect(summary?.content).toContain("ok");
  });

  it("gates.plan run → the tier-2 summary carries the plan restatement", async () => {
    let calls = 0;
    const model: ModelClient = {
      async generate() {
        calls += 1;
        // Turn 1 keeps the run alive (a tool call) so the loop REACHES the
        // boundary where the threshold compaction fires; the summarizer
        // consumes slot 2, the final answer slot 3.
        if (calls === 1) return { role: "assistant", content: "", toolCalls: [{ id: "e1", name: "echo", arguments: { command: "hi" } }] };
        if (calls === 2) return { role: "assistant", content: "SUMMARY" };
        return { role: "assistant", content: "done" };
      },
    };
    const state: AgentState = {
      systemPrompt: "s",
      messages: [
        { role: "user", content: "task 0 " + "x".repeat(2000) },
        { role: "assistant", content: "answer 0 " + "y".repeat(2000) },
        { role: "user", content: "task 1 " + "x".repeat(2000) },
        { role: "assistant", content: "answer 1 " + "y".repeat(2000) },
        { role: "user", content: "go" },
      ],
      tools: [trivialTool("echo")],
      status: "idle",
    };
    const events = await drain(runAgentLoop(state, model, {
      maxTurns: 3,
      gates: { todo: false, verify: false, plan: true },
      compaction: { contextWindowTokens: 1_500, keepRecent: 1, zeroLlmDigest: false },
    }));
    if (events.find((e) => e.type === "compacted" && e.tier === 2) === undefined) {
      throw new Error("test premise failed: no tier-2 compaction");
    }
    const summary = state.messages.find((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER));
    expect(summary?.content).toContain("[plan mode still active");
  });
});
