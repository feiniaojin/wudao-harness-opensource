# Architecture

How wudao-harness is put together: the architectural pattern and its name, package structure, the design tensions the code enforces and where each lives, and the three data flows that matter most (request construction, the compaction ladder, orchestration). Companion to the [README](../README.md) (user-facing), `docs/research/` (why it looks this way — the design DNA study is `03-design-dna-and-recommendations.md`), and `docs/adr/` (one-page decisions, each ≤40 lines).

## The pattern: a Trust-Laddered Hybrid Kernel

The shape has a name because it is now deliberate, not emergent: **Trust-Laddered Hybrid Kernel** — *hybrid* because correctness invariants live inside a zero-dependency kernel while deployment policy lives at the edge, *trust-laddered* because everything extensible is sorted into four rungs of trust instead of one flat plugin API. Four package layers, four rungs, one kernel.

Two claims make the name load-bearing:

1. **The kernel is invariant-native.** Byte-stable request serialization, the append-only session ledger, the permission pipeline, fail-closed tool construction, pairing-safe compaction — these are *structure*, not conventions. An extension cannot opt out of them because there is no seam through which it could.
2. **The kernel is policy-free.** Since M41, core holds *mechanisms* and *protocol constants* only. Every operating point a deployer could reasonably choose differently — registry concurrency, live-agent cap, child turn budget, grace-turn whitelist — is a required constructor parameter; the CLI supplies the values from one file (`packages/cli/src/kernel-policy.ts`), and tests pin them there. A grep of `packages/core/src` for swappable opinion comes back with protocol strings and mechanism calibration only (audit table below).

The counterexample both claims are argued against is the **full-plugin microkernel** — everything is an extension, the kernel is minimal, invariants are enforced by convention and test. That model is real and works; the honest comparison is in [§ vs the full-plugin microkernel](#vs-the-full-plugin-microkernel). The short version: retrofitting invariants onto a plugin substrate costs companion machinery and eternal vigilance; keeping them native costs kernel changes when a *new* cross-cutting invariant appears. We chose the second cost because our invariants (prefix-cache byte stability above all, `docs/research/05`) are exactly the kind plugins are worst at honoring.

### Mechanism/policy inventory

Where each module's mechanism ends and someone's policy begins. This table is the M41 purity audit, maintained as documentation — a new hardcoded "default a deployer could pick differently" in core is a bug against it.

| Module | Mechanism (in core) | Policy (outside core) | Notes |
| --- | --- | --- | --- |
| `loop.ts` | typed transitions, exit-on-no-tool-use, gates engine, turn-fuse *mechanism* | fuse value (longTask `maxTurnsFuse`, `WUDAO_MAX_TURNS`), gate toggles per run | fuse default `200` is a safety bound, cli-supplied at every entry |
| `tools/*`, `tool.ts` | capability + risk annotations, fail-closed `buildTool`, argument validation | which tools exist in a set, sandbox flags, MCP servers | a tool never decides permission |
| `compaction.ts` | cheapest-first ladder, pairing safety, marker protocol (`SUMMARY_MARKER`…) | thresholds & keep-recent calibration (overridable per call, eval-pinned) | calibration is mechanism tuning, not deployment operating point |
| `session/` | append-only JSONL, sidechains, orphan repair | store location, what you resume | ledger format is protocol |
| `agents/registry.ts` | slot scheduling, hard-cap gate, budget-fuse grace, wall-clock timeout, receipts | **all operating points required at construction** — `kernel-policy.ts` (M41) + #47 defaultTimeoutMs | maxConcurrent 3, hardCap 16, childTurns 20, graceTools `todo_write`, backgroundTimeoutMs 30m; task-tool timeoutMs clamped [30s, 1h] |
| `agents/roster.ts` | builtin < plugin < workspace layering, frozen-role rules, receipt chain | role *values*: prompts, tool sets, budgets — `.wudao/agents/`, plugins | builtin roles are vocabulary, shadowable |
| `subagent.ts` | isolation, fork prefix-sharing, refused-tool set, grace semantics | the child's turn fuse — stated by every caller (M41) | no default remains in core |
| `providers/` | `ModelClient` port, canonical serializer, reasoning matrix | provider/model/effort choice per session | port is protocol, profiles are data |
| `cli/permission.ts` | 5-layer pipeline, bypass-immune steps, mode semantics | deny/allow/ask *rules*, which mode | same `shell` under every mode |
| `cli/hooks-config.ts` + hooks seams | event bus, interception points, isolation/timeouts | which commands/hooks run, their config | fail-open convenience, not a security boundary |
| skills / plugins / extensions | discovery, registries, `ext_` namespace, timeouts | the packs themselves | see the ladder below |

### vs the full-plugin microkernel

Fair comparison, sources cited:

- **pi** (`docs/research/07`): ~40 typed events, first-class registries for tools, commands, providers, renderers; the agent is assembled almost entirely from extensions. Gains: maximal flexibility, ecosystem reuse (skills, keybindings), a small core to maintain. Costs we did not accept: the invariants that matter to us are *postures* there — pi ships no built-in permission layer and runs extensions in-process unsandboxed, so the trust decision is delegated to the user at install time. We kept pi's extension *shapes* (skills layout, `appendEntry`, keybinding registry) and rejected its trust model.
- **deepseek-harness** (`docs/research/05`): a pluginized runtime whose prefix-cache invariants had to be *added back* — a runtime companion rebuilds every request from the session log and diffs it, an e2e gate requires positive cache-read tokens, per-package READMEs must carry a "KV Cache effect" section. That is what it looks like when the substrate does not structurally guarantee the invariant: enforcement becomes external machinery and institutional discipline, forever.
- **wudao-harness**: the invariant is the kernel's shape (one canonical serializer, append-only ledger, projection-not-rewrite). The price is paid in the other direction — a genuinely new cross-cutting invariant means a kernel change, and the extension API will not grow invisible structural powers. The four-rung ladder exists precisely so the *common* extension cases (content, config, out-of-process tools, in-process code) never need to touch the kernel.

### The extension ladder (four rungs of trust)

Sorted by what you must trust when you install something. Each rung is a deliberate capability/risk trade — moving a surface up a rung requires arguing it in an ADR.

| Rung | Surface | Capability | Risk / blast radius | Guardrails |
| --- | --- | --- | --- | --- |
| 1 — declarative data | `.wudao/settings.json`, role profiles, keybindings, MCP config, workflow args | reshape operating points, roster, prompts; wire servers | wrong values misconfigure *your* run | parse-time validation, fail-closed degradation, displacement receipts |
| 2 — prompt-visible content | skills, plugin assets (commands/agents/skills) | change what the model knows and is told | no execution; shifts prompt *tail* bytes → one cold prefix per change | tail-only placement, collision warnings, pinned by `det-15`/`det-26` |
| 3 — out-of-process programs | config hooks (commands), MCP servers | run programs with your privileges, outside the loop; I/O re-enters through validated seams | the program itself (read hook scripts before configuring them) | per-call timeouts, observer/interceptor failure semantics, JSON-RPC validation |
| 4 — in-process code | extensions (`.wudao/extensions/*.mjs`), workflow scripts | full `ExtensionAPI`: tools, commands, events; workflows orchestrate `task` calls programmatically | code executes in-process with full user privileges; no sandbox, no kill switch short of deletion | handler isolation + timeouts, `ext_` namespace, full permission pipeline, parent-level tools; workflows: determinism tripwires + journal replay |

## Package structure

```
wudao-harness/
├── packages/
│   ├── core/        @wudao/core — the harness runtime. ZERO runtime deps, imports no provider.
│   │   ├── loop.ts            runAgentLoop: async generator, typed transitions, exit-on-no-tool_use,
│   │   │                      steering/metaNote drains, gates, abort
│   │   ├── tool.ts            Tool interface + fail-closed buildTool + validateToolArguments
│   │   ├── model-client.ts    ModelClient PORT (providers implement it; createScriptedModel for tests)
│   │   ├── state.ts           AgentState (mutable runtime state)
│   │   ├── types.ts           AgentMessage / Transition / Terminal shapes
│   │   ├── compaction.ts      estimateTokens · clearTier (0) · microcompact (1) · tier2Compact (2)
│   │   ├── defer.ts           deferred tool loading (load_tools meta-tool controller)
│   │   ├── runner.ts          Runner/Middleware seam — pipe() combinator (library extension point)
│   │   ├── subagent.ts        runSubagent: context-isolated child runs
│   │   ├── session/           store.ts (append-only JSONL, appendEntry) · validate.ts (load repair)
│   │   ├── agents/            roster.ts (role profiles) · registry.ts (background agents) ·
│   │   │                      worktree.ts (per-child git worktrees) · write-scope.ts (guards)
│   │   └── tools/             read-file, write-file, edit, shell, glob, grep, todo, task,
│   │                          ask-user, read-state (freshness table), file-history (rewind),
│   │                          workspace (path safety), output-caps
│   ├── providers/   @wudao/providers — OpenAI-compatible ModelClient adapter.
│   │   ├── config.ts          provider profiles + reasoning-format matrix + effort validation
│   │   └── openai-compatible.ts  SSE streaming · reasoning sniffing · retry ladder · onUsage ·
│   │                              serializePrompt (THE canonical request serializer)
│   ├── cli/         wudao-harness (bin: wudao) — three frontends + everything workspace-shaped.
│   │   ├── index.ts           entry: flag parsing, config assembly, frontend dispatch
│   │   ├── run.ts / repl.ts   one-shot + readline REPL; tui/ the Ink frontend
│   │   ├── permission.ts      mode + rule layering, session allowlist, settings-write immunity
│   │   ├── tools.ts           buildToolSet: builtin + MCP + orchestration wiring per frontend
│   │   ├── prompt.ts          sectioned system prompt (byte-stable per run)
│   │   ├── skills.ts · plugins.ts · extensions/ (ExtensionAPI v1) · mcp/ · hooks-config.ts · long-task-config.ts
│   │   ├── kernel-policy.ts   the single policy-value source (M41): registry operating points
│   │   │                      supplied to core at every construction site
│   │   ├── agents/ · workflow/ · plan.ts · rewind.ts · git-safety.ts · mentions.ts · cache.ts
│   │   └── tui/               app.tsx, keybindings.ts, status-bar, diff/markdown renderers
│   └── evals/       @wudao/evals (private) — 28 offline deterministic suites + 4 live suites
├── docs/            research/, superpowers/specs/, ARCHITECTURE.md, RELEASE.md, hooks-examples.md
├── examples/agents/ sample role profiles
└── skills/          bundled ultracode-quality skill (install into a workspace to use)
```

**Dependency direction (one-way):** `cli → core + providers`, `providers → core`, `evals → core + providers + cli`. Core never imports a provider — the demo and every deterministic eval run on `createScriptedModel`. Swapping the OpenAI-compatible adapter for a native one requires zero core changes.

## The six design tensions, and where each lives

These six separations are the inherited design DNA (distilled in `docs/research/03-*.md`); each is enforced by a concrete seam in this codebase. Placement map first — each row names the two halves and the seam that keeps them apart:

| Tension | One half | Other half | The seam |
| --- | --- | --- | --- |
| Loop ≠ Harness | `core/loop.ts` generator | lifecycle in cli frontends + `core/runner.ts` | `LoopEvent` stream + `Terminal` |
| Runtime ≠ persisted state | `AgentState` (mutable) | `SessionStore` JSONL ledger | frontend persists post-turn; `validate.ts` repairs |
| Capability ≠ policy | tools + risk annotations | permission rules/modes, write scopes, roster values | `canUseTool` at the loop boundary |
| Events ≠ hooks | observation channel | interception channel | yield vs fail-open gate seams |
| Core ≠ provider | one port (`ModelClient`) | HTTP/SSE/reasoning matrix in `providers/` | the port + scripted-model determinism |
| Model-visible ≠ runtime-known | per-call projection | append-only history | compaction stubs, MetaNotes, defer — never rewrites |

The subsections walk each seam in detail:

### 1. Loop ≠ Harness

`runAgentLoop(state, model, options)` (`core/loop.ts`) is an async generator over a mutable `AgentState`: a `while (true)` — project → call → yield events → execute tools → append — with a **typed `Transition`/`Terminal` reason** per turn, not recursion. Exit signal = the assistant turn carries **no tool-call block** (`stop_reason === "tool_use"` is not trusted). Lifecycle concerns (cancellation UI, retry policy, streaming render, persistence cadence) all live *outside* the loop, in the CLI frontends and the provider adapter. The `core/runner.ts` seam (`Runner` + `pipe()`) keeps even middleware composability out of the loop itself.

### 2. Runtime state ≠ Persisted state

`AgentState` (`core/state.ts`) is the live, in-memory conversation a run mutates. `SessionStore` (`core/session/store.ts`) is the append-only JSONL ledger — messages plus non-message entries (`session_name`, `model_change`, `thinking_level_change`, generic `appendEntry` records). The loop never writes the store; the frontend persists after turns/compactions, and `session/validate.ts` repairs orphans on load so a crashed run resumes provider-legal. Persist failure therefore cannot corrupt an in-flight run, and a resumed run rebuilds projections (compaction markers) from the ledger rather than trusting stale runtime state.

### 3. Capability ≠ Policy

Tools (`core/tool.ts`, `core/tools/*`) expose only *what they can do* plus risk annotations (`isReadOnly`, `isDestructive`-class flags, `isConcurrencySafe`, `requiresUserInteraction`, `shouldDefer`). Whether a call is *allowed* is decided entirely elsewhere: `canUseTool` at the loop boundary → `cli/permission.ts` layering (settings deny → settings-write immunity → session allowlist → settings ask/allow → mode) → plan-mode whitelist (M37) → write-scope guards (M31, applied at child-spawn time by wrapping the tool). The same `shell` tool is reused unchanged under `--read-only`, ask-mode, sandbox, and scoped roles.

### 4. Events ≠ Hooks

**Events** are the loop's observation channel: everything the UI renders (`assistant_delta`, `tool_call`, `compacted`, `steered`, `gate`, terminals) arrives as `LoopEvent`s yielded by the generator — a listener that throws (or a frontend that ignores them) cannot affect execution. **Hooks** (`AgentHooks` in `core/loop.ts`) are the interception channel: `onRunStop` can force another turn, `onPromptSubmit` can rewrite/block a prompt, `onPreToolUse` runs *before* the permission gate and can block a tool call. Two postures by design: observer hooks are isolated (never crash the run); gate hooks are fail-open (a throwing `onPreToolUse` degrades to allow — a broken hook must not wedge a run, which is also why hooks are a convenience layer, not a security boundary). The `.wudao/settings.json` command bridge (`cli/hooks-config.ts`) compiles configured commands into these same hooks.

### 5. Core ≠ Provider

Core sees exactly one port: `ModelClient` (`core/model-client.ts`) — `generate(input)` / `stream(input)` plus types for usage and stream events. The HTTP reality (auth, profiles, reasoning-format matrix, SSE parsing, reasoning-field sniffing, retry ladder with backoff, `stream_options` placement, the canonical byte serializer) lives in `providers/openai-compatible.ts` + `providers/config.ts`. Determinism comes from the port itself: `createScriptedModel` (in core) drives every offline test and eval without a network.

### 6. Model-visible ≠ Runtime-known

What the model receives is a **projection** of state, recomputed per model call — never a rewrite of it:

- Compaction stubs/markers (`core/compaction.ts`) replace tool-result *content* in the projected messages; the session JSONL keeps the originals, and markers are re-derived on resume.
- MetaNotes (`LoopOptions.metaNotes`, M32) append `<system_note>` blocks onto the **tail of the last projected tool_result** for one call; the persisted tool_result bytes are untouched. With no tool_result in view, the note degrades to a projected user message.
- Deferred tool loading (`core/defer.ts`) changes the projected tools array once per run; the session records a `deferred_loaded` entry as the durable fact.
- Read-state/external-change injection re-reads a changed file and projects a `<file_changed>` diff, then refreshes the table — the model's view converges to disk without rewriting history.

The four context layers in one line: `Session (JSONL ledger) → AgentState (mutable runtime) → per-call projection → ModelInput (bytes)`. Compaction, notes, and deferral all act on the last two arrows only.

## Key data flows

### Request construction (per model call)

```
AgentState ──project──► ModelInput ──serializePrompt──► HTTP body (byte-stable prefix)

ModelInput =
  systemPrompt     built ONCE per run (cli/prompt.ts): fixed section order —
                   core principles → tool usage → task discipline → long tasks →
                   behavioral contracts → environment (cwd/platform LAST) — plus
                   appended-at-the-absolute-tail sections when present:
                   # MCP tools · <available_skills>
  tools            builtin defs (+ MCP defs) in stable order; shouldDefer-marked
                   orchestration tools replaced by the single trailing load_tools
                   meta-tool; after a load, chosen defs APPENDED after it, frozen
  messages         state.messages + appended steering texts (queue drained before
                   every call) + MetaNotes projected onto the last tool_result tail;
                   assistant reasoning NEVER replayed
```

The provider serializes through `serializePrompt` (`providers/openai-compatible.ts`) — fixed key order, recursive key sort, stable header — which is the single source of request bytes and the substrate of the prefix-cache theorem: request N is a byte prefix of request N+1 except where a priced, announced change happens (compaction turn, the one `load_tools` growth, run boundaries). Usage flows back through `onUsage` with disjoint `cacheHitTokens`/`cacheMissTokens`; `cli/cache.ts` wraps the model to track hit-rate per call, render `cache N%`, and diff serialized prompts to attribute misses (`⚠️ cache break at <tool> result`).

### The compaction ladder

Checked before every model call; the **cheapest tier that fits wins**:

```
occupancy = max(estimateTokens(projected messages + system + tools),
                last real promptTokens)          ← usage-driven, not estimate-only

if occupancy ≥ 0.8 × contextWindowTokens:
    tier 0  clearTier          oldest tool results past keepRecent(6) over 30k chars
                              → frozen "[Old tool result content cleared]" marker
                              (fits? stop — dearer tiers never fire)
    tier 1  microcompact      old large tool results → stubs with head previews
                              (keepRecent 6, minChars 1000)
    tier 2  tier2Compact      LLM summarizes the old span — a WARM REPLAY (same
                              system + tools + span + one trailing instruction);
                              persisted "[compacted summary]" markers; the last
                              todo board mechanically re-injected after the summary
```

Timing: "approaching" occupancy (≥ threshold, < threshold+8k) defers the rewrite to the **turn boundary** so the current call keeps its warm full suffix — only the next request pays one announced cold turn; deeper occupancy compacts immediately. Every tier is pairing-safe (an assistant tool-call never loses its result: the message stays, only content shrinks). `compacted` events carry `tier: 0|1|2`; the JSONL keeps full fidelity and markers are re-derived on load.

### Orchestration

```
task({prompt, role, background?, session?, worktree role, writeScope…})
   │
   ├─ roster.ts   resolve role: workspace .wudao/agents/<role>.json over builtins;
   │              frozen pins survive call-time overrides; reasoning {requested,effective}
   │              receipt on the result
   │
   ├─ write-scope.ts   fail-closed guards wrap the child's write_file/edit/shell
   │              (shell exempt only under --sandbox or role allowShell);
   │              taskWriteScope narrows; overlaps warn (or refuse under strictOverlaps)
   │
   ├─ worktree.ts      role.worktree → dedicated git worktree, tools re-rooted,
   │              retired with worktree remove + branch -d
   │
   ├─ foreground → runSubagent (subagent.ts): child ToolUseContext — own state,
   │              own sidechain JSONL (session: new/resume:/fork:), NO orchestration
   │              tools, NO MCP tools; fork mode reuses the parent's prompt+tools+
   │              messages snapshot (byte-prefix sharing); parent receives ONLY the
   │              final report (≤4000 chars projected)
   │
   └─ background → agents/registry.ts: bg-N ids, concurrency slots (maxConcurrent 3,
                  ceiling 16 — kernel-policy.ts values since M41, not core defaults),
                  agent_await all/allSettled/any/race, agent_status/agent_cancel,
                  budget-fuse grace, parent abort kills all; adaptive budgets from
                  .wudao/agents-stats.json (median of successes clamped to 1.25×max)
```

Lineage: every `task` call carries a stable `t-N` id; `resumeFrom: "t-N"` continues that child session — explore→implement→verify chains never re-read the repository. The workflow engine (`cli/workflow/`) reuses the same `task` primitive inside a deterministic JS program: `Date`/`Math.random` throw, results journal by `sha256(prompt + canonical opts)`, `--resume` replays matched tasks with zero model calls, and an edited key truncates the journal at that edit point.

## Invariants worth knowing before changing things

- **Byte-stability tests are load-bearing.** `det-06` (prefix theorem), `det-15` (skills tail), `det-16` (format shapes) and `det-26` (zero-plugin prompt) pin serialized bytes. A change that shifts request bytes — system-prompt section order, tools ordering, serializer key order, tail-section placement — must be a *deliberate* priced decision or these fail.
- **Fail-closed defaults.** `buildTool` assumes the dangerous side on unspecified annotations; permission unknowns deny; sandbox unavailability denies; scope violations error without executing; malformed config degrades to warnings, never crashes.
- **The kernel holds no deployment policy (M41).** Core exposes mechanisms and protocol constants only; operating points are required constructor params, values live in `cli/kernel-policy.ts`, and the deterministic evals pin the end-to-end behavior those values produce. A new hardcoded default in core that a deployer could reasonably pick differently is a regression against the [inventory table](#mechanismpolicy-inventory).
- **Append-only history.** Nothing may splice or rewrite persisted messages. New information enters as appended entries or per-call projections (MetaNotes), which is what keeps the cache theorem true.
- **Reasoning is per-response.** `reasoning_content` is surfaced, stored on the assistant message, and never replayed to the provider.
- **The engine owns determinism** (workflows): scripts receive time/randomness only through `args`, so journals replay.
- **Extensions climb the ladder, never around it.** Every rung routes through the same gates (permission pipeline, fail-closed validation, timeout/isolation); no extension surface can touch the serializer, the ledger, or the loop's transitions directly.

## Appendix: what survives compaction (M58 semantics)

Compaction rewrites the *conversation layer* only. Everything sorts into one of four zones:

| Zone | Contents | After compaction |
| --- | --- | --- |
| **Stable prefix** | System prompt (memoized sections, tools, skills description listing), project context (WUDAO.md etc.), auto-memory recall | Untouched — never part of message history, rebuilds byte-identically |
| **Message history** | File reads, tool results, paths-scoped rules (M62), invoked-skill bodies, turn exchanges | Summarized away by the tier-2 summary; reload on next trigger |
| **Ghost markers** | `[SKILL_PRUNED:…]` replacements for pruned skill reads | Actively re-planted at every tier; the model sees the reload instruction |
| **Compensation** | Most-recent invoked skill body (5k cap, M58 hybrid reinjection), focus riders, todo-board re-injection | Re-injected at the compact boundary as new messages |

Rules of engagement, all cache-law consequences of append-only history:

- The summarizer request **shares the live prefix** (the instruction rides as a trailing user message), so the summary call itself hits cache; the slow part is generation, not a miss.
- The first post-compaction turn is priced and **annotated**: `coldTurnExpected` + break attribution ride the turn_usage receipt (reactive compaction from a 413 does the same).
- Anything that must survive *unchanged* belongs in the prefix zone (context files, memory) — anything acceptable to lose-and-reload belongs in history (path rules, one-shot context).
- Thrash guard: two consecutive auto-compactions re-firing within ≤2 turns stop the loop with an explicit error instead of cycling.
