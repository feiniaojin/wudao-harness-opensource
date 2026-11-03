# 03 — One motto per mechanism

The compressed index. Each motto is the invariant the mechanism defends; when
code seems to violate the motto, one of you is wrong — check which.

## The kernel

| Mechanism | Motto |
| --- | --- |
| Agent loop | **A generator over mutable state — never recursion, never exceptions for control flow.** |
| Loop exit | **The turn ends because a tool_use block arrived — trust the block, not `stop_reason`.** |
| Tool interface | **Fail closed: unannotated means destructive, unknown means ask.** |
| Permissions | **Deny outranks everything; the runtime-policy file always reaches a human.** |
| Events vs hooks | **Events observe (a listener failure is isolated); hooks intercept (a veto stops the world).** |

## Context as a budget

| Mechanism | Motto |
| --- | --- |
| Occupancy | **One estimate everywhere — the loop, the bar, and ctx_inspect quote the same number.** |
| Compaction tiers | **Cheapest first: clear, then stub, then summarize, then dual-summarize.** |
| Boundaries | **Never cut at a tool result — the pair moves together.** |
| Single-turn overflow | **Summarize the turn's head and its history — never drop a whole turn.** |
| Chained spans | **Each summary covers only what came after the previous one; frozen bytes are never re-summarized.** |
| Projection | **Change what the model sees, never what the transcript says.** |
| Prefix cache | **Append-only is not a style preference; it is the cache-hit invariant.** |
| Ghost skills | **A pruned skill leaves a reload pointer, never silence.** |

## Persistence and resume

| Mechanism | Motto |
| --- | --- |
| Sessions | **Append-only JSONL; every line has a parent; the file is the truth.** |
| Compaction boundary | **Record where the kept region began — as a session entry, so the chain survives resume.** |
| Orphaned tool calls | **Repair at load; the next model call must be provider-legal.** |
| Rewind | **Files roll back; the transcript only annotates.** |

## Extension surface

| Mechanism | Motto |
| --- | --- |
| Subagents | **A child ToolUseContext, not a new process — isolated asks, shared budget.** |
| Steering | **A queued text drains before the next call — never interrupts, never interleaves.** |
| Deferred tools | **Big definitions hide behind load_tools until the model asks.** |
| Stop gates | **Nudge at most three times, then trust the stop.** |
| Sidecar | **Auto mode classifies first; a high verdict escalates, a breaker trips to the human.** |
| ctx_inspect / /context | **The model — and you — see the real projected occupancy, not a guess.** |

## Working agreements

| Agreement | Motto |
| --- | --- |
| Deterministic acceptance | **A milestone lands with a deterministic test, or it hasn't landed.** |
| Zero new deps in core | **Core depends on ports (`ModelClient`, `Tool`), not packages.** |
| Reasoning models | **Stable system-prompt prefix, reasoning streamed separately, thinking preserved.** |

Carry this page in your head; grep the rest.
