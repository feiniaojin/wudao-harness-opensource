// ω99-45 — cooperative abort through the compaction pipeline (pi findings C2,
// the wudao port). The contract under test:
//   1. an abort mid-summarizer PROPAGATES (AbortError out) — it never degrades
//      to the static fallback, which would be MORE work after the user asked
//      for less;
//   2. a NON-abort summarizer failure keeps the M47 static-fallback semantics
//      byte-for-byte (the zero-change pin — the fallback is for a down
//      provider, never for a cancel);
//   3. the signal threads DEEP — it rides ModelInput.signal into the provider
//      call (a real mid-flight fetch cancel);
//   4. phase boundaries — a summary that completed while the abort fired
//      still never becomes a boundary (entry + post-call checks);
//   5. absent signal = exactly today's behavior (the entire existing
//      compaction pack passing unchanged is that witness).
import { describe, it, expect } from "vitest";
import {
  manualCompact,
  runAgentLoop,
  SUMMARY_MARKER,
  tier2Compact,
  type AgentMessage,
  type AgentState,
  type LoopEvent,
  type ModelClient,
  type ModelInput,
  type Tool,
} from "../src/index.js";
import { dualTier2Compact } from "../src/compaction.js";
import type { AssistantMessage } from "../src/model-client.js";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const abortError = (): Error => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

/** A model whose generate() parks forever and rejects with the AbortError
 *  shape the moment the request's signal fires — the fetch shape. */
const hangingModel = (): { model: ModelClient; calls: () => number } => {
  let calls = 0;
  const model: ModelClient = {
    generate(input: ModelInput): Promise<AssistantMessage> {
      calls += 1;
      return new Promise((_resolve, reject) => {
        if (input.signal?.aborted) {
          reject(abortError());
          return;
        }
        input.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
      });
    },
  };
  return { model, calls: () => calls };
};

// A span with a compactable window AND a non-digestible narrative (user text
// over the digest cap) so tier-2 takes the LLM path (mirrors the carryover
// pack's shape).
const spanMessages = (): AgentMessage[] => [
  { role: "user", content: "task 0 " + "x".repeat(2000) },
  { role: "assistant", content: "answer 0" },
  { role: "user", content: "task 1 " + "x".repeat(2000) },
  { role: "assistant", content: "answer 1" },
  { role: "user", content: "go" },
];

// A single turn filling the whole window — standard tier-2 has no span, the
// DUAL path fires (mirrors m52 §1.4's shape).
const dualMessages = (): AgentMessage[] => [
  { role: "user", content: "go" },
  { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "read_file", arguments: { path: "a" } }] },
  { role: "tool", toolCallId: "c0", name: "read_file", content: "h".repeat(31_000) },
];

const trivialTool = (name: string): Tool => ({
  name,
  description: "trivial",
  parameters: { type: "object", properties: { command: { type: "string" } }, required: [] },
  execute: () => Promise.resolve({ content: "ok" }),
});

describe("ω99-45 manualCompact abort (§2.1)", () => {
  it("an abort mid-summarizer propagates — no static fallback, no boundary", async () => {
    const ctl = new AbortController();
    const { model } = hangingModel();
    const messages = spanMessages();
    const snapshot = messages.map((m) => ({ ...m }));
    const p = manualCompact(
      { systemPrompt: "s", tools: [], messages, model, signal: ctl.signal },
      { keepRecent: 1 },
    );
    await wait(10); // let generate() enter (the summarizer is in flight)
    ctl.abort();
    // The REJECTION is the no-fallback proof: had the catch degraded to
    // staticTier2Compact, manualCompact would have RESOLVED with a
    // deterministic static summary instead of throwing.
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    // No boundary anywhere: the caller's history is untouched.
    expect(messages.some((m) => m.content.startsWith(SUMMARY_MARKER))).toBe(false);
    expect(messages.some((m) => m.content.includes("Static fallback summary"))).toBe(false);
    expect(messages).toEqual(snapshot);
  });

  it("a NON-abort summarizer failure keeps the M47 static fallback (zero-change pin)", async () => {
    const model: ModelClient = {
      async generate() {
        throw new Error("provider down");
      },
    };
    const out = await manualCompact({ systemPrompt: "s", tools: [], messages: spanMessages(), model }, { keepRecent: 1 });
    expect(out).not.toBeNull();
    expect(out?.reason).toBe("manual");
    expect(out?.tier).toBe(2);
    expect(out?.summaryMessage?.content).toContain("Static fallback summary");
  });

  it("a summary that completed while the abort fired never becomes a boundary (phase check)", async () => {
    const ctl = new AbortController();
    // The provider shape of "the response was already buffered when the
    // cancel landed": generate() resolves normally, but the signal fired
    // first. The post-call phase boundary must still refuse the boundary.
    const model: ModelClient = {
      async generate() {
        await wait(5);
        ctl.abort();
        return { role: "assistant", content: "SUMMARY" };
      },
    };
    await expect(
      manualCompact({ systemPrompt: "s", tools: [], messages: spanMessages(), model, signal: ctl.signal }, { keepRecent: 1 }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("the dual path aborts through too (per-part direct-through, no static half)", async () => {
    const ctl = new AbortController();
    const { model } = hangingModel();
    const p = manualCompact(
      { systemPrompt: "s", tools: [], messages: dualMessages(), model, signal: ctl.signal },
      { keepRecent: 6 },
    );
    await wait(10);
    ctl.abort();
    // A swallowed abort would have resolved with per-part STATIC halves
    // ("History — Static fallback summary"); the rejection proves the
    // direct-through reached the dual seam.
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("ω99-45 signal threading (§1.1 穿深)", () => {
  it("tier2Compact hands the signal to the provider call via ModelInput.signal", async () => {
    const ctl = new AbortController();
    let seen: AbortSignal | undefined;
    const model: ModelClient = {
      generate(input: ModelInput) {
        seen = input.signal;
        return new Promise<AssistantMessage>((_resolve, reject) => {
          if (input.signal?.aborted) {
            reject(abortError());
            return;
          }
          input.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
        });
      },
    };
    const p = tier2Compact(spanMessages(), model, { keepRecent: 1 }, ctl.signal);
    await wait(10);
    expect(seen).toBe(ctl.signal); // the deep-threading witness
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("dualTier2Compact threads the same signal to its halves", async () => {
    const ctl = new AbortController();
    const { model, calls } = hangingModel();
    const p = dualTier2Compact(dualMessages(), model, { keepRecent: 6 }, ctl.signal);
    await wait(10);
    expect(calls()).toBeGreaterThan(0);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("ω99-45 loop auto-compaction abort (runCompact direct-through)", () => {
  const drain = async (gen: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> => {
    const events: LoopEvent[] = [];
    for (;;) {
      const r = await gen.next();
      if (r.done) return events;
      events.push(r.value);
    }
  };

  it("an aborted auto-compaction propagates as AbortError — the static fallback does not run", async () => {
    let calls = 0;
    const model: ModelClient = {
      async generate() {
        calls += 1;
        // Slot 1 keeps the run alive past the threshold check; slot 2 IS the
        // tier-2 summarizer — cancelled mid-flight (the shape a provider
        // fetch produces when the run's signal fires).
        if (calls === 1) {
          return { role: "assistant", content: "", toolCalls: [{ id: "e1", name: "echo", arguments: { command: "hi" } }] };
        }
        throw abortError();
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
    // The abort escapes the generator (the driver's abort bookkeeping owns it
    // from there — the same shape a cancelled model call produces). Had the
    // catch degraded to staticTier2Compact, the run would have CONTINUED to a
    // terminal instead of rejecting.
    await expect(drain(runAgentLoop(state, model, {
      maxTurns: 4,
      gates: { todo: false, verify: false },
      compaction: { contextWindowTokens: 1_500, keepRecent: 1, zeroLlmDigest: false },
    }))).rejects.toMatchObject({ name: "AbortError" });
    // No fallback boundary in the history.
    expect(state.messages.some((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER))).toBe(false);
    expect(state.messages.some((m) => m.content.includes("Static fallback summary"))).toBe(false);
  });
});
