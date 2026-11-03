// 0.4.20 npm 首发线 —— wudao ui 的静态资源定位：仓内形态（packages/web/dist）
// 与 npm 安装形态（node_modules/@wudao-org/web/dist）两处都要命中；两者皆无 →
// 交给服务端占位页（不抛）。
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeStaticDir } from "../src/ui.js";

describe("wudao ui 静态资源定位（仓内 / npm 两种安装形态）", () => {
  it("npm 形态：node_modules/@wudao-org/web/dist 命中", async () => {
    const root = await mkdtemp(join(tmpdir(), "wudao-static-npm-"));
    try {
      const cliDist = join(root, "node_modules", "wudao-harness", "dist");
      const webDist = join(root, "node_modules", "@wudao-org", "web", "dist");
      await mkdir(cliDist, { recursive: true });
      await mkdir(webDist, { recursive: true });
      expect(await probeStaticDir(cliDist)).toBe(webDist);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("仓内形态：packages/web/dist 命中（优先于 npm 候选）", async () => {
    const root = await mkdtemp(join(tmpdir(), "wudao-static-repo-"));
    try {
      const cliDist = join(root, "packages", "cli", "dist");
      const webDist = join(root, "packages", "web", "dist");
      await mkdir(cliDist, { recursive: true });
      await mkdir(webDist, { recursive: true });
      expect(await probeStaticDir(cliDist)).toBe(webDist);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("两者皆无 → undefined（服务端走占位页，不抛）", async () => {
    const root = await mkdtemp(join(tmpdir(), "wudao-static-none-"));
    try {
      const cliDist = join(root, "node_modules", "wudao-harness", "dist");
      await mkdir(cliDist, { recursive: true });
      expect(await probeStaticDir(cliDist)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
