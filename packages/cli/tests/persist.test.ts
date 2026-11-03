import { describe, it, expect } from "vitest";
import { selectMessagesToPersist } from "../src/persist.js";
import { SUMMARY_MARKER, CLEARED_MARKER, EMERGENCY_DROP_PREFIX, SKILL_PRUNED_PREFIX, toolResultRef, type AgentMessage } from "@wudao-org/core";

describe("selectMessagesToPersist", () => {
  it("excludes messages that are identity-in the loaded history (already persisted)", () => {
    const a: AgentMessage = { role: "user", content: "old question" };
    const b: AgentMessage = { role: "assistant", content: "old answer" };
    const loaded = [a, b];
    // Same SHAPES, different identities (this run's new objects) — must persist.
    const fresh: AgentMessage = { role: "user", content: "old question" };
    const out = selectMessagesToPersist([...loaded, fresh], loaded);
    expect(out).toEqual([fresh]);
  });

  it("includes new messages after the loaded history", () => {
    const a: AgentMessage = { role: "user", content: "q" };
    const reply: AgentMessage = { role: "assistant", content: "a" };
    const tool: AgentMessage = { role: "tool", toolCallId: "t1", name: "read_file", content: "..." };
    const out = selectMessagesToPersist([a, reply, tool], [a]);
    expect(out).toEqual([reply, tool]);
  });

  it("excludes tier-2 summary markers (persisted at compacted-event time)", () => {
    const marker: AgentMessage = { role: "user", content: `${SUMMARY_MARKER} done stuff` };
    const fresh: AgentMessage = { role: "user", content: "next" };
    const out = selectMessagesToPersist([marker, fresh], []);
    expect(out).toEqual([fresh]);
  });

  it("excludes microcompact stubs (re-derived from persisted originals on load)", () => {
    const stub: AgentMessage = { role: "tool", toolCallId: "t1", name: "grep", content: "[compacted 4000 chars]" };
    const fresh: AgentMessage = { role: "assistant", content: "answer" };
    const out = selectMessagesToPersist([stub, fresh], []);
    expect(out).toEqual([fresh]);
  });

  it("excludes tier-0 cleared markers (M34: re-derived from persisted originals on load)", () => {
    const cleared: AgentMessage = { role: "tool", toolCallId: "t1", name: "read_file", content: "[Old tool result content cleared]" };
    const fresh: AgentMessage = { role: "assistant", content: "answer" };
    const out = selectMessagesToPersist([cleared, fresh], []);
    expect(out).toEqual([fresh]);
  });

  it("ω-2b R1: excludes the TWO-LINE cleared shape (marker + recovery pointer) — persisting it would duplicate the toolCallId against the retained original", () => {
    // Exactly what clearTier emits since ω-2b (I3): the marker line plus the
    // session_result recovery pointer naming the ORIGINAL bytes.
    const clearedShape = `${CLEARED_MARKER}\nfull original retained in this session; recover with session_result(tool_call_id="t1", result_ref="${toolResultRef("t1", "the original big body")}")`;
    const cleared: AgentMessage = { role: "tool", toolCallId: "t1", name: "read_file", content: clearedShape };
    const fresh: AgentMessage = { role: "assistant", content: "answer" };
    const out = selectMessagesToPersist([cleared, fresh], []);
    // If the derived cleared message were persisted, the JSONL would carry it
    // BESIDE the original (same toolCallId) — resume rebuilds a history with
    // duplicate tool ids (provider 400) and session_result sees an ambiguity.
    expect(out).toEqual([fresh]);
  });

  it("ω-2b R1: excludes emergency-drop markers (never persisted; resume re-derives from the originals)", () => {
    const marker: AgentMessage = { role: "user", content: `${EMERGENCY_DROP_PREFIX} 5 oldest messages were removed to fit the context window — the full history remains in the session file]` };
    const fresh: AgentMessage = { role: "assistant", content: "answer" };
    const out = selectMessagesToPersist([marker, fresh], []);
    // A persisted marker would (a) claim messages were removed that resume
    // just restored, and (b) permanently disarm emergencyDrop's idempotence
    // check (every future reactive corner → hard error).
    expect(out).toEqual([fresh]);
  });

  it("does not treat assistant messages quoting markers as markers", () => {
    const loaded: AgentMessage[] = [];
    const messages: AgentMessage[] = [
      { role: "assistant", content: "[compacted summary] (this is a quote)" },
    ];
    expect(selectMessagesToPersist(messages, loaded)).toEqual(messages); // must be persisted
  });

  it("ω-2b carry #1: excludes tool-message SKILL_PRUNED markers (microcompact skill-read re-derivations) — persisting them would corrupt resume", () => {
    // Exactly what microcompact emits at compaction.ts:404 when the tool was a
    // pruned skill read: the role is "tool", and content is the canonical
    // [SKILL_PRUNED: name — reload with read_file path] marker.
    const marker: AgentMessage = {
      role: "tool",
      toolCallId: "t1",
      name: "read_file",
      content: `${SKILL_PRUNED_PREFIX} foo — reload with read_file /tmp/x]`,
    };
    const fresh: AgentMessage = { role: "assistant", content: "answer" };
    const out = selectMessagesToPersist([marker, fresh], []);
    // If the derived SKILL_PRUNED tool message were persisted, the JSONL would
    // carry it BESIDE the original (same toolCallId) — resume rebuilds a
    // history with duplicate tool ids (provider 400) and the reload pointer
    // baked into the marker is wasted (the marker is just a deterministically
    // re-derived cache-clearing stub, not an instruction the model needs
    // twice).
    expect(out).toEqual([fresh]);
  });

  it("ω-2b carry #1: excludes user-message SKILL_PRUNED markers (tier-2 skill-reinjection side-markers) — persisting them would duplicate the tier-2 boundary", () => {
    // Exactly what tier-2 emits at compaction.ts:970 for every distinct skill
    // OTHER than the most recent (which gets a SKILL_REINJECTED body): a
    // user-role canonical marker pointing back at the skill file.
    const marker: AgentMessage = {
      role: "user",
      content: `${SKILL_PRUNED_PREFIX} foo — reload with read_file /tmp/x]`,
    };
    const fresh: AgentMessage = { role: "assistant", content: "answer" };
    const out = selectMessagesToPersist([marker, fresh], []);
    // A persisted user-role SKILL_PRUNED marker would (a) survive resume and
    // get re-injected into the next compact span (marker keeps its prefix,
    // already-marked compaction.ts:958 short-circuit) — but (b) duplicate the
    // boundary role that tier-2 already emits deterministically from the
    // originals, bloating JSONL with re-derivable state. Marker consumers
    // key on prefix, never on identity; persisting it breaks resume parity.
    expect(out).toEqual([fresh]);
  });

  it("post-tier-2 array (marker + kept originals + new) persists only the new messages", () => {
    const m1: AgentMessage = { role: "user", content: "old q1" };
    const m2: AgentMessage = { role: "assistant", content: "old a1" };
    const m3: AgentMessage = { role: "user", content: "kept q" };
    const loaded = [m1, m2, m3];
    const marker: AgentMessage = { role: "user", content: `${SUMMARY_MARKER} summarized m1+m2` };
    const prompt: AgentMessage = { role: "user", content: "new prompt" };
    const answer: AgentMessage = { role: "assistant", content: "new answer" };
    // What the loop leaves behind after tier-2 compact + one more exchange.
    const afterRun = [marker, m3, prompt, answer];
    expect(selectMessagesToPersist(afterRun, loaded)).toEqual([prompt, answer]);
  });
});
