// M48 §3 — ghost-skill markers (hermes). A skill loaded via read_file whose
// message later falls into a compaction span would silently vanish from the
// model's context — the agent stops obeying the skill without knowing why.
// Compaction now swaps pruned skill-read tool results for the canonical
// [SKILL_PRUNED: name — reload with read_file <path>] marker (tier 0/1,
// in-place, pairing-safe) and re-injects one marker per distinct skill right
// after a tier-2 summary (board-restore-isomorphic). The loop tracks skill
// reads through a caller-supplied classifier over (toolName, args).
import { describe, it, expect } from "vitest";
import {
  formatSkillPrunedMarker, parseSkillPrunedMarker, SKILL_PRUNED_PREFIX,
  microcompact, clearTier, tier2Compact, staticTier2Compact, SUMMARY_MARKER,
  runAgentLoop,
} from "../src/index.js";
import { SKILL_REINJECT_CAP_CHARS } from "../src/compaction.js";
import type { AgentMessage, AgentState, AssistantMessage, ModelClient, ModelInput, Tool } from "../src/index.js";

const SKILL_READ = { toolCallId: "s1", name: "commit-flow", path: ".wudao/skills/commit-flow/SKILL.md" };
const skillReads = () => new Map([[SKILL_READ.toolCallId, { name: SKILL_READ.name, path: SKILL_READ.path }]]);

const bigSkillBody = `---\nname: commit-flow\ndescription: how to commit\n---\n${"step instruction line\n".repeat(120)}`;

function skillReadMessage(content = bigSkillBody): AgentMessage {
  return { role: "tool", toolCallId: SKILL_READ.toolCallId, name: "read_file", content };
}

// ---------------------------------------------------------------------------
// marker format
// ---------------------------------------------------------------------------

describe("skill-pruned marker", () => {
  it("formats the canonical marker", () => {
    expect(formatSkillPrunedMarker("commit-flow", ".wudao/skills/commit-flow/SKILL.md"))
      .toBe("[SKILL_PRUNED: commit-flow — reload with read_file .wudao/skills/commit-flow/SKILL.md]");
    expect(formatSkillPrunedMarker("a", "p").startsWith(SKILL_PRUNED_PREFIX)).toBe(true);
  });

  it("parses its own output (round-trip)", () => {
    const m = parseSkillPrunedMarker(formatSkillPrunedMarker("commit flow 2", "path with spaces/SKILL.md"));
    expect(m).toEqual({ name: "commit flow 2", path: "path with spaces/SKILL.md" });
  });

  it("returns undefined for other content", () => {
    expect(parseSkillPrunedMarker("[compacted tool_result x: preview…]")).toBeUndefined();
    expect(parseSkillPrunedMarker("ordinary message")).toBeUndefined();
    expect(parseSkillPrunedMarker("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// tier 0 / tier 1: in-place marker swap, pairing-safe, idempotent
// ---------------------------------------------------------------------------

describe("microcompact — skill-read swap", () => {
  it("a pruned skill read becomes the canonical marker, not the generic stub", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "load the skill" },
      { role: "assistant", content: "", toolCalls: [{ id: SKILL_READ.toolCallId, name: "read_file", arguments: { path: SKILL_READ.path } }] },
      skillReadMessage(),
      // ω-3b hand-check: the skill read used to end its exchange unseen —
      // swapping it was the over-stub the floor closes. The ack makes it SEEN.
      { role: "assistant", content: "skill loaded" },
      ...Array.from({ length: 6 }, (_, i) => ({ role: "user" as const, content: `filler ${i}` })),
    ];
    const out = microcompact(messages, { keepRecent: 1, minChars: 100, skillReads: skillReads() });
    const swapped = out[2];
    expect(swapped?.role).toBe("tool");
    expect((swapped as { content: string }).content).toBe(formatSkillPrunedMarker(SKILL_READ.name, SKILL_READ.path));
    // Pairing-safe: the message (and its toolCallId) survives.
    expect((swapped as { toolCallId: string }).toolCallId).toBe(SKILL_READ.toolCallId);
  });

  it("is idempotent — a marker is never re-processed", () => {
    // ω-3b hand-check: the old shape had no assistant (floor 0 → nothing
    // swapped → the pin ran vacuously). The caller + ack restore the swap.
    const once = microcompact([
      { role: "assistant", content: "", toolCalls: [{ id: SKILL_READ.toolCallId, name: "read_file", arguments: { path: SKILL_READ.path } }] },
      skillReadMessage(bigSkillBody),
      { role: "assistant", content: "loaded" },
      ...Array.from({ length: 2 }, (_, i) => ({ role: "user" as const, content: `f${i}` })),
    ], { keepRecent: 1, minChars: 100, skillReads: skillReads() });
    const marker = once[1];
    expect(marker).toBeDefined();
    const twice = microcompact(once, { keepRecent: 1, minChars: 100, skillReads: skillReads() });
    expect(twice[1]).toEqual(marker);
  });

  it("without skillReads the status-quo stub applies", () => {
    // ω-3b hand-check: same seen-shape repair (caller + ack assistant).
    const messages: AgentMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: SKILL_READ.toolCallId, name: "read_file", arguments: { path: SKILL_READ.path } }] },
      skillReadMessage(),
      { role: "assistant", content: "loaded" },
      { role: "user", content: "x" },
    ];
    const out = microcompact(messages, { keepRecent: 1, minChars: 100 });
    expect((out[1] as { content: string }).content).toContain("[compacted");
  });
});

describe("clearTier — skill-read swap", () => {
  it("a cleared huge skill read becomes the marker", () => {
    const huge = `${"skill body line\n".repeat(3000)}`;
    // ω-3b hand-check: the old shape was a bare orphan result (no assistant —
    // floor 0, nothing clearable). Caller + ack restore the clearing.
    const out = clearTier([
      { role: "assistant", content: "", toolCalls: [{ id: SKILL_READ.toolCallId, name: "read_file", arguments: { path: SKILL_READ.path } }] },
      skillReadMessage(huge),
      { role: "assistant", content: "read it" },
    ], { keepRecent: 0, skillReads: skillReads() });
    expect(out.cleared).toBe(1);
    expect((out.messages[1] as { content: string }).content).toBe(formatSkillPrunedMarker(SKILL_READ.name, SKILL_READ.path));
  });
});

// ---------------------------------------------------------------------------
// tier 2: marker re-injection after the summary (board-isomorphic)
// ---------------------------------------------------------------------------

// ω-3b hand-check: the skill read used to end its exchange unseen — spanning
// (and thus re-injecting) it was the over-stub the floor closes. The ack
// assistant makes the read SEEN, so the tier-2 span still covers it.
const spanWithSkillRead = (): AgentMessage[] => [
  { role: "user", content: "task" },
  { role: "assistant", content: "", toolCalls: [{ id: SKILL_READ.toolCallId, name: "read_file", arguments: { path: SKILL_READ.path } }] },
  skillReadMessage(),
  { role: "assistant", content: "skill loaded" },
  { role: "user", content: "later" },
];

describe("tier2Compact — skill re-injection (M58 §C#11 hybrid)", () => {
  const summarizer: ModelClient = {
    async generate(input: ModelInput): Promise<AssistantMessage> {
      expect(input.messages.length).toBeGreaterThan(0);
      return { role: "assistant", content: "SUMMARY OF THE SPAN" };
    },
  };

  it("the single (most recent) skill's BODY is re-injected after the summary, capped at the line boundary", async () => {
    const t2 = await tier2Compact(spanWithSkillRead(), summarizer, { keepRecent: 1, skillReads: skillReads() });
    expect(t2).not.toBeNull();
    const out = t2!.messages;
    expect(out[0]?.content.startsWith(SUMMARY_MARKER)).toBe(true);
    // The most recent distinct skill gets its body back, not a marker.
    expect(out[1]?.role).toBe("user");
    expect(out[1]?.content.startsWith("[SKILL_REINJECTED:")).toBe(true);
    expect(out[1]?.content).toContain(SKILL_READ.name);
    expect(out[1]?.content).toContain(bigSkillBody.slice(0, 40));
    // Head-capped at 5000 chars (the full body is ~2.8k here, so it fits —
    // the cap is exercised below with a bigger body).
    expect(out[1]!.content.length).toBeLessThanOrEqual(SKILL_REINJECT_CAP_CHARS + 200);
    // No marker for the re-injected skill, and no other skill to mark.
    expect(out.some((m) => m.content.startsWith(SKILL_PRUNED_PREFIX))).toBe(false);
  });

  it("caps a huge skill body at 5000 chars with the line-boundary backoff", async () => {
    const hugeBody = `${"---\nname: big\n---\n"}${"step instruction line\n".repeat(2000)}`;
    // ω-3b hand-check: ack so the read is SEEN (see spanWithSkillRead).
    const span: AgentMessage[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: "", toolCalls: [{ id: SKILL_READ.toolCallId, name: "read_file", arguments: { path: SKILL_READ.path } }] },
      skillReadMessage(hugeBody),
      { role: "assistant", content: "skill loaded" },
      { role: "user", content: "later" },
    ];
    const t2 = await tier2Compact(span, summarizer, { keepRecent: 1, skillReads: skillReads() });
    const body = t2!.messages.find((m) => m.content.startsWith("[SKILL_REINJECTED:"))?.content ?? "";
    const bodyText = body.slice(body.indexOf("\n") + 1);
    expect(bodyText.length).toBeLessThanOrEqual(SKILL_REINJECT_CAP_CHARS);
    expect(bodyText.length).toBeGreaterThan(SKILL_REINJECT_CAP_CHARS - 100);
    // Line-boundary backoff: the cap never cuts mid-line.
    expect(bodyText.endsWith("\n")).toBe(true);
  });

  it("older distinct skills keep their [SKILL_PRUNED] markers; only the most recent body returns", async () => {
    const OLD = { toolCallId: "s0", name: "old-skill", path: ".wudao/skills/old-skill/SKILL.md" };
    const oldBody = "old skill instructions\nsecond line\n";
    const messages: AgentMessage[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: "", toolCalls: [{ id: OLD.toolCallId, name: "read_file", arguments: { path: OLD.path } }] },
      { role: "tool", toolCallId: OLD.toolCallId, name: "read_file", content: oldBody },
      { role: "user", content: "then" },
      { role: "assistant", content: "", toolCalls: [{ id: SKILL_READ.toolCallId, name: "read_file", arguments: { path: SKILL_READ.path } }] },
      skillReadMessage(),
      // ω-3b hand-check: ack so the MOST RECENT read is SEEN and span-covered
      // (this test pins its body re-injection).
      { role: "assistant", content: "skill loaded" },
      { role: "user", content: "later" },
    ];
    const reads = new Map([
      [OLD.toolCallId, { name: OLD.name, path: OLD.path }],
      [SKILL_READ.toolCallId, { name: SKILL_READ.name, path: SKILL_READ.path }],
    ]);
    const t2 = await tier2Compact(messages, summarizer, { keepRecent: 1, skillReads: reads });
    const out = t2!.messages;
    // The OLDER skill keeps exactly one marker…
    const markers = out.filter((m) => m.content.startsWith(SKILL_PRUNED_PREFIX));
    expect(markers).toHaveLength(1);
    expect(markers[0]?.content).toBe(formatSkillPrunedMarker(OLD.name, OLD.path));
    // …the most recent one gets its body (after the marker, before the tail).
    const reinjected = out.find((m) => m.content.startsWith("[SKILL_REINJECTED:"));
    expect(reinjected?.content).toContain(SKILL_READ.name);
    expect(out.indexOf(reinjected!)).toBeGreaterThan(out.indexOf(markers[0]!));
    // The OLD body is gone (the span was replaced; only its marker remains).
    expect(out.some((m) => m.content.includes(oldBody))).toBe(false);
  });

  it("without skillReads nothing is re-injected (status quo)", async () => {
    const t2 = await tier2Compact(spanWithSkillRead(), summarizer, { keepRecent: 1 });
    expect(t2!.messages.some((m) => m.content.startsWith(SKILL_PRUNED_PREFIX))).toBe(false);
    expect(t2!.messages.some((m) => m.content.startsWith("[SKILL_REINJECTED:"))).toBe(false);
  });

  it("re-reads of the same skill collapse to ONE reinjection carrying the LATEST body", async () => {
    const latestBody = "latest version of the skill body\n";
    // ω-3b hand-check: ack so the SECOND read is SEEN and span-covered.
    const messages: AgentMessage[] = [
      ...spanWithSkillRead(),
      { role: "user", content: "again" },
      skillReadMessage(latestBody),
      { role: "assistant", content: "reloaded" },
      { role: "user", content: "end" },
    ];
    const t2 = await tier2Compact(messages, summarizer, { keepRecent: 1, skillReads: skillReads() });
    const reinjected = t2!.messages.filter((m) => m.content.startsWith("[SKILL_REINJECTED:"));
    expect(reinjected).toHaveLength(1);
    expect(reinjected[0]?.content).toContain(latestBody.trim());
    expect(t2!.messages.some((m) => m.content.startsWith(SKILL_PRUNED_PREFIX))).toBe(false);
  });

  it("a skill whose body tier-0/1 already swapped to a marker does not re-inject a marker-as-body (older skills fall back to markers)", async () => {
    // Tier 0/1 ran first and swapped the only skill read into a marker — the
    // body is gone; tier 2 must not present the marker text as a body.
    const span: AgentMessage[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: "", toolCalls: [{ id: SKILL_READ.toolCallId, name: "read_file", arguments: { path: SKILL_READ.path } }] },
      skillReadMessage(formatSkillPrunedMarker(SKILL_READ.name, SKILL_READ.path)),
      { role: "user", content: "later" },
    ];
    const t2 = await tier2Compact(span, summarizer, { keepRecent: 1, skillReads: skillReads() });
    expect(t2!.messages.some((m) => m.content.startsWith("[SKILL_REINJECTED:"))).toBe(false);
    expect(t2!.messages.filter((m) => m.content.startsWith(SKILL_PRUNED_PREFIX))).toHaveLength(1);
  });

  it("PIN (review ruling): when the most recent skill is marker-ized, the OLDER skill's body is what gets re-injected", async () => {
    // Two skills: OLD still has its body; RECENT was already tier-0/1
    // marker-ized. The selection is latest-WITH-BODY by decision — a marker
    // presented as a body would be worse than an older real body, so OLD's
    // body is re-injected and RECENT keeps its marker.
    const OLD = { toolCallId: "s0", name: "old-skill", path: ".wudao/skills/old-skill/SKILL.md" };
    const oldBody = "old skill instructions\nsecond line\n";
    const messages: AgentMessage[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: "", toolCalls: [{ id: OLD.toolCallId, name: "read_file", arguments: { path: OLD.path } }] },
      { role: "tool", toolCallId: OLD.toolCallId, name: "read_file", content: oldBody },
      { role: "user", content: "then" },
      { role: "assistant", content: "", toolCalls: [{ id: SKILL_READ.toolCallId, name: "read_file", arguments: { path: SKILL_READ.path } }] },
      skillReadMessage(formatSkillPrunedMarker(SKILL_READ.name, SKILL_READ.path)),
      { role: "user", content: "later" },
    ];
    const reads = new Map([
      [OLD.toolCallId, { name: OLD.name, path: OLD.path }],
      [SKILL_READ.toolCallId, { name: SKILL_READ.name, path: SKILL_READ.path }],
    ]);
    const t2 = await tier2Compact(messages, summarizer, { keepRecent: 1, skillReads: reads });
    const out = t2!.messages;
    // The OLDER skill's body is the one re-injected…
    const reinjected = out.find((m) => m.content.startsWith("[SKILL_REINJECTED:"));
    expect(reinjected?.content).toContain(OLD.name);
    expect(reinjected?.content).toContain(oldBody.trim());
    // …and the marker-ized most-recent skill keeps its marker (exactly one,
    // and the marker text is never presented as a body).
    const markers = out.filter((m) => m.content.startsWith(SKILL_PRUNED_PREFIX));
    expect(markers).toHaveLength(1);
    expect(markers[0]?.content).toBe(formatSkillPrunedMarker(SKILL_READ.name, SKILL_READ.path));
    expect(reinjected?.content.startsWith(SKILL_PRUNED_PREFIX)).toBe(false);
  });

  it("the static fallback re-injects identically", () => {
    const t2 = staticTier2Compact(spanWithSkillRead(), { keepRecent: 1, skillReads: skillReads() });
    expect(t2!.messages[1]?.content.startsWith("[SKILL_REINJECTED:")).toBe(true);
    expect(t2!.messages[1]?.content).toContain(bigSkillBody.slice(0, 40));
  });

  it("board restore, skill markers, and the reinjected body coexist (board first, body last)", async () => {
    // ω-3b hand-check: ack so the read is SEEN (see spanWithSkillRead).
    const messages: AgentMessage[] = [
      { role: "user", content: "[todo board 0/1 done]\n◐ only step" },
      { role: "assistant", content: "", toolCalls: [{ id: SKILL_READ.toolCallId, name: "read_file", arguments: { path: SKILL_READ.path } }] },
      skillReadMessage(),
      { role: "assistant", content: "skill loaded" },
      { role: "user", content: "tail" },
    ];
    const t2 = await tier2Compact(messages, summarizer, { keepRecent: 1, skillReads: skillReads() });
    const out = t2!.messages;
    expect(out[0]?.content.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(out[1]?.content.startsWith("[todo board")).toBe(true);
    expect(out[2]?.content.startsWith("[SKILL_REINJECTED:")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loop integration: the classifier feeds the map; compaction consumes it
// ---------------------------------------------------------------------------

describe("runAgentLoop — skill-read tracking", () => {
  it("a successful read_file of a classified skill is tracked and survives compaction as a marker", async () => {
    const fakeRead: Tool = {
      name: "read_file",
      description: "returns the skill body",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async (args) => ({
        // The skill body is compactable (minChars 10); the OTHER read is a
        // huge filler that pushes occupancy over the threshold only AFTER it
        // lands — so compaction runs at the turn-1 boundary, with the skill
        // read already outside the keep-recent window.
        content: (args as { path?: string }).path === SKILL_READ.path ? bigSkillBody : `${"filler line\n".repeat(400)}`,
      }),
    };
    // Turn 0 reads the skill; turn 1 reads something ELSE (keeps the
    // loop-safety net quiet); the boundary compaction after turn 1 finds the
    // skill read outside the keep-recent window → tier-1 marker swap.
    const responses: AssistantMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "s1", name: "read_file", arguments: { path: SKILL_READ.path } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "s2", name: "read_file", arguments: { path: "other.txt" } }] },
      { role: "assistant", content: "done" },
    ];
    let call = 0;
    const model: ModelClient = {
      async generate(): Promise<AssistantMessage> {
        const r = responses[call];
        call += 1;
        if (!r) throw new Error("exhausted");
        return r;
      },
    };
    const state: AgentState = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }],
      tools: [fakeRead],
      status: "idle",
    };
    let compacted = false;
    const gen = runAgentLoop(state, model, {
      maxTurns: 5,
      gates: { todo: false, verify: false },
      compaction: {
        contextWindowTokens: 625, // threshold 500: crossed only once the filler lands
        keepRecent: 1,
        minChars: 10,
        classifySkillRead: (toolName, args) =>
          toolName === "read_file" && args["path"] === SKILL_READ.path ? { name: SKILL_READ.name, path: SKILL_READ.path } : undefined,
      },
    });
    for (;;) {
      const { done, value } = await gen.next();
      if (done) break;
      if ((value as { type: string }).type === "compacted") compacted = true;
    }
    expect(compacted).toBe(true);
    expect(state.messages.some((m) => m.role === "tool" && m.content === formatSkillPrunedMarker(SKILL_READ.name, SKILL_READ.path))).toBe(true);
  });

  it("a FAILED read is not tracked (its content never entered context)", async () => {
    const boom: Tool = {
      name: "read_file",
      description: "fails",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async () => { throw new Error("disk fell over"); },
    };
    // Turn 0's read FAILS; the boundary compaction escalates to tier 2 (the
    // error result is the last message — nothing to microcompact), and the
    // summarizer shares this scripted model (call 2). No marker anywhere.
    const responses: AssistantMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "s1", name: "read_file", arguments: { path: SKILL_READ.path } }] },
      { role: "assistant", content: "SUMMARY-BYTES" },
      { role: "assistant", content: "gave up" },
    ];
    let call = 0;
    const model: ModelClient = {
      async generate(): Promise<AssistantMessage> {
        const r = responses[call];
        call += 1;
        if (!r) throw new Error("exhausted");
        return r;
      },
    };
    const state: AgentState = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }],
      tools: [boom],
      status: "idle",
    };
    const gen = runAgentLoop(state, model, {
      maxTurns: 5,
      gates: { todo: false, verify: false },
      compaction: {
        contextWindowTokens: 10,
        keepRecent: 1,
        minChars: 10,
        classifySkillRead: () => ({ name: SKILL_READ.name, path: SKILL_READ.path }),
      },
    });
    for (;;) {
      const { done } = await gen.next();
      if (done) break;
    }
    expect(state.messages.some((m) => m.content.startsWith(SKILL_PRUNED_PREFIX))).toBe(false);
  });
});
