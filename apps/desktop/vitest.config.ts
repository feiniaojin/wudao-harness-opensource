import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Handshake/terminate suites spawn real processes and race real timers.
    testTimeout: 20_000,
    hookTimeout: 10_000,
  },
});
