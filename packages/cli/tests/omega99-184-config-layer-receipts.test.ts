// ω99-184 receipts — /config 三层头模板串中文化（182 弧披露的反引号模板形
// 盲区残面，第七形首例）：A 层头三态（global/project/local 精确行形——前缀+
// 路径插值原样+全角括号+全角冒号收尾）、B 整体形（三段头同报+global 空态
// 紧随其头+旧形三串反向）。
// Fixture 形镜像 m55:216-:258（tmpWs + .wudao/settings.json + env）；
// WUDAO_GLOBAL_HOME 把 global 层钉到临时目录，头与空态断言不依赖宿主
// ~/.wudao（设置与否随机器漂移）。
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfigReport } from "../src/commands/config.js";

async function tmpWs(): Promise<string> {
  return mkdtemp(join(tmpdir(), "o99-184-cfg-"));
}

describe("ω99-184 /config 三层头 — A 层头三态", () => {
  it("A1 settings.json 在场 → 项目层 settings（…）：精确行（前缀+路径插值+全角收尾）", async () => {
    const ws = await tmpWs();
    const ghome = await tmpWs();
    try {
      await mkdir(join(ws, ".wudao"), { recursive: true });
      await writeFile(join(ws, ".wudao", "settings.json"), JSON.stringify({ model: "glm" }), "utf8");
      const report = await buildConfigReport({
        workspaceRoot: ws,
        env: { WUDAO_GLOBAL_HOME: ghome },
        argv: ["node", "wudao", "hello"],
      });
      expect(report).toContain("项目层 settings（");
      expect(report).toContain(join(ws, ".wudao", "settings.json"));
      const line = report.split("\n").find((l) => l.startsWith("项目层 settings（"));
      expect(line).toBe(`项目层 settings（${join(ws, ".wudao", "settings.json")}）：`);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(ghome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("A2 settings.local.json 在场 → 本地层 settings（…）：精确行", async () => {
    const ws = await tmpWs();
    const ghome = await tmpWs();
    try {
      await mkdir(join(ws, ".wudao"), { recursive: true });
      await writeFile(join(ws, ".wudao", "settings.local.json"), JSON.stringify({ quiet: true }), "utf8");
      const report = await buildConfigReport({
        workspaceRoot: ws,
        env: { WUDAO_GLOBAL_HOME: ghome },
        argv: ["node", "wudao", "hello"],
      });
      expect(report).toContain("本地层 settings（");
      const line = report.split("\n").find((l) => l.startsWith("本地层 settings（"));
      expect(line).toBe(`本地层 settings（${join(ws, ".wudao", "settings.local.json")}）：`);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(ghome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("A3 WUDAO_GLOBAL_HOME 重定向 tmp → 全局层 settings（…）：精确行（路径落 tmp 不落宿主）", async () => {
    const ws = await tmpWs();
    const ghome = await tmpWs();
    try {
      await writeFile(join(ghome, "settings.json"), JSON.stringify({ provider: "glm" }), "utf8");
      const report = await buildConfigReport({
        workspaceRoot: ws,
        env: { WUDAO_GLOBAL_HOME: ghome },
        argv: ["node", "wudao", "hello"],
      });
      expect(report).toContain("全局层 settings（");
      const line = report.split("\n").find((l) => l.startsWith("全局层 settings（"));
      expect(line).toBe(`全局层 settings（${join(ghome, "settings.json")}）：`);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(ghome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("ω99-184 /config 三层头 — B 整体形", () => {
  it("B1 三段头同报；无 global 时  （无全局设置——用默认值） 紧随 全局层头之后行", async () => {
    const ws = await tmpWs();
    const ghome = await tmpWs();
    try {
      const report = await buildConfigReport({
        workspaceRoot: ws,
        env: { WUDAO_GLOBAL_HOME: ghome },
        argv: ["node", "wudao", "hello"],
      });
      const lines = report.split("\n");
      const gIdx = lines.findIndex((l) => l.startsWith("全局层 settings（"));
      const pIdx = lines.findIndex((l) => l.startsWith("项目层 settings（"));
      const lIdx = lines.findIndex((l) => l.startsWith("本地层 settings（"));
      expect(gIdx).toBeGreaterThan(-1);
      expect(pIdx).toBeGreaterThan(-1);
      expect(lIdx).toBeGreaterThan(-1);
      expect(lines[gIdx + 1]).toBe("  （无全局设置——用默认值）");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(ghome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("B2 旧形反向：settings (global / settings (project / settings (local 三串不在场", async () => {
    const ws = await tmpWs();
    const ghome = await tmpWs();
    try {
      await mkdir(join(ws, ".wudao"), { recursive: true });
      await writeFile(join(ws, ".wudao", "settings.json"), JSON.stringify({ model: "glm" }), "utf8");
      await writeFile(join(ws, ".wudao", "settings.local.json"), JSON.stringify({ quiet: true }), "utf8");
      const report = await buildConfigReport({
        workspaceRoot: ws,
        env: { WUDAO_GLOBAL_HOME: ghome },
        argv: ["node", "wudao", "hello"],
      });
      expect(report).not.toContain("settings (global");
      expect(report).not.toContain("settings (project");
      expect(report).not.toContain("settings (local");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(ghome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
