// OOM fix (second retention path): the CLI must run React in PRODUCTION mode.
// Node loads the CJS `react`/`react-reconciler` builds based on NODE_ENV, and
// without this the shipped CLI silently ran React's DEVELOPMENT reconciler —
// whose per-commit `performance.measure` entries (the DevTools profiler
// channel) embed component props in their `detail`. During streaming that
// retained ~1 copy of the full live-reasoning accumulation per render in
// Node's measure buffer (heap-snapshot-proven: 1209 measures × up to 1.5MB =
// 1.7GB). Production builds have no such instrumentation.
//
// This module must be the FIRST import of the entry: ESM evaluates the import
// graph in declaration order, so it runs before `react`'s index decides which
// build to load. It only pins the env when unset — `NODE_ENV=development`
// still opts into dev React for debugging, and vitest (NODE_ENV=test) is
// never affected because tests import the app modules directly.
if (process.env.NODE_ENV === undefined || process.env.NODE_ENV === "") {
  process.env.NODE_ENV = "production";
}
