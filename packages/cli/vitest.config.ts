import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    setupFiles: ["tests/setup-global-home.ts"],
    // Full-suite load: spawn-heavy children (git, sh hooks, sidecars) starve
    // the 5s per-test ceiling — TUI/timing suites trip it non-deterministically
    // under the shared pool. 0.4.21 发版预检证明 posix 满载同病（tui-ask/
    // settings-ops/omega99-257/261 轮流揭发，win32 分支 0.4.14 就已 20s）。
    // 超时是观察预算不是行为断言：solo 全是毫秒级，只有满载最坏情况付代价。
    testTimeout: 20_000,
  },
});
