// ω99-33 T0 — offline adjudication of the campaign's five ⚠️ rows
// (/tmp/o33-campaign.log :394/:817/:920/:1320/:1583 — turns 11/30/38/55/64).
//
// What this file pins (the round-2 verdict, evidence-grounded):
//   A. serializePrompt (the M24 canonical serializer, which by design M47 never
//      contains reasoning_content) shows PURE EXTENSION across every ⚠️ pair —
//      re-validated from the JSONL ground truth, not from the wrapper.
//   B. The REAL wire builder (createOpenAICompatibleProvider → captured body)
//      is byte-monotone across the m67→m69 pair under every replay mode: no
//      driver-side gate or state rebuild can remove bytes ⇒ H1/H2 FALSIFIED at
//      the driver's own code path.
//   C. Counted-prompt reconciliation: the run-first rows (first call after
//      each user turn) reconcile EXACTLY with head+serialization, while the
//      last mid-run rows carry ≈ that run's tool-call reasoning inventory as
//      an invisible counted surplus ⇒ the component that leaves the counted
//      prompt at run boundaries is the PROVIDER-side reasoning cohort ⇒ H3
//      CONFIRMED. Live-probe corroboration (/tmp/o33-probe/probe-results.json,
//      probe2-results.json): DeepSeek v4-flash never counts client-sent
//      reasoning_content (7 probes, deltas exactly 0, with/without effort
//      params, user-final and tool-final alike) — the counted cohort is
//      server-side: billed inside a tool-call continuation, detached when a
//      fresh user message arrives.
//
// The evidence files are the campaign's load-bearing archive on this machine;
// the suite skips when they are absent so CI elsewhere stays green.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { serializePrompt, createOpenAICompatibleProvider } from "@wudao-org/providers";
import type { AgentMessage } from "@wudao-org/core";

const JSONL = "/tmp/o33-ws/.wudao/sessions/e9e276a7.jsonl";
type Entry = Record<string, unknown>;

function loadEntries(): Entry[] {
  return readFileSync(JSONL, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Entry);
}
function toAgentMessage(e: Entry): AgentMessage {
  if (e.role === "user") return { role: "user", content: String(e.content ?? "") };
  if (e.role === "assistant") {
    const tc = e.toolCalls as { id: string; name: string; arguments: Record<string, unknown> }[] | undefined;
    return {
      role: "assistant",
      content: String(e.content ?? ""),
      ...(tc ? { toolCalls: tc.map((t) => ({ id: t.id, name: t.name, arguments: t.arguments })) } : {}),
      ...(typeof e.reasoning === "string" ? { reasoning: e.reasoning } : {}),
    };
  }
  return { role: "tool", toolCallId: String(e.toolCallId ?? ""), name: String(e.name ?? ""), content: String(e.content ?? "") };
}
/** The request answered by assistant-entry `idx`: every message entry before it. */
const inputOf = (entries: Entry[], idx: number): AgentMessage[] =>
  entries.slice(0, idx).filter((e) => typeof e.role === "string").map(toAgentMessage);

/** The estimator the providers' replayedReasoningTokens uses (CJK ≈ 1 token,
 *  ~4 other units/token). An ESTIMATOR — serialization always goes through the
 *  real serializePrompt; this never touches bytes. */
function estTokens(s: string): number {
  let cjk = 0;
  for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) >= 0x2e80) cjk += 1;
  return cjk + Math.ceil((s.length - cjk) / 4);
}
/** Tool-call-turn reasoning inventory of a message list (what a toolCallTurns
 *  replay would send — and, empirically, what the provider's own cohort bills). */
function cohortInventory(msgs: readonly AgentMessage[]): number {
  let t = 0;
  for (const m of msgs) {
    if (m.role === "assistant" && m.reasoning !== undefined && m.reasoning !== "" && (m.toolCalls?.length ?? 0) > 0) {
      t += estTokens(m.reasoning);
    }
  }
  return t;
}
/** Real wire messages via the REAL provider path (captured body, stub fetch). */
async function wireMessages(messages: readonly AgentMessage[], reasoningReplay: "never" | "toolCallTurns"): Promise<unknown[]> {
  const cap: { body?: Record<string, unknown> } = {};
  const provider = createOpenAICompatibleProvider(
    { apiKey: "k", baseURL: "http://provider.test", model: "m", ...(reasoningReplay === "never" ? {} : { reasoningReplay }) },
    {
      fetch: (async (_u: unknown, init: { body?: string }) => {
        cap.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }) } as unknown as Response;
      }) as unknown as typeof fetch,
    },
  );
  await provider.generate({ systemPrompt: "s", tools: [], messages: [...messages] });
  return (cap.body?.messages as unknown[]) ?? [];
}

const skip = !existsSync(JSONL);
describe.skipIf(skip)("ω99-33 T0 — the five ⚠️ rows: serializePrompt-blind, cohort-driven", () => {
  // ω99-174 走查小刀：describe.skipIf 在 vitest 收集期仍执行 describe 体，
  // 证据档缺失时 loadEntries 抛 ENOENT → 套件红而非 skip（头注释「absent 则
  // skip 保 CI 绿」失效，/tmp 清理后 174 全量亲证）。skip 时喂空数组收集，
  // 套件正常标记 skip，测试体永不执行。
  const entries = skip ? [] : loadEntries();
  const assistantIdx = entries.map((e, i) => (e.role === "assistant" ? i : -1)).filter((i) => i >= 0);
  // Row n of the campaign log (session 1) = the call answered by assistant n.
  const req = (n: number) => inputOf(entries, assistantIdx[n - 1] as number);
  const ser = (n: number) => serializePrompt({ systemPrompt: "s", tools: [], messages: req(n) });

  it("A. serializePrompt pure-extension across every ⚠️ pair (wrapper's line<0 revalidated from ground truth)", () => {
    expect(assistantIdx).toHaveLength(72);
    // The five ⚠️ rows pair with their predecessor request. prev ⊂ curr bytes.
    for (const [prev, curr] of [[11, 12], [30, 31], [38, 39], [55, 56], [64, 65]] as const) {
      expect(ser(curr).startsWith(ser(prev))).toBe(true);
    }
  });

  it("B. the real wire builder is byte-monotone m67→m69 under every replay mode — no driver-side gate exists (H1/H2 falsified)", async () => {
    const m67 = req(30);
    const m69 = req(31);
    // sanity: m67's input is exactly m69's minus the appended tail
    expect(m69.length).toBe(m67.length + 2);
    for (const mode of ["never", "toolCallTurns"] as const) {
      const w67 = await wireMessages(m67, mode);
      const w69 = await wireMessages(m69, mode);
      // element-wise: m69's wire = m67's wire verbatim + the appended tail
      expect(w69.length).toBe(w67.length + 2);
      for (let i = 0; i < w67.length; i += 1) {
        expect(JSON.stringify(w69[i])).toBe(JSON.stringify(w67[i])); // the wire cannot SHRINK here
      }
      if (mode === "toolCallTurns") {
        // and the replay bytes really do ride: 24 messages carry reasoning_content
        expect(w69.filter((m) => (m as { reasoning_content?: unknown }).reasoning_content !== undefined)).toHaveLength(24);
      }
    }
  });

  it("C. counted-prompt reconciliation: the run-boundary drop equals the run's reasoning cohort (H3 confirmed)", () => {
    // Probe anchors: DeepSeek counted 14 701 / 15 274 tokens for the m67/m69
    // MESSAGE parts (1-char system) — the head (system+tools) is ≈12.2k (row
    // #1's 13.1k minus the first user message and the session-start note).
    // Differential form (estimator systematics cancel inside a pair):
    //   counted(runEnd) = head + ser(runEnd)·S + cohort
    //   counted(runFirst) = head + ser(runFirst)·S            (cohort detached)
    //   ⇒ cohort = (obs(first) − obs(end)) − (pred(first) − pred(end))
    const S = 1.0193; // probe-calibrated est→actual scale (14701/14409, 15274/14984)
    const HEAD = 12.23; // k tokens
    const serTokens = (n: number) =>
      req(n).reduce((t, m) => {
        if (m.role === "user") return t + estTokens(m.content);
        if (m.role === "tool") return t + estTokens(m.content) + estTokens(m.name) + 25;
        return t + estTokens(m.content) + (m.toolCalls ?? []).reduce((s, c) => s + estTokens(c.id) + estTokens(c.name) + estTokens(JSON.stringify(c.arguments)) + 30, 0);
      }, 0);
    const predict = (n: number) => HEAD + (serTokens(n) * S) / 1000;
    // Observed counted prompts (campaign log, k tokens).
    const observed: Record<number, number> = { 12: 30.0, 30: 44.6, 31: 27.5, 38: 35.9, 39: 32.2, 45: 37.2, 46: 36.5, 55: 44.8, 56: 42.0, 64: 60.1, 65: 51.6 };
    // [runEnd, runFirst, runSpan): the five user-turn boundaries (t1/t2/t3/t4/t5
    // at entries 68/85/102/125/145; t3's drop stayed sub-threshold — no ⚠️).
    const pairs = [[30, 31, 2, 67], [38, 39, 69, 84], [45, 46, 86, 101], [55, 56, 103, 124], [64, 65, 126, 144]] as const;
    for (const [end, first, from, to] of pairs) {
      const cohort = (observed[first] - observed[end]) - (predict(first) - predict(end));
      const inv = cohortInventory(inputOf(entries, to).slice(from - 2)) / 1000;
      expect(Math.abs(Math.abs(cohort) - inv)).toBeLessThan(Math.max(1.5, inv * 0.25));
    }
    // And the onboarding shape (turn 11, log:394): mid-run the counted prompt
    // JUMPS by ≈ the newly generated reasoning (entry 26: 28 039 chars,
    // est 8.55k) — deltaTokens saw only the ≈0.5k serialization delta ⇒ the
    // false spike.
    const jump = observed[12] - 21.6;
    const onboarding = cohortInventory(inputOf(entries, 27).slice(24)) / 1000;
    expect(Math.abs(jump - onboarding)).toBeLessThan(1.5);
  });
});
