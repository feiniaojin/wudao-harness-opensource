// 0.3.31 context-window guard (反馈 2026-08-30): 会话中可任意切模型，但
// 长窗→短窗要提示，且当前上下文已用 tokens 超过目标模型窗口时禁止切换
// （先 /compact）。守卫坐在 applyModelSwitch / applyProviderSwitch 两个
// 漏斗头部 + 两个 run-settle 消费点（parked 期间 run 可能又涨了上下文），
// 度量与压缩触发器同源（ctxTokens.used = max(estimate, lastPromptTokens)）；
// 未知（used:null，如刚压缩完）保持放行——没有证据就不拒绝。
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel } from "@wudao/core";
import { defaultProviderRegistryPath, writeProviderRegistrySync } from "@wudao/providers";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { invalidateProviderRegistryCache } from "../src/provider-registry.js";
import { asMutableConfig } from "../src/commands/model.js";
import { resolveProviderSwitch } from "../src/commands/provider.js";

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

/** 64k 会话窗上的一张跨档矩阵：16k（远小于已用）/ 50k（刚好容纳的缩窗）/
 *  128k（放大）。deepseek 供应商内部切换——同一端点，纯窗口维度。 */
const MATRIX = [
  { provider: "deepseek", model: "boot-model", source: "env" as const, contextLength: 64_000 },
  { provider: "deepseek", model: "tiny-16k", source: "env" as const, contextLength: 16_384 },
  { provider: "deepseek", model: "fit-50k", source: "env" as const, contextLength: 50_000 },
  { provider: "deepseek", model: "huge-128k", source: "env" as const, contextLength: 131_072 },
];

/** A driver on the 64k window whose watermark measures ~50k used: one
 *  scripted run over a 200k-char loaded history (the same chars/4 accounting
 *  the compactor triggers on). */
async function loadedDriver(used: number, historyChars: number): Promise<AgentDriver> {
  const driver = createAgentDriver({
    systemPrompt: "s",
    summarize: summarizeToolCall,
    model: createScriptedModel([{ role: "assistant", content: "ok" }]),
    tools: [],
    sessionMeta: { provider: "deepseek", model: "boot-model" },
    availableModels: MATRIX,
    ...(used > 0
      ? {
          // one real run materializes the watermark (model_call boundaries +
          // the usage row clear the post-boot unknown)
        }
      : {}),
  });
  if (used > 0) {
    driver.loadHistory([{ role: "user", content: "x".repeat(historyChars) }], "ctx-guard-load");
    driver.submit("hi");
    await until(() => driver.getHistory().some((e) => e.kind === "assistant" && e.text.includes("ok")), "the run replies");
    const st = driver.getStatus();
    if (st.ctxTokens === null || st.ctxTokens.used === null) throw new Error(`watermark not measurable: ${JSON.stringify(st.ctxTokens)}`);
    if (st.ctxTokens.used < used) throw new Error(`watermark too small: ${st.ctxTokens.used} < ${used}`);
  }
  return driver;
}

const noticesOf = (d: AgentDriver): string[] =>
  d.getHistory().filter((e) => e.kind === "notice").map((e) => e.text);

describe("context-window guard (0.3.31) — /model lane", () => {
  it("当前上下文已用 ~50k 超过目标 16k 窗口：拒绝切换并点名 /compact，不落 model_change", async () => {
    const driver = await loadedDriver(40_000, 200_000);
    try {
      driver.submit("/model tiny-16k");
      await until(() => noticesOf(driver).some((t) => t.includes("禁止切换")), "the refusal");
      const refusal = noticesOf(driver).find((t) => t.includes("禁止切换")) ?? "";
      expect(refusal).toContain("/compact");
      expect(refusal).toContain("16,384");
      // 没有成功通知（拒绝文案含同一 label——用成功通知的固定后缀区分）、
      // overlay 不动、不写 entry。
      expect(noticesOf(driver).some((t) => t.includes("tiny-16k") && t.includes("recorded (model_change entry)"))).toBe(false);
      expect(driver.getStatus().model?.label).toBe("boot-model");
    } finally {
      driver.dispose();
    }
  });

  it("缩窗但容纳得下（64k→50k，已用 ~50k 内）：允许，成功通知带窗口提示", async () => {
    const driver = await loadedDriver(40_000, 160_000); // ~40k used < 50k target
    try {
      driver.submit("/model fit-50k");
      await until(() => noticesOf(driver).some((t) => t.includes("模型 → deepseek/fit-50k")), "the switch lands"); // ω99-195: 钉随源演进（census 漏列）
      const ok = noticesOf(driver).find((t) => t.includes("模型 → deepseek/fit-50k")) ?? ""; // ω99-195: 钉随源演进（census 漏列）
      expect(ok).toContain("context window 64,000 → 50,000");
      expect(driver.getStatus().model?.label).toBe("fit-50k");
    } finally {
      driver.dispose();
    }
  });

  it("放大窗口（64k→128k）：允许，无缩窗提示", async () => {
    const driver = await loadedDriver(40_000, 200_000);
    try {
      driver.submit("/model huge-128k");
      await until(() => noticesOf(driver).some((t) => t.includes("模型 → deepseek/huge-128k")), "the switch lands"); // ω99-195: 钉随源演进（census 漏列）
      const ok = noticesOf(driver).find((t) => t.includes("模型 → deepseek/huge-128k")) ?? ""; // ω99-195: 钉随源演进（census 漏列）
      expect(ok).not.toContain("context window");
    } finally {
      driver.dispose();
    }
  });

  it("度量未知（used:null，新会话未跑过）：放行——没有证据不拒绝", async () => {
    const driver = await loadedDriver(0, 0);
    try {
      expect(driver.getStatus().ctxTokens === null || driver.getStatus().ctxTokens?.used === null).toBe(true);
      driver.submit("/model tiny-16k");
      await until(() => noticesOf(driver).some((t) => t.includes("模型 → deepseek/tiny-16k")), "the switch lands"); // ω99-195: 钉随源演进（census 漏列）
    } finally {
      driver.dispose();
    }
  });
});

describe("context-window guard (0.3.31) — /provider lane", () => {
  it("当前上下文 ~50k 超过自定义目标 16k 窗：resolve 通过但落地被拒 — 不 build、不记 entry、缩点名 /compact", async () => {
    const home = mkdtempSync(join(tmpdir(), "ctx-guard-prov-"));
    const prevHome = process.env.WUDAO_GLOBAL_HOME;
    process.env.WUDAO_GLOBAL_HOME = home;
    try {
      writeProviderRegistrySync(defaultProviderRegistryPath(process.env), {
        version: 1,
        providers: {
          tinyprov: { baseUrl: "https://tiny.example/v1", defaultModel: "tiny-model", models: [{ name: "tiny-model", contextLength: 16_384 }] },
        } as Record<string, never>,
      });
      invalidateProviderRegistryCache();
      const live = asMutableConfig({ apiKey: "sk-live", baseURL: "https://api.deepseek.com", model: "boot-model", provider: "deepseek" });
      const builds: string[] = [];
      const driver = createAgentDriver({
        systemPrompt: "s",
        summarize: summarizeToolCall,
        model: createScriptedModel([{ role: "assistant", content: "ok" }]),
        tools: [],
        sessionMeta: { provider: "deepseek", model: "boot-model" },
        onProviderSwitch: {
          resolve: (target: import("@wudao/providers").ProviderName) => resolveProviderSwitch({ target, env: process.env, current: live }),
          build: (config: import("@wudao/providers").ProviderConfig) => {
            builds.push(config.provider ?? "?");
            return createScriptedModel([{ role: "assistant", content: "x" }]);
          },
        },
      });
      try {
        driver.loadHistory([{ role: "user", content: "x".repeat(200_000) }], "ctx-guard-prov");
        driver.submit("hi");
        await until(() => driver.getHistory().some((e) => e.kind === "assistant" && e.text.includes("ok")), "the run replies");
        const used = driver.getStatus().ctxTokens?.used;
        if (used === null || used === undefined) throw new Error("watermark not measurable");

        driver.submit("/provider tinyprov");
        await until(() => noticesOf(driver).some((t) => t.includes("禁止切换")), "the refusal");
        const refusal = noticesOf(driver).find((t) => t.includes("禁止切换")) ?? "";
        expect(refusal).toContain("/compact");
        expect(refusal).toContain("16,384");
        // 不 build、overlay 不动。
        expect(builds).toEqual([]);
        expect(driver.getStatus().model?.provider).toBe("deepseek");
      } finally {
        driver.dispose();
      }
    } finally {
      invalidateProviderRegistryCache();
      if (prevHome === undefined) delete process.env.WUDAO_GLOBAL_HOME;
      else process.env.WUDAO_GLOBAL_HOME = prevHome;
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
