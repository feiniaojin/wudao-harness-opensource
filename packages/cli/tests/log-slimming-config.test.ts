// 借鉴弧 C1（a reference project C3）— logSlimming 的 cli 配置面：loader 契约（缺省关
// /字段回退/未知键告警）、fail-closed runtime（enabled 无 model = 关）、
// 廉价档客户端的 config 形状（sidecar 同款：effort none 标 soft + 2048
// 完成上限）、以及 createLogSlimmingPorts 只透传显式覆盖的阈值。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "@wudao-org/providers";
import {
  loadLogSlimmingSettings,
  resolveLogSlimmingRuntime,
  logSlimmingReducerConfig,
  createLogSlimmingPorts,
} from "../src/output-config.js";

let dir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wudao-log-slim-"));
  savedEnv["WUDAO_LOG_SLIMMING"] = process.env["WUDAO_LOG_SLIMMING"];
  delete process.env["WUDAO_LOG_SLIMMING"];
});
afterEach(async () => {
  if (savedEnv["WUDAO_LOG_SLIMMING"] === undefined) delete process.env["WUDAO_LOG_SLIMMING"];
  else process.env["WUDAO_LOG_SLIMMING"] = savedEnv["WUDAO_LOG_SLIMMING"];
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function writeSettings(json: string): Promise<void> {
  await mkdir(join(dir, ".wudao"), { recursive: true });
  await writeFile(join(dir, ".wudao", "settings.json"), json, "utf8");
}

const WARNINGS: string[] = [];
const warn = (m: string): void => {
  WARNINGS.push(m);
};

describe("loadLogSlimmingSettings — loader 契约", () => {
  it("缺省关：无 settings → { enabled: false }", async () => {
    expect(await loadLogSlimmingSettings(dir)).toEqual({ enabled: false });
  });

  it("reads the node: enabled + model + threshold overrides", async () => {
    await writeSettings(JSON.stringify({ logSlimming: { enabled: true, model: "deepseek-v4-flash", minChars: 50_000, timeoutMs: 60_000 } }));
    expect(await loadLogSlimmingSettings(dir)).toEqual({ enabled: true, model: "deepseek-v4-flash", minChars: 50_000, timeoutMs: 60_000 });
  });

  it("malformed node / wrong types / unknown keys → fallback + warn, never fatal", async () => {
    WARNINGS.length = 0;
    await writeSettings(JSON.stringify({ logSlimming: "yes" }));
    expect(await loadLogSlimmingSettings(dir, warn)).toEqual({ enabled: false });
    await writeSettings(JSON.stringify({ logSlimming: { enabled: "true", model: "", minChars: -1, surprise: 1 } }));
    const s = await loadLogSlimmingSettings(dir, warn);
    expect(s).toEqual({ enabled: false });
    expect(WARNINGS.some((w) => w.includes("must be an object"))).toBe(true);
    expect(WARNINGS.some((w) => w.includes("enabled must be a boolean"))).toBe(true);
    expect(WARNINGS.some((w) => w.includes("model must be a non-empty string"))).toBe(true);
    expect(WARNINGS.some((w) => w.includes("minChars must be a positive integer"))).toBe(true);
    expect(WARNINGS.some((w) => w.includes("unknown logSlimming key"))).toBe(true);
  });
});

describe("resolveLogSlimmingRuntime — fail-closed 门", () => {
  it("off by default; env kill switch wins", () => {
    expect(resolveLogSlimmingRuntime(undefined, {})).toBeUndefined();
    expect(resolveLogSlimmingRuntime({ enabled: true, model: "deepseek-v4-flash" }, { WUDAO_LOG_SLIMMING: "off" })).toBeUndefined();
  });

  it("enabled WITHOUT a model → undefined + one 人话 warn（不猜 flash 名）", () => {
    WARNINGS.length = 0;
    expect(resolveLogSlimmingRuntime({ enabled: true }, {}, warn)).toBeUndefined();
    expect(WARNINGS).toHaveLength(1);
    expect(WARNINGS[0]).toContain("deepseek-v4-flash");
  });

  it("enabled + model → runtime with explicit overrides only", () => {
    expect(resolveLogSlimmingRuntime({ enabled: true, model: "glm-5.3-flash" }, {})).toEqual({ model: "glm-5.3-flash" });
    expect(resolveLogSlimmingRuntime({ enabled: true, model: "deepseek-v4-flash", minChars: 30_000, timeoutMs: 45_000 }, {}))
      .toEqual({ model: "deepseek-v4-flash", minChars: 30_000, timeoutMs: 45_000 });
  });
});

describe("the reducer client — sidecar 同款形状", () => {
  const base: ProviderConfig = {
    apiKey: "sk-test",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    reasoningEffort: "high",
  };

  it("cheap-tier overrides: model swap, effort none (soft), 2048 completion cap", () => {
    const cfg = logSlimmingReducerConfig(base, { model: "deepseek-v4-flash" });
    expect(cfg.model).toBe("deepseek-v4-flash");
    expect(cfg.reasoningEffort).toBe("none");
    expect(cfg.softReasoningNone).toBe(true);
    expect(cfg.maxTokens).toBe(2048);
    expect(cfg.apiKey).toBe("sk-test");
    expect(cfg.baseURL).toBe("https://api.deepseek.com");
  });

  it("the session's own config object is not mutated (spread, not write)", () => {
    logSlimmingReducerConfig(base, { model: "deepseek-v4-flash" });
    expect(base.model).toBe("deepseek-v4-pro");
    expect(base.reasoningEffort).toBe("high");
  });

  it("createLogSlimmingPorts threads ONLY explicit threshold overrides (core keeps conservative defaults)", () => {
    const ports = createLogSlimmingPorts(base, { model: "deepseek-v4-flash", minChars: 30_000 });
    expect(ports.config).toEqual({ minChars: 30_000 });
    expect(typeof ports.model.generate).toBe("function");
  });
});
