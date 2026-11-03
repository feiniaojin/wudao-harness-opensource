# 01 — Constants first

Every mechanism in this repo is anchored by a small set of named constants.
Learn them BEFORE the mechanisms: when you later read code, the magic numbers
will already have names, homes, and rationales. Each row: the constant, where
it lives, and the one-line why.

## Occupancy and compaction budget

| Constant | Value | Home | Why |
| --- | --- | --- | --- |
| chars-per-token estimate | `~4` (`estimateTokens`) | `core/src/compaction.ts` | A deterministic proxy for provider tokenizers — the whole harness AGREES on one estimate so the loop, the status bar, and `ctx_inspect` never disagree. |
| compaction threshold | `0.8 × contextWindowTokens` | `core/src/loop.ts` | Compact at 80%: early enough to avoid a 413, late enough to keep the prefix cache warm. |
| defer band | `8192` tokens (`COMPACT_DEFER_BAND_TOKENS`) | `core/src/loop.ts` | Between threshold and threshold+8k, let the current call go out warm and compact at the turn boundary; past it, compact immediately. |
| keepRecent | `6` messages | every compaction tier | The active working set no tier may summarize away. |
| clear tier floor | `30,000` chars (`CLEAR_TIER_MIN_CHARS`) | `core/src/compaction.ts` | Tier 0 only touches results this huge — content that is worthless once old. |
| microcompact floor | `1,000` chars (`minChars` default) | `core/src/compaction.ts` | Tier 1 stubs the merely large, keeping a 100-char preview. |
| summary replay cap | `24,000` chars (`SUMMARY_SPAN_CAP_CHARS`) | `core/src/compaction.ts` | The summary call replays a byte-identical PREFIX of the span; the cut is at the tail, so the prefix cache keeps hitting. |
| dual turn-prefix budget | `12,000` chars (`DUAL_TURN_PREFIX_CHARS`) | `core/src/compaction.ts` | M52: when ONE turn overflows the window, this much of its head gets dual-summarized; the tail survives verbatim. |

## Frozen strings (protocol, not prose)

| Marker | Meaning |
| --- | --- |
| `[compacted summary]` (`SUMMARY_MARKER`) | A tier-2 summary message. Byte-frozen once written; resume projections key off it. |
| `[End of summary — respond to the user below, not to the summary]` | Weak models kept answering the summary; this line draws the boundary. |
| `[Old tool result content cleared]` (`CLEARED_MARKER`) | Tier 0's deterministic replacement. |
| `[compacted tool_result …]` (`COMPACTION_STUB_PREFIX`) | Tier 1's stub + 100-char preview. |
| `[SKILL_PRUNED: <name> — reload with read_file <path>]` | A pruned skill read degrades to a reload pointer, never silent loss. |

Change any of these and old sessions stop loading correctly — they are
**protocol constants**, treated like wire formats.

## Loop and UI shapes

| Constant | Value | Why |
| --- | --- | --- |
| `DEFAULT_MAX_TURNS` | `200` | A runaway fuse, not the stop condition — long tasks are driven by todo gates. |
| stop-gate insist cap | `3` (`maxInsists`) | A gate nudges at most three times before it trusts the model's stop. |
| session history | `100` entries (TUI + REPL) | The human-scale recency window. |
| diff render cap | `50,000` chars (`DIFF_CAP_CHARS`) | A pathological diff must not blow up the terminal render. |
| result preview | `200` chars | History entries carry previews, not payloads. |

## The rule behind the table

New code with a tunable number must name it, place it next to its mechanism,
and record the why here or beside the constant. An unnamed number in a
condition is a review blocker — not because numbers are bad, but because the
next reader must be able to find the DECISION, not just the arithmetic.
