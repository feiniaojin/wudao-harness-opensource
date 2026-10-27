---
description: Run the repo verification ladder and report
---

Run the repository's verification ladder and report each step's outcome:

1. `pnpm build`
2. `pnpm test`
3. `pnpm eval`

For each step report PASS/FAIL with the one line that proves it. If a step
fails, stop and analyze the failure before moving on. Finish with a verdict
line: VERIFIED or FIX-FIRST (plus what to fix).

Context: $ARGUMENTS
