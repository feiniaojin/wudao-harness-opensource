import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    setupFiles: ["tests/setup-global-home.ts"],
    // win32 full-suite load: spawn-heavy children (git, sh hooks, sidecars)
    // starve the default 5s per-test ceiling — the TUI/timing suites trip it
    // non-deterministically under the shared pool. 20s there; posix keeps
    // the tight default.
    testTimeout: process.platform === "win32" ? 20_000 : 5_000,
  },
});
