---
name: ultracode-quality
description: Multi-agent quality playbook for high-stakes work — adversarial verification, judge panels, loop-until-dry discovery, completeness criticism, and pipeline-first fan-out with the task tool.
---

# ultracode-quality — a quality playbook for high-stakes work

Use these patterns when the task is high-stakes (a migration, an audit, a broad
review, a security-sensitive change) or the user explicitly asks for
thoroughness ("be comprehensive", "find ALL the bugs", "leave no stone
unturned"). For conversational turns or trivial mechanical edits, work solo.
This skill is knowledge-only: it changes no runtime behavior, toggles no
switch — it is a menu of orchestration shapes to run with the `task` tool.

The universal primitive: `task` spawns an isolated subagent
(`general-purpose` = read-only research; `coder` = full tools). Each subagent
gets a COMPLETE, self-contained prompt (it sees nothing of this conversation)
and its final text is data for you to synthesize.

## Pattern 1 — pipeline-first (default for any fan-out)

Independent items should each flow find → verify end-to-end without waiting
for the other items. Concretely: dispatch ALL `task` calls for the round in
ONE turn (parallel tool calls), each brief carrying its own verify step, and
synthesize when they all return. Do NOT run find-ALL → barrier → verify-ALL
unless the barrier is genuinely needed.

A barrier (collect everything before proceeding) is correct ONLY when:

- the next stage must dedup/merge across the full result set (e.g. two
  finders reporting the same bug — dedup before paying for verification);
- an early-exit depends on the total ("zero findings → skip verification");
- a later prompt references "the other findings" for comparison.

NOT justified: "flatten/map/filter first" (do it in your own synthesis),
"the stages feel conceptually separate" (that's what a pipeline models), or
"cleaner code". Barriers waste the fast finders' idle time.

## Pattern 2 — adversarial verification

Plausible-but-wrong findings survive polite review. For every finding that
matters, spawn 2–3 INDEPENDENT skeptics, each prompted to REFUTE it (default
to refuted when uncertain), and keep the finding only if a majority fail to
refute. Give each skeptic the evidence and instructions to check it: "Try to
refute: <claim>. Reproduce the reasoning, check the callers, verify the test
actually fails. Default to refuted=true if uncertain."

Perspective-diverse beats redundant: when a claim can fail in more than one
way, give each verifier a distinct lens (correctness / security / performance
/ does-it-reproduce) instead of N identical refuters.

## Pattern 3 — judge panel

When the solution space is wide (designs, plans, naming/architecture,
strategies), generate N independent attempts from different angles
(e.g. MVP-first, risk-first, user-first), score them with parallel judge
subagents against explicit criteria, then synthesize from the winner while
grafting the best ideas from the runners-up. One-attempt-then-iterate
converges on the first idea; panels don't.

## Pattern 4 — loop-until-dry

For unknown-size discovery (bugs, edge cases, call sites), keep spawning
finder rounds until K consecutive rounds surface nothing NEW. Simple
fixed-count loops ("find 10 bugs") miss the tail.

- Dedup against the set of ALL findings ever seen — not just the confirmed
  ones — or rejected findings reappear every round and it never converges.
- Vary the lens between rounds (round 1: by feature; round 2: by failure
  mode; round 3: by file/module) — repetition of the same lens also repeats
  the same findings.

## Pattern 5 — completeness critic

Before declaring done, spawn one final subagent that asks: "what's missing —
a pattern not swept, a claim unverified, a source unread, an error path
untested?" Whatever it names becomes the next round of work. This is the
cheapest pattern and the most frequently valuable one.

## Rules that apply to all patterns

- **No silent caps.** If you bound coverage (top-N, sampling, skipped
  areas), say so in the final answer — silent truncation reads as "covered
  everything" when it didn't.
- **Scale to the ask.** "find any bugs" → a few finders, single-vote verify.
  "thoroughly audit" → larger finder pool, 3-vote adversarial pass, critic
  at the end. Don't gold-plate a quick check; don't solo an audit.
- **Synthesis is yours.** Subagent reports are input; the answer the user
  reads is your synthesis, with evidence (file:line) carried through.
- **Track the rounds on the board** (`todo_write`) when a pattern runs more
  than ~3 steps, and update it as each round settles.
