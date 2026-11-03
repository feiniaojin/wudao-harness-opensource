// P2-15 (96 队列 #15) — 接线层：driver onEvent 缝 E2E（真 driver + scripted
// model + stub tool → telemetry 收到 tool 事件产生 tool span），以及
// settings-layer 信任门（telemetry 节点属远程面开放类，仅全局层可配——
// 克隆仓库的 project/local 层不得指定 OTLP endpoint 外发遥测）。
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool, createScriptedModel } from "@wudao-org/core";
import type { CostRegistry } from "../src/commands/cost.js";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import { loadLayeredSettings } from "../src/settings-layer.js";
import { createTelemetryRuntime } from "../src/telemetry/telemetry.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const params = {
  type: "object" as const,
  properties: { path: { type: "string" as const } },
  required: ["path"],
  additionalProperties: false,
};

function stubReadTool(content = "STUB FILE CONTENT"): ReturnType<typeof buildTool> {
  return buildTool({
    name: "read_file",
    description: "stub read",
    parameters: params,
    execute: async () => ({ content }),
  });
}

describe("driver onEvent seam → TelemetryRuntime (E2E)", () => {
  it("a real tool call produces a tool span under a turn span, exported at flush", async () => {
    const posts: unknown[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body === "string") posts.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    // The EXACT composition the session engine wires (events seam only —
    // the loop path and core are untouched; observer failures self-isolate).
    const registry: CostRegistry = new (await import("../src/commands/cost.js")).CostRegistry({});
    const telemetry = createTelemetryRuntime({
      otlpEndpoint: "https://otel.example.test",
      sessionId: "s-wiring",
      liveIdentity: () => ({ model: "deepseek-v4-flash", provider: "deepseek" }),
      costRows: () => registry.rows,
      fetchImpl,
    });

    // Scripted model twin that reports usage through the provider's channel
    // (ModelInput.onUsage — createScriptedModel itself never fires it, and
    // the cache-tracking wrapper the real engine wraps around the provider
    // is what records CostRegistry rows from it).
    const base = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
      { role: "assistant", content: "ALL DONE" },
    ]);
    const model = {
      ...base,
      async generate(input: import("@wudao-org/core").ModelInput) {
        const res = await base.generate(input);
        await input.onUsage?.({
          promptTokens: 1000,
          cacheHitTokens: 700,
          cacheMissTokens: 300,
          completionTokens: 9,
          cacheWriteTokens: 300,
        });
        return res;
      },
    };
    const driver = createAgentDriver({
      model,
      tools: [stubReadTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onPermissionAsk: async () => ({ kind: "allow" as const }),
      onEvent: (event) => {
        // mirror production: usage events land as registry rows (the cache
        // tracker's onUsage in the real engine); telemetry observes the rest.
        if (event.type === "usage") {
          registry.record({
            model: "deepseek-v4-flash",
            provider: "deepseek",
            usage: {
              ...event.usage,
              promptTokens: 1000, cacheHitTokens: 700, cacheMissTokens: 300,
              completionTokens: 9, cacheWriteTokens: 300,
            },
          });
        }
        telemetry.observe(event);
      },
    });
    await wait();
    driver.submit("hi");
    await until(() => driver.getStatus().busy === false, "run to finish");
    await telemetry.flush();
    await telemetry.close();
    driver.dispose();

    const spans: { name: string; parentSpanId?: string; status: { code: number }; attributes?: { key: string; value: Record<string, unknown> }[] }[] = [];
    for (const p of posts) {
      const rs = (p as { resourceSpans: { scopeSpans: { spans: unknown[] }[] }[] }).resourceSpans;
      for (const r of rs) for (const sc of r.scopeSpans) for (const s of sc.spans) spans.push(s as never);
    }
    const tool = spans.find((s) => s.name === "tool.read_file");
    const turn = spans.find((s) => s.name === "turn");
    expect(tool).toBeDefined();
    expect(turn).toBeDefined();
    expect(tool!.parentSpanId).toBe(turn!.spanId);
    expect(tool!.status.code).toBe(1);
    const turnAttrs = Object.fromEntries((turn!.attributes ?? []).map((a) => [a.key, a.value]));
    expect(turnAttrs).toMatchObject({ model: { stringValue: "deepseek-v4-flash" }, input_tokens: { intValue: 1000 } });
    // redaction holds through the real seam: the stub result text never left
    const raw = JSON.stringify(posts);
    expect(raw).not.toContain("STUB FILE CONTENT");
    expect(raw).not.toContain("ALL DONE");
    expect(raw).not.toContain("\"hi\"");
  });
});

describe("settings trust gate — telemetry is global-tier only", () => {
  it("a project-tier telemetry node is dropped as an escalation (cloned repo must not beacon)", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-p15-"));
    try {
      await mkdir(join(ws, ".wudao"), { recursive: true });
      await writeFile(
        join(ws, ".wudao", "settings.json"),
        JSON.stringify({ telemetry: { otlpEndpoint: "https://attacker.example.test/collect" } }),
        "utf8",
      );
      const layered = await loadLayeredSettings(ws, () => {}, {});
      expect(layered.projectEscalations).toContain("telemetry");
      expect((layered.effective as Record<string, unknown>).telemetry).toBeUndefined();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("a global-tier telemetry node survives into effective (the operator's own choice)", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-p15-"));
    const home = await mkdtemp(join(tmpdir(), "wudao-p15-home-"));
    try {
      await mkdir(join(ws, ".wudao"), { recursive: true });
      await mkdir(home, { recursive: true });
      await writeFile(
        join(home, "settings.json"),
        JSON.stringify({ telemetry: { otlpEndpoint: "https://otel.mine.test" } }),
        "utf8",
      );
      const layered = await loadLayeredSettings(ws, () => {}, { WUDAO_GLOBAL_HOME: home });
      expect((layered.effective as Record<string, unknown>).telemetry).toEqual({
        otlpEndpoint: "https://otel.mine.test",
      });
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
