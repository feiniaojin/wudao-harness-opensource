#!/bin/bash
# Release gate — the honest version (0.3.18 lessons, encoded).
#
#   1. Anti-false-green (0.3.18): `pnpm test | tail` returns tail's exit 0 even
#      when vitest failed. Here every test run's exit code goes through
#      `if out=$(...)` directly — nothing between us and vitest's status —
#      and ALL_GREEN is printed only when every step really exited 0.
#   2. Serial by design (0.3.16): parallel package runs starve core's
#      write-verify suites (node --check / py_compile spawn budgets). One
#      package at a time; core additionally runs with --no-file-parallelism.
#      cli joins core's --no-file-parallelism from 0.3.19: two gate rounds
#      each red on a DIFFERENT cli test (file-changes round-robin, then
#      tui-ux permission-mode cycling), both solo-green — the 180-file suite
#      at full parallelism starves its own deadline-sensitive tests on a
#      machine already warm from six prior packages (same mechanism the
#      0.3.16 note documented for core).
#   3. Build + check first (0.3.18): evals resolves workspace deps through
#      their dist exports, so tests must see a fresh build; and vitest does
#      NOT typecheck (det-57 shipped two type errors that only tsc caught —
#      discovered mid-release by desktop's build-sea), so `pnpm check`
#      (tsc --noEmit across packages) runs before any test.
#
# Usage: pnpm release:gate   (or: bash scripts/release-gate.sh)
set -o pipefail
cd "$(dirname "$0")/.." || exit 1

fail=0
ok=()
step() { printf '\n=== %s ===\n' "$1"; }

step "build (fresh dist — evals reads workspace deps through their exports)"
pnpm build >/dev/null || { echo "FAIL build"; exit 1; }

step "check (tsc --noEmit, every package + root scripts)"
pnpm check >/dev/null || { echo "FAIL check"; exit 1; }

run_pkg() { # $1 = dir under packages/, $2... = extra vitest args
  local pkg="$1"; shift
  step "test packages/$pkg"
  local out
  # Full per-package output persists to /tmp — the 0.3.19 gate reds (two
  # rounds, two different tests) were undebuggable from the greps alone;
  # the assertion that names the root cause lives in this file now.
  if out=$( (cd "packages/$pkg" && pnpm vitest run "$@" 2>&1) ); then
    printf '%s\n' "$out" > "/tmp/wudao-release-gate-$pkg.log"
    printf '%s\n' "$out" | grep -E "Test Files .*passed" | tail -1
    ok+=("$pkg")
  else
    printf '%s\n' "$out" > "/tmp/wudao-release-gate-$pkg.log"
    printf '%s\n' "$out" | grep -E "Test Files|FAIL|ELIFECYCLE" | tail -5
    echo "FAIL packages/$pkg (full output: /tmp/wudao-release-gate-$pkg.log)"
    fail=1
  fi
}

# Short packages first (fast feedback), cli last (it is the long pole).
run_pkg core --no-file-parallelism
run_pkg providers
run_pkg server
run_pkg slack
run_pkg web
run_pkg evals
# --testTimeout: the posix 5s default assumes a quiet dev box (cli's own
# config comment); a release run on a busy desktop (load ~20) trips the
# TUI/timing suites non-deterministically — the exact failure mode the
# config already gives win32 20s for. Three 0.3.19 gate rounds, three
# different cli tests, all solo-green: the budget, not the tests.
run_pkg cli --no-file-parallelism --testTimeout=20000

step "summary"
if [ "$fail" = 0 ]; then
  echo "ALL_GREEN: ${ok[*]}"
else
  echo "HAD_FAILURES"
  exit 1
fi
