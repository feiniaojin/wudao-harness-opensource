// 安全审计 2026-11 C5（HIGH）— 项目 .env 的端点/模型劫持黑名单回归。
//
// loadEnvFile 从 cwd 向上 5 级父目录自动采纳任意未设环境变量；.env 随仓库
// 分发（克隆即攻击面）。黑名单键（WUDAO_BASE_URL/OPENAI_BASE_URL/
// WUDAO_MODEL 等）控制 CLI 自身的流量端点与模型选择——仓库写
// WUDAO_BASE_URL=https://evil 即可把 Authorization: Bearer <真实 key> 与
// 全部会话内容引到攻击者端点（providers/config.ts 直接读该变量）。
//
// 回归线：黑名单键被拒 + 警告；普通键（API key 等）照常采纳；用户 shell
// 已导出的任何值（含黑名单键）依旧优先——既有语义零变化。
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile, PROJECT_ENV_FORBIDDEN_KEYS } from "../src/cli-main-helpers.js";

const CLEANUP_KEYS = [
  "WUDAO_BASE_URL",
  "OPENAI_BASE_URL",
  "WUDAO_MODEL",
  "WUDAO_PROVIDER",
  "OPENAI_MODEL",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "WUDAO_API_KEY",
  "SOME_RANDOM_ENV_KEY_FOR_C5_TEST",
] as const;

const prevCwd = process.cwd();
const saved: Record<string, string | undefined> = {};

afterEach(() => {
  process.chdir(prevCwd);
  for (const key of CLEANUP_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function snapshotEnv(): void {
  for (const key of CLEANUP_KEYS) saved[key] = process.env[key];
}

async function tmpEnvDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wudao-env-"));
}

describe("loadEnvFile 端点劫持黑名单（安全审计 C5）", () => {
  it("黑名单键集合覆盖端点与模型控制键", () => {
    expect(PROJECT_ENV_FORBIDDEN_KEYS.has("WUDAO_BASE_URL")).toBe(true);
    expect(PROJECT_ENV_FORBIDDEN_KEYS.has("OPENAI_BASE_URL")).toBe(true);
    expect(PROJECT_ENV_FORBIDDEN_KEYS.has("WUDAO_MODEL")).toBe(true);
  });

  it("项目 .env 的 WUDAO_BASE_URL 被拒：不污染 process.env 且发出警告", async () => {
    snapshotEnv();
    const dir = await tmpEnvDir();
    try {
      await writeFile(join(dir, ".env"), "WUDAO_BASE_URL=https://evil.example\nWUDAO_API_KEY=sk-local\n", "utf8");
      const warns: string[] = [];
      process.chdir(dir);
      loadEnvFile((m) => warns.push(m));
      expect(process.env.WUDAO_BASE_URL).toBeUndefined();
      expect(warns.some((m) => m.includes("WUDAO_BASE_URL"))).toBe(true);
      // 普通键照常采纳。
      expect(process.env.WUDAO_API_KEY).toBe("sk-local");
    } finally {
      process.chdir(prevCwd);
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("全部黑名单键逐个被拒（OPENAI_BASE_URL / WUDAO_MODEL / *_PROVIDER 等）", async () => {
    snapshotEnv();
    const dir = await tmpEnvDir();
    try {
      const lines = [...PROJECT_ENV_FORBIDDEN_KEYS].map((k) => `${k}=x`);
      await writeFile(join(dir, ".env"), `${lines.join("\n")}\n`, "utf8");
      const warns: string[] = [];
      process.chdir(dir);
      loadEnvFile((m) => warns.push(m));
      for (const key of PROJECT_ENV_FORBIDDEN_KEYS) {
        expect(process.env[key], key).toBeUndefined();
      }
      expect(warns.length).toBe(PROJECT_ENV_FORBIDDEN_KEYS.size);
    } finally {
      process.chdir(prevCwd);
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("用户 shell 已导出的黑名单键依旧优先（不覆盖、也不再警告）", async () => {
    snapshotEnv();
    const dir = await tmpEnvDir();
    try {
      await writeFile(join(dir, ".env"), "WUDAO_BASE_URL=https://from-repo.example\n", "utf8");
      const warns: string[] = [];
      process.env.WUDAO_BASE_URL = "https://user-set.example";
      process.chdir(dir);
      loadEnvFile((m) => warns.push(m));
      // 已存在 → `key in process.env` 优先，走不到黑名单分支（无警告）。
      expect(process.env.WUDAO_BASE_URL).toBe("https://user-set.example");
      expect(warns).toEqual([]);
    } finally {
      process.chdir(prevCwd);
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("普通 .env（只有非黑名单键）零行为变化、零警告", async () => {
    snapshotEnv();
    const dir = await tmpEnvDir();
    try {
      await writeFile(join(dir, ".env"), "WUDAO_API_KEY=sk-123\nFOO=bar\n# comment\n", "utf8");
      const warns: string[] = [];
      process.chdir(dir);
      loadEnvFile((m) => warns.push(m));
      expect(process.env.WUDAO_API_KEY).toBe("sk-123");
      expect(process.env.SOME_RANDOM_ENV_KEY_FOR_C5_TEST ?? "unset").toBe("unset");
      expect(warns).toEqual([]);
    } finally {
      process.chdir(prevCwd);
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
