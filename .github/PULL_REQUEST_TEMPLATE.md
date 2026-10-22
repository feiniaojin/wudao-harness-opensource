<!-- M47 §3 (B8): the cache gates. Check a box (- [x]) or write N/A with a
     one-line reason on the same line. A best-effort CI job verifies each
     field was filled in; see CONTRIBUTING.md "The cache gates". -->

## What & why

<!-- One short paragraph: what changes, why now, and the spec/task it closes. -->

## Cache gates (required — check or N/A + reason)

- [ ] **Cache-impact**: I described how this change affects the bytes of the requests the harness sends (system prompt / tool definitions / message serialization) — or it cannot affect request bytes (N/A + why).
- [ ] **Cache-guard**: the cache invariants stay pinned — `det-06-prefix-stability`, `det-12-cache-hit-gate`, `serializePrompt` unit tests — or I explained which pins changed and why (N/A + why).
- [ ] **System-prompt-review**: system-prompt changes are append-only at the tail with a stable section order — or no system-prompt bytes moved (N/A + why).

## Verification

<!-- What you ran: pnpm build / pnpm test / pnpm eval (+ live smoke if the
     change touches provider behavior). Deterministic evidence over prose. -->
