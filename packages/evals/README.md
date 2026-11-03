# @wudao-org/evals

Eval suites for **wudao-harness** — the product safety net.

```
pnpm build   # build all packages (evals imports @wudao-org/core dist types)
pnpm eval    # run everything: deterministic + live (root workspace script)
```

## What this is (and is not)

Evals here test **harness behavior**, not model capability. The question every
suite answers is: "does the harness still behave the way we designed it?" —
the loop exits on the right signal, tools stay inside the workspace, the
permission gate actually gates, compaction keeps the request prefix
byte-stable, sessions survive orphaned tool calls, subagents get the right
tool subset. A model regression is the provider's problem; a harness
regression is ours, and these suites catch it.

Two kinds of suites:

| kind | model | cost | when |
| --- | --- | --- | --- |
| `deterministic` | scripted (`createScriptedModel`-style recording stub) | zero, CI-safe | always runs |
| `live` | real model (DeepSeek etc. via `.env`) | one short run per suite | runs only with a key, otherwise ⏭ skipped with a reason |

## Suites

Deterministic (60 at the time of writing — the authoritative registry is
`src/suites/deterministic.ts`, not this list; `tests/suites.test.ts` pins the
count so it can never drift silently). The founding suites, for orientation:

1. `det-01-read-file-answer` — read_file → final answer carries file content.
2. `det-02-write-and-run` — write_file then shell; exit 0, output 42, file on disk.
3. `det-03-edit-unique` — unique old_string edits land; non-unique is refused.
4. `det-04-read-escape-rejected` — `../` read is rejected, secret never enters the transcript.
5. `det-05-permission-ask` — non-read tools hit the permission gate; denied calls never execute.
6. `det-06-prefix-stability` — after compaction, request bodies stay append-only (prefix-cache hits).
7. `det-16-reasoning-format-shapes` — glm/qwen/wudao effort transforms post exactly the reasoning-format matrix fields (scripted fetch, zero network).
8. `det-07-resume-integrity` — orphaned tool_call in a session file is repaired into a legal sequence.
9. `det-08-subagent-isolation` — the subagent's tool set excludes `task` (and write tools for read-only types).
10. `det-09-long-task-clear-board` — the todo board drives the run; premature stops are gated back to work.
11. `det-10-verify-gate` — code changes without a shell are gated before finishing.
12. `det-11-compaction-survival` — the todo board survives tier-2 compaction (mechanically restored).
13. `det-13-read-elision` — a re-read of unchanged bytes is elided; originals stay model-visible.
14. `det-14-retry-path` — 429 twice then success: identical bytes resent, output delivered once.
15. `det-15-skills` — skills manifest is byte-exact and purely additive; `/skill:name` expansion is actionable.

Live (5, real model):

1. `live-01-read-summary` — read README, one-sentence summary containing the fixture codename.
2. `live-02-write-and-run` — write calc.js, run it; answer contains the number an independent run prints.
3. `live-03-tool-chain` — glob → grep → read_file chain, in that order, codeword reported.
4. `det-12-cache-hit-gate` — a real 3+ turn chain rides the prefix cache: ≥80% hit rate from call 3 on.
5. `live-04-project-context` — AGENTS.md/CLAUDE.md rules actually reach the model and shape the answer.

Live assertions are deliberately loose (keyword presence, final file state,
"this tool call happened"), because model output is not deterministic.

## Snapshot replay (M71 — keyless regression net for prompt assembly)

A third kind of evidence: **record once with a key, replay forever without
one**. Real-model scenarios run through the production assembly
(`buildSystemPrompt`, real tools, real loop, real provider client); every
HTTP exchange at the provider boundary — the assembled request bodies and
the verbatim responses — is captured into committed fixtures under
`snapshots/<name>/{requests.json,transcript.jsonl}`.

Replay re-runs the same scenarios with responses served from the fixtures
(no network, no key) and diffs, after stripping provably volatile fields
(timestamps, session ids, durations, workspace paths, platform):

1. `serializePrompt()` bytes per model call (the canonical serializer),
2. the raw request bodies per HTTP call,
3. the final transcripts (both loop phases),
4. the persisted session JSONL, read back from disk.

Every scenario also mounts a negative prompt-injection canary: a
persistence-only session entry reading `THIS MARKER MUST NOT REACH THE
MODEL` sits between the two phases, and the second phase resumes through
the real `store.load()`. Any appearance of the marker in an assembled
request — recorded or replayed — fails the suite.

```
pnpm test                                          # replays keylessly (part of CI)
WUDAO_SNAPSHOT=record pnpm --filter @wudao-org/evals test -- snapshot   # re-record (dev key)
```

Recording self-replays before committing the fixture, so a normalization
gap fails at record time, not in CI. Scenarios live in
`src/snapshot/scenarios.ts`; the engine in `src/snapshot/engine.ts`;
normalization + diffing (unit-tested with synthetic data) in
`src/snapshot/normalize.ts`.

Current scenarios: `snap-01-read-answer` (production system prompt + one
tool turn + resume), `snap-02-tool-chain` (glob → grep → read_file),
`snap-03-compaction` (microcompact stub projection — the full result rides
the warm defer-band call, the stub rides everything after).

## Output

`pnpm eval` prints a table (✅ / ❌ / ⏭ + name + first failure line) and
writes `.wudao/evals/last.json`. Exit code is `1` when ANY suite (deterministic
or live) fails; skips never fail the run.

## Adding an eval

An eval is a plain object, not a framework:

```ts
import type { EvalDefinition } from "@wudao-org/evals/runner"; // or relative path

const myEval: EvalDefinition<MyCtx, MyEvidence> = {
  name: "det-09-my-behavior",   // det- / live- prefix + number
  kind: "deterministic",        // or "live"
  // optional, live-only: return a reason string to skip (e.g. no API key)
  skip: () => undefined,
  setup: async (tmplDir) => { /* seed fixtures into the fresh temp dir */ },
  run: async (ctx) => { /* drive the harness; return evidence */ },
  assertions: (evidence) => [ /* error strings; empty array = pass */ ],
};
```

Add it to the exported list in `src/suites/deterministic.ts` (or `live.ts`).
Each eval gets its own throwaway temp directory, created and removed by the
runner. Keep deterministic suites free of network, keys, and wall-clock
dependencies; keep live assertions loose.

## Live keys

Live suites read `WUDAO_API_KEY` (or `OPENAI_API_KEY`) etc. from the
environment, auto-loading a `.env` found at or above the working directory
(existing env wins; `.env` is gitignored — never commit keys).

## A/B layer evals — design reference (methodology from harness(bare)'s skill-testing-guide)

The det suites above pin **harness behavior**. A different question — "does
this prompt LAYER help?" (a skill, a persona, an output style) — needs a
different instrument: an **A/B pair against a baseline**. This section is the
design reference for that instrument, distilled from harness(bare)'s
`skills/harness/references/skill-testing-guide.md` (verified against wudao's
seams — nothing here requires new runtime plumbing):

**The pair.** For each test prompt run TWO live runs: with the layer mounted,
and without it (for a new layer) or with the PREVIOUS snapshot of it (for an
improvement — keep the old version verbatim). Same prompt, same fixtures,
fresh workspaces, run concurrently. Capture `total_tokens` + `duration_ms`
**at run completion** — wudao's seam already exists: the run receipt's
`耗时 X · 模型 Y` (0.3.15) and usage `durationMs` land in history at settle
time and are not recoverable later; read them off the event, not from a
post-hoc scan.

**Test prompts.** Write what a real user would actually type — concrete file
names, column names, context — never "process the PDF" abstraction. Mix
explicit vs implied intent (says "CSV" vs the format must be inferred), formal
vs casual tone, simple vs composite. Start with 2–3: one core use case, one
edge case, optionally one composite task.

**Assertions — the two kills.** An assertion must be objectively true/false,
descriptively named, and verify the layer's core value. Two things must die:
  - **Non-discriminating assertions** — pass 100% in BOTH arms measure
    nothing about the layer. On discovery, remove or harden them (this is the
    A/B twin of a det assertion that can never fail).
  - **Subjective assertions** — "well written" needs a grader run or a human,
    not a keyword check.
  When an assertion is programmably checkable, script it — reusable across
  iterations and faster than eyeballing.

**Trigger validation** (for anything with a description that auto-activates —
skills, personas): 10 should-trigger + 10 should-NOT-trigger queries. The
NOT side is where the value is: **near-misses** (similar keywords, wrong
context, a competing layer that should win) — obviously-unrelated queries
test nothing. Check new descriptions against existing ones' trigger zones;
on collision, sharpen the boundary in the description, not the prompt.
Description optimization, if ever needed: split queries 60/40 train/test,
select on TEST only (overfitting guard), ≤5 rounds, last step only — it
burns tokens.

**Iteration workspace.** Never overwrite a prior iteration: each round gets
`iteration-N/` with per-eval descriptive dir names (`eval-multi-page-table`,
not `eval-3`), each arm's `outputs/` + `timing.json` + `grading.json`, and an
iteration-level `benchmark.json`. The workspace is the audit trail — keep it.

**Improvement loop discipline.** Generalize feedback to the principle (a fix
that only fits the test prompt is overfitting); cut steps that make the agent
do unproductive work (read the transcripts); bundle any helper script every
run regenerates into the layer's `scripts/`; draft, then re-read with fresh
eyes before committing. Stop when user feedback comes back empty across a
full round.

**What wudao already has that harness(bare) had to build**: the run receipts
(tokens + duration in history), the skills manifest pins (det-15: byte-exact,
purely additive), and this runner itself — an A/B eval is just a `kind:
"live"` suite that mounts the layer for arm A and not for arm B, with `skip`
when no key. The methodology above is the discipline to wrap around it when
that first A/B suite is written (M11+ extension surface — not a night item).
