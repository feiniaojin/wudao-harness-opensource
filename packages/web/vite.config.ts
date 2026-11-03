// Vite build + vitest config for @wudao-org/web. The build is standalone (no
// workspace cross-deps): React + this package's sources in, static assets out
// to dist/, which @wudao-org/server serves when present (see cli/src/ui.ts
// probeStaticDir). Tests run the same sources under jsdom for the component
// suites; protocol/input-machine suites are pure logic.
/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      // ω99-97: multipage — index.html (main shell) + pet.html (the pet
      // window's page; the sidecar serves it at /pet.html). ESM config has
      // no __dirname, so the inputs resolve via import.meta.url.
      input: {
        index: new URL("index.html", import.meta.url).pathname,
        pet: new URL("pet.html", import.meta.url).pathname,
      },
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    css: true, /* M64-visual §1: mount imported CSS in jsdom so tokens tests resolve custom props */
  },
});
