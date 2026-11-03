# 02 — Loop first

The agent loop (`packages/core/src/loop.ts`, `runAgentLoop`) is the organ
everything else serves. Read it top to bottom once; after that, every feature
you meet is one of five things riding the loop.

## The shape

```ts
const gen = runAgentLoop(state, model, options);   // async generator
for (;;) {
  const r = await gen.next();
  if (r.done) return r.value;                       // Terminal: {reason}
  handle(r.value);                                  // a typed LoopEvent
}
```

- **`state: AgentState`** — mutable runtime truth (`systemPrompt`, `messages`,
  `tools`, `status`). The loop mutates it; callers hold the same reference
  (that is how the TUI's context probe and the fork seam stay live).
- **`model: ModelClient`** — the only provider seam core knows. A port, not
  an SDK: `generate(input)` / `stream(input)`. Adapters live in
  `packages/providers`.
- **`options`** — gates, hooks, permissions (`canUseTool`), compaction,
  steering, MetaNotes, signal. All optional; the loop degrades, never crashes,
  when a seam is absent.

The body is `for (;;)`, **not recursion**: each turn goes
occupancy-check → (maybe compact) → model call → tool calls → turn boundary.
No stack growth, one place to abort, and every continuation reason is a typed
`Terminal` (`done`, `max_turns`, `aborted`, …) or event, never an exception.

## The turn, in order

1. **Fuse check** — turn budget; on the final turn a last-chance
   "[system note: turn limit reached]" nudge.
2. **Compaction check** — occupancy = `max(estimate, lastRealUsage)`; at
   threshold set `pendingCompaction` (compact at the boundary); at
   threshold+8k compact NOW (tier 0 clear → tier 1 microcompact → tier 2
   summary → M52 dual summary when the turn itself overflows).
3. **Steering drain** — queued user texts enter as plain user messages.
4. **MetaNote projection** — system-class notes ride the last tool_result
   tail; `state.messages` keeps the ORIGINAL bytes (projection-only).
5. **Model call** — the exit signal is "a tool_use block arrived"
   (`stop_reason === "tool_use"` is unreliable).
6. **Tool calls** — gate (`canUseTool`) → execute (concurrently when safe) →
   push results; failures become error RESULTS, never throws.
7. **Turn boundary** — pending compaction fires here (the prefix stays warm
   for the call that just went out).

## The five things a feature can be

| Riding the loop as… | Examples |
| --- | --- |
| a Tool | read/write/edit/grep/glob/shell, task, ask_user, ctx_inspect |
| an Event | `compacted`, `defer_loaded`, `loop_detected`, `meta_note` |
| a Gate (loop-visible stop condition) | todo board, verify-before-done, plan mode |
| a Projection (changes what the model sees, never the history) | MetaNotes, mention expansion, summary markers |
| an Extension seam (one unified point) | subagents, skills, MCP, plugins, extensions |

If a proposed feature fits none of these, that is a design smell — bring it
to an ADR before writing it.

## Reading path after this page

`loop.ts` → `tool.ts` (`buildTool`, fail-closed defaults) →
`compaction.ts` (the tiers) → `session/store.ts` (append-only JSONL) →
`packages/cli/src/driver/agent-driver.ts` (how a frontend drives the loop).
