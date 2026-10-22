---
name: deslop
description: Simplify a completed workpackage — strip AI-slop redundancy (needless abstraction, pass-through layers, speculative flexibility, defensive code inside trust boundaries, impossible-state fallbacks) under a per-path human approval gate that fires before any unapproved edit.
approval-gate: file-edits
---

# deslop — post-completion simplification under an approval gate

Review a completed workpackage and simplify its implementation without
changing its intended behavior. AI-written code carries systematic redundancy;
this pass removes it — and every significant deletion passes a human gate
FIRST, so simplification can never quietly become destruction.

## Scope

- Focus on code added or affected by the workpackage, plus the nearby code
  needed to simplify coherently. No unrelated cleanup.
- Read the affected files in full before editing: invariants, call sites,
  tests, public API.
- Optimize for a direct, coherent, maintainable design — not the smallest
  diff.
- Work on the main line. Do not route edits through task-tool children — the
  approval gate covers the session's main-line edit/write_file calls.

## What to remove or simplify

- Abstractions with no clear responsibility that reduce no real complexity.
- Trivial helpers, wrappers, adapters, and pass-through layers that obscure
  rather than clarify behavior.
- Duplicated logic — put shared behavior at the appropriate existing layer.
- Speculative flexibility: configuration, extension points, and generic
  machinery with no current requirement.
- Speculative defensive programming inside trusted code. Validate at real
  trust boundaries; rely on types and established invariants internally.
- Fallback behavior for states that should be impossible — fix the invariant
  or the type model instead.
- Excessive state, boolean flags, branching, indirection, special cases;
  rework the underlying representation when that is clearer.
- Loose TypeScript types where invalid states could be made unrepresentable.
- Comments that merely restate the code. Keep comments that explain
  constraints, intent, or non-obvious decisions.

## The approval gate (mechanism, not discipline)

Invoking this skill armed the session's **file-edits approval gate**: until
`/clear`, every `edit`/`write_file` on a path the human has not approved this
session prompts them (`allow edit: <path>? [y/a/p/N]`) instead of passing
silently. This is enforced by the permission pipeline — you cannot edit past
it, and you are not expected to try.

- `y` approves that one call; `a` approves the exact tool+path for the rest of
  the session (the receipt); `p` additionally persists it. A receipt covers
  that path only — a sibling path or the other edit tool asks again.
- Approval is per decision. Do NOT bundle independent deletions into one
  request, and do not re-ask for a path the human already covered with `a`/`p`.

### Report before you delete (ask_user)

Before the first edit on a path carrying a **significant** removal, report the
item with ONE `ask_user` question: what you propose to remove; why it looks
unnecessary or over-defensive; what behavior, compatibility, validation, or
error handling could be affected; the simpler replacement; your recommendation.
Present independent decisions as separate questions — never a combined
"approve all". The gate still asks at the edit itself; the report is what the
human approves INTO.

A removal is significant when it deletes or materially changes: user-visible
behavior or supported workflows; public APIs, persisted formats, protocol
behavior, or backward compatibility; validation, authorization, security
checks, recovery, retries, fallbacks, or error handling; an abstraction or
extension point that looks deliberate or has multiple consumers;
functionality covered by tests or documentation; code whose purpose or
invariant you are unsure of. When uncertain whether a removal is significant,
report it.

Routine behavior-preserving cleanup needs no report: inlining a single-use
trivial helper, removing a branch proven impossible by the type model,
deleting duplication the workpackage itself added.

## Constraints

- Preserve intended behavior unless the human explicitly approves a change.
- Before removing "unused" code, check whether it is a public API, an
  extension point, a generated entry point, or retained compatibility surface.
- Do not replace clear code with a new abstraction just to cut line count.
- Do not weaken tests to permit a simplification. Update tests only when an
  approved behavior change or a cleaner equivalent structure requires it.
- Follow the repository's validation and testing instructions after edits.

## Completion report

After editing, review the final diff for avoidable complexity, duplication,
indirection, defensive branches, and accidental behavior changes. Report:

1. **what was simplified** — the removals/consolidations that landed;
2. **the invariants the implementation now relies on** (so the next reader
   knows what is load-bearing);
3. **significant removals NOT made** because approval was not granted, with
   the reason if the human gave one;
4. **the validation performed and its results** — the focused tests you ran
   (which suites, pass/fail), plus type checks.

Passing tests and type checks is necessary but not sufficient. Leave the
affected code easier to understand and change.
