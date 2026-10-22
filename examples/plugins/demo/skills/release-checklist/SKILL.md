---
name: release-checklist
description: Release checklist for this repository (version bump, changelog, verify)
---

# Release checklist

Run these in order; every step must pass before the next.

1. `pnpm build` — cold-tree build green.
2. `pnpm test` — all package suites green.
3. `pnpm eval` — deterministic suites green (count in the report).
4. `CHANGELOG.md` — one line per milestone, dated.
5. Version bump in every `package.json` (root + packages).
6. Commit message: `chore(release): v<version>`.
