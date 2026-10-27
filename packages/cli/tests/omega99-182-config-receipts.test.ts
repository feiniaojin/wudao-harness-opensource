// ω99-182 receipts — /config effective-view 中文输出面四组：A 助手（脱敏/明文/
// 镜像标注/截断后缀）、B 骨架（首行/三段头/missingLabel 三态）、C 空态、D 尾注。
// Fixture 形镜像 m55:216-:258（tmpWs + .wudao/settings.json + env + argv）；
// WUDAO_GLOBAL_HOME 把 global 层钉到空临时目录，断言全局缺失态/空 keySources
// 时不依赖宿主 ~/.wudao（设置与否随机器漂移）。
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfigReport } from "../src/commands/config.js";

async function tmpWs(): Promise<string> {
  return mkdtemp(join(tmpdir(), "o99-182-cfg-"));
}

describe("ω99-182 /config receipts — A 助手", () => {
  it("A1 secret 形 env 值脱敏为（已设置）；非 secret 明文；PATH 不入列", async () => {
    const ws = await tmpWs();
    try {
      const report = await buildConfigReport({
        workspaceRoot: ws,
        env: { WUDAO_API_KEY: "sk-182-secret", WUDAO_MAX_TURNS: "50", PATH: "/bin" },
        argv: ["node", "wudao", "hello"],
      });
      expect(report).toContain("WUDAO_API_KEY=（已设置）");
      expect(report).not.toContain("sk-182-secret");
      expect(report).toContain("WUDAO_MAX_TURNS=50");
      expect(report).not.toContain("PATH=");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("A2 --sandbox 标注镜像（env 的 WUDAO_SANDBOX_IMAGE）", async () => {
    const ws = await tmpWs();
    try {
      const report = await buildConfigReport({
        workspaceRoot: ws,
        env: { WUDAO_SANDBOX_IMAGE: "foo" },
        argv: ["node", "wudao", "--sandbox"],
      });
      expect(report).toContain("--sandbox（镜像 foo）");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("A3 超 4000 字符的 settings 段截断为（… 还有 N 字符）", async () => {
    const ws = await tmpWs();
    const ghome = await tmpWs();
    try {
      await mkdir(join(ws, ".wudao"), { recursive: true });
      const record = { note: "x".repeat(4_200) };
      await writeFile(join(ws, ".wudao", "settings.json"), JSON.stringify(record), "utf8");
      const report = await buildConfigReport({
        workspaceRoot: ws,
        env: { WUDAO_GLOBAL_HOME: ghome },
        argv: ["node", "wudao", "hello"],
      });
      const pretty = JSON.stringify(record, null, 2);
      expect(pretty.length).toBeGreaterThan(4_000);
      expect(report).toContain(`（… 还有 ${pretty.length - 4_000} 字符）`);
      expect(report).not.toContain("more chars");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(ghome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("ω99-182 /config receipts — B 骨架", () => {
  it("B1 首行=配置（生效值，只读）：", async () => {
    const ws = await tmpWs();
    try {
      const report = await buildConfigReport({ workspaceRoot: ws, env: {}, argv: ["node", "wudao", "hello"] });
      expect(report.split("\n")[0]).toBe("配置（生效值，只读）：");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("B2 三段头：生效键来源/环境变量覆盖（WUDAO_*）/命令行覆盖", async () => {
    const ws = await tmpWs();
    try {
      const report = await buildConfigReport({ workspaceRoot: ws, env: {}, argv: ["node", "wudao", "hello"] });
      expect(report).toContain("生效键来源：");
      expect(report).toContain("环境变量覆盖（WUDAO_*）：");
      expect(report).toContain("命令行覆盖：");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("B3 missingLabel 三态全角整体形（global/project/local）", async () => {
    const ws = await tmpWs();
    const ghome = await tmpWs();
    try {
      const report = await buildConfigReport({
        workspaceRoot: ws,
        env: { WUDAO_GLOBAL_HOME: ghome },
        argv: ["node", "wudao", "hello"],
      });
      expect(report).toContain("（无全局设置——用默认值）");
      expect(report).toContain("（无 .wudao/settings.json）");
      expect(report).toContain("（无 .wudao/settings.local.json）");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(ghome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("ω99-182 /config receipts — C 空态", () => {
  it("C1 env 无覆盖 →（未设置）", async () => {
    const ws = await tmpWs();
    try {
      const report = await buildConfigReport({ workspaceRoot: ws, env: {}, argv: ["node", "wudao", "hello"] });
      expect(report).toContain("（未设置）");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("C2 无 flag →（无）", async () => {
    const ws = await tmpWs();
    try {
      const report = await buildConfigReport({ workspaceRoot: ws, env: {}, argv: ["node", "wudao", "hello"] });
      expect(report).toContain("（无）");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("C3 无设置键 →（无设置键——用默认值）", async () => {
    const ws = await tmpWs();
    const ghome = await tmpWs();
    try {
      const report = await buildConfigReport({
        workspaceRoot: ws,
        env: { WUDAO_GLOBAL_HOME: ghome },
        argv: ["node", "wudao", "hello"],
      });
      expect(report).toContain("（无设置键——用默认值）");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(ghome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("ω99-182 /config receipts — D 尾注", () => {
  it("D1 尾注整句（token 逐字保留）", async () => {
    const ws = await tmpWs();
    try {
      const report = await buildConfigReport({ workspaceRoot: ws, env: {}, argv: ["node", "wudao", "hello"] });
      expect(report).toContain("（视图只读——/config set local <key> <value> 写 local 层（首次写入自动 gitignore）；permissions/hooks 热加载；prompt 级改动需重启会话）");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
