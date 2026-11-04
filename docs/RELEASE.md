# Release checklist

The publishable artifacts are six npm packages: `@wudao-org/core`, `@wudao-org/providers`, `@wudao-org/server`, `@wudao-org/browser`, `@wudao-org/web`, and `wudao-harness` (the CLI, bin `wudao`). The root package, `@wudao-org/evals`, and `@wudao-org/slack` are `private: true` and never publish.

The CLI depends on the other five via `workspace:*`, which pnpm rewrites to real versions at publish time — **all six must publish together, at the same version**. A missing one breaks the install: `wudao-harness` imports `@wudao-org/server` at runtime, and `@wudao-org/browser` / `@wudao-org/web` are runtime dependencies too (the latter carries the `wudao ui` frontend assets).

## 0. Preconditions

- [ ] Clean tree on `main` (`git status` empty); all intended work merged.
- [ ] `npm whoami` returns the publishing account (else `npm login`). First publish of each package needs `--access public` — the release script already passes it.
- [ ] `npm config get registry` points at the registry you intend to publish to (a mirror here receives the real publish too — see step 3).
- [ ] Node ≥ 22 and pnpm 11 (`packageManager` pins `pnpm@11.21.0`).

## 1. Version bump (one release, eleven places)

The version lives in **eleven** files and must match everywhere:

| File | Field |
| --- | --- |
| `/package.json` | `version` (root; private, but keeps the release line named) |
| `packages/core/package.json` | `version` |
| `packages/providers/package.json` | `version` |
| `packages/server/package.json` | `version` |
| `packages/browser/package.json` | `version` |
| `packages/web/package.json` | `version` |
| `packages/cli/package.json` | `version` |
| `apps/desktop/package.json` | `version` (the desktop app's own line; missed at 0.4.21 and the artifacts shipped labeled 0.4.20) |
| `apps/desktop/src-tauri/tauri.conf.json` | `version` (the ELEVENTH place — tauri reads THIS for the dmg/exe filename; missed the same day and the local dmg still said 0.4.20) |
| `packages/evals/package.json` | `version` (private, never publishes — bumped for line consistency) |
| `packages/cli/src/version.ts` | `VERSION` const (CLI banner, REPL header, MCP clientInfo) |

- [ ] Bump all of them (e.g. `0.2.0` → `0.3.0`). No test pins the version constant today — verify that still holds: `grep -rn '"0\.2\.0"' packages --include="*.ts" | grep -v version.ts` should return nothing.
- [ ] `scripts/publish-assets.mjs` copies the repo-root LICENSE (and README for the CLI) into each package before packing — it runs from each package's `prepublishOnly`. The copies are gitignored (publish artifacts, not source).
- [ ] Add the release to `CHANGELOG.md` (one line per milestone, dated).
- [ ] Commit: `chore: version <X.Y.Z> everywhere`.

## 2. Verify (all green before publishing)

```bash
pnpm build && pnpm test && pnpm eval
```

- [ ] Build green. **Cold-tree note:** `@wudao-org/core` dev-depends on `@wudao-org/providers` (manifest cycle), so on a tree with no `dist/` pnpm may start the two builds concurrently and providers fails to resolve core's types. If that happens: `pnpm --filter @wudao-org/core build && pnpm build`. Fix candidate for a later milestone: drop the unused devDependency.
- [ ] Tests green (currently 1364 across the four packages).
- [ ] Evals green (currently 30 suites: 26 offline deterministic, 4 live needing `WUDAO_API_KEY` via `.env`).
- [ ] `pnpm check` (tsc --noEmit) green.
- [ ] README flag/env tables still match code if the release changed any surface.

## 3. Rehearse the publish (no network writes)

```bash
pnpm -r publish --dry-run --access public
```

- [ ] The output names the **registry** it would publish to (`📦 <pkg>@<ver> → <registry>`) — check it is the one you intend. The configured registry wins over `--access public`: a mirror in `.npmrc` (`npm config get registry`) receives the real publish too. Point at npmjs with `--registry=https://registry.npmjs.org/` if that is the target.
- [ ] Rehearsing on a **feature branch** trips pnpm's `publish-branch` guard (`master|main` only) — add `--no-git-checks` for the rehearsal; the real release runs from `main` and does not need it.
- [ ] Completes without error for exactly the six public packages (`📦 @wudao-org/core@… / @wudao-org/providers@… / @wudao-org/server@… / @wudao-org/browser@… / @wudao-org/web@… / wudao-harness@…`, each followed by `[WARN] Skip publishing … (dry run)`). The CLI's `prepublishOnly` runs build+test as part of it.
- [ ] Tarball contents and dependency rewriting are **not** shown by the dry run — verify once with a real pack:
  ```bash
  cd packages/cli && pnpm pack --pack-destination /tmp
  tar -xzOf /tmp/wudao-harness-<ver>.tgz package/package.json   # @wudao-org/core/@wudao-org/providers must be the new version, not workspace:*
  tar -tzf /tmp/wudao-harness-<ver>.tgz                        # dist/ + LICENSE + package.json only
  ```

## 4. Publish

```bash
pnpm run release     # = pnpm -r build && pnpm -r test && pnpm -r publish --access public
```

- [ ] Six `+ @wudao-org/…@X.Y.Z` (or `wudao-harness@X.Y.Z`) success lines, zero errors.
- [ ] If any package fails mid-way: the already-published ones stay public — publish the stragglers individually (`pnpm --filter @wudao-org/core publish --access public`), then record the miss here.

## 5. Post-publish verification

- [ ] `npm view wudao-harness@<ver> version dependencies` — version correct, `@wudao-org/core`/`@wudao-org/providers`/`@wudao-org/server`/`@wudao-org/browser`/`@wudao-org/web` resolve to published versions (not `workspace:*`).
- [ ] Clean-room smoke test (no local checkout):
  ```bash
  npx -y wudao-harness@<ver> "Reply with OK and use no tools."
  npx -y wudao-harness@<ver> --list-sessions
  ```
- [ ] Optional deeper check in a scratch dir: `npm i -g wudao-harness@<ver>` then `wudao "<prompt>"`, `wudao --no-tui`, and the TUI (`wudao` in a real terminal).

## 6. Close out

- [ ] Tag the release: `git tag vX.Y.Z && git push origin vX.Y.Z`.
- [ ] GitHub release notes: paste the CHANGELOG section for the release.
- [ ] Start the next dev cycle: bump nothing yet (the version changes at the next release, per step 1).
