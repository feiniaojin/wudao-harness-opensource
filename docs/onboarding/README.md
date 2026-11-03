# Onboarding — how to read this codebase

> Audience: a new contributor (human or agent) who wants to understand wudao-harness
> well enough to change it safely. Reading order is deliberate: **constants
> first, loop first** — you meet the smallest stable facts before any
> mechanism, and the agent loop before everything built on top of it.

## Reading order

| # | Read | What you'll have after it |
| --- | --- | --- |
| 1 | [01-constants-first.md](01-constants-first.md) | The ~20 lines of the repo everything else obeys (tokens/4, 0.8×window, keepRecent 6, marker strings). |
| 2 | [02-loop-first.md](02-loop-first.md) | The while-true loop in `packages/core/src/loop.ts`: state in, typed events out, and WHY it is a generator and not recursion. |
| 3 | [03-mechanism-mottos.md](03-mechanism-mottos.md) | One motto per mechanism — the mental index you carry while grepping. |
| 4 | [04-reference-comparison.md](04-reference-comparison.md) | Where each design came from (real CC / pi / open-harness / CCB / dsh…) and what we deliberately did differently. |

Then: [../ARCHITECTURE.md](../ARCHITECTURE.md) for the full mechanism/policy
inventory, `docs/adr/` for the one-page "why" records, and
`docs/superpowers/specs/` for the milestone-by-milestone acceptance history.

## The one-paragraph version

wudao-harness is a runtime agent harness: an **agent loop** (a pure async
generator over mutable state) that calls a **model client port**, drives
**tools** through a fail-closed factory and a five-layer permission pipeline,
keeps the model's view and the persisted truth separate (**projection never
rewrites history**), and manages the context as a budget (**cheapest-first
compaction**, append-only JSONL sessions, prefix-cache stability as an
invariant). Everything else — subagents, skills, MCP, plans, sidecar
classification — is an extension riding those four joints.
