# 04 — Where the design came from (comparison table)

wudao-harness learned from the reference projects in this workspace; nothing
was copied wholesale. This table maps each mechanism to its primary reference,
what was inherited, and where we deliberately diverged. Full inventories:
`docs/research/02` (projects) and `docs/research/03` (design DNA).

| Mechanism | Primary reference | Inherited | Deliberate divergence |
| --- | --- | --- | --- |
| Agent loop (generator, mutable state) | claude-code-sourcemap `query.ts` | while-true + typed transitions; exit-on-tool_use-block | Turn loop kept under ~900 lines with the five-seam feature model instead of a 4000-file surface |
| Tool factory (fail-closed) | claude-code-sourcemap `Tool.ts` | `buildTool` defaults (`isReadOnly:false`, destructive-until-annotated) | Zero-dep core; annotations extended in M51 for the sidecar (`inputsEquivalent`, `interruptBehavior`) |
| Permission pipeline | claude-code-sourcemap permissions + OpenHarness | deny-first layering; hot-reload receipts; protected runtime-policy writes | One `decideRichPermission` pure function all four frontends share (REPL/TUI/web/one-shot) |
| Cheapest-first compaction | claude-code-sourcemap compact + pi | tier order (clear → stub → summarize); keep-recent window; board restore | M52 pi correctness pack: all-tier boundary alignment, dual merged summary, chained spans via session entries, `reason: manual/threshold/overflow` |
| Session store (append-only JSONL) | claude-code-sourcemap sessionStorage | UUID + parent chain; resume repair; non-message entries (M35) | `compact_boundary` entries record chain heads (M52) instead of relying on inline markers alone |
| Prefix-cache discipline | deepseek-harness | byte-stable system prompt; warm-replay summary calls; append-only history | Cache hit is asserted in evals (det-06/det-12), not just encouraged |
| Reasoning-model adaptation | deepseek-harness + DeepSeek-Reasonix | `reasoning_content` streaming; `reasoning_effort`; replay-only-on-tool-turn | Provider matrix (wudao/DeepSeek/GLM/Qwen) behind one OpenAI-compatible adapter |
| Subagents | claude-code-sourcemap forkedAgent + hive | child ToolUseContext isolation; sidechain JSONL; clone fanout | Orchestration rides ONE task tool + roster (roles as data, not code) |
| Deterministic workflows | claude-code workflow-engine (CCB) | JS engine + journal + ports | Kept optional — the model-first path remains the default orchestrator |
| Runner middleware | open-harness `runner.ts` | middleware pipeline shape | Collapsed into loop options/hooks — fewer layers, same seams |
| Eval discipline | better-harness + ai-agent-book Ch6 | deterministic + behavioral split | Every milestone ships its det suite in-repo (37 and counting) |
| Context visibility | CC `/context` + CCB CtxInspect | count over the REAL projection; per-server/per-section breakdown | One shared `occupancyBreakdown` feeds both the `ctx_inspect` tool and `/context` |
| Onboarding docs | learn-claude-code | constants-first, loop-first ordering; motto-per-mechanism | This series — recomposed for THIS codebase, not a tour of the references |

## What we consciously did NOT inherit

- **mini-pi's architecture** — demo-grade; used only to sanity-check abstraction
  boundaries (four context layers, loop ≠ harness).
- **Vercel AI SDK / Strands as the loop** — the loop is built from zero; SDKs
  hide exactly the internals this project exists to master.
- **Reference scale** — paradigms, not file counts. Nothing here mirrors the
  real CC's 4000-file surface.

## Rules for borrowing more

1. Check `docs/research/02` for the project and `06`'s index for the file.
2. Port the INVARIANT (what must stay true), then write the deterministic test
   that pins it — before the implementation.
3. Record the divergence (if any) in the ADR list or this table.
