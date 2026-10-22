// ω99-33 T1/T2 — the reasoning-cohort transition must not read as eviction.
//
// T0 adjudication (o99-33-replay-blindness.test.ts + /tmp/o33-probe/): the
// provider bills a server-side reasoning cohort inside a tool-call
// continuation and detaches it when a fresh user message opens a new run —
// serializePrompt (M47: no reasoning) is structurally blind to the whole
// face. Two false shapes hit the campaign:
//   DETACHMENT (turns 30/38/55/64, log:817/:920/:1320/:1583): the counted
//     prompt SHRINKS under append-only growth (the cohort left); miss =
//     everything after the old head → mislabeled "provider-side eviction?".
//   ONBOARDING (turn 11, log:394): the cohort joins mid-run; the counted
//     prompt jumps by ≈ the new reasoning, miss matches the jump — a benign
//     growth mislabeled a spike.
// The fix is observation-only (the wire is NOT defective — T0/H3): the
// classifier consumes the counted-prompt GROWTH (promptTokens deltas the
// wrapper already observes) — no second serializer, no wire change.
import { describe, it, expect } from "vitest";
import type { AgentMessage, ModelClient, ModelInput, ModelUsage } from "@wudao/core";
import { createCacheTrackingModel, detectCacheBreak } from "../src/cache.js";
import { serializePrompt } from "@wudao/providers";

function fakeModel(usages: readonly ModelUsage[]): ModelClient {
  let i = 0;
  return {
    async generate(input: ModelInput) {
      const usage = usages[i];
      i += 1;
      if (usage) input.onUsage?.(usage);
      return { role: "assistant", content: `answer-${i}` };
    },
  };
}
const U = (promptTokens: number, hit: number): ModelUsage =>
  ({ promptTokens, cacheHitTokens: hit, cacheMissTokens: promptTokens - hit });

const TOOLS = [{ name: "read_file", description: "d", parameters: { type: "object" as const, properties: {}, additionalProperties: false } }];
const run = (tracked: ReturnType<typeof createCacheTrackingModel>, messages: readonly AgentMessage[]) =>
  tracked.generate({ systemPrompt: "sys", tools: TOOLS, messages: [...messages] });

// The campaign's mid-run shape: an assistant carrying reasoning (serializePrompt
// never sees it) + its tool result.
const midRun: AgentMessage[] = [
  { role: "user", content: "t1 please" },
  { role: "assistant", content: "", reasoning: "THINK".repeat(2000), toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a" } }] },
  { role: "tool", toolCallId: "c1", name: "read_file", content: "A".repeat(200) },
];
// A fresh run's first call: the same history + the run's final assistant + the
// next user message (pure extension — the wrapper's line<0 evidence).
const nextRunFirst = [...midRun, { role: "assistant", content: "done" }, { role: "user", content: "t2 please" }] as AgentMessage[];

describe("ω99-33 T1 — cohort shapes through the live wrapper", () => {
  it("① DETACHMENT (campaign turn 30): counted prompt shrinks under append-only growth → named ℹ️ tier, not ⚠️ eviction", async () => {
    const breaks: string[] = [];
    const tracked = createCacheTrackingModel(fakeModel([
      U(44_600, 44_400), // mid-run row: cohort billed, miss 0.2k
      U(27_500, 12_300), // run-first row: cohort detached, miss 15.2k
    ]), { onBreak: (w) => breaks.push(w) });
    await run(tracked, midRun);
    await run(tracked, nextRunFirst);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toContain("ℹ️ reasoning-replay transition"); // RED before: ⚠️ provider-side eviction?
    expect(breaks[0]).toContain("turn 2"); // = assistant count in the curr input (a1 + a2)
    expect(breaks[0]).toMatch(/— miss 15\.2k\/27\.5k \(55\.\d%\)/); // ω99-28 cost tier shape
  });

  it("② ONBOARDING (campaign turn 11): miss matches the counted-prompt growth → silent, no spike report", async () => {
    const breaks: string[] = [];
    const tracked = createCacheTrackingModel(fakeModel([
      U(21_600, 20_500), // miss 1.1k
      U(30_000, 21_500), // growth 8.4k ≈ cohort onboarding; miss 8.5k
    ]), { onBreak: (w) => breaks.push(w) });
    await run(tracked, midRun);
    await run(tracked, nextRunFirst);
    expect(breaks).toHaveLength(0); // RED before: ⚠️ cache miss spike beyond appended delta
  });

  it("③ TRUE eviction still reports ⚠️: prompt grew normally, hit collapsed — nothing detached, nothing onboarded", async () => {
    const breaks: string[] = [];
    const tracked = createCacheTrackingModel(fakeModel([
      U(44_600, 44_400),
      U(45_100, 30_000), // growth 0.5k, miss 15.1k ≫ growth — the prefix re-missed
    ]), { onBreak: (w) => breaks.push(w) });
    await run(tracked, midRun);
    await run(tracked, nextRunFirst);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toContain("⚠️");
    expect(breaks[0]).toContain("provider-side");
    expect(breaks[0]).toContain("eviction");
  });
});

describe("ω99-33 T2 — detectCacheBreak degradation stays byte-identical", () => {
  const ser = (m: readonly AgentMessage[]) => serializePrompt({ systemPrompt: "sys", tools: TOOLS, messages: m });
  it("④ no prevPromptTokens (hand-built row) → the legacy eviction branch, unchanged", () => {
    const warning = detectCacheBreak({
      prevSerialized: ser(midRun),
      currSerialized: ser(nextRunFirst),
      currMessages: nextRunFirst,
      missTokens: 12_000,
      promptTokens: 27_500, // present, but no predecessor size to difference
      recentMisses: [100, 100],
    });
    expect(warning).toContain("provider-side");
    expect(warning).toContain("eviction");
    expect(warning).toContain("— miss 12k/27.5k (43.6%)");
  });
});
