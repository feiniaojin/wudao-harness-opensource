// Selecting which post-run messages still need persisting. Tier-2 compaction
// replaces state.messages wholesale with [summaryMessage, ...kept] — a much
// shorter array — so an index captured before the run (the old
// slice(preRunCount)) selects nothing or the wrong elements. Selection here is
// identity-based against the loaded history instead.
import { SUMMARY_MARKER, COMPACTION_STUB_PREFIX, CLEARED_MARKER, EMERGENCY_DROP_PREFIX, SKILL_PRUNED_PREFIX, type AgentMessage } from "@wudao/core";

/** Messages to append after a run: NOT identity-in the loaded history (already
 *  persisted), NOT a summary marker (persisted at event time), NOT a microcompact
 *  stub, a tier-0 cleared marker, an emergency-drop marker, or a skill-pruned
 *  marker (all four are
 *  runtime re-derivations — re-derived (or harmlessly absent) at the NEXT
 *  compaction, never rebuilt on load; resume only repairs any unpaired
 *  tool_use via repairOrphanedToolCalls. Persisting any of them would
 *  corrupt resume: a cleared
 *  message would duplicate its toolCallId beside the retained original, an
 *  emergency marker would claim messages were removed that resume just
 *  restored and would permanently disarm emergencyDrop's idempotence check,
 *  a skill-pruned marker would duplicate its toolCallId (tool shape) or
 *  duplicate the tier-2 skill boundary (user shape) beside the retained
 *  originals). Role-gated to the exact shapes compaction produces: tier-2,
 *  emergency, and skill-pruned user markers are user messages; stubs/clears
 *  and skill-pruned tool markers are tool messages — an assistant message
 *  merely QUOTING a marker prefix is real content and must be persisted. The
 *  cleared shape is matched by PREFIX: since ω-2b (I3) the marker carries the
 *  session_result recovery pointer on a second line. */
export function selectMessagesToPersist(
  messages: readonly AgentMessage[],
  loaded: readonly AgentMessage[],
): AgentMessage[] {
  const loadedSet = new Set(loaded);
  return messages.filter(
    (m) => !loadedSet.has(m)
      && !(m.role === "user" && (m.content.startsWith(SUMMARY_MARKER) || m.content.startsWith(EMERGENCY_DROP_PREFIX) || m.content.startsWith(SKILL_PRUNED_PREFIX)))
      && !(m.role === "tool" && (m.content.startsWith(COMPACTION_STUB_PREFIX) || m.content.startsWith(CLEARED_MARKER) || m.content.startsWith(SKILL_PRUNED_PREFIX))),
  );
}
