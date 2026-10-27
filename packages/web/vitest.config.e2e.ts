// PB-3 E2E — 专项配置（`pnpm -C packages/web test:e2e`）。
// 普通 gate 走 vite.config.ts 的 include（tests/**/*.test.ts(x)），天然不收
// *.e2e.ts —— E2E 太慢，不进普通 gate（@slow 面），只在本配置里显式跑。
// 每文件串行（浏览器进程 + 临时端口），forks 池让 server/浏览器子进程与
// 主进程干净隔离。
/// <reference types="vitest" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.e2e.ts"],
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
